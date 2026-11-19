import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH, hashTransaction, secp256k1 } from '@bitauth/libauth';
import { createHash } from 'node:crypto';
import { fromHex, hash256, hex, normalizeSource, publicBytes, toAddress } from './primitives.mjs';

const hash160 = value => createHash('ripemd160').update(createHash('sha256').update(value).digest()).digest();

// Record reserve. A paid political operation is proven by a public record transaction after the operation has been
// applied. Somebody has to pay that transaction's network fee, and it must not be an account the game operator controls.
// The payer therefore adds this output to the payment. It has exactly one use: the game key may spend it, alone, in a
// transaction whose single output is an unspendable data record of zero value. The whole output becomes that
// transaction's network fee. The game key cannot send a satoshi of it anywhere, and nobody else can spend it at all.
// 576 satoshis is the smallest contract output the network relays; the record transaction itself is about 230 bytes.
export const RECORD_RESERVE = 'record-reserve-v2';
export const RECORD_RESERVE_1 = 'record-reserve-v1';
export const RECORD_RESERVE_SATOSHIS = 576;
// Blocks after which the payer alone may take an unused reserve back (about two weeks). In ordinary operation the proof
// is published within minutes; an operation that failed or was cancelled leaves the reserve for its payer, not for good.
export const RECORD_RECOVERY_BLOCKS = 2016;
const type = Uint8Array.of(0x61);

// Version 2 (current): lane 1 is the record lane described above; lane 0 returns an unused reserve to its payer, whose
// key alone may spend it once the output is `recoveryAge` blocks old. Version 1 (no owner key) had the record lane only.
export function recordReserve({ id, operatorKey, ownerKey, recoveryAge = RECORD_RECOVERY_BLOCKS }) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A record reserve needs its 16-byte payment ID.');
  const operator = hex(publicBytes(operatorKey));
  const record = `<0x${operator}> OP_CHECKSIGVERIFY
    OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY OP_TXOUTPUTCOUNT OP_1 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE OP_1 OP_SPLIT OP_DROP <0x6a> OP_EQUAL`;
  if (!ownerKey) {
    const redeem = cashAssemblyToBin(`<0x${id.slice(0, 16)}> OP_DROP ${record}`);
    if (typeof redeem === 'string') throw new Error(redeem);
    const script = 'aa20' + hex(hash256(redeem)) + '87';
    return { version: RECORD_RESERVE_1, id, operatorKey: operator, script, address: toAddress(script), redeemScript: hex(redeem) };
  }
  if (!Number.isSafeInteger(recoveryAge) || recoveryAge < 144 || recoveryAge > 65_535) throw new Error('The reserve recovery age must be between 144 and 65,535 blocks.');
  const owner = hex(publicBytes(ownerKey));
  const redeem = cashAssemblyToBin(`<0x${id.slice(0, 16)}> OP_DROP
    OP_IF ${record}
    OP_ELSE <${recoveryAge}> OP_CHECKSEQUENCEVERIFY OP_DROP <0x${owner}> OP_CHECKSIG OP_ENDIF`);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { version: RECORD_RESERVE, id, operatorKey: operator, ownerKey: owner, recoveryAge, script, address: toAddress(script), redeemScript: hex(redeem) };
}
export const recordTerms = ({ id, operatorKey, ownerKey, recoveryAge }) => ({ id, operatorKey, ...(ownerKey && { ownerKey, recoveryAge }) });
const unlock = (contract, signature, lane) => Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([signature, type])),
  ...(contract.ownerKey ? [Uint8Array.of(lane ? 0x51 : 0x00)] : []), encodeDataPush(fromHex(contract.redeemScript))]));

// Publishes `eventScript` (an OP_RETURN record) and spends the whole reserve as its network fee.
// `outputs` replaces the single record output; tests use it to show that the script refuses anything else, correctly signed.
export function signRecord(funding, eventScript, operatorPrivateKey, { unchecked = false, outputs } = {}) {
  const contract = recordReserve(funding.rr);
  const source = normalizeSource(funding);
  if (source.script !== contract.script || source.token) throw new Error('The source is not this record reserve output.');
  const transaction = { version: 2, locktime: 0, inputs: [{ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() }],
    outputs: (outputs ?? [{ script: eventScript, satoshis: 0 }]).map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(source.satoshis) }];
  const digest = hash256(generateSigningSerializationBCH({ inputIndex: 0, sourceOutputs, transaction }, { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: type }));
  const signature = secp256k1.signMessageHashSchnorr(fromHex(operatorPrivateKey), digest);
  transaction.inputs[0].unlockingBytecode = unlock(contract, signature, 1);
  const raw = encodeTransaction(transaction);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The record reserve rejected the spend: ' + verdict);
  if (source.satoshis < raw.length) throw new Error('The record reserve does not cover the network fee of its record.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: source.satoshis, bytes: raw.length };
}

// The payer takes an unused reserve back. Only the payer's key can do it, and only once the output is `recoveryAge`
// blocks old. The reserve alone cannot carry a fee and still leave a spendable output, so the payer adds `fee`, an
// ordinary output of the same wallet ({ txid, vout, satoshis }); everything returns to that wallet in one output.
// `early` and `outputs` exist for tests that show what the script refuses.
export function signRecordRecovery(funding, ownerPrivateKey, { fee, unchecked = false, early = false } = {}) {
  const contract = recordReserve(funding.rr);
  if (!contract.ownerKey) throw new Error('A version 1 record reserve has no owner lane.');
  const source = normalizeSource(funding);
  if (source.script !== contract.script || source.token) throw new Error('The source is not this record reserve output.');
  const publicKey = hex(secp256k1.derivePublicKeyCompressed(fromHex(ownerPrivateKey)));
  if (publicKey !== contract.ownerKey) throw new Error('This key is not the payer of this record reserve.');
  const wallet = '76a914' + hex(hash160(fromHex(publicKey))) + '88ac';
  const payer = normalizeSource({ ...fee, script: wallet });
  const build = feeSatoshis => {
    const transaction = { version: 2, locktime: 0, inputs: [
      { outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout, sequenceNumber: early ? 1 : contract.recoveryAge, unlockingBytecode: new Uint8Array() },
      { outpointTransactionHash: fromHex(payer.txid), outpointIndex: payer.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() }],
      outputs: [{ lockingBytecode: fromHex(wallet), valueSatoshis: BigInt(source.satoshis + payer.satoshis - feeSatoshis) }] };
    const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(source.satoshis) }, { lockingBytecode: fromHex(wallet), valueSatoshis: BigInt(payer.satoshis) }];
    const digest = (inputIndex, covered) => hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction }, { coveredBytecode: fromHex(covered), signingSerializationType: type }));
    transaction.inputs[0].unlockingBytecode = unlock(contract, secp256k1.signMessageHashSchnorr(fromHex(ownerPrivateKey), digest(0, contract.redeemScript)), 0);
    transaction.inputs[1].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([secp256k1.signMessageHashSchnorr(fromHex(ownerPrivateKey), digest(1, wallet)), type])), encodeDataPush(fromHex(publicKey))]));
    return { transaction, sourceOutputs, raw: encodeTransaction(transaction) };
  };
  const feeSatoshis = build(1000).raw.length + 2;
  if (source.satoshis + payer.satoshis - feeSatoshis < 546) throw new Error('The fee output is too small to return the reserve.');
  const { transaction, sourceOutputs, raw } = build(feeSatoshis);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The record reserve rejected the recovery: ' + verdict);
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis, bytes: raw.length, returnedSatoshis: source.satoshis + payer.satoshis - feeSatoshis, age: contract.recoveryAge };
}
