import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH, hashTransaction, secp256k1 } from '@bitauth/libauth';
import { fromHex, hash256, hex, normalizeSource, publicBytes, toAddress, walletFromPublicKey } from './primitives.mjs';
import { thresholdCheck, thresholdPushes } from './kingdom-vault.mjs';

// Stake escrow, version 3. The stake of a paid raid or a territory contest, with its settlement reserve.
//
// The outcome lanes are opened by the PANEL, not by the game key alone. The panel is the independent attestors (a strict
// majority must sign); with a single attestor it is the game key AND that attestor, both required. A server whose key is
// stolen can therefore not choose a financial outcome: at most it can propose one and wait for signatures it will not get.
//   Lane 0, return: the whole stake goes back to its owner's wallet.
//   Lane 1, split: `keep` stays with the owner and the rest goes to the opponent's wallet fixed at funding (a raid or a
//   territory attack), or to one wallet named in the signed transaction (an open territory claim).
//   Lane 2, refund: after `refundAt` the owner's key alone returns the stake to the owner's wallet, less the reserve.
// Every output amount is fixed, so the network fee of an outcome is exactly the reserve; the script is written to fit a
// 600-satoshi reserve with two signatures of a three-key panel. One zero-value record output may follow the payments.
export const STAKE_ESCROW_3 = 'stake-escrow-v3';
const type = Uint8Array.of(0x61);
const push = value => `<0x${value}>`;
const kinds = { 'battle-escrow': 'opponent-wins', 'territory-escrow': 'opponent-wins', 'territory-claim': 'forfeit' };

export function stakeEscrow({ id, kind, ownerKey, opponent, principal, reserve, refundAt, panel, version = 3 }) {
  if (version !== 3) throw new Error('These terms are not a version 3 stake escrow.');
  if (!Object.hasOwn(kinds, kind)) throw new Error('Unknown stake escrow kind.');
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A stake escrow needs its 16-byte payment ID.');
  if (!Number.isInteger(principal) || principal < 1200 || principal > 10_000_000) throw new Error('The stake is out of range.');
  if (!Number.isInteger(reserve) || reserve < 400 || reserve > 4000) throw new Error('The settlement reserve is out of range.');
  if (!Number.isInteger(refundAt) || refundAt < 500_000_000 || refundAt >= 0xffffffff) throw new Error('A stake escrow needs an absolute refund time in seconds.');
  const owner = walletFromPublicKey(hex(publicBytes(ownerKey)));
  const keys = [...new Set((panel?.keys ?? []).map(item => hex(publicBytes(item))))].sort();
  const threshold = panel?.threshold;
  if (keys.length < 1 || keys.length > 3 || keys.length !== panel.keys.length) throw new Error('The outcome panel has one to three distinct keys.');
  if (!Number.isInteger(threshold) || threshold < Math.floor(keys.length / 2) + 1 || threshold > keys.length) throw new Error('The panel threshold must be a strict majority of its keys.');
  if (keys.some(item => item.slice(2) === owner.publicKey.slice(2))) throw new Error('The stake owner cannot sit on the outcome panel.');
  const fixed = kind !== 'territory-claim';
  const rival = fixed ? opponent : null;
  if (fixed && (!/^76a914[0-9a-f]{40}88ac$/.test(rival ?? '') || rival === owner.script)) throw new Error('The opponent is a different P2PKH wallet script.');
  const keep = principal - Math.floor(principal / 2);
  const lone = (count, limit) => `OP_TXOUTPUTCOUNT <${count}> OP_GREATERTHAN OP_IF <${count}> OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF OP_TXOUTPUTCOUNT <${limit}> OP_LESSTHANOREQUAL`;
  const source = `${push(id.slice(0, 12))} OP_DROP ${push(owner.script)}
    OP_OVER OP_2 OP_NUMEQUAL OP_IF
      OP_NIP <${refundAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP
      OP_INPUTINDEX OP_OUTPUTBYTECODE OP_EQUALVERIFY
      ${push(owner.publicKey)} OP_CHECKSIGVERIFY
      OP_INPUTINDEX OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <${reserve}> OP_SUB OP_GREATERTHANOREQUAL
    OP_ELSE
      OP_0 OP_OUTPUTBYTECODE OP_EQUALVERIFY OP_TOALTSTACK
      ${thresholdCheck(keys, threshold)}
      OP_INPUTINDEX OP_0 OP_NUMEQUALVERIFY
      OP_FROMALTSTACK OP_IF
        OP_0 OP_OUTPUTVALUE <${keep}> OP_NUMEQUALVERIFY OP_1 OP_OUTPUTVALUE <${principal - keep}> OP_NUMEQUALVERIFY
        ${fixed ? `OP_1 OP_OUTPUTBYTECODE ${push(rival)} OP_EQUALVERIFY` : ''}
        ${lone(2, 3)}
      OP_ELSE
        OP_0 OP_OUTPUTVALUE <${principal}> OP_NUMEQUALVERIFY
        ${lone(1, 2)}
      OP_ENDIF
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  // The largest outcome spend: `threshold` signatures, an empty item for every other key, two payments and the record.
  const maxBytes = 10 + 40 + 3 + 66 * threshold + (keys.length - threshold) + 1 + 3 + redeem.length + 34 + 34 + 48;
  if (maxBytes > reserve) throw new Error(`This panel needs ${maxBytes} bytes to settle and the reserve is ${reserve} satoshis.`);
  return { version: 3, id, kind, ownerKey: owner.publicKey, ownerScript: owner.script, ownerAddress: owner.address, opponent: rival, principal, reserve, refundAt,
    panel: { keys, threshold }, keep, lanes: ['return', kinds[kind]], satoshis: principal + reserve, maxBytes, script, address: toAddress(script), redeemScript: hex(redeem) };
}
export const stakeTerms = ({ id, kind, ownerKey, opponent, principal, reserve, refundAt, panel }) => ({ version: 3, id, kind, ownerKey, ...(opponent && { opponent }), principal, reserve, refundAt, panel });

// Builds the unsigned outcome. `payee` (a locking script) is needed only for the open half of a territory claim.
export function planStakeSpend(funding, { lane, payee, eventScript } = {}) {
  const contract = stakeEscrow(funding.escrow);
  const source = normalizeSource(funding);
  if (source.script !== contract.script || source.token) throw new Error('The source is not this stake escrow output.');
  if (source.satoshis !== contract.satoshis) throw new Error('An incorrectly funded stake escrow returns to its owner by the timed refund only.');
  const selection = contract.lanes.indexOf(lane);
  if (selection < 0) throw new Error('Unknown settlement lane.');
  const second = selection === 1 ? contract.opponent ?? payee : null;
  if (selection === 1 && (!/^[0-9a-f]{46,70}$/.test(second ?? '') || second === contract.ownerScript)) throw new Error('The split lane pays a second wallet.');
  const outputs = [...(selection === 1 ? [{ script: contract.ownerScript, satoshis: contract.keep }, { script: second, satoshis: contract.principal - contract.keep }] :
    [{ script: contract.ownerScript, satoshis: contract.principal }]), ...(eventScript ? [{ script: eventScript, satoshis: 0 }] : [])];
  const transaction = { version: 2, locktime: 0, inputs: [{ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() }],
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(source.satoshis) }];
  const digest = hex(hash256(generateSigningSerializationBCH({ inputIndex: 0, sourceOutputs, transaction }, { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: type })));
  return { contract, transaction, sourceOutputs, lane, selection, outputs, digest };
}
export const signStakeDigest = (plan, privateKey) => hex(secp256k1.signMessageHashSchnorr(fromHex(privateKey), fromHex(plan.digest)));
export const validStakeSignature = (plan, publicKey, signature) => typeof signature === 'string' && /^[0-9a-f]{128}$/.test(signature) &&
  secp256k1.verifySignatureSchnorr(fromHex(signature), fromHex(publicKey), fromHex(plan.digest)) === true;

function finish(transaction, sourceOutputs, unchecked) {
  const raw = encodeTransaction(transaction);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The stake escrow rejected the spend: ' + verdict);
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error('The fee does not cover one satoshi per serialized byte.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
}
// `signatures` maps panel keys to their signatures of `plan.digest`.
export function completeStakeSpend(plan, signatures, { unchecked = false } = {}) {
  const transaction = structuredClone(plan.transaction);
  const { keys, threshold } = plan.contract.panel;
  transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([...thresholdPushes(keys, threshold, item => signatures?.[item]),
    Uint8Array.of(plan.selection === 1 ? 0x51 : 0x00), encodeDataPush(fromHex(plan.contract.redeemScript))]));
  return finish(transaction, plan.sourceOutputs, unchecked);
}
// The owner's own timed refund. It needs no game server.
export function signStakeRefund(funding, ownerPrivateKey, { unchecked = false } = {}) {
  const contract = stakeEscrow(funding.escrow);
  const source = normalizeSource(funding);
  if (source.script !== contract.script) throw new Error('The source is not this stake escrow output.');
  const transaction = { version: 2, locktime: contract.refundAt, inputs: [{ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: fromHex(contract.ownerScript), valueSatoshis: BigInt(source.satoshis - contract.reserve) }] };
  const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(source.satoshis) }];
  const digest = hash256(generateSigningSerializationBCH({ inputIndex: 0, sourceOutputs, transaction }, { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: type }));
  const signature = secp256k1.signMessageHashSchnorr(fromHex(ownerPrivateKey), digest);
  transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([signature, type])), Uint8Array.of(0x52), encodeDataPush(fromHex(contract.redeemScript))]));
  return finish(transaction, sourceOutputs, unchecked);
}
