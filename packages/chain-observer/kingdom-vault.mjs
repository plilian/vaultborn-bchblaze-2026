import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH,
  hashTransaction, secp256k1 } from '@bitauth/libauth';
import { fromHex, hash256, hex, normalizeSource, publicBytes, toAddress, walletFromPublicKey } from './primitives.mjs';

// Kingdom Treasury custody. Every satoshi credited to a kingdom is locked to its owner's own script.
//
// Kingdom vault (safe funds)
//   Lane 1, payout: the game key signs, and the whole input must go to the owner's wallet at its own output index, less
//   at most `maxFee`. There is no change and no re-issue, so the game key can spend an output exactly once, to its owner.
//   Lane 0, recovery: after `recoverAt` the owner's key alone spends the output.
// War chest (funds the owner's wallet chose to put at risk)
//   Lane 1, release: as the payout lane, but the last input may leave change in this same script, and the input must
//   be `captureAge` blocks old. A chest output can therefore be re-issued at most once per `captureAge` blocks.
//   Lane 2, capture: needs the game key AND every independent battle attestor. At most `capturePercent` of an input per
//   spend, the rest returns to this same script, and the input must be `captureAge` blocks old. The game server cannot
//   capture alone, whatever battle result it reports.
//   Lane 0, recovery: after `recoverAt` the owner's key alone spends the output.
export const KINGDOM_VAULT = 'kingdom-vault-v2';
export const WAR_CHEST = 'war-chest-v2';
// Revision 3 of the war chest (one script per owner, so its outputs can be consolidated):
//   Capture needs the game key AND `threshold` of the independent attestors (a strict majority), not every one of them.
//   Lane 0 is a two-step exit instead of a dated recovery. Step one, at any time and with the owner's key alone, moves an
//   output into the exit script, less at most `maxFee`. The exit script keeps the same capture lane and lets the owner's
//   key spend only when the output is `exitDelay` blocks old. `exitDelay` is longer than `captureAge`, so a capture that
//   was owed before the exit began always has blocks `captureAge`..`exitDelay` to confirm before the owner can leave.
export const WAR_CHEST_3 = 'war-chest-v3';
export const majority = count => Math.floor(count / 2) + 1;
// A revision 3 capture spends up to this many outputs of one chest and returns ONE remainder: at least 80% of everything
// the transaction spends goes back to the same script as output 0. A capture therefore also consolidates the chest.
export const CAPTURE_INPUTS = 4;
// `needed` of the listed keys must have signed. The spender pushes one item per key, last key first: a signature, or
// an empty item for a key that did not sign. BCH requires a failing signature check to be given an empty signature, so
// nothing but real signatures can count.
export const thresholdCheck = (keys, needed) => keys.map((item, index) => `${index ? 'OP_SWAP ' : ''}<0x${item}> OP_CHECKSIG${index ? ' OP_ADD' : ''}`).join(' ') +
  ` <${needed}> OP_GREATERTHANOREQUAL OP_VERIFY`;
// The items a spender pushes for `thresholdCheck`, from a map of key to signature.
export const thresholdPushes = (keys, needed, signatureOf, type = 0x61) => {
  let used = 0;
  const items = keys.map(item => { const signature = used < needed ? signatureOf(item) : undefined; if (signature) used += 1; return signature; });
  if (used < needed) throw new Error('An attestor signature is missing.');
  return items.toReversed().map(signature => signature ? encodeDataPush(Buffer.concat([fromHex(signature), Uint8Array.of(type)])) : Uint8Array.of(0x00));
};
const DUST32 = 576;
const type = Uint8Array.of(0x61);
const push = value => `<0x${value}>`;

export function kingdomVault(terms) {
  return terms?.revision === 4 ? warChest4(terms) : earlierVault(terms);
}
function earlierVault({ id, operatorKey, ownerKey, recoverAt, maxFee = 700, capturePercent = 0, captureAge = 144, attestors = [], revision,
  threshold, exitDelay = 288, exiting = false }) {
  if (revision !== 2 && revision !== 3) throw new Error('These kingdom vault terms come from an earlier build and cannot be rebuilt.');
  const third = revision === 3;
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A kingdom vault needs its 16-byte ID.');
  if (!third && (!Number.isInteger(recoverAt) || recoverAt < 500_000_000 || recoverAt >= 0xffffffff)) throw new Error('A kingdom vault needs an absolute recovery time in seconds.');
  if (third && !(capturePercent > 0)) throw new Error('Revision 3 is a war chest.');
  if (!Number.isInteger(maxFee) || maxFee < 350 || maxFee > 2000) throw new Error('Choose a fee cap from 350 to 2,000 satoshis per input.');
  if (!Number.isInteger(capturePercent) || capturePercent < 0 || capturePercent > 50) throw new Error('A war chest can expose at most 50% per capture.');
  if (!Number.isInteger(captureAge) || captureAge < 1 || captureAge > 65_535) throw new Error('The capture age is a number of blocks from 1 to 65,535.');
  const operator = hex(publicBytes(operatorKey));
  const owner = walletFromPublicKey(hex(publicBytes(ownerKey)));
  if (operator.slice(2) === owner.publicKey.slice(2)) throw new Error('The game key and the owner must have different keys.');
  const chest = capturePercent > 0;
  const independent = attestors.map(item => hex(publicBytes(item))).sort();
  if (chest && (independent.length < 1 || independent.length > 3)) throw new Error('A war chest needs one to three independent battle attestor keys.');
  const needed = third ? threshold ?? majority(independent.length) : independent.length;
  if (third && (!Number.isInteger(needed) || needed < majority(independent.length) || needed > independent.length)) throw new Error('The attestor threshold must be a strict majority of the attestors.');
  if (third && (!Number.isInteger(exitDelay) || exitDelay <= captureAge || exitDelay > 65_535)) throw new Error('The exit delay must be longer than the capture age.');
  if (!chest && independent.length) throw new Error('A kingdom vault has no capture lane and takes no attestors.');
  if (new Set([operator, owner.publicKey, ...independent].map(item => item.slice(2))).size !== independent.length + 2) {
    throw new Error('The game key, the owner and every attestor must have different keys.');
  }
  const capture = chest ? `OP_2 OP_NUMEQUAL OP_IF
      ${third ? thresholdCheck(independent, needed) : independent.map(item => `${push(item)} OP_CHECKSIGVERIFY`).join(' ')}
      ${push(operator)} OP_CHECKSIGVERIFY
      <${captureAge}> OP_CHECKSEQUENCEVERIFY OP_DROP
      ${third ? `OP_TXINPUTCOUNT <${CAPTURE_INPUTS}> OP_LESSTHANOREQUAL OP_VERIFY
      OP_0 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_0 OP_OUTPUTVALUE <100> OP_MUL
      OP_0 OP_UTXOVALUE ${Array.from({ length: CAPTURE_INPUTS - 1 }, (_, index) => `OP_TXINPUTCOUNT <${index + 1}> OP_GREATERTHAN OP_IF <${index + 1}> OP_UTXOVALUE OP_ADD OP_ENDIF`).join(' ')}
      <${100 - capturePercent}> OP_MUL OP_GREATERTHANOREQUAL` : `OP_INPUTINDEX OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTVALUE <100> OP_MUL OP_INPUTINDEX OP_UTXOVALUE <${100 - capturePercent}> OP_MUL OP_GREATERTHANOREQUAL`}
    OP_ELSE` : 'OP_0 OP_NUMEQUALVERIFY';
  const assisted = chest ? `<${captureAge}> OP_CHECKSEQUENCEVERIFY OP_DROP
      OP_INPUTINDEX OP_OUTPUTBYTECODE OP_DUP ${push(owner.script)} OP_EQUAL OP_SWAP OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUAL
      OP_INPUTINDEX OP_TXINPUTCOUNT OP_1SUB OP_NUMEQUAL OP_BOOLAND OP_BOOLOR OP_VERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_2 OP_ADD OP_LESSTHANOREQUAL OP_VERIFY
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_1ADD OP_GREATERTHAN OP_IF OP_TXINPUTCOUNT OP_1ADD OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF
      OP_INPUTINDEX OP_OUTPUTVALUE
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_GREATERTHAN OP_IF
        OP_TXINPUTCOUNT OP_OUTPUTBYTECODE ${push(owner.script)} OP_EQUAL OP_IF
          OP_TXINPUTCOUNT OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
          OP_INPUTINDEX OP_TXINPUTCOUNT OP_1SUB OP_NUMEQUAL OP_IF OP_TXINPUTCOUNT OP_OUTPUTVALUE OP_ADD OP_ENDIF
        OP_ELSE
          OP_TXINPUTCOUNT OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY
        OP_ENDIF
      OP_ENDIF` : `OP_INPUTINDEX OP_OUTPUTBYTECODE ${push(owner.script)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_1ADD OP_LESSTHANOREQUAL OP_VERIFY
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_GREATERTHAN OP_IF OP_TXINPUTCOUNT OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF
      OP_INPUTINDEX OP_OUTPUTVALUE`;
  // The exit script is this same contract with `exiting` set. The live script names it, so step one can go nowhere else.
  const exit = third && !exiting ? earlierVault({ id, operatorKey, ownerKey, maxFee, capturePercent, captureAge, attestors, revision, threshold: needed, exitDelay, exiting: true }) : null;
  const leave = !third ? `<${recoverAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP ${push(owner.publicKey)} OP_CHECKSIG` :
    exiting ? `<${exitDelay}> OP_CHECKSEQUENCEVERIFY OP_DROP ${push(owner.publicKey)} OP_CHECKSIG` :
      `${push(owner.publicKey)} OP_CHECKSIGVERIFY
      OP_INPUTINDEX OP_OUTPUTBYTECODE ${push(exit.script)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <${maxFee}> OP_SUB OP_GREATERTHANOREQUAL`;
  // A revision 3 chest carries no ID: its owner's key already makes the script unique, and one script per owner is what lets outputs be consolidated.
  const source = `${third ? '' : push((chest ? '5642574332' : '56424b5632') + id) + ' OP_DROP'}
    OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_DUP OP_1 OP_NUMEQUAL OP_IF
      OP_DROP ${push(operator)} OP_CHECKSIGVERIFY
      ${assisted}
      OP_INPUTINDEX OP_UTXOVALUE <${maxFee}> OP_SUB OP_GREATERTHANOREQUAL
    OP_ELSE
      ${capture}
      ${leave}
    ${chest ? 'OP_ENDIF' : ''} OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  if (redeem.length > 520) throw new Error('The kingdom vault script is too large.');
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  if (third) return { id, version: WAR_CHEST_3, operatorKey: operator, ownerKey: owner.publicKey, ownerAddress: owner.address, ownerScript: owner.script,
    maxFee, capturePercent, captureAge, attestors: independent, threshold: needed, exitDelay, exiting, revision: 3, script, address: toAddress(script), redeemScript: hex(redeem),
    ...(exit && { exitScript: exit.script, exitAddress: exit.address }) };
  return { id, version: chest ? WAR_CHEST : KINGDOM_VAULT, operatorKey: operator, ownerKey: owner.publicKey, ownerAddress: owner.address, ownerScript: owner.script,
    recoverAt, maxFee, capturePercent, captureAge, attestors: independent, revision: 2, script, address: toAddress(script), redeemScript: hex(redeem) };
}

// Revision 4 of the war chest: matched stakes.
//
// One script per owner, as in revision 3, and the same two-step exit. What changed is the capture rule. A capture no longer
// takes a percentage and no longer pays its own fee. Instead the script measures what LEAVES the chest in a transaction
// (the value of its inputs at positions 0 to 3 that carry this script, less a remainder returned to this script as
// output 2) and demands that output 0 pays at least TWICE that amount. Value is conserved, so whoever receives a capture
// must have brought at least the same amount into the same transaction: the attacker's own stake, spent from its escrow
// together with the chest. The network fee comes from that escrow's reserve, so the chest loses exactly the stake.
//   Lane 1, release: the game key pays the owner's wallet as output 0; a remainder may return to this script as output 1.
//   At most `maxFee` is lost to the network fee, and the input must be `releaseAge` blocks old, so the game key can
//   re-issue an output at most once per `releaseAge` blocks and never to anyone but its owner.
//   Lane 2, capture: the game key AND `threshold` of the independent attestors, under the matched rule above.
//   Lane 0, exit: with the owner's key alone, at any time, into the exit script as output 0. The WHOLE value of the
//   inputs must arrive there: the fee is paid by another input of the owner's, and an exit can neither shrink nor split
//   a chest. A raid that was funded against this chest therefore still finds its full amount, in at most as many outputs
//   as before. The exit script is this same contract with `exiting` set: it keeps lanes 1 and 2 and lets the owner's key
//   spend freely once the output is `exitDelay` blocks old.
// The matched rule binds honest settlement to the attacker's stake and makes a capture impossible to build as a plain
// payment. It is not a defence against the game key and an attestor majority acting together: they could match a capture
// with money of their own. Nothing short of the owner's signature could prevent that, and a defender is not online to sign.
export const WAR_CHEST_4 = 'war-chest-v4';
export const MATCHED_INPUTS = 4;
// Every revision 4 War Chest output is a multiple of this amount, and so is every stake.
export const CHEST_GRID = 1000;
function warChest4({ operatorKey, ownerKey, maxFee = 2000, attestors = [], threshold, exitDelay = 288, exiting = false, releaseAge = 144 }) {
  if (!Number.isInteger(maxFee) || maxFee < 600 || maxFee > 3000) throw new Error('Choose a fee cap from 600 to 3,000 satoshis per transaction.');
  if (!Number.isInteger(releaseAge) || releaseAge < 1 || releaseAge > 65_535) throw new Error('The release age is a number of blocks from 1 to 65,535.');
  if (!Number.isInteger(exitDelay) || exitDelay < 36 || exitDelay > 65_535) throw new Error('The exit delay is a number of blocks from 36 to 65,535.');
  const operator = hex(publicBytes(operatorKey));
  const owner = walletFromPublicKey(hex(publicBytes(ownerKey)));
  const independent = attestors.map(item => hex(publicBytes(item))).sort();
  if (independent.length < 1 || independent.length > 3) throw new Error('A war chest needs one to three independent battle attestor keys.');
  const needed = threshold ?? majority(independent.length);
  if (!Number.isInteger(needed) || needed < majority(independent.length) || needed > independent.length) throw new Error('The attestor threshold must be a strict majority of the attestors.');
  if (new Set([operator, owner.publicKey, ...independent].map(item => item.slice(2))).size !== independent.length + 2) {
    throw new Error('The game key, the owner and every attestor must have different keys.');
  }
  const exit = exiting ? null : warChest4({ operatorKey, ownerKey, maxFee, attestors, threshold: needed, exitDelay, exiting: true, releaseAge });
  // HELD, the value of this script's inputs at positions 0..3, goes to the alternate stack with the script itself.
  const measure = `OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_INPUTINDEX <${MATCHED_INPUTS}> OP_LESSTHAN OP_VERIFY
    OP_INPUTINDEX OP_UTXOBYTECODE OP_0
    ${Array.from({ length: MATCHED_INPUTS }, (_, index) => `OP_TXINPUTCOUNT <${index}> OP_GREATERTHAN OP_IF <${index}> OP_UTXOBYTECODE OP_2 OP_PICK OP_EQUAL OP_IF <${index}> OP_UTXOVALUE OP_ADD OP_ENDIF OP_ENDIF`).join('\n    ')}
    OP_TOALTSTACK OP_TOALTSTACK`;
  // LEAVING: HELD less output `position` when that output returns to this script. A release keeps its remainder at
  // position 1; a capture at position 2, after the two payments to the winner.
  const leaving = position => `OP_FROMALTSTACK OP_TXOUTPUTCOUNT <${position}> OP_GREATERTHAN OP_IF
      <${position}> OP_OUTPUTBYTECODE OP_EQUAL OP_IF <${position}> OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY <${position}> OP_OUTPUTVALUE OP_ELSE OP_0 OP_ENDIF
    OP_ELSE OP_DROP OP_0 OP_ENDIF
    OP_FROMALTSTACK OP_SWAP OP_SUB`;
  const leave = exiting ? `<${exitDelay}> OP_CHECKSEQUENCEVERIFY OP_DROP ${push(owner.publicKey)} OP_CHECKSIG` :
    `${push(owner.publicKey)} OP_CHECKSIGVERIFY
      OP_0 OP_OUTPUTBYTECODE ${push(exit.script)} OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_0 OP_OUTPUTVALUE OP_FROMALTSTACK OP_DROP OP_FROMALTSTACK OP_GREATERTHANOREQUAL`;
  const source = `${measure}
    OP_DUP OP_1 OP_NUMEQUAL OP_IF
      OP_DROP ${push(operator)} OP_CHECKSIGVERIFY
      <${releaseAge}> OP_CHECKSEQUENCEVERIFY OP_DROP
      OP_0 OP_OUTPUTBYTECODE ${push(owner.script)} OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_0 OP_OUTPUTVALUE <${maxFee}> OP_ADD ${leaving(1)} OP_GREATERTHANOREQUAL
    OP_ELSE
      OP_2 OP_NUMEQUAL OP_IF
        ${thresholdCheck(independent, needed)}
        ${push(operator)} OP_CHECKSIGVERIFY
        OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
        OP_0 OP_OUTPUTVALUE ${leaving(2)} OP_2 OP_MUL OP_GREATERTHANOREQUAL
      OP_ELSE
        ${leave}
      OP_ENDIF
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  if (redeem.length > 520) throw new Error('The war chest script is too large.');
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { version: WAR_CHEST_4, operatorKey: operator, ownerKey: owner.publicKey, ownerAddress: owner.address, ownerScript: owner.script,
    maxFee, capturePercent: 100, releaseAge, captureAge: 0, attestors: independent, threshold: needed, exitDelay, exiting, revision: 4, script, address: toAddress(script), redeemScript: hex(redeem),
    ...(exit && { exitScript: exit.script, exitAddress: exit.address }) };
}

// The stored terms of a source are the constructor arguments, so its script can always be rebuilt from public data.
export const vaultTerms = ({ id, operatorKey, ownerKey, recoverAt, maxFee, capturePercent, captureAge, attestors, revision, threshold, exitDelay, exiting, releaseAge }) => revision === 4 ?
  { operatorKey, ownerKey, maxFee, capturePercent: 100, attestors, threshold, exitDelay, exiting, releaseAge, revision: 4 } : revision === 3 ?
  { id, operatorKey, ownerKey, maxFee, capturePercent, captureAge, attestors, threshold, exitDelay, exiting, revision: 3 } :
  { id, operatorKey, ownerKey, recoverAt, maxFee, capturePercent, captureAge, attestors, revision: 2 };
// How many attestor signatures a capture of this output carries.
export const quorumOf = terms => terms.revision >= 3 ? terms.threshold : terms.attestors.length;
const contractOf = source => {
  const contract = kingdomVault(source.kv);
  const funding = normalizeSource(source);
  if (funding.script !== contract.script || funding.token) throw new Error('The source is not this kingdom vault output.');
  return contract;
};
const inputBytes = (contract, signatures = 1) => 40 + 3 + 66 * signatures + 1 + 3 + contract.redeemScript.length / 2;
const outputBytes = outputs => outputs.reduce((total, item) => total + 9 + item.script.length / 2, 0);

function build(sources, contracts, outputs, { locktime = 0, sequence = 0xfffffffe } = {}) {
  const transaction = { version: 2, locktime, inputs: sources.map((source, index) => ({ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout,
    sequenceNumber: typeof sequence === 'function' ? sequence(contracts[index]) : sequence, unlockingBytecode: new Uint8Array() })),
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = sources.map((source, index) => ({ lockingBytecode: fromHex(contracts[index].script), valueSatoshis: BigInt(source.satoshis) }));
  return { transaction, sourceOutputs };
}

function sign({ transaction, sourceOutputs }, contracts, privateKey, selector, { unchecked = false, wallet = null } = {}) {
  if (wallet) {
    // An ordinary wallet input of the same key: it pays the network fee of a revision 4 exit.
    const digest = hash256(generateSigningSerializationBCH({ inputIndex: wallet.index, sourceOutputs, transaction }, { coveredBytecode: fromHex(wallet.script), signingSerializationType: type }));
    const signature = secp256k1.signMessageHashSchnorr(fromHex(privateKey), digest);
    transaction.inputs[wallet.index].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([signature, type])), encodeDataPush(fromHex(wallet.publicKey))]));
  }
  contracts.forEach((contract, inputIndex) => {
    const digest = hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction },
      { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: type }));
    const signature = secp256k1.signMessageHashSchnorr(fromHex(privateKey), digest);
    if (typeof signature === 'string') throw new Error('Could not sign the kingdom vault spend.');
    transaction.inputs[inputIndex].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([signature, type])),
      Uint8Array.of(selector === 0 ? 0x00 : 0x50 + selector), encodeDataPush(fromHex(contract.redeemScript))]));
  });
  const raw = encodeTransaction(transaction);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The kingdom vault rejected the spend: ' + verdict);
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error('The fee does not cover one satoshi per serialized byte.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
}

// Pays an owner from that owner's outputs. Kingdom vault outputs are paid out whole. Only a war chest output, placed
// last, can leave change, so `satoshis` is met exactly when a chest output is included and rounded up to whole vault
// outputs otherwise. Undefined `satoshis` pays everything.
export function planKingdomWithdrawal(offered, { satoshis, leaving, eventScript } = {}) {
  if (offered[0]?.kv?.revision === 4) return planChestRelease(offered, { satoshis, leaving, eventScript });
  if (!offered.length || offered.length > 24) throw new Error('A withdrawal spends 1 to 24 kingdom vault outputs.');
  const chestLast = (a, b) => Boolean(a.kv.capturePercent) - Boolean(b.kv.capturePercent) || a.satoshis - b.satoshis || (a.txid + a.vout < b.txid + b.vout ? -1 : 1);
  const sources = offered.toSorted(chestLast);
  const contracts = sources.map(contractOf);
  const owner = contracts[0];
  if (contracts.some(item => item.ownerScript !== owner.ownerScript)) throw new Error('One withdrawal pays one owner.');
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  const count = sources.length;
  const size = 10 + contracts.reduce((total, item) => total + inputBytes(item), 0) + count * 34 + 44 + outputBytes(record);
  const each = Math.ceil((size + 2) / count);
  if (each > Math.min(...contracts.map(item => item.maxFee))) throw new Error('The network fee exceeds the vault fee cap.');
  const net = sources.map(source => source.satoshis - each);
  if (net.some(value => value < 546)) throw new Error('A kingdom vault output is too small to withdraw.');
  const gross = net.reduce((total, value) => total + value, 0);
  const last = count - 1;
  const splittable = contracts[last].capturePercent > 0;
  const wanted = splittable ? satoshis ?? gross : gross;
  if (!Number.isSafeInteger(wanted) || wanted < 546 || wanted > gross || (satoshis ?? 0) > gross) throw new Error('These vault outputs do not cover the amount and network fee.');
  let change = gross - wanted;
  let extra = net[last] - change;
  if (change < DUST32) { change = 0; extra = 0; }
  else if (extra < 0) throw new Error('Choose fewer vault outputs for this amount.');
  else if (extra < 546) { change = net[last]; extra = 0; }
  const outputs = [...net.slice(0, last).map(value => ({ script: owner.ownerScript, satoshis: value })),
    change ? { script: contracts[last].script, satoshis: change } : { script: owner.ownerScript, satoshis: net[last] },
    ...(extra ? [{ script: owner.ownerScript, satoshis: extra }] : []), ...record];
  const paid = gross - change;
  return { ...build(sources, contracts, outputs, { sequence: contract => contract.capturePercent ? contract.captureAge : 0xfffffffe }), sources, contracts, outputs, paid, feeSatoshis: each * count,
    change: change ? { script: contracts[last].script, address: contracts[last].address, redeemScript: contracts[last].redeemScript,
      vout: last, satoshis: change, kv: sources[last].kv } : undefined };
}

export const signKingdomWithdrawal = (plan, operatorPrivateKey, options) => sign(plan, plan.contracts, operatorPrivateKey, 1, options);

// Revision 4: up to four outputs of one War Chest pay their owner's wallet as output 0. What is not withdrawn returns to
// the same chest as output 1, so a withdrawal also consolidates the chest. The fee is the size of the transaction.
function planChestRelease(offered, { satoshis, leaving, eventScript } = {}) {
  if (!offered.length || offered.length > MATCHED_INPUTS) throw new Error('A withdrawal spends 1 to ' + MATCHED_INPUTS + ' War Chest outputs.');
  const sources = offered.toSorted((a, b) => b.satoshis - a.satoshis || (a.txid + a.vout < b.txid + b.vout ? -1 : 1));
  const contracts = sources.map(contractOf);
  const owner = contracts[0];
  if (contracts.some(item => item.script !== owner.script)) throw new Error('One withdrawal spends outputs of one War Chest script.');
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  const held = sources.reduce((total, item) => total + item.satoshis, 0);
  const base = 10 + contracts.reduce((total, item) => total + inputBytes(item), 0) + 34 + outputBytes(record) + 2;
  let fee = base;
  let paid = held - base;
  let change = 0;
  if (leaving !== undefined) {
    // The player names what leaves the War Chest, on its 1,000-satoshi grid. The wallet receives that amount less the
    // network fee, and the rest stays in the chest as one output: the number asked for is the number that leaves.
    if (!Number.isSafeInteger(leaving) || leaving % CHEST_GRID || leaving < CHEST_GRID || leaving > held) throw new Error('These War Chest outputs do not cover the amount and network fee.');
    change = held - leaving;
    if (change % CHEST_GRID) throw new Error('This War Chest output is not on the 1,000-satoshi grid; withdraw all of it.');
    fee = base + (change ? 44 : 0);
    paid = leaving - fee;
  } else if (satoshis !== undefined) {
    // A remainder too small to be an output of its own is paid out with the rest, so nothing is left behind as dust.
    // The remainder is kept on the 1,000-satoshi grid of War Chest outputs, so a later matched capture never leaves dust; the odd satoshis are paid out.
    const kept = Math.floor((held - satoshis - base - 44) / CHEST_GRID) * CHEST_GRID;
    if (kept >= CHEST_GRID) { fee = base + 44; change = kept; paid = held - fee - change; }
    else if (paid < satoshis) throw new Error('These War Chest outputs do not cover the amount and network fee.');
  }
  if (!Number.isSafeInteger(paid) || paid < 546) throw new Error('These War Chest outputs do not cover the amount and network fee.');
  if (fee > owner.maxFee) throw new Error('The network fee exceeds the War Chest fee cap.');
  const outputs = [{ script: owner.ownerScript, satoshis: paid }, ...(change ? [{ script: owner.script, satoshis: change }] : []), ...record];
  return { ...build(sources, contracts, outputs, { sequence: contract => contract.releaseAge }), sources, contracts, outputs, paid, feeSatoshis: fee,
    change: change ? { script: owner.script, address: owner.address, redeemScript: owner.redeemScript, vout: 1, satoshis: change, kv: sources[0].kv } : undefined };
}

// Takes `satoshis` in total from war chest outputs, each within its capture limit, and pays the remainder after the fee to `script`.
export function planChestCapture(offered, { satoshis, script, eventScript, feeders = [] }) {
  if (offered[0]?.kv?.revision === 3) return planJoinedCapture(offered, { satoshis, script, eventScript, feeders });
  if (feeders.length) throw new Error('Waiting shares join a revision 3 capture only.');
  if (!offered.length || offered.length > 12) throw new Error('A capture spends 1 to 12 war chest outputs.');
  // Only as many outputs as the amount needs are spent, in the order given.
  let needed = satoshis;
  const sources = offered.filter(source => {
    if (needed <= 0) return false;
    needed -= Math.max(0, Math.min(Math.floor(source.satoshis * (source.kv?.capturePercent ?? 0) / 100), source.satoshis - DUST32));
    return true;
  });
  const contracts = sources.map(contractOf);
  if (contracts.some(item => !item.capturePercent)) throw new Error('Only a war chest can be captured.');
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  const fee = 10 + contracts.reduce((total, item) => total + inputBytes(item, 1 + quorumOf(item)) + (item.revision === 3 ? item.attestors.length - item.threshold : 0), 0) + sources.length * 44 + 34 + outputBytes(record) + 2;
  let left = satoshis;
  const kept = sources.map((source, index) => {
    const limit = Math.min(Math.floor(source.satoshis * contracts[index].capturePercent / 100), source.satoshis - DUST32);
    const take = Math.max(0, Math.min(limit, left));
    left -= take;
    return { script: contracts[index].script, satoshis: source.satoshis - take };
  });
  if (!Number.isSafeInteger(satoshis) || left > 0) throw new Error('The capture exceeds what these war chest outputs permit.');
  if (satoshis - fee < 546) throw new Error('The capture is too small to pay its network fee.');
  const outputs = [...kept, { script, satoshis: satoshis - fee }, ...record];
  return { ...build(sources, contracts, outputs, { sequence: contract => contract.captureAge }), sources, contracts, outputs, paid: satoshis - fee, feeSatoshis: fee,
    changes: kept.map((item, index) => ({ ...item, address: contracts[index].address, redeemScript: contracts[index].redeemScript, vout: index, kv: sources[index].kv })) };
}

// Revision 3: every offered output is spent and one remainder returns to the chest.
// `feeders` are waiting shares of the same owner (outputs with their feeder contract). They need no signature: with a
// War Chest output as input 0 their script lets the attested capture take them along, and the 80% rule covers their value too.
function planJoinedCapture(sources, { satoshis, script, eventScript, feeders = [] }) {
  if (!sources.length || sources.length + feeders.length > CAPTURE_INPUTS) throw new Error('A capture spends 1 to ' + CAPTURE_INPUTS + ' war chest outputs.');
  const contracts = sources.map(contractOf);
  if (contracts.some(item => item.script !== contracts[0].script)) throw new Error('One capture spends outputs of one war chest.');
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  if (feeders.some(item => item.contract.chestScript !== contracts[0].script || item.script !== item.contract.script) || (feeders.length && contracts[0].exiting)) throw new Error('A waiting share joins a capture of its own live War Chest only.');
  const total = [...sources, ...feeders].reduce((sum, source) => sum + source.satoshis, 0);
  const fee = 10 + contracts.reduce((sum, item) => sum + inputBytes(item, 1 + item.threshold) + item.attestors.length - item.threshold, 0) +
    feeders.reduce((sum, item) => sum + 40 + 3 + item.contract.redeemScript.length / 2 + 1, 0) + 44 + 34 + outputBytes(record) + 2;
  if (!Number.isSafeInteger(satoshis) || satoshis < 1 || satoshis * 100 > total * contracts[0].capturePercent || total - satoshis < DUST32) throw new Error('The capture exceeds what these war chest outputs permit.');
  if (satoshis - fee < 546) throw new Error('The capture is too small to pay its network fee.');
  const outputs = [{ script: contracts[0].script, satoshis: total - satoshis }, { script, satoshis: satoshis - fee }, ...record];
  const built = build(sources, contracts, outputs, { sequence: contract => contract.captureAge });
  for (const item of feeders) {
    built.transaction.inputs.push({ outpointTransactionHash: fromHex(item.txid), outpointIndex: item.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: encodeDataPush(fromHex(item.contract.redeemScript)) });
    built.sourceOutputs.push({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) });
  }
  return { ...built, sources, feeders, contracts, outputs, paid: satoshis - fee, feeSatoshis: fee,
    changes: [{ ...outputs[0], address: contracts[0].address, redeemScript: contracts[0].redeemScript, vout: 0, kv: sources[0].kv }] };
}

const digestOf = (plan, inputIndex) => hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs: plan.sourceOutputs, transaction: plan.transaction },
  { coveredBytecode: fromHex(plan.contracts[inputIndex].redeemScript), signingSerializationType: type }));
export const captureDigests = plan => plan.contracts.map((contract, index) => hex(digestOf(plan, index)));
export const signCaptureDigests = (plan, privateKey) => captureDigests(plan).map(digest => hex(secp256k1.signMessageHashSchnorr(fromHex(privateKey), fromHex(digest))));
export const validCaptureSignatures = (plan, publicKey, signatures) => Array.isArray(signatures) && signatures.length === plan.contracts.length &&
  captureDigests(plan).every((digest, index) => typeof signatures[index] === 'string' && /^[0-9a-f]{128}$/.test(signatures[index]) &&
    secp256k1.verifySignatureSchnorr(fromHex(signatures[index]), fromHex(publicKey), fromHex(digest)) === true);

// `attestations` maps each attestor public key to its signatures, one per input. The game key signs last.
export function signChestCapture(plan, operatorPrivateKey, attestations, { unchecked = false } = {}) {
  const transaction = structuredClone(plan.transaction);
  const mine = signCaptureDigests(plan, operatorPrivateKey);
  plan.contracts.forEach((contract, index) => {
    if (contract.revision === 3) {
      transaction.inputs[index].unlockingBytecode = Uint8Array.from(Buffer.concat([encodeDataPush(Buffer.concat([fromHex(mine[index]), type])),
        ...thresholdPushes(contract.attestors, contract.threshold, item => attestations?.[item]?.[index]), Uint8Array.of(0x52), encodeDataPush(fromHex(contract.redeemScript))]));
      return;
    }
    const pushed = [mine[index], ...contract.attestors.toReversed().map(item => attestations?.[item]?.[index])];
    if (pushed.some(value => !value)) throw new Error('An attestor signature is missing.');
    transaction.inputs[index].unlockingBytecode = Uint8Array.from(Buffer.concat([...pushed.map(value => encodeDataPush(Buffer.concat([fromHex(value), type]))),
      Uint8Array.of(0x52), encodeDataPush(fromHex(contract.redeemScript))]));
  });
  const raw = encodeTransaction(transaction);
  if (unchecked) return { rawHex: hex(raw) };
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs: plan.sourceOutputs });
  if (verdict !== true) throw new Error('The war chest rejected the capture: ' + verdict);
  const fee = plan.sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error('The fee does not cover one satoshi per serialized byte.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
}

// Owner-only recovery, to any outputs the owner chooses: after `recoverAt` for revision 2, and from the exit script once
// the output is `exitDelay` blocks old for revision 3.
export function signKingdomRecovery(sources, ownerPrivateKey, outputs) {
  const contracts = sources.map(contractOf);
  if (contracts.some(item => item.revision >= 3 && !item.exiting)) throw new Error('Start the exit first: a live war chest output leaves through its exit script.');
  const third = contracts.every(item => item.revision >= 3);
  if (!third && contracts.some(item => item.revision >= 3)) throw new Error('Recover old and new outputs in separate transactions.');
  const plan = build(sources, contracts, outputs, third ? { sequence: contract => contract.exitDelay } : { locktime: Math.max(...contracts.map(item => item.recoverAt)) });
  return sign(plan, contracts, ownerPrivateKey, 0);
}

// Step one of the owner's exit: each live war chest output moves, whole, into its exit script. Only the owner's key signs.
// `outputs` replaces the computed outputs; tests use it to show that a node refuses any other destination.
export function signChestExit(sources, ownerPrivateKey, { unchecked = false, outputs: given, fee } = {}) {
  if (!sources.length || sources.length > 12) throw new Error('An exit moves 1 to 12 war chest outputs.');
  const contracts = sources.map(contractOf);
  if (contracts.every(item => item.revision === 4 && !item.exiting)) {
    // Revision 4: every output offered (up to four of one chest) moves, at its full value, into ONE output of the exit script.
    // The network fee comes from `fee`, an output of the owner's own wallet ({ txid, vout, satoshis }); its change returns there.
    if (sources.length > MATCHED_INPUTS || contracts.some(item => item.script !== contracts[0].script)) throw new Error('An exit moves 1 to ' + MATCHED_INPUTS + ' outputs of one War Chest.');
    const owner = contracts[0];
    const held = sources.reduce((total, item) => total + item.satoshis, 0);
    const payer = fee ? normalizeSource(fee) : null;
    const size = 10 + contracts.reduce((total, item) => total + inputBytes(item), 0) + 44 + 148 + 34 + 2;
    if (!given && (!payer || payer.satoshis < size)) throw new Error(`An exit keeps the whole War Chest: pay its network fee (${size} satoshis) from an output of your own wallet.`);
    const change = payer ? payer.satoshis - size : 0;
    const outputs = given ?? [{ script: owner.exitScript, satoshis: held }, ...(change >= 546 ? [{ script: owner.ownerScript, satoshis: change }] : [])];
    const plan = build(sources, contracts, outputs);
    if (payer) {
      plan.transaction.inputs.push({ outpointTransactionHash: fromHex(payer.txid), outpointIndex: payer.vout, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() });
      plan.sourceOutputs.push({ lockingBytecode: fromHex(owner.ownerScript), valueSatoshis: BigInt(payer.satoshis) });
    }
    const signed = sign(plan, contracts, ownerPrivateKey, 0, { unchecked, wallet: payer ? { index: sources.length, publicKey: owner.ownerKey, script: owner.ownerScript } : null });
    const exit = kingdomVault({ ...sources[0].kv, exiting: true });
    return { ...signed, outputs, exits: [{ ...outputs[0], address: exit.address, redeemScript: exit.redeemScript, vout: 0, kv: vaultTerms(exit) }] };
  }
  if (contracts.some(item => item.revision !== 3 || item.exiting)) throw new Error('Only a live revision 3 war chest output starts an exit.');
  const size = 10 + contracts.reduce((total, item) => total + inputBytes(item), 0) + sources.length * 44 + 2;
  const each = Math.ceil(size / sources.length);
  if (each > Math.min(...contracts.map(item => item.maxFee))) throw new Error('The network fee exceeds the war chest fee cap.');
  const outputs = given ?? sources.map((source, index) => ({ script: contracts[index].exitScript, satoshis: source.satoshis - each }));
  if (outputs.some(item => item.satoshis < DUST32)) throw new Error('A war chest output is too small to move.');
  const signed = sign(build(sources, contracts, outputs), contracts, ownerPrivateKey, 0, { unchecked });
  return { ...signed, outputs, exits: outputs.map((item, index) => {
    const exit = kingdomVault({ ...sources[index].kv, exiting: true });
    return { ...item, address: exit.address, redeemScript: exit.redeemScript, vout: index, kv: vaultTerms(exit) };
  }) };
}
