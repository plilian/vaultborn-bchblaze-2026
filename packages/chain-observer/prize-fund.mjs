import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH,
  hashTransaction, secp256k1 } from '@bitauth/libauth';
import { fromHex, hash256, hex, normalizeSource, publicBytes, toAddress, walletFromPublicKey } from './primitives.mjs';
import { majority } from './kingdom-vault.mjs';

// Seasonal Prize Fund custody for the 70% share of a sponsorship. The sponsor's wallet pays this script directly.
//
// Lane 1, award: only after the season has closed (`closesAt`), and only with the automation key of the game AND the
// signature of every independent prize attestor over the complete transaction. The game server holds the automation
// key only, so neither the server nor the developer can move a prize output alone, at any time.
// Even all signers together are limited by the script: one award may take at most `awardPercent` of a fund output
// (the largest share the prize rules can give), the rest must return to this same script at the next output index,
// nothing else may leave except a bounded network fee, and the output must be `awardAge` blocks old, so successive
// awards from one contribution are spaced out.
// Lane 0, refund: after `refundAt` anyone may broadcast a transaction that returns the output to the sponsor's own
// wallet script. No key is involved, so a lost automation key, a missing attestor or a dead server cannot strand it.
// The script cannot rank players. Who wins is decided off chain and is what the attestors check before they sign.
export const PRIZE_FUND = 'prize-fund-v1';
export const PRIZE_FUND_REFUND_FEE = 1000;
export const PRIZE_FUND_DUST = 576;
// A pool output can be re-issued by anyone only together with at least this much new prize money, so nobody can stall awards for free.
export const POOL_TOP_UP = 300;
const type = Uint8Array.of(0x61);
const push = value => `<0x${value}>`;
const key = value => hex(publicBytes(value));
const instant = (value, name) => {
  if (!Number.isInteger(value) || value < 500_000_000 || value >= 0xffffffff) throw new Error(`A prize fund needs an absolute ${name} time in seconds.`);
  return value;
};

// With `threshold` set, an award needs the automation key and that many of the attestors (a strict majority), so one
// absent attestor does not stop prizes. With `recoverAt` set as well, an award sent after that time needs the automation
// key and any one attestor: a fund is then not lost when all but one attestor have disappeared. Every other limit of the
// award lane stays in force in both cases. Terms without `threshold` rebuild the earlier script, which needs every attestor.
export function prizeFund({ id, operatorKey, attestors, sponsorKey, closesAt, refundAt, refundFee = PRIZE_FUND_REFUND_FEE, awardPercent = 40, awardAge = 6, maxFee = 2000,
  threshold, recoverAt }) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A prize fund needs its 16-byte sponsorship ID.');
  instant(closesAt, 'closing');
  // Without a sponsor the fund is the season pool of service prize shares: it has no refund lane, only a keyless top-up.
  const pooled = sponsorKey == null;
  if (!pooled && instant(refundAt, 'refund') <= closesAt) throw new Error('The sponsor refund must open after the season closes.');
  if (!Number.isInteger(refundFee) || refundFee < 400 || refundFee > 5000) throw new Error('Choose a refund fee cap from 400 to 5,000 satoshis.');
  if (!Number.isInteger(awardPercent) || awardPercent < 1 || awardPercent > 50) throw new Error('One award may take 1% to 50% of a prize fund output.');
  if (!Number.isInteger(awardAge) || awardAge < 1 || awardAge > 65_535) throw new Error('The award age is a number of blocks from 1 to 65,535.');
  if (!Number.isInteger(maxFee) || maxFee < 800 || maxFee > 5000) throw new Error('Choose an award fee cap from 800 to 5,000 satoshis.');
  const operator = key(operatorKey);
  const sponsor = pooled ? { publicKey: null, address: null, script: null } : walletFromPublicKey(key(sponsorKey));
  if (!Array.isArray(attestors) || attestors.length < 1 || attestors.length > 3) throw new Error('A prize fund needs one to three independent attestor keys.');
  const independent = attestors.map(key).sort();
  // Compared without the parity byte: the same secret must not appear in two roles.
  const secrets = new Set([operator, ...independent].map(item => item.slice(2)));
  if (secrets.size !== independent.length + 1) throw new Error('The automation key and every attestor key must be different.');
  const counted = threshold !== undefined;
  if (counted && (!Number.isInteger(threshold) || threshold < majority(independent.length) || threshold > independent.length)) throw new Error('The attestor threshold must be a strict majority of the attestors.');
  if (!counted && recoverAt !== undefined) throw new Error('A recovery time needs an attestor threshold.');
  if (recoverAt !== undefined && instant(recoverAt, 'recovery') <= closesAt) throw new Error('The recovery time must come after the season closes.');
  // Each key adds 1 for a real signature; a key that did not sign is given an empty item.
  const count = independent.map((item, index) => `${index ? 'OP_SWAP ' : ''}${push(item)} OP_CHECKSIG${index ? ' OP_ADD' : ''}`).join(' ');
  // Normal: the automation key and `threshold` attestors. From `recoverAt` two more ways open, so the fund survives the
  // loss of keys: the automation key with any one attestor (attestors lost), or EVERY attestor without the automation key
  // (game server and its key lost). The second needs at least two attestors, so no single party can ever spend alone.
  const continuity = counted && recoverAt !== undefined && independent.length >= 2;
  const authorised = !counted ? `${independent.map(item => `${push(item)} OP_CHECKSIGVERIFY`).join(' ')} ${push(operator)} OP_CHECKSIGVERIFY` :
    continuity ?
      `${count} OP_SWAP ${push(operator)} OP_CHECKSIG OP_2DUP OP_SWAP <${threshold}> OP_GREATERTHANOREQUAL OP_BOOLAND OP_NOTIF
        <${recoverAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP OP_2DUP OP_IF OP_1 OP_GREATERTHANOREQUAL OP_ELSE <${independent.length}> OP_NUMEQUAL OP_ENDIF OP_VERIFY
      OP_ENDIF OP_2DROP` :
      `${count} <${threshold}> OP_GREATERTHANOREQUAL OP_VERIFY ${push(operator)} OP_CHECKSIGVERIFY`;
  const source = `${push('5642504631' + id)} OP_DROP
    OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_IF
      <${closesAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP
      <${awardAge}> OP_CHECKSEQUENCEVERIFY OP_DROP
      ${authorised}
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_2 OP_MUL OP_1ADD OP_LESSTHANOREQUAL OP_VERIFY
      OP_TXOUTPUTCOUNT OP_TXINPUTCOUNT OP_2 OP_MUL OP_GREATERTHAN OP_IF OP_TXINPUTCOUNT OP_2 OP_MUL OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF
      OP_INPUTINDEX OP_2 OP_MUL
      OP_DUP OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_DUP OP_OUTPUTVALUE <100> OP_MUL OP_INPUTINDEX OP_UTXOVALUE <${awardPercent}> OP_MUL OP_LESSTHANOREQUAL OP_VERIFY
      OP_DUP OP_OUTPUTVALUE OP_SWAP OP_1ADD
      OP_DUP OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY
      OP_DUP OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_OUTPUTVALUE OP_ADD OP_INPUTINDEX OP_UTXOVALUE <${maxFee}> OP_SUB OP_GREATERTHANOREQUAL
    OP_ELSE
      ${pooled ? `OP_INPUTINDEX OP_TXINPUTCOUNT OP_1SUB OP_NUMEQUALVERIFY
      OP_0 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_0 OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <${POOL_TOP_UP}> OP_ADD OP_GREATERTHANOREQUAL` : `<${refundAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP
      OP_INPUTINDEX OP_OUTPUTBYTECODE ${push(sponsor.script)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTVALUE OP_INPUTINDEX OP_UTXOVALUE <${refundFee}> OP_SUB OP_GREATERTHANOREQUAL`}
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  if (redeem.length > 520) throw new Error('The prize fund script is too large.');
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { id, version: PRIZE_FUND, operatorKey: operator, attestors: independent, sponsorKey: sponsor.publicKey, sponsorAddress: sponsor.address,
    sponsorScript: sponsor.script, closesAt, refundAt: pooled ? null : refundAt, refundFee, awardPercent, awardAge, maxFee, pooled, script, address: toAddress(script), redeemScript: hex(redeem),
    ...(counted && { threshold }), ...(recoverAt !== undefined && { recoverAt }), continuity };
}
// How many attestor signatures an award from this fund needs when it is sent at `locktime`.
// Without the automation key (`unassisted`), every attestor must sign, and only from the recovery time.
export const awardQuorum = (fund, locktime = 0, unassisted = false) => unassisted ? (fund.continuity && locktime >= fund.recoverAt ? fund.attestors.length : Infinity) :
  fund.threshold === undefined ? fund.attestors.length : fund.recoverAt !== undefined && fund.attestors.length >= 2 && locktime >= fund.recoverAt ? 1 : fund.threshold;

const terms = source => prizeFund(source.fund);
// Signatures are pushed so that the automation key is checked last: [operator, attestor n, ..., attestor 1, selector, redeem].
const awardUnlocking = (contract, operatorSignature, attestorSignatures, needed = contract.threshold) => Buffer.concat([
  operatorSignature ? encodeDataPush(Buffer.concat([fromHex(operatorSignature), type])) : Uint8Array.of(0x00),
  ...(contract.threshold === undefined ? contract.attestors.toReversed().map(item => encodeDataPush(Buffer.concat([fromHex(attestorSignatures[item]), type]))) :
    // The first `needed` attestors that signed, in key order; an empty item for every other key.
    (() => { let used = 0; return contract.attestors.map(item => attestorSignatures[item] && used < needed ? (used += 1, encodeDataPush(Buffer.concat([fromHex(attestorSignatures[item]), type]))) : Uint8Array.of(0x00)).toReversed(); })()),
  Uint8Array.of(0x51), encodeDataPush(fromHex(contract.redeemScript))]);
const placeholder = '00'.repeat(64);

export function awardSize(sources, outputs) {
  const inputs = sources.reduce((total, source) => {
    const contract = terms(source);
    return total + 40 + 3 + awardUnlocking(contract, placeholder, Object.fromEntries(contract.attestors.map(item => [item, placeholder]))).length;
  }, 0);
  return 10 + inputs + outputs.reduce((total, item) => total + 9 + item.script.length / 2, 0);
}

// Builds the unsigned award. Every input must be a prize fund output; each party signs one digest per input.
export function planPrizeAward(sources, outputs, options = {}) {
  if (!sources.length || sources.length > 32) throw new Error('An award spends 1 to 32 prize fund outputs.');
  const contracts = sources.map(source => {
    const contract = terms(source);
    const funding = normalizeSource(source);
    if (funding.script !== contract.script || funding.token) throw new Error('The source is not this prize fund output.');
    return contract;
  });
  // An award built after a fund's recovery time is dated at that time, so it is valid with the reduced quorum as well.
  const locktime = Math.max(...contracts.map(item => item.closesAt), ...contracts.flatMap(item => item.recoverAt !== undefined && item.recoverAt <= (options.now ?? 0) ? [item.recoverAt] : []));
  const transaction = { version: 2, locktime, inputs: sources.map(source => ({ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout,
    sequenceNumber: contracts[sources.indexOf(source)].awardAge, unlockingBytecode: new Uint8Array() })),
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = sources.map((source, index) => ({ lockingBytecode: fromHex(contracts[index].script), valueSatoshis: BigInt(source.satoshis) }));
  const digests = contracts.map((contract, inputIndex) => hex(hash256(generateSigningSerializationBCH({ inputIndex, sourceOutputs, transaction },
    { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: type }))));
  return { contracts, transaction, sourceOutputs, digests, locktime };
}

// Lays out an award of `satoshis` to `script`: every fund output gives the same proportion, within its own limit, and
// its remainder returns to its own script. Outputs are [award 0, remainder 0, award 1, remainder 1, ..., record].
export function layoutPrizeAward(offered, { script, satoshis, eventScript }) {
  const total = offered.reduce((sum, source) => sum + source.satoshis, 0);
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  // Outputs too small to give a spendable part are left out; the rest carry the award between them.
  const sources = offered.filter(source => Math.floor(satoshis * source.satoshis / total) >= 546).slice(0, 16);
  if (!sources.length) throw new Error('The prize fund outputs cannot carry this award.');
  const base = sources.reduce((sum, source) => sum + source.satoshis, 0);
  let left = satoshis;
  const outputs = [];
  const changes = [];
  sources.forEach((source, index) => {
    const contract = terms(source);
    const part = index === sources.length - 1 ? left : Math.floor(satoshis * source.satoshis / base);
    left -= part;
    const fee = awardSize([source], [{ script }, { script: contract.script }]) + (index === 0 ? 12 + record.reduce((size, item) => size + 9 + item.script.length / 2, 0) : 0);
    const remainder = source.satoshis - part - fee;
    if (part * 100 > source.satoshis * contract.awardPercent || fee > contract.maxFee || part < 546 || remainder < PRIZE_FUND_DUST) {
      throw new Error('The prize fund outputs cannot carry this award within their limits.');
    }
    outputs.push({ script, satoshis: part }, { script: contract.script, satoshis: remainder });
    changes.push({ script: contract.script, address: contract.address, redeemScript: contract.redeemScript, vout: 2 * index + 1, satoshis: remainder, fund: source.fund });
  });
  return { sources, outputs: [...outputs, ...record], changes, feeSatoshis: sources.reduce((sum, source) => sum + source.satoshis, 0) - outputs.reduce((sum, item) => sum + item.satoshis, 0) };
}

export function signPrizeAward(plan, privateKey) {
  return plan.digests.map(digest => {
    const signature = secp256k1.signMessageHashSchnorr(fromHex(privateKey), fromHex(digest));
    if (typeof signature === 'string') throw new Error('Could not sign the prize award.');
    return hex(signature);
  });
}

export function validAwardSignatures(plan, publicKey, signatures) {
  return Array.isArray(signatures) && signatures.length === plan.digests.length && signatures.every((signature, index) =>
    typeof signature === 'string' && /^[0-9a-f]{128}$/.test(signature) &&
    secp256k1.verifySignatureSchnorr(fromHex(signature), fromHex(publicKey), fromHex(plan.digests[index])) === true);
}

// `attestations` maps each attestor public key to its signatures, one per input.
// `unchecked` skips the local VM so that tests can hand an invalid spend to a real node and watch it refuse.
export function completePrizeAward(plan, operatorSignatures, attestations, { unchecked = false } = {}) {
  const transaction = structuredClone(plan.transaction);
  plan.contracts.forEach((contract, index) => {
    const mine = Object.fromEntries(contract.attestors.map(item => [item, attestations[item]?.[index]]));
    // `operatorSignatures` may be null: the attestors act together after the recovery time, without the game.
    const needed = awardQuorum(contract, plan.locktime, !operatorSignatures);
    if (Object.values(mine).filter(Boolean).length < needed) throw new Error('An attestor signature is missing.');
    transaction.inputs[index].unlockingBytecode = Uint8Array.from(awardUnlocking(contract, operatorSignatures?.[index], mine, needed));
  });
  if (unchecked) return { rawHex: hex(encodeTransaction(transaction)) };
  return finish(transaction, plan.sourceOutputs);
}

function finish(transaction, sourceOutputs) {
  const verdict = createVirtualMachineBCH().verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error('The prize fund rejected the spend: ' + verdict);
  const raw = encodeTransaction(transaction);
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error('The fee does not cover one satoshi per serialized byte.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
}

// Keyless return to the sponsors after `refundAt`. Output i pays the sponsor of input i.
export function buildPrizeRefund(sources, fee = 600) {
  const contracts = sources.map(terms);
  if (contracts.some(item => item.pooled)) throw new Error('A season pool has no sponsor to refund.');
  if (fee < 400 || fee > Math.min(...contracts.map(item => item.refundFee))) throw new Error('The refund fee is outside the covenant limit.');
  const transaction = { version: 2, locktime: Math.max(...contracts.map(item => item.refundAt)),
    inputs: sources.map((source, index) => ({ outpointTransactionHash: fromHex(source.txid), outpointIndex: source.vout, sequenceNumber: 0xfffffffe,
      unlockingBytecode: Uint8Array.from(Buffer.concat([Uint8Array.of(0x00), encodeDataPush(fromHex(contracts[index].redeemScript))])) })),
    outputs: sources.map((source, index) => ({ lockingBytecode: fromHex(contracts[index].sponsorScript), valueSatoshis: BigInt(source.satoshis - fee) })) };
  const sourceOutputs = sources.map((source, index) => ({ lockingBytecode: fromHex(contracts[index].script), valueSatoshis: BigInt(source.satoshis) }));
  return { ...finish(transaction, sourceOutputs), refunds: sources.map((source, index) => ({ address: contracts[index].sponsorAddress, satoshis: source.satoshis - fee })) };
}
