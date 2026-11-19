import { connect } from 'node:tls';
import { HEX64, hex, parseHeader, readTransaction, scriptHash, verifyHeaderChain, verifyInclusion } from './primitives.mjs';

import { NETWORK_LABEL, NETWORK_PROFILE, networkEnv } from '../../config/network.mjs';

// The block that identifies the network of this process (config/network.mjs). Every observer session checks it first,
// so a server of another network, or of another chain that shares the address format, is refused before any data is used.
export const NETWORK_CHECKPOINT = NETWORK_PROFILE.checkpoint;
export const CHIPNET_CHECKPOINT = NETWORK_CHECKPOINT; // earlier name, same value
const DEFAULT_HOSTS = [...NETWORK_PROFILE.electrumHosts];
const MAX_RESPONSE = 3_000_000;

class NetworkError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function notFound(error) {
  return error?.code === -5 || /not found|no such mempool|no such transaction|not in mempool/i.test(error?.message ?? '');
}

async function queryOrNull(request, method, params) {
  try {
    return await request(method, params);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function withSocket(host, work) {
  const [hostname, port] = host.split(':');
  if (!/^[a-z0-9.-]+$/i.test(hostname) || (port !== undefined && !/^\d{1,5}$/.test(port))) {
    throw new Error('Invalid ' + NETWORK_LABEL + ' Electrum endpoint.');
  }
  const socket = connect({ host: hostname, port: Number(port ?? 50002), servername: hostname, rejectUnauthorized: true });
  const requests = new Map();
  let buffer = '';
  let nextId = 0;
  let fault;
  const fail = (error) => {
    fault = error;
    for (const { reject } of requests.values()) reject(error);
    requests.clear();
    socket.destroy();
  };
  socket.setEncoding('utf8');
  socket.setTimeout(7000, () => fail(new NetworkError('' + NETWORK_LABEL + ' observer timed out.')));
  socket.on('error', (error) => fail(new NetworkError('' + NETWORK_LABEL + ' TLS failed: ' + error.message, error.code)));
  socket.on('close', () => fail(new NetworkError('' + NETWORK_LABEL + ' observer closed the connection.')));
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_RESPONSE) {
      fail(new NetworkError('' + NETWORK_LABEL + ' observer response exceeded the size limit.'));
      return;
    }
    let lineBreak = buffer.indexOf('\n');
    while (lineBreak !== -1) {
      const line = buffer.slice(0, lineBreak).trim();
      buffer = buffer.slice(lineBreak + 1);
      lineBreak = buffer.indexOf('\n');
      if (line.length === 0) continue;
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        fail(new NetworkError('' + NETWORK_LABEL + ' observer returned invalid JSON.'));
        return;
      }
      const waiting = requests.get(reply.id);
      if (!waiting) continue;
      requests.delete(reply.id);
      if (reply.error) waiting.reject(new NetworkError(reply.error.message, reply.error.code));
      else waiting.resolve(reply.result);
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (fault) {
        reject(fault);
        return;
      }
      const id = ++nextId;
      requests.set(id, { resolve, reject });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    await request('server.version', ['BCH Dominion 0.1', ['1.4', '1.5']]);
    return await work(request);
  } finally {
    socket.destroy();
  }
}

function assertCheckpoint(header, checkpoint = NETWORK_CHECKPOINT) {
  if (parseHeader(header).hash !== checkpoint.hash) {
    throw new NetworkError('Wrong network: ' + NETWORK_LABEL + ' checkpoint mismatch.');
  }
}

function checkHeight(result, checkpoint = NETWORK_CHECKPOINT) {
  if (!Number.isSafeInteger(result) || result < checkpoint.height) {
    throw new NetworkError('' + NETWORK_LABEL + ' observer has an invalid or outdated tip.');
  }
  return result;
}

function createElectrumClient(request, tip, witness) {
  const raw = (txid) => queryOrNull(request, 'blockchain.transaction.get', [txid, false]);
  return {
    tip,
    raw,
    block: height => request('blockchain.block.header', [height]),
    async history(script) {
      const records = await request('blockchain.scripthash.get_history', [scriptHash(script)]);
      if (!Array.isArray(records)) throw new NetworkError('Invalid ' + NETWORK_LABEL + ' scripthash history.');
      return records.filter(({ tx_hash, height }) => HEX64.test(tx_hash) && Number.isSafeInteger(height))
        .map(({ tx_hash, height }) => ({ txid: tx_hash.toLowerCase(), height }));
    },
    async lookup(txid, knownHeight) {
      let height = knownHeight;
      let transactionHex;
      if (height === undefined) {
        const verbose = await queryOrNull(request, 'blockchain.transaction.get', [txid, true]);
        if (!verbose) return null;
        transactionHex = verbose.hex;
        if (verbose.confirmations > 0) {
          const reportedHeight = verbose.height ?? verbose.blockheight;
          height = reportedHeight ?? tip - verbose.confirmations + 1;
        } else height = 0;
      } else transactionHex = await raw(txid);
      if (!transactionHex) return null;
      const parsed = readTransaction(transactionHex, txid);
      if (height <= 0) return { ...parsed, height: null, confirmations: 0 };
      if (!Number.isSafeInteger(height) || height > tip) throw new NetworkError('' + NETWORK_LABEL + ' transaction height disagrees with the observer tip.');
      const [proof, candidateHeader] = await Promise.all([
        request('blockchain.transaction.get_merkle', [txid, height]),
        request('blockchain.block.header', [height]),
      ]);
      const header = parseHeader(candidateHeader);
      if (proof.block_height !== height || !verifyInclusion(txid, proof, header)) {
        throw new NetworkError('' + NETWORK_LABEL + ' transaction failed Merkle inclusion verification.');
      }
      // The block and the blocks counted as its confirmations must each carry their claimed work and link together.
      const depth = Math.min(tip - height + 1, 12);
      const following = depth > 1 ? await request('blockchain.block.headers', [height, depth]) : null;
      const chainHex = following?.hex ?? candidateHeader;
      const headers = chainHex.match(/.{160}/g) ?? [];
      if (headers.length !== depth || headers[0] !== candidateHeader.toLowerCase() || !verifyHeaderChain(headers)) {
        throw new NetworkError('' + NETWORK_LABEL + ' headers failed work or linkage verification.');
      }
      // A second, independent server must name the same block at this height. Disagreement is never resolved in favor of either.
      const seen = witness ? await witness(height) : undefined;
      if (seen && seen !== header.hash) throw new NetworkError('' + NETWORK_LABEL + ' servers disagree about the block at this height.');
      return { ...parsed, height, confirmations: tip - height + 1, blockHash: header.hash, blockTime: header.timestamp * 1000,
        witnessed: Boolean(seen) };
    },
    async listUnspent(script, tokenFilter = 'exclude_tokens') {
      const results = await request('blockchain.scripthash.listunspent', [scriptHash(script), tokenFilter]);
      if (!Array.isArray(results)) throw new NetworkError('Invalid ' + NETWORK_LABEL + ' unspent output list.');
      return results.map(({ tx_hash, tx_pos, value, height }) => ({ txid: tx_hash, vout: tx_pos, satoshis: value, height }));
    },
    broadcast(rawHex) {
      return request('blockchain.transaction.broadcast', [rawHex]);
    },
  };
}

export function createElectrumTransport(host, { open = withSocket, requireWitness = networkEnv('REQUIRE_WITNESS') === undefined ? NETWORK_PROFILE.requireWitness : networkEnv('REQUIRE_WITNESS') === 'true',
  checkpoint: pinned = NETWORK_CHECKPOINT } = {}) {
  const endpoints = host ? host.split(',').map(item => item.trim()).filter(Boolean) : DEFAULT_HOSTS;
  let preferred = 0;
  const agreed = new Map();
  // Asks a different server for the block hash at a height. Deep blocks are remembered; shallow ones are asked again.
  function witnessFor(primary) {
    return async height => {
      if (agreed.has(height)) return agreed.get(height);
      for (let i = 1; i < endpoints.length; i += 1) {
        const index = (primary + i) % endpoints.length;
        try {
          return await open(endpoints[index], async request => {
            const [checkpoint, tip, header] = await Promise.all([request('blockchain.block.header', [pinned.height]),
              request('blockchain.headers.subscribe', []), request('blockchain.block.header', [height])]);
            assertCheckpoint(checkpoint, pinned);
            const { hash } = parseHeader(header);
            if (checkHeight(tip.height, pinned) - height >= 10) {
              if (agreed.size > 4000) agreed.clear();
              agreed.set(height, hash);
            }
            return hash;
          });
        } catch (error) {
          if (!(error instanceof NetworkError) || typeof error.code === 'number') throw error;
        }
      }
      if (requireWitness) throw new NetworkError('No second ' + NETWORK_LABEL + ' server was available to confirm this block.');
      return undefined;
    };
  }
  return {
    async withClient(work) {
      let lastError;
      for (let i = 0; i < endpoints.length; i += 1) {
        const index = (preferred + i) % endpoints.length;
        try {
          const result = await open(endpoints[index], async (request) => {
            const [checkpoint, tip] = await Promise.all([
              request('blockchain.block.header', [pinned.height]),
              request('blockchain.headers.subscribe', []),
            ]);
            assertCheckpoint(checkpoint, pinned);
            return work(createElectrumClient(request, checkHeight(tip.height, pinned), endpoints.length > 1 || requireWitness ? witnessFor(index) : undefined));
          });
          preferred = index;
          return result;
        } catch (error) {
          if (!(error instanceof NetworkError) || typeof error.code === 'number') throw error;
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}

export function createRpcTransport({ rpcUrl, rpcUser, rpcPassword }) {
  const endpoint = new URL(rpcUrl);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('BCHN RPC requires an HTTP(S) endpoint and separately configured credentials.');
  }
  if (endpoint.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) {
    throw new Error('Remote BCHN RPC endpoints require TLS.');
  }
  const authorization = 'Basic ' + Buffer.from((rpcUser ?? '') + ':' + (rpcPassword ?? '')).toString('base64');
  const request = async (method, params) => {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'dominion', method, params }),
    });
    if (response.status === 401 || response.status === 403) throw new NetworkError('BCHN RPC credentials were rejected.');
    const reply = await response.json();
    if (reply.error) throw new NetworkError(reply.error.message, reply.error.code);
    if (!response.ok) throw new NetworkError('BCHN RPC request failed.');
    return reply.result;
  };
  return {
    async withClient(work) {
      const [checkpoint, info] = await Promise.all([
        request('getblockhash', [NETWORK_CHECKPOINT.height]),
        request('getblockchaininfo', []),
      ]);
      if (checkpoint !== NETWORK_CHECKPOINT.hash) throw new NetworkError('Wrong network: BCHN ' + NETWORK_LABEL + ' checkpoint mismatch.');
      if (info.initialblockdownload) throw new NetworkError('BCHN is still syncing ' + NETWORK_LABEL + '.');
      const tip = checkHeight(info.blocks);
      return work({
        tip,
        block: async height => request('getblockheader', [await request('getblockhash', [height]), false]),
        raw: (txid) => queryOrNull(request, 'getrawtransaction', [txid, false]),
        history: null,
        listUnspent: null,
        async lookup(txid) {
          const raw = await queryOrNull(request, 'getrawtransaction', [txid, true]);
          if (!raw) return null;
          const result = readTransaction(raw.hex, txid);
          if (!raw.blockhash) {
            const mempool = await queryOrNull(request, 'getmempoolentry', [txid]);
            return mempool ? { ...result, height: null, confirmations: 0 } : null;
          }
          const block = await request('getblockheader', [raw.blockhash, true]);
          if (block.confirmations < 1 || raw.in_active_chain === false) return null;
          return {
            ...result, height: block.height, confirmations: block.confirmations,
            blockHash: block.hash, blockTime: block.time * 1000,
          };
        },
        broadcast: (rawHex) => request('sendrawtransaction', [rawHex]),
      });
    },
  };
}

export async function observedFee(client, transaction) {
  if (transaction.inputs.length > 24 || transaction.inputs.some((input) => /^0+$/.test(hex(input.outpointTransactionHash)))) {
    return undefined;
  }
  try {
    const previous = await Promise.all(transaction.inputs.map(async (input) => {
      const txid = hex(input.outpointTransactionHash);
      const rawHex = await client.raw(txid);
      if (!rawHex) return undefined;
      return readTransaction(rawHex, txid).transaction.outputs[input.outpointIndex]?.valueSatoshis;
    }));
    if (previous.some((value) => value === undefined)) return undefined;
    const total = previous.reduce((sum, value) => sum + value, 0n) -
      transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
    if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(total);
  } catch {
    return undefined;
  }
}
