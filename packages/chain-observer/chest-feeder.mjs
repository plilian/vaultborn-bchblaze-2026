import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, hashTransaction } from '@bitauth/libauth';
import { fromHex, hash256, hex, normalizeSource, toAddress } from './primitives.mjs';

// War Chest feeder. A service payment's 50% share waits here, with a small payer-funded network reserve, until it can
// join its owner's War Chest as an output large enough to be captured and withdrawn economically.
//
// The script has no key. Anyone may spend feeders, and only one way:
//   - the transaction has at most four inputs and exactly one output, and it is the owner's War Chest script, without tokens;
//   - that output is worth at least the sum of ALL inputs less `reserve` satoshis per input (the network fee cap);
//   - and either that output reaches `threshold` satoshis, or this feeder is `wait` blocks old.
// One exception makes waiting shares capturable: when input 0 of the transaction is an output of that same War Chest
// script, the feeder only requires output 0 to be the War Chest. The chest's own lanes then govern the transaction, and
// the only lane that can satisfy this is the attested capture, which returns at least 80% of ALL inputs to the chest.
// So a share can only ever become the owner's own War Chest money, the fee is bounded, and nobody (the owner included)
// can split shares into chest outputs too small to capture before the waiting period has passed.
export const CHEST_FEEDER = 'chest-feeder-v2';
export const FEEDER_INPUTS = 4;
const push = value => `<0x${value}>`;

export function chestFeeder({ id, chestScript, threshold, reserve, wait }) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A chest feeder needs its 16-byte payment ID.');
  if (!/^aa20[0-9a-f]{64}87$/.test(chestScript)) throw new Error('A chest feeder pays a P2SH32 War Chest script.');
  if (!Number.isInteger(threshold) || threshold < 1000 || threshold > 100_000) throw new Error('The chest threshold is out of range.');
  if (!Number.isInteger(reserve) || reserve < 150 || reserve > 600) throw new Error('The feeder network reserve is out of range.');
  if (!Number.isInteger(wait) || wait < 1 || wait > 65_535) throw new Error('The feeder waiting period is a number of blocks from 1 to 65,535.');
  const sum = ['OP_0 OP_UTXOVALUE', ...Array.from({ length: FEEDER_INPUTS - 1 }, (_, index) =>
    `OP_TXINPUTCOUNT <${index + 1}> OP_GREATERTHAN OP_IF <${index + 1}> OP_UTXOVALUE OP_ADD OP_ENDIF`)].join(' ');
  // Eight bytes of the payment ID make each feeder's script unique, so its payment can be found on chain.
  const source = `${push(id.slice(0, 16))} OP_DROP
    ${push(chestScript)} OP_DUP OP_0 OP_OUTPUTBYTECODE OP_EQUALVERIFY
    OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_0 OP_UTXOBYTECODE OP_EQUAL OP_NOTIF
      OP_TXOUTPUTCOUNT OP_1 OP_NUMEQUALVERIFY
      OP_TXINPUTCOUNT <${FEEDER_INPUTS}> OP_LESSTHANOREQUAL OP_VERIFY
      ${sum} OP_TXINPUTCOUNT <${reserve}> OP_MUL OP_SUB OP_0 OP_OUTPUTVALUE OP_LESSTHANOREQUAL OP_VERIFY
      OP_0 OP_OUTPUTVALUE <${threshold}> OP_GREATERTHANOREQUAL OP_NOTIF <${wait}> OP_CHECKSEQUENCEVERIFY OP_DROP OP_ENDIF
    OP_ENDIF
    OP_1`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { version: CHEST_FEEDER, id, chestScript, threshold, reserve, wait, script, address: toAddress(script), redeemScript: hex(redeem) };
}
export const feederTerms = ({ id, chestScript, threshold, reserve, wait }) => ({ id, chestScript, threshold, reserve, wait });
export const feederInputBytes = contract => 40 + 3 + contract.redeemScript.length / 2 + 1;
// The serialized size of a move of `count` feeders that share these terms.
export const feedBytes = (terms, count = 1) => 10 + count * feederInputBytes(chestFeeder({ id: '00'.repeat(16), ...terms })) + 44;

// Moves up to four feeders of one owner into one War Chest output. `aged` marks a move that relies on the waiting period.
export function buildChestFeed(feeders, { aged = false, unchecked = false } = {}) {
  if (!feeders.length || feeders.length > FEEDER_INPUTS) throw new Error('A chest feed moves 1 to ' + FEEDER_INPUTS + ' feeders.');
  const contracts = feeders.map(item => {
    const contract = chestFeeder(item.cf);
    const funding = normalizeSource(item);
    if (funding.script !== contract.script || funding.token) throw new Error('The source is not this chest feeder output.');
    return contract;
  });
  const chestScript = contracts[0].chestScript;
  if (contracts.some(item => item.chestScript !== chestScript)) throw new Error('One chest feed pays one War Chest.');
  const total = feeders.reduce((sum, item) => sum + item.satoshis, 0);
  const fee = 10 + contracts.reduce((sum, item) => sum + feederInputBytes(item), 0) + 44;
  const satoshis = total - fee;
  if (contracts.some(item => fee > feeders.length * item.reserve)) throw new Error('The feeders\' network reserves do not cover this move.');
  if (!aged && contracts.some(item => satoshis < item.threshold)) throw new Error('These feeders do not reach the War Chest threshold yet.');
  const transaction = { version: 2, locktime: 0, inputs: feeders.map((item, index) => ({ outpointTransactionHash: fromHex(item.txid), outpointIndex: item.vout,
    sequenceNumber: aged && satoshis < contracts[index].threshold ? contracts[index].wait : 0xfffffffe,
    unlockingBytecode: encodeDataPush(fromHex(contracts[index].redeemScript)) })),
    outputs: [{ lockingBytecode: fromHex(chestScript), valueSatoshis: BigInt(satoshis) }] };
  const sourceOutputs = feeders.map((item, index) => ({ lockingBytecode: fromHex(contracts[index].script), valueSatoshis: BigInt(item.satoshis) }));
  const raw = encodeTransaction(transaction);
  if (!unchecked) {
    const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
    if (verdict !== true) throw new Error('The chest feeder rejected the move: ' + verdict);
    if (fee < raw.length) throw new Error('The fee does not cover one satoshi per serialized byte.');
  }
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: fee, chestSatoshis: satoshis, outputs: [{ script: chestScript, satoshis }] };
}
