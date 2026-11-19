import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH, hashTransaction, secp256k1 } from '@bitauth/libauth';
import { fromHex, hash256, hex, normalizeSource, publicBytes, toAddress, walletFromPublicKey } from './primitives.mjs';
import { MATCHED_INPUTS, kingdomVault, thresholdCheck, thresholdPushes } from './kingdom-vault.mjs';

// Matched-stakes raid escrow (stake escrow, version 4).
//
// A paid raid is a contest for the same amount on both sides. The attacker locks the stake S here, with a network reserve.
// The defender's S is already in the defender's War Chest, whose script lets a capture leave only together with at least
// the same amount brought into the same transaction. The two contracts therefore settle an attacker victory ATOMICALLY:
// one transaction spends the defender's War Chest outputs and this escrow, pays the attacker 2 x S, and returns the rest
// of the chest to the chest. Either both sides of the victory happen or neither does.
//
// Every outcome lane is opened by the PANEL: a strict majority of the independent attestors, or, with a single attestor,
// the game key AND that attestor. The game key alone can choose nothing.
//   Lane 0, void: the raid did not take place as a paid contest. The stake and the unused reserve return to the attacker.
//   Lane 1, defender wins: the defender's wallet, fixed at funding, receives S. The unused reserve returns to the attacker.
//   Lane 3, attacker wins: output 0 pays the attacker exactly 2 x S, and output 1 pays the attacker the part of the reserve
//   this settlement did not need. The script allows a fee of `winBase` plus `winPerInput` for each War Chest output
//   spent, and nothing more. The lane has no rule about where the second S comes from: it can only be someone else's
//   money, and the only money the panel can move is the defender's War Chest, under that chest's own matched rule. Because
//   output 0 is exactly 2 x S, that rule lets exactly S leave the chest and not a satoshi more.
//   Lane 2, refund: after `refundAt` the attacker's key alone takes the escrow back, less at most `settleFee`.
// The fee of lanes 0 and 1 is exactly `settleFee`. The reserve is sized for the heaviest victory (three War Chest outputs);
// whatever a settlement does not use returns to the attacker in that same settlement.
export const RAID_ESCROW = 'stake-escrow-v4';
export const MATCHED_RAID = 'matched-raid-v1';
const type = Uint8Array.of(0x61);
const push = value => `<0x${value}>`;
const DUST = 546;
const DUST32 = 576;

export function raidEscrow({ id, ownerKey, opponent, principal, reserve, settleFee, winBase, winPerInput, refundAt, panel, version = 4 }) {
  if (version !== 4) throw new Error('These terms are not a matched raid escrow.');
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A raid escrow needs its 16-byte payment ID.');
  if (!Number.isInteger(principal) || principal < 1000 || principal > 10_000_000) throw new Error('The stake is out of range.');
  if (!Number.isInteger(settleFee) || settleFee < 400 || settleFee > 2000) throw new Error('The settlement fee is out of range.');
  if (!Number.isInteger(reserve) || reserve < settleFee || reserve > 6000) throw new Error('The network reserve is out of range.');
  // An attacker victory may cost `winBase` plus `winPerInput` for every War Chest output it spends, and not a satoshi more.
  if (!Number.isInteger(winBase) || !Number.isInteger(winPerInput) || winBase < 400 || winPerInput < 300 || winBase + (MATCHED_INPUTS - 1) * winPerInput + DUST > reserve) throw new Error('The victory fee terms do not fit the reserve.');
  if (!Number.isInteger(refundAt) || refundAt < 500_000_000 || refundAt >= 0xffffffff) throw new Error('A raid escrow needs an absolute refund time in seconds.');
  const owner = walletFromPublicKey(hex(publicBytes(ownerKey)));
  const keys = [...new Set((panel?.keys ?? []).map(item => hex(publicBytes(item))))].sort();
  const threshold = panel?.threshold;
  if (keys.length < 1 || keys.length > 3 || keys.length !== panel.keys.length) throw new Error('The outcome panel has one to three distinct keys.');
  if (!Number.isInteger(threshold) || threshold < Math.floor(keys.length / 2) + 1 || threshold > keys.length) throw new Error('The panel threshold must be a strict majority of its keys.');
  if (keys.some(item => item.slice(2) === owner.publicKey.slice(2))) throw new Error('The attacker cannot sit on the outcome panel.');
  if (!/^76a914[0-9a-f]{40}88ac$/.test(opponent ?? '') || opponent === owner.script) throw new Error('The defender is a different P2PKH wallet script.');
  // What the attacker gets back of the reserve when the heavier atomic settlement was not needed. Below the dust limit nothing can be returned.
  const unused = reserve - settleFee >= DUST ? reserve - settleFee : 0;
  const lone = (count, limit) => `OP_TXOUTPUTCOUNT <${count}> OP_GREATERTHAN OP_IF <${count}> OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF OP_TXOUTPUTCOUNT <${limit}> OP_LESSTHANOREQUAL`;
  const source = `${push(id.slice(0, 12))} OP_DROP ${push(owner.script)} OP_SWAP
    OP_DUP OP_2 OP_NUMEQUAL OP_IF
      OP_DROP <${refundAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP
      OP_INPUTINDEX OP_OUTPUTBYTECODE OP_EQUALVERIFY
      ${push(owner.publicKey)} OP_CHECKSIGVERIFY
      OP_INPUTINDEX OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <${settleFee}> OP_SUB OP_GREATERTHANOREQUAL
    OP_ELSE
      OP_TOALTSTACK OP_TOALTSTACK
      ${thresholdCheck(keys, threshold)}
      OP_FROMALTSTACK OP_FROMALTSTACK
      OP_DUP OP_3 OP_NUMEQUAL OP_IF
        OP_DROP OP_DUP OP_0 OP_OUTPUTBYTECODE OP_EQUALVERIFY
        OP_0 OP_OUTPUTVALUE <${2 * principal}> OP_NUMEQUALVERIFY
        OP_1 OP_OUTPUTBYTECODE OP_EQUALVERIFY
        OP_1 OP_OUTPUTVALUE <${reserve - winBase}> OP_TXINPUTCOUNT OP_1SUB <${winPerInput}> OP_MUL OP_SUB OP_GREATERTHANOREQUAL
      OP_ELSE
        OP_INPUTINDEX OP_0 OP_NUMEQUALVERIFY OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY
        OP_IF
          OP_0 OP_OUTPUTBYTECODE ${push(opponent)} OP_EQUALVERIFY OP_0 OP_OUTPUTVALUE <${principal}> OP_NUMEQUALVERIFY
          ${unused ? `OP_1 OP_OUTPUTBYTECODE OP_EQUALVERIFY OP_1 OP_OUTPUTVALUE <${unused}> OP_NUMEQUALVERIFY ${lone(2, 3)}` : `OP_DROP ${lone(1, 2)}`}
        OP_ELSE
          OP_0 OP_OUTPUTBYTECODE OP_EQUALVERIFY OP_0 OP_OUTPUTVALUE <${principal + reserve - settleFee}> OP_NUMEQUALVERIFY
          ${lone(1, 2)}
        OP_ENDIF
      OP_ENDIF
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  const inputBytes = 40 + 3 + 66 * threshold + (keys.length - threshold) + 1 + 3 + redeem.length / 1;
  // The largest transaction of lanes 0 and 1: both payments and a record of up to 48 bytes.
  const settleBytes = 10 + inputBytes + 34 + (unused ? 34 : 0) + 52;
  if (settleBytes > settleFee) throw new Error(`This panel needs ${settleBytes} bytes to settle and the settlement fee is ${settleFee} satoshis.`);
  return { version: 4, id, kind: 'matched-raid', ownerKey: owner.publicKey, ownerScript: owner.script, ownerAddress: owner.address, opponent, principal, reserve, settleFee, winBase, winPerInput, refundAt,
    panel: { keys, threshold }, unused, lanes: ['void', 'defender-wins', 'refund', 'attacker-wins'], satoshis: principal + reserve, inputBytes, settleBytes,
    script, address: toAddress(script), redeemScript: hex(redeem) };
}
export const raidEscrowTerms = ({ id, ownerKey, opponent, principal, reserve, settleFee, winBase, winPerInput, refundAt, panel }) => ({ version: 4, id, kind: 'matched-raid', ownerKey, opponent, principal, reserve, settleFee, winBase, winPerInput, refundAt, panel });

const input = source => ({ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() });
const digestOf = (transaction, sourceOutputs, inputIndex, redeemScript) => hex(hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction },
  { coveredBytecode: fromHex(redeemScript), signingSerializationType: type })));
function escrowOf(funding) {
  const contract = raidEscrow(funding.escrow);
  const source = normalizeSource(funding);
  if (source.script !== contract.script || source.token) throw new Error('The source is not this raid escrow output.');
  if (source.satoshis !== contract.satoshis) throw new Error('An incorrectly funded raid escrow returns to its owner by the timed refund only.');
  return { contract, source };
}
function finish(transaction, sourceOutputs, unchecked, least) {
  const raw = encodeTransaction(transaction);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The contract rejected the spend: ' + verdict);
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length) || (least !== undefined && least !== null && fee !== BigInt(least))) throw new Error('The fee does not match the reserve of this settlement.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee), bytes: raw.length };
}

// Lanes 0 and 1: the escrow alone. `lane` is 'void' or 'defender-wins'.
export function planRaidSpend(funding, { lane, eventScript } = {}) {
  const { contract, source } = escrowOf(funding);
  if (lane !== 'void' && lane !== 'defender-wins') throw new Error('Unknown settlement lane.');
  const outputs = [...(lane === 'void' ? [{ script: contract.ownerScript, satoshis: contract.principal + contract.reserve - contract.settleFee }] :
    [{ script: contract.opponent, satoshis: contract.principal }, ...(contract.unused ? [{ script: contract.ownerScript, satoshis: contract.unused }] : [])]),
    ...(eventScript ? [{ script: eventScript, satoshis: 0 }] : [])];
  const transaction = { version: 2, locktime: 0, inputs: [input(source)], outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(source.satoshis) }];
  return { contract, transaction, sourceOutputs, lane, selection: lane === 'void' ? 0 : 1, outputs, digest: digestOf(transaction, sourceOutputs, 0, contract.redeemScript),
    feeSatoshis: source.satoshis - outputs.reduce((sum, item) => sum + item.satoshis, 0) };
}
export const signRaidDigest = (digest, privateKey) => hex(secp256k1.signMessageHashSchnorr(fromHex(privateKey), fromHex(digest)));
export const validRaidSignature = (digest, publicKey, signature) => typeof signature === 'string' && /^[0-9a-f]{128}$/.test(signature) &&
  secp256k1.verifySignatureSchnorr(fromHex(signature), fromHex(publicKey), fromHex(digest)) === true;
const selector = value => Uint8Array.of(value === 0 ? 0x00 : 0x50 + value);
const escrowUnlock = (contract, lane, signatures) => Uint8Array.from(Buffer.concat([...thresholdPushes(contract.panel.keys, contract.panel.threshold, item => signatures?.[item]),
  selector(lane), encodeDataPush(fromHex(contract.redeemScript))]));
// `signatures` maps panel keys to their signature of `plan.digest`.
export function completeRaidSpend(plan, signatures, { unchecked = false } = {}) {
  const transaction = structuredClone(plan.transaction);
  transaction.inputs[0].unlockingBytecode = escrowUnlock(plan.contract, plan.selection, signatures);
  return finish(transaction, plan.sourceOutputs, unchecked);
}
// The attacker's own timed refund. It needs no game server and no attestor.
export function signRaidRefund(funding, ownerPrivateKey, { unchecked = false } = {}) {
  const contract = raidEscrow(funding.escrow);
  const source = normalizeSource(funding);
  if (source.script !== contract.script) throw new Error('The source is not this raid escrow output.');
  const transaction = { version: 2, locktime: contract.refundAt, inputs: [input(source)],
    outputs: [{ lockingBytecode: fromHex(contract.ownerScript), valueSatoshis: BigInt(source.satoshis - contract.settleFee) }] };
  const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(source.satoshis) }];
  const signature = secp256k1.signMessageHashSchnorr(fromHex(ownerPrivateKey), fromHex(digestOf(transaction, sourceOutputs, 0, contract.redeemScript)));
  transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([signature, type])), selector(2), encodeDataPush(fromHex(contract.redeemScript))]));
  return finish(transaction, sourceOutputs, unchecked);
}

// The bytes one War Chest output adds to an atomic settlement, and the bytes of everything else in it: the escrow input of
// `escrowBytes`, the payment, the remainder and a record of up to `record` bytes.
export const chestInputBytes = chest => 40 + 3 + 66 * (1 + chest.threshold) + (chest.attestors.length - chest.threshold) + 1 + 3 + chest.redeemScript.length / 2;
export const matchedBaseBytes = (escrowBytes, record = 52) => 10 + escrowBytes + 34 + 34 + 44 + record;

// The complete terms of a raid escrow against one defender's War Chest. Every fee in them is the measured size of the
// transaction it pays for, at one satoshi per byte: nothing is taken from a table.
//   settleFee: a void raid or a defender victory (the escrow alone, both payments, the record).
//   winPerInput: one War Chest output in the atomic settlement.  winBase: everything else in that settlement.
//   reserve: the heaviest settlement the contracts allow (`outputs` War Chest outputs, three by default).
export function raidTermsFor({ id, ownerKey, opponent, principal, refundAt, panel, chest, outputs = MATCHED_INPUTS - 1, record = 52 }) {
  const probe = raidEscrow({ id, ownerKey, opponent, principal, reserve: 5990, settleFee: 1990, winBase: 1990, winPerInput: 990, refundAt, panel });
  const settleFee = Math.ceil((10 + probe.inputBytes + 34 + 34 + record) / 10) * 10;
  const winPerInput = chestInputBytes(chest);
  const winBase = matchedBaseBytes(probe.inputBytes, record);
  // The reserve covers the heaviest victory and still leaves a spendable amount to hand back, so the refund output always exists.
  const reserve = Math.ceil((winBase + outputs * winPerInput + DUST) / 10) * 10;
  return raidEscrowTerms(raidEscrow({ id, ownerKey, opponent, principal, reserve, settleFee, winBase, winPerInput, refundAt, panel }));
}

// Lane 3: the attacker's victory. Spends up to three outputs of the defender's War Chest (or of its exit script) and the
// escrow; pays the attacker 2 x S as output 0 and the unused reserve as output 1, and returns what is left of the chest as output 2.
export function planMatchedCapture(chests, funding, { eventScript } = {}) {
  const { contract: escrow, source } = escrowOf(funding);
  if (!chests.length || chests.length >= MATCHED_INPUTS) throw new Error('A matched capture spends one to three War Chest outputs.');
  const contracts = chests.map(item => {
    const chest = kingdomVault(item.kv);
    const funded = normalizeSource(item);
    if (chest.revision !== 4 || funded.script !== chest.script || funded.token) throw new Error('The source is not a matched-stakes War Chest output.');
    return chest;
  });
  if (contracts.some(item => item.ownerScript !== escrow.opponent)) throw new Error('This War Chest does not belong to the defender named in the escrow.');
  const held = chests.reduce((sum, item) => sum + item.satoshis, 0);
  const remainder = held - escrow.principal;
  if (remainder < 0 || (remainder > 0 && remainder < DUST32)) throw new Error('These War Chest outputs do not cover the stake, or would leave an unspendable remainder.');
  // The remainder returns to the script of the LAST output given, so outputs of the exit script and of the live chest can be spent together.
  const home = contracts.at(-1);
  if (remainder > chests.at(-1).satoshis) throw new Error('More War Chest outputs are offered than the stake needs.');
  const fee = escrow.winBase + chests.length * escrow.winPerInput;
  // Output 0: both stakes. Output 1: the reserve this settlement did not use. Output 2: what is left of the War Chest.
  const outputs = [{ script: escrow.ownerScript, satoshis: 2 * escrow.principal }, { script: escrow.ownerScript, satoshis: escrow.reserve - fee },
    ...(remainder ? [{ script: home.script, satoshis: remainder }] : []), ...(eventScript ? [{ script: eventScript, satoshis: 0 }] : [])];
  const transaction = { version: 2, locktime: 0, inputs: [...chests.map(item => input(normalizeSource(item))), input(source)],
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = [...chests.map((item, index) => ({ lockingBytecode: fromHex(contracts[index].script), valueSatoshis: BigInt(item.satoshis) })),
    { lockingBytecode: fromHex(escrow.script), valueSatoshis: BigInt(source.satoshis) }];
  // One digest per input, the escrow last. An attestor signs every one of them.
  const digests = [...contracts.map((chest, index) => digestOf(transaction, sourceOutputs, index, chest.redeemScript)), digestOf(transaction, sourceOutputs, chests.length, escrow.redeemScript)];
  return { escrow, contracts, chests, transaction, sourceOutputs, outputs, digests, remainder, feeSatoshis: fee, paid: outputs[0].satoshis + outputs[1].satoshis,
    change: remainder ? { script: home.script, address: home.address, redeemScript: home.redeemScript, vout: 2, satoshis: remainder, kv: chests.at(-1).kv } : undefined };
}
export const signMatchedDigests = (plan, privateKey) => plan.digests.map(digest => signRaidDigest(digest, privateKey));
export const validMatchedSignatures = (plan, publicKey, signatures) => Array.isArray(signatures) && signatures.length === plan.digests.length &&
  plan.digests.every((digest, index) => validRaidSignature(digest, publicKey, signatures[index]));
// `attestations` maps each attestor key to its signatures (one per input). The game key signs the chest inputs, and the escrow too when it sits on the panel.
export function completeMatchedCapture(plan, operatorPrivateKey, attestations, { unchecked = false } = {}) {
  const transaction = structuredClone(plan.transaction);
  const mine = signMatchedDigests(plan, operatorPrivateKey);
  const last = plan.chests.length;
  plan.contracts.forEach((chest, index) => {
    transaction.inputs[index].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([fromHex(mine[index]), type])),
      ...thresholdPushes(chest.attestors, chest.threshold, item => attestations?.[item]?.[index]), selector(2), encodeDataPush(fromHex(chest.redeemScript))]));
  });
  const operator = plan.contracts[0].operatorKey;
  transaction.inputs[last].unlockingBytecode = escrowUnlock(plan.escrow, 3, Object.fromEntries(plan.escrow.panel.keys.map(item =>
    [item, item === operator ? mine[last] : attestations?.[item]?.[last]])));
  return finish(transaction, plan.sourceOutputs, unchecked, plan.feeSatoshis);
}

// Recomputes the digests of a plan whose transaction was changed. The negative tests use it to sign a WRONG transaction
// correctly, so that a refusal is the contract's own rule and not merely a broken signature.
export function redigest(plan) {
  if (plan.contracts) {
    plan.digests = [...plan.contracts.map((chest, index) => digestOf(plan.transaction, plan.sourceOutputs, index, chest.redeemScript)),
      digestOf(plan.transaction, plan.sourceOutputs, plan.chests.length, plan.escrow.redeemScript)];
    plan.feeSatoshis = undefined;
  } else plan.digest = digestOf(plan.transaction, plan.sourceOutputs, 0, plan.contract.redeemScript);
  return plan;
}
