import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, hashTransaction } from '@bitauth/libauth';
import { fromHex, hash256, hex, publicBytes, toAddress } from './primitives.mjs';

// A season prize share below the BCH dust limit cannot be its own output. The payer therefore sends the prize share and
// the kingdom share together to this carrier. An exactly funded carrier has one way out: a sweep that pays its prize share
// into the season prize output and its kingdom share to its kingdom output. Nobody, the operator included, can send an
// exactly funded carrier anywhere else. Many carriers are swept together, so the summed prize output is above dust.
//
// Sweep layout: inputs [carrier 0 .. carrier n-1, fee input]; outputs [prize, kingdom 0 .. kingdom n-1, anything else].
// Each carrier checks that output 0 pays the prize script at least `prize` satoshis per non-final input, and that the
// output after its own input index pays its kingdom script at least `kingdom` satoshis. The final input pays the fee, so
// neither share is reduced. A sweep needs no key: anyone may relay it, because the destinations are fixed in the script.
export const PRIZE_CARRIER = 'prize-carrier-v1';
const P2SH32_DUST = 576;
const push = value => `<0x${value}>`;

export function prizeCarrier({ id, operatorKey, prize, kingdom, prizeScript, kingdomScript }) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A carrier needs its 16-byte payment ID.');
  const key = hex(publicBytes(operatorKey));
  for (const value of [prize, kingdom]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_000_000) throw new Error('Invalid carrier share.');
  for (const script of [prizeScript, kingdomScript]) if (!/^(?:[0-9a-f]{2}){20,40}$/.test(script)) throw new Error('Invalid carrier destination.');
  if (prizeScript === kingdomScript) throw new Error('Carrier destinations must differ.');
  if (kingdom < 546 || prize + kingdom < P2SH32_DUST) throw new Error('The carrier or its kingdom share is below the spendable minimum.');
  const total = prize + kingdom;
  const source = `${push('5642434131' + id)} OP_DROP
    OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_IF
      OP_INPUTINDEX OP_UTXOVALUE <${total}> OP_NUMEQUAL OP_NOT OP_VERIFY
      ${push(key)} OP_CHECKSIG
    OP_ELSE
      OP_INPUTINDEX OP_UTXOVALUE <${total}> OP_NUMEQUALVERIFY
      OP_INPUTINDEX OP_TXINPUTCOUNT OP_1SUB OP_LESSTHAN OP_VERIFY
      OP_0 OP_OUTPUTBYTECODE ${push(prizeScript)} OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_0 OP_OUTPUTVALUE OP_TXINPUTCOUNT OP_1SUB <${prize}> OP_MUL OP_GREATERTHANOREQUAL OP_VERIFY
      OP_INPUTINDEX OP_1ADD OP_OUTPUTBYTECODE ${push(kingdomScript)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_1ADD OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_1ADD OP_OUTPUTVALUE <${kingdom}> OP_GREATERTHANOREQUAL
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { id, version: PRIZE_CARRIER, prize, kingdom, satoshis: total, prizeScript, kingdomScript,
    script, address: toAddress(script), redeemScript: hex(redeem) };
}

// Unlocking bytes for the keyless sweep lane: selector 0, then the redeem script.
export const carrierSweepUnlocking = '00';
export const carrierBytes = contract => 41 + 4 + contract.redeemScript.length / 2;
export { fromHex as carrierHex };

// Version 2 carries a payer-funded sweep reserve and needs no operator key at all.
//
// Lane 1, sweep (keyless, exactly funded outputs only): output 0 is the season prize pool and must grow by this
// carrier's prize share for every carrier in the transaction; the output after this input's index is the payer's own
// kingdom vault with at least the kingdom share. The reserve pays the network fee; what is left of it stays in the pool.
// The last input may be the pool output itself, so every sweep tops up one pool instead of leaving small outputs behind.
// Lane 0, refund (keyless): after `refundAt` the whole output can only return to the payer's wallet. A carrier that
// was mis-funded, or never swept, is therefore recoverable without the game.
export const PRIZE_CARRIER_V2 = 'prize-carrier-v2';
export const SWEEP_RESERVE = 500;
const type2 = value => `<0x${value}>`;

export function prizeCarrier2({ id, prize, kingdom, reserve, prizeScript, kingdomScript, payerScript, refundAt }) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A carrier needs its 16-byte payment ID.');
  for (const value of [prize, kingdom, reserve]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Carrier shares are positive satoshi amounts.');
  if (reserve < 300 || reserve > 2000) throw new Error('Choose a sweep reserve from 300 to 2,000 satoshis.');
  if (!Number.isInteger(refundAt) || refundAt < 500_000_000 || refundAt >= 0xffffffff) throw new Error('A carrier needs an absolute refund time in seconds.');
  if (!/^76a914[0-9a-f]{40}88ac$/.test(payerScript)) throw new Error('A carrier refunds to its payer wallet.');
  const total = prize + kingdom + reserve;
  const source = `${type2('5642434132' + id)} OP_DROP
    OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_IF
      OP_INPUTINDEX OP_UTXOVALUE <${total}> OP_NUMEQUALVERIFY
      OP_0 OP_OUTPUTBYTECODE ${type2(prizeScript)} OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_TXINPUTCOUNT OP_1SUB OP_UTXOBYTECODE ${type2(prizeScript)} OP_EQUAL OP_IF
        OP_0 OP_OUTPUTVALUE OP_TXINPUTCOUNT OP_1SUB OP_UTXOVALUE OP_SUB OP_TXINPUTCOUNT OP_1SUB <${prize}> OP_MUL OP_GREATERTHANOREQUAL OP_VERIFY
      OP_ELSE
        OP_0 OP_OUTPUTVALUE OP_TXINPUTCOUNT <${prize}> OP_MUL OP_GREATERTHANOREQUAL OP_VERIFY
      OP_ENDIF
      OP_INPUTINDEX OP_1ADD OP_OUTPUTBYTECODE ${type2(kingdomScript)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_1ADD OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_1ADD OP_OUTPUTVALUE <${kingdom}> OP_GREATERTHANOREQUAL
    OP_ELSE
      <${refundAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP
      OP_INPUTINDEX OP_OUTPUTBYTECODE ${type2(payerScript)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <600> OP_SUB OP_GREATERTHANOREQUAL
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { id, version: PRIZE_CARRIER_V2, prize, kingdom, reserve, satoshis: total, prizeScript, kingdomScript, payerScript, refundAt,
    script, address: toAddress(script), redeemScript: hex(redeem) };
}

const keyless = (selector, redeemScript) => Uint8Array.from(Buffer.concat([Uint8Array.of(selector), encodeDataPush(fromHex(redeemScript))]));
const checked = (transaction, sourceOutputs, unchecked) => {
  const raw = encodeTransaction(transaction);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The carrier rejected the spend: ' + verdict);
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error('The carriers in this sweep do not hold enough reserve for its network fee.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
};

// Sweeps carriers of one pool and one prize share. `pool` is the current pool output ({ txid, vout, satoshis, script,
// redeemScript }) or undefined for the first sweep of a season. No key signs anything.
export function buildPoolSweep(carriers, { pool, eventScript } = {}, { unchecked = false } = {}) {
  const contracts = carriers.map(item => prizeCarrier2(item.carrier2));
  const lead = contracts[0];
  if (contracts.some((item, index) => item.script !== carriers[index].script || item.prizeScript !== lead.prizeScript || item.prize !== lead.prize || carriers[index].satoshis !== item.satoshis)) {
    throw new Error('One sweep serves exactly funded carriers of one pool and one prize share.');
  }
  if (pool && pool.script !== lead.prizeScript) throw new Error('The pool output does not belong to these carriers.');
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  const bytes = 10 + contracts.reduce((sum, item) => sum + 44 + item.redeemScript.length / 2 + 44, 0) + (pool ? 44 + pool.redeemScript.length / 2 : 0) + 44 +
    record.reduce((sum, item) => sum + 9 + item.script.length / 2, 0);
  const reserves = contracts.reduce((sum, item) => sum + item.reserve, 0);
  // Whatever the fee does not need stays in the prize pool.
  const poolValue = (pool?.satoshis ?? 0) + contracts.length * lead.prize + Math.max(0, reserves - bytes - 2);
  const outputs = [{ script: lead.prizeScript, satoshis: poolValue }, ...contracts.map(item => ({ script: item.kingdomScript, satoshis: item.kingdom })), ...record];
  const inputs = [...carriers.map((item, index) => ({ source: item, unlocking: keyless(0x51, contracts[index].redeemScript), script: contracts[index].script })),
    ...(pool ? [{ source: pool, unlocking: keyless(0x00, pool.redeemScript), script: pool.script }] : [])];
  const transaction = { version: 2, locktime: 0, inputs: inputs.map(item => ({ outpointTransactionHash: fromHex(item.source.txid), outpointIndex: item.source.vout,
    sequenceNumber: 0xffffffff, unlockingBytecode: item.unlocking })),
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = inputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.source.satoshis) }));
  return { ...checked(transaction, sourceOutputs, unchecked), outputs, poolSatoshis: poolValue, contracts };
}

// Returns carriers to their payers after the refund date. Output i pays the payer of input i.
export function buildCarrierRefund(carriers, { unchecked = false } = {}) {
  const contracts = carriers.map(item => prizeCarrier2(item.carrier2));
  const transaction = { version: 2, locktime: Math.max(...contracts.map(item => item.refundAt)),
    inputs: carriers.map((item, index) => ({ outpointTransactionHash: fromHex(item.txid), outpointIndex: item.vout, sequenceNumber: 0xfffffffe,
      unlockingBytecode: keyless(0x00, contracts[index].redeemScript) })),
    outputs: carriers.map((item, index) => ({ lockingBytecode: fromHex(contracts[index].payerScript), valueSatoshis: BigInt(item.satoshis - 450) })) };
  const sourceOutputs = carriers.map((item, index) => ({ lockingBytecode: fromHex(contracts[index].script), valueSatoshis: BigInt(item.satoshis) }));
  return checked(transaction, sourceOutputs, unchecked);
}

// Prize feeder: the smallest script that can hold one service prize share until it joins the season pool.
// It has one way out and no key: a transaction whose output 0 is the season pool and grows by this share for every
// feeder spent. The last input may be the pool output itself, so feeders top up one pool. The payer adds a small
// reserve to the feeder output; it pays this move, and what the fee does not need stays in the pool.
export const PRIZE_FEEDER = 'prize-feeder-v1';

export function prizeFeeder({ poolScript, share }) {
  if (!/^aa20[0-9a-f]{64}87$/.test(poolScript)) throw new Error('A prize feeder pays one season pool covenant.');
  if (!Number.isSafeInteger(share) || share < 1) throw new Error('A prize feeder carries a positive prize share.');
  const source = `<0x5642504631> OP_DROP OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE OP_DUP <0x${poolScript}> OP_EQUALVERIFY
    OP_TXINPUTCOUNT OP_1SUB OP_UTXOBYTECODE OP_EQUAL OP_IF
      OP_0 OP_OUTPUTVALUE OP_TXINPUTCOUNT OP_1SUB OP_UTXOVALUE OP_SUB OP_TXINPUTCOUNT OP_1SUB <${share}> OP_MUL OP_GREATERTHANOREQUAL
    OP_ELSE
      OP_0 OP_OUTPUTVALUE OP_TXINPUTCOUNT <${share}> OP_MUL OP_GREATERTHANOREQUAL
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { version: PRIZE_FEEDER, poolScript, share, script, address: toAddress(script), redeemScript: hex(redeem) };
}

// Moves feeders of one pool and one share into that pool. `pool` is the current pool output or undefined for the first
// move of a season. Nobody signs. The fee comes from the reserves the payers added to their feeder outputs.
export function buildFeedSweep(feeders, { pool } = {}, { unchecked = false } = {}) {
  const contracts = feeders.map(item => prizeFeeder(item.feeder));
  const lead = contracts[0];
  if (contracts.some((item, index) => item.script !== feeders[index].script || item.script !== lead.script)) throw new Error('One move serves feeders of one pool and one prize share.');
  if (pool && pool.script !== lead.poolScript) throw new Error('The pool output does not belong to these feeders.');
  const push = redeemScript => Uint8Array.from(encodeDataPush(fromHex(redeemScript)));
  const inputs = [...feeders.map(item => ({ source: item, unlocking: push(lead.redeemScript), script: lead.script })),
    ...(pool ? [{ source: pool, unlocking: keyless(0x00, pool.redeemScript), script: pool.script }] : [])];
  const bytes = 10 + 44 + inputs.reduce((sum, item) => sum + 41 + item.unlocking.length, 0);
  const held = feeders.reduce((sum, item) => sum + item.satoshis, 0);
  const poolValue = (pool?.satoshis ?? 0) + Math.max(feeders.length * lead.share, held - bytes - 2);
  const outputs = [{ script: lead.poolScript, satoshis: poolValue }];
  const transaction = { version: 2, locktime: 0, inputs: inputs.map(item => ({ outpointTransactionHash: fromHex(item.source.txid), outpointIndex: item.source.vout,
    sequenceNumber: 0xffffffff, unlockingBytecode: item.unlocking })),
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = inputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.source.satoshis) }));
  return { ...checked(transaction, sourceOutputs, unchecked), outputs, poolSatoshis: poolValue };
}
