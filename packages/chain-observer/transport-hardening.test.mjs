import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hash256, hex, parseHeader, readTransaction, signSpend, verifyHeaderChain, walletFromPrivateKey } from './primitives.mjs';
import { createElectrumTransport } from './transports.mjs';

// The first two Bitcoin headers, shared by Bitcoin Cash. Their proof of work is real.
const genesis = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const second = '010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299';

test('a header must carry its claimed work and link to its parent', () => {
  const first = parseHeader(genesis);
  assert.equal(first.hash, '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.equal(first.meetsTarget, true);
  assert.equal(parseHeader(second).previous, first.hash);
  assert.equal(verifyHeaderChain([genesis, second]), true);
  assert.equal(verifyHeaderChain([second, genesis]), false, 'out of order headers do not link');
  const forged = genesis.slice(0, 152) + '00000000';
  assert.equal(parseHeader(forged).meetsTarget, false, 'a changed nonce loses the work');
  assert.equal(verifyHeaderChain([forged]), false);
  assert.equal(verifyHeaderChain([genesis, second.slice(0, 8) + 'ff' + second.slice(10)]), false, 'a wrong parent is refused');
  assert.equal(verifyHeaderChain([]), false);
});

// Synthetic low-difficulty headers stand in for a test chain. Each is ground until it meets its own target.
function header(previous, merkleRoot, salt = 0) {
  for (let nonce = salt * 1_000_000; ; nonce++) {
    const bytes = Buffer.alloc(80);
    bytes.writeUInt32LE(1, 0);
    Buffer.from(previous, 'hex').reverse().copy(bytes, 4);
    Buffer.from(merkleRoot, 'hex').copy(bytes, 36);
    bytes.writeUInt32LE(1_800_000_000, 68);
    bytes.writeUInt32LE(0x207fffff, 72);
    bytes.writeUInt32LE(nonce, 76);
    if (parseHeader(hex(bytes)).meetsTarget) return hex(bytes);
  }
}
const wallet = walletFromPrivateKey('7'.padStart(64, '0'));
const payment = signSpend({ privateKey:'7'.padStart(64, '0'), sources:[{ txid:'aa'.repeat(32), vout:0, script:wallet.script, satoshis:10_000 }],
  outputs:[{ script:wallet.script, satoshis:9_000 }] });
const merkleRoot = hex(Buffer.from(payment.txid, 'hex').reverse());
const anchor = header('00'.repeat(32), hex(hash256(Buffer.from('anchor'))));
const pinned = { height:100, hash:parseHeader(anchor).hash };
// An honest chain and a forged fork. Both include the payment at height 101, in different blocks.
const honest = [header(pinned.hash, merkleRoot, 1)];
honest.push(header(parseHeader(honest[0]).hash, 'cc'.repeat(32), 1));
const fork = [header(pinned.hash, merkleRoot, 2)];
fork.push(header(parseHeader(fork[0]).hash, 'dd'.repeat(32), 2));

function server(chain, { down = false } = {}) {
  return async (method, params) => {
    if (down) throw Object.assign(new Error('unreachable'), { name:'NetworkError' });
    if (method === 'blockchain.block.header') return params[0] === 100 ? anchor : chain[params[0] - 101];
    if (method === 'blockchain.headers.subscribe') return { height:100 + chain.length };
    if (method === 'blockchain.block.headers') return { hex:chain.slice(params[0] - 101, params[0] - 101 + params[1]).join(''), count:params[1] };
    if (method === 'blockchain.transaction.get') return params[1] ? { hex:payment.rawHex, confirmations:chain.length, height:101 } : payment.rawHex;
    if (method === 'blockchain.transaction.get_merkle') return { block_height:101, merkle:[], pos:0 };
    throw new Error('unexpected ' + method);
  };
}
const transport = (servers, options = {}) => createElectrumTransport(Object.keys(servers).join(','), { checkpoint:pinned, ...options,
  open:async (endpoint, work) => {
    if (servers[endpoint] === null) throw new (class NetworkError extends Error {})('down');
    return work(servers[endpoint]);
  } });

test('a confirmation is accepted when a second server names the same block', async () => {
  const seen = await transport({ 'a:1':server(honest), 'b:1':server(honest) }).withClient(client => client.lookup(payment.txid));
  assert.equal(seen.confirmations, 2);
  assert.equal(seen.witnessed, true);
  assert.equal(seen.blockHash, parseHeader(honest[0]).hash);
  assert.equal(readTransaction(payment.rawHex).txid, seen.txid);
});

test('a forged fork served by one server is refused when another server disagrees', async () => {
  await assert.rejects(transport({ 'a:1':server(fork), 'b:1':server(honest) }).withClient(client => client.lookup(payment.txid)), /disagree/);
  await assert.rejects(transport({ 'a:1':server(honest), 'b:1':server(fork) }).withClient(client => client.lookup(payment.txid)), /disagree/);
});

test('confirmations must be a linked chain of headers that each carry work', async () => {
  const broken = [honest[0], fork[1]];
  await assert.rejects(transport({ 'a:1':server(broken), 'b:1':server(broken) }).withClient(client => client.lookup(payment.txid)), /work or linkage/);
  // A server with a broken chain is skipped: the client fails over to an honest one and still gets a witnessed answer.
  const recovered = await transport({ 'a:1':server(broken), 'b:1':server(honest), 'c:1':server(honest) }).withClient(client => client.lookup(payment.txid));
  assert.equal(recovered.blockHash, parseHeader(honest[0]).hash);
  const weak = [honest[0], honest[1].slice(0, 152) + 'ffffffff'];
  if (!parseHeader(weak[1]).meetsTarget) {
    await assert.rejects(transport({ 'a:1':server(weak), 'b:1':server(weak) }).withClient(client => client.lookup(payment.txid)), /work or linkage/);
  }
});

test('strict mode refuses a confirmation that no second server can vouch for', async () => {
  const servers = { 'a:1':server(honest) };
  const alone = await transport(servers).withClient(client => client.lookup(payment.txid));
  assert.equal(alone.witnessed, false);
  await assert.rejects(transport(servers, { requireWitness:true }).withClient(client => client.lookup(payment.txid)), /No second Chipnet server/);
});
