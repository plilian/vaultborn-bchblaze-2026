// A local stand-in for the Electrum network used by the XO engine: one in-memory chain shared by every engine in the process.
// Transactions are checked by the BCH virtual machine before they are accepted, so a covenant that would be refused by a node
// is refused here too. It is a test fixture and nothing it produces exists on any public network.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { binToHex, createVirtualMachineBch, decodeTransaction, encodeTransaction, hashTransaction, hexToBin } from '@bitauth/libauth';

export const electrumEvents = new EventEmitter();
export const electrumClients = new Map();
const coins = new Map();          // "txid:vout" -> { lockingBytecode, valueSatoshis, token, height }
const transactions = new Map();   // txid -> raw hex
const watched = new Set();
export const chain = { height: 300_000, time: Math.floor(Date.now() / 1000), coins, transactions, accepted: [] };

// With XO_SIM_CHAIN set, the chain is kept in that file so that several processes, one per account, share it.
const file = process.env.XO_SIM_CHAIN;
if (file && existsSync(file)) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  chain.time = saved.time; chain.accepted.push(...saved.accepted);
  for (const [txid, raw] of saved.transactions) transactions.set(txid, raw);
  for (const [key, coin] of saved.coins) coins.set(key, { lockingBytecode: hexToBin(coin.lockingBytecode), valueSatoshis: BigInt(coin.valueSatoshis), height: coin.height });
}
const save = () => { if (file) writeFileSync(file, JSON.stringify({ time: chain.time, accepted: chain.accepted, transactions: [...transactions],
  coins: [...coins].map(([key, coin]) => [key, { lockingBytecode: binToHex(coin.lockingBytecode), valueSatoshis: String(coin.valueSatoshis), height: coin.height }]) })); };

const scriptHashOf = (bytecode) => Buffer.from(createHash('sha256').update(bytecode).digest()).reverse().toString('hex');
const notify = (bytecode) => electrumEvents.emit('ScriptHashUpdate', { scriptHash: scriptHashOf(bytecode) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

export async function fund(lockingBytecodeHex, satoshis) {
  const lockingBytecode = hexToBin(lockingBytecodeHex);
  const raw = encodeTransaction({ version: 2, locktime: 0,
    inputs: [{ outpointTransactionHash: createHash('sha256').update(String(Math.random())).digest(), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode, valueSatoshis: BigInt(satoshis) }] });
  const txid = hashTransaction(raw);
  transactions.set(txid, binToHex(raw));
  coins.set(txid + ':0', { lockingBytecode, valueSatoshis: BigInt(satoshis), height: chain.height });
  save();
  notify(lockingBytecode);
  await settle();
  return { txid, vout: 0 };
}

export async function broadcastTransaction(rawHex) {
  const raw = hexToBin(rawHex);
  const transaction = decodeTransaction(raw);
  if (typeof transaction === 'string') throw new Error('undecodable transaction: ' + transaction);
  const sourceOutputs = transaction.inputs.map((input) => {
    const coin = coins.get(binToHex(input.outpointTransactionHash) + ':' + input.outpointIndex);
    if (!coin) throw new Error('missing or spent input ' + binToHex(input.outpointTransactionHash) + ':' + input.outpointIndex);
    return { lockingBytecode: coin.lockingBytecode, valueSatoshis: coin.valueSatoshis, ...(coin.token ? { token: coin.token } : {}) };
  });
  const verdict = createVirtualMachineBch().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('the virtual machine refused the transaction: ' + verdict);
  if (transaction.locktime >= 500_000_000 ? transaction.locktime > chain.time : transaction.locktime > chain.height) {
    if (transaction.inputs.some((input) => input.sequenceNumber !== 0xffffffff)) throw new Error('non-final transaction (locktime not reached)');
  }
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error(`fee ${fee} is below one satoshi per byte (${raw.length} bytes)`);
  const txid = hashTransaction(raw);
  transactions.set(txid, rawHex);
  for (const input of transaction.inputs) coins.delete(binToHex(input.outpointTransactionHash) + ':' + input.outpointIndex);
  transaction.outputs.forEach((output, index) => {
    if (output.lockingBytecode[0] !== 0x6a) coins.set(txid + ':' + index, { lockingBytecode: output.lockingBytecode, valueSatoshis: output.valueSatoshis, token: output.token, height: 0 });
  });
  chain.accepted.push({ txid, bytes: raw.length, fee: Number(fee) });
  save();
  for (const item of [...sourceOutputs, ...transaction.outputs]) notify(item.lockingBytecode);
  await settle();
  return txid;
}

export const listUnspent = (scriptHash) => [...coins].filter(([, coin]) => scriptHashOf(coin.lockingBytecode) === scriptHash)
  .map(([key, coin]) => ({ tx_hash: key.split(':')[0], tx_pos: Number(key.split(':')[1]), height: coin.height, value: Number(coin.valueSatoshis) }));

export const getUsableElectrumClient = async () => ({ fake: true });
export const getTransaction = async (txid) => { const raw = transactions.get(txid); if (!raw) throw new Error('unknown transaction ' + txid); return raw; };
export const getChainStatus = async () => ({ currentHeight: chain.height, verifiedHeight: chain.height, verifiedPercent: '100.0' });
export const initializeElectrumApplication = async () => {};
export const monitorScriptHash = async (scriptHash) => { watched.add(scriptHash); };
export const monitorTransaction = async () => {};
export const stopElectrumNetwork = async () => {};
// The one request helper the engine takes from @electrum-cash/protocol.
export const fetchScriptHashUnspentTransactionOutputs = async (_client, scriptHash) => listUnspent(scriptHash);
