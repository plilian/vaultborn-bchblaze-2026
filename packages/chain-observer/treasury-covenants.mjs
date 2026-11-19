import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction,
  generateSigningSerializationBCH, getDustThreshold, hashTransaction, OpcodesBCH } from '@bitauth/libauth';
import { amount, decodeAddress, DUST, fromHex, hash256, hex, normalizeSource, publicBytes,
  toAddress, walletFromPublicKey } from './primitives.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

const feeType = Uint8Array.of(0x61); // ALL | UTXOS | FORKID
const vm = createVirtualMachineBCH();
const push = value => `<0x${value}>`;
const number = value => `<${value}>`;
const op = value => Uint8Array.of(value);
const checkSignature = key => `OP_DUP OP_SIZE OP_1SUB OP_SPLIT OP_NIP ${push('61')} OP_EQUALVERIFY ${push(key)} OP_CHECKSIGVERIFY`;

function compressedKeys(keys, count) {
  if (!Array.isArray(keys) || keys.length !== count) throw new Error(`Supply ${count} distinct compressed public keys.`);
  const normalized = keys.map(key => hex(publicBytes(key)));
  if (new Set(normalized.map(key => key.slice(2))).size !== count) throw new Error('Signing roles require distinct public keys.');
  return normalized;
}

function nativeDestination(address) {
  const destination = decodeAddress(address);
  if (destination.tokenSupport) throw new Error('Treasury outputs use native BCH addresses.');
  return destination;
}
const minimumOutput = destination => {
  const dust = getDustThreshold({ lockingBytecode:fromHex(destination.script), valueSatoshis:0n });
  return dust > DUST ? dust : DUST;
};

function compile(source, fields) {
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  if (redeem.length > 520) throw new Error('The compiled redemption script exceeds the supported stack item limit.');
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { ...fields, network: NETWORK_ID, source, script, address: toAddress(script), redeemScript: hex(redeem) };
}

function locktime(value) {
  if (!Number.isInteger(value) || value < 500_000_000 || value >= 0xffffffff) throw new Error('An absolute refund timestamp in seconds is required.');
  return value;
}

function noTokens(index, opcode) {
  return `${number(index)} ${opcode} OP_0 OP_EQUALVERIFY`;
}

// With `record`, one extra zero-value output may follow the fixed outputs. It carries the public settlement record and no money.
function constrainOutputs(outputs, record = false) {
  const count = record ? `OP_TXOUTPUTCOUNT ${number(outputs.length)} ${number(outputs.length + 2)} OP_WITHIN OP_VERIFY ` +
    `OP_TXOUTPUTCOUNT ${number(outputs.length)} OP_GREATERTHAN OP_IF ${number(outputs.length)} OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF ` :
    `${number(outputs.length)} OP_TXOUTPUTCOUNT OP_NUMEQUALVERIFY `;
  // An output without a script is "open": its amount is fixed, its destination is chosen when the lane is used.
  return count + outputs.map((output, index) =>
    (output.script ? `${number(index)} OP_OUTPUTBYTECODE ${push(output.script)} OP_EQUALVERIFY ` : '') +
    `${number(index)} OP_OUTPUTVALUE ${output.satoshis == null ? `OP_0 OP_UTXOVALUE ${number(output.reserve)} OP_SUB` : number(output.satoshis)} OP_NUMEQUALVERIFY ` +
    noTokens(index, 'OP_OUTPUTTOKENCATEGORY')).join(' ');
}

function chooseOutcome(outcomes, index = 0, record = false) {
  if (record) {
    if (index === outcomes.length - 1) return `${number(index)} OP_NUMEQUALVERIFY ${constrainOutputs(outcomes[index].outputs, true)}`;
    return `OP_DUP ${number(index)} OP_NUMEQUAL OP_IF OP_DROP ${constrainOutputs(outcomes[index].outputs, true)} ` +
      `OP_ELSE ${chooseOutcome(outcomes, index + 1, true)} OP_ENDIF`;
  }
  if (index === outcomes.length - 1) return `${number(index)} OP_NUMEQUALVERIFY ${constrainOutputs(outcomes[index].outputs)}`;
  return `OP_DUP ${number(index)} OP_NUMEQUAL OP_IF OP_DROP ${constrainOutputs(outcomes[index].outputs)} ` +
    `OP_ELSE ${chooseOutcome(outcomes, index + 1)} OP_ENDIF`;
}

export function compileTreasuryCovenant(descriptor) {
  const { id, kind, reserve = 650, network = NETWORK_ID, version = 1 } = descriptor;
  if (![1, 2].includes(version)) throw new Error('Unknown treasury covenant version.');
  if (network !== NETWORK_ID) throw new Error('Only an explicit ' + NETWORK_LABEL + ' profile is supported.');
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('An independent 16-byte covenant ID is required.');
  if (kind === 'development') {
    const keys = compressedKeys(descriptor.keys, 3).sort();
    return compile(`${push('56424431' + id)} OP_DROP OP_2 ${keys.map(push).join(' ')} OP_3 OP_CHECKMULTISIG`, { id, kind, keys });
  }
  if (!Number.isInteger(reserve) || reserve < 600 || reserve > 4000) throw new Error('Choose a settlement reserve from 600 to 4,000 satoshis.');
  const principal = Number(amount(descriptor.principal, DUST));
  if (principal > 250_000) throw new Error('A covenant tranche may contain up to 250,000 satoshis.');
  const refundAt = locktime(descriptor.refundAt);
  const refundKey = kind === 'season-prize' ? null : hex(publicBytes(descriptor.ownerKey));
  const owner = refundKey ? walletFromPublicKey(refundKey) : null;
  const refund = { ...owner, reserve };
  const output = (destination, satoshis) => ({ ...destination, satoshis: Number(amount(satoshis, minimumOutput(destination))) });
  const split = (destination, transfer) => [output(owner, principal - transfer), output(destination, transfer)];
  let keys = [];
  let outcomes;
  if (kind === 'season-prize') {
    const recipient = nativeDestination(descriptor.recipient);
    const rollover = nativeDestination(descriptor.rollover);
    if (recipient.script === rollover.script) throw new Error('The winner and rollover treasury must be distinct.');
    Object.assign(refund, rollover);
    outcomes = [{ name: 'claim', outputs: [output(recipient, principal)] }];
  } else if (['battle-escrow', 'kingdom-treasury', 'territory-escrow'].includes(kind)) {
    const opponent = nativeDestination(descriptor.opponent);
    if (opponent.script === owner.script) throw new Error('The opposing destination must differ from the payer.');
    // Version 2 accepts one outcome key: the signer only chooses between outcomes whose outputs were fixed at funding.
    keys = compressedKeys(descriptor.attestors, version === 2 && descriptor.attestors?.length === 1 ? 1 : 2);
    if (keys.some(key => key.slice(2) === refundKey.slice(2))) throw new Error('The owner and settlement attestors must have independent keys.');
    const capture = kind === 'kingdom-treasury' ? Math.min(Math.floor(principal / 5), 3000) : Math.floor(principal / 2);
    outcomes = [
      { name: 'return', outputs: [output(owner, principal)] },
      { name: 'opponent-wins', outputs: split(opponent, capture) },
    ];
  } else if (kind === 'territory-claim') {
    // The winner of an open contest is not known when a claim is paid. The claimant always keeps at least half;
    // at most half may go to one wallet named at settlement.
    keys = compressedKeys(descriptor.attestors, 1);
    if (keys[0].slice(2) === refundKey.slice(2)) throw new Error('The owner and the settlement key must be different.');
    const forfeit = Math.floor(principal / 2);
    outcomes = [
      { name: 'return', outputs: [output(owner, principal)] },
      { name: 'forfeit', outputs: [output(owner, principal - forfeit), { script: null, address: null, satoshis: forfeit }] },
    ];
  } else if (kind === 'territory-uncontested') {
    outcomes = [{ name: 'return', outputs: [output(owner, principal)] }];
    locktime(descriptor.closesAt);
    if (descriptor.closesAt > refundAt) throw new Error('Territory closure must precede recovery.');
  } else {
    throw new Error('Unknown treasury covenant kind.');
  }
  const tag = { 'season-prize': '01', 'battle-escrow': '02', 'kingdom-treasury': '03', 'territory-escrow': '04', 'territory-uncontested': '05', 'territory-claim': '06' }[kind];
  const authorization = keys.map(checkSignature).join(' ');
  const closure = kind === 'territory-uncontested' ? `${number(descriptor.closesAt)} OP_CHECKLOCKTIMEVERIFY OP_DROP` : '';
  // Version 2 recovery pays the output at the covenant's own input index. It returns the funded value less the reserve, or the
  // whole value when that would leave less than a spendable output, so a fee sponsor can rescue any amount that was paid in.
  const recoveryFloor = reserve + Number(minimumOutput(refund));
  const source = version === 2 ? `${push('56424332' + tag + id)} OP_DROP
    OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_IF
      ${number(refundAt)} OP_CHECKLOCKTIMEVERIFY OP_DROP ${refundKey ? checkSignature(refundKey) : ''}
      OP_INPUTINDEX OP_OUTPUTBYTECODE ${push(refund.script)} OP_EQUALVERIFY
      OP_INPUTINDEX OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_INPUTINDEX OP_UTXOVALUE OP_DUP ${number(recoveryFloor)} OP_GREATERTHANOREQUAL OP_IF ${number(reserve)} OP_SUB OP_ENDIF
      OP_INPUTINDEX OP_OUTPUTVALUE OP_SWAP OP_GREATERTHANOREQUAL OP_VERIFY
    OP_ELSE
      OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY
      OP_0 OP_UTXOVALUE ${number(principal + reserve)} OP_NUMEQUALVERIFY
      ${closure} ${chooseOutcome(outcomes, 0, descriptor.record === true)} ${authorization}
    OP_ENDIF OP_1` : `${push('56424331' + tag + id)} OP_DROP OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY
    ${noTokens(0, 'OP_UTXOTOKENCATEGORY')}
    OP_IF
      ${number(refundAt)} OP_CHECKLOCKTIMEVERIFY OP_DROP ${refundKey ? checkSignature(refundKey) : ''}
      ${constrainOutputs([refund])}
    OP_ELSE
      OP_0 OP_UTXOVALUE ${number(principal + reserve)} OP_NUMEQUALVERIFY
      ${closure} ${chooseOutcome(outcomes)} ${authorization}
    OP_ENDIF OP_1`;
  const contract = compile(source, { id, kind, version, recoveryFloor, keys, refundKey, refundAddress: refund.address, refundAt,
    closesAt: descriptor.closesAt, principal, reserve, satoshis: principal + reserve, outcomes });
  // Include a conservative maximum size for DER signatures, selectors, the redeem push, and transaction overhead.
  const serializedOutputs = values => values.reduce((size, output) => size + 9 + (output.script?.length ?? 50)/2, 0);
  const outputBytes = Math.max(serializedOutputs([refund]), ...outcomes.map(outcome => serializedOutputs(outcome.outputs)));
  const maximumSignatures = Math.max(keys.length, Number(Boolean(refundKey)));
  const maximumBytes = 53 + 5 + contract.redeemScript.length/2 + 74*maximumSignatures + outputBytes + (descriptor.record === true ? 45 : 0);
  if (reserve < maximumBytes) throw new Error('The settlement reserve cannot cover the largest permitted spend.');
  return contract;
}

// The planner only constructs bytes. Source verification and publication are separate operations.
export function planTreasurySpend(descriptor, funding, { lane, locktime: requestedTime, outputs, sponsor, eventScript, payee } = {}) {
  const contract = compileTreasuryCovenant(descriptor);
  const source = normalizeSource(funding);
  if (source.script !== contract.script || source.token) throw new Error('Expected the matching native covenant output.');
  const development = contract.kind === 'development';
  const refund = !development && lane === 'refund';
  const selection = development || refund ? -1 : contract.outcomes.findIndex(outcome => outcome.name === lane);
  if (!development && !refund && selection < 0) throw new Error('Unknown settlement lane.');
  if (!development && !refund && source.satoshis !== contract.satoshis) throw new Error('Incorrectly funded contracts must use timed recovery.');
  const output = (address, value) => {
    const destination = nativeDestination(address);
    return { ...destination, satoshis:Number(amount(value, minimumOutput(destination))) };
  };
  const sponsored = refund && contract.version === 2 && sponsor ? { ...walletFromPublicKey(sponsor.publicKey), coin: normalizeSource(sponsor.source) } : null;
  if (sponsor && !sponsored) throw new Error('Only version 2 recovery accepts a fee sponsor input.');
  if (sponsored && (sponsored.coin.script !== sponsored.script || sponsored.coin.token)) throw new Error('The fee sponsor must spend its own plain BCH output.');
  const selfFunded = contract.version === 2 ? source.satoshis >= contract.recoveryFloor : true;
  if (refund && !selfFunded && !sponsored) throw new Error('This small payment needs a fee sponsor input to be recovered.');
  const refundDestination = refund ? nativeDestination(contract.refundAddress) : null;
  let payments = development ? outputs?.map(item => output(item.address, item.satoshis)) :
    refund ? [selfFunded ? output(contract.refundAddress, source.satoshis - contract.reserve) :
      { ...refundDestination, satoshis: Math.max(source.satoshis, Number(minimumOutput(refundDestination))) }] : contract.outcomes[selection].outputs;
  if (payments?.some(item => !item.script)) {
    // The open half of a forfeited claim goes to the wallet named now. It must be an ordinary wallet address.
    const destination = nativeDestination(payee ?? '');
    if (!/^76a914[0-9a-f]{40}88ac$/.test(destination.script)) throw new Error('A forfeited claim half is paid to a wallet address.');
    payments = payments.map(item => item.script ? item : { ...destination, satoshis: item.satoshis });
  }
  if (eventScript) {
    if (development || refund || descriptor.record !== true || !/^6a(?:[0-9a-f]{2}){1,40}$/.test(eventScript)) throw new Error('Only a recorded settlement lane carries a record output.');
    payments = [...payments, { script: eventScript, satoshis: 0 }];
  }
  if (sponsored) {
    // The reserve covers the covenant spend. The sponsor adds 200 satoshis for its own input and change output.
    const change = sponsored.coin.satoshis + source.satoshis - payments[0].satoshis - contract.reserve - 200;
    if (change < 0) throw new Error('The fee sponsor output is too small.');
    if (change >= 546) payments.push({ script: sponsored.script, address: sponsored.address, satoshis: change });
  }
  const available = source.satoshis + (sponsored?.coin.satoshis ?? 0);
  if (!payments?.length || payments.length > 12 || payments.reduce((sum, item) => sum + item.satoshis, 0) >= available) {
    throw new Error('Provide funded outputs with a separate fee reserve.');
  }
  const locktime = requestedTime ?? (refund ? contract.refundAt : contract.closesAt ?? 0);
  if (!Number.isInteger(locktime) || locktime < 0 || locktime > 0xffffffff) throw new Error('Invalid transaction locktime.');
  const transaction = { version: 2, locktime, inputs: [{ outpointTransactionHash: fromHex(source.txid),
    outpointIndex: source.vout, sequenceNumber: locktime ? 0xfffffffe : 0xffffffff, unlockingBytecode: new Uint8Array() },
    ...(sponsored ? [{ outpointTransactionHash: fromHex(sponsored.coin.txid), outpointIndex: sponsored.coin.vout,
      sequenceNumber: locktime ? 0xfffffffe : 0xffffffff, unlockingBytecode: new Uint8Array() }] : [])],
    outputs: payments.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = [{ lockingBytecode: fromHex(source.script), valueSatoshis: BigInt(source.satoshis) },
    ...(sponsored ? [{ lockingBytecode: fromHex(sponsored.script), valueSatoshis: BigInt(sponsored.coin.satoshis) }] : [])];
  return { contract, transaction, sourceOutputs, lane, selection, refund, development,
    ...(sponsored && { sponsor: { script: sponsored.script, publicKey: sponsored.publicKey } }) };
}

export function treasurySigningHash({ contract, transaction, sourceOutputs }) {
  return hash256(generateSigningSerializationBCH({ inputIndex: 0, transaction, sourceOutputs },
    { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: feeType }));
}

// The fee sponsor signs its own ordinary input over the same transaction.
export function sponsorSigningHash({ sponsor, transaction, sourceOutputs }) {
  if (!sponsor) throw new Error('This plan has no fee sponsor input.');
  return hash256(generateSigningSerializationBCH({ inputIndex: 1, transaction, sourceOutputs },
    { coveredBytecode: fromHex(sponsor.script), signingSerializationType: feeType }));
}

export function completeTreasurySpend(plan, signatures = [], sponsorSignature) {
  const { contract, refund, development, selection, sourceOutputs } = plan;
  const transaction = structuredClone(plan.transaction);
  const selector = index => op(index === 0 ? OpcodesBCH.OP_0 : OpcodesBCH.OP_1);
  const required = development ? 2 : refund ? Number(Boolean(contract.refundKey)) : contract.keys.length;
  if (!Array.isArray(signatures) || signatures.length !== required) {
    throw new Error('The selected lane requires the expected number of signatures.');
  }
  const pushSignature = value => {
    if (typeof value !== 'string' || !/^[a-f0-9]+$/i.test(value) || value.length % 2 || value.length > 144) throw new Error('Invalid signature encoding.');
    return encodeDataPush(Buffer.concat([fromHex(value), feeType]));
  };
  const unlocking = development ? [selector(0), ...signatures.map(pushSignature)] : refund ?
    [...signatures.map(pushSignature), selector(1)] : [...signatures.map(pushSignature).reverse(), selector(selection), selector(0)];
  transaction.inputs[0].unlockingBytecode = Uint8Array.from(Buffer.concat([...unlocking, encodeDataPush(fromHex(contract.redeemScript))]));
  if (plan.sponsor) {
    transaction.inputs[1].unlockingBytecode = Uint8Array.from(Buffer.concat([pushSignature(sponsorSignature),
      encodeDataPush(fromHex(plan.sponsor.publicKey))]));
  }
  const result = vm.verify({ transaction, sourceOutputs });
  if (result !== true) throw new Error('Treasury covenant rejected the spend: ' + result);
  const raw = encodeTransaction(transaction);
  const fee = sourceOutputs.reduce((sum, item) => sum + item.valueSatoshis, 0n) - transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (fee < BigInt(raw.length)) throw new Error('The settlement fee does not cover one satoshi per serialized byte.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: Number(fee) };
}

