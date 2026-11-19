import { createHash } from 'node:crypto';
import { bigIntToVmNumber, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH,
  hashTransaction, OpcodesBCH, secp256k1 } from '@bitauth/libauth';
import { amount, DUST, fromHex, hash256, hex, normalizeSource, publicBytes, readTransaction, toAddress, walletFromPrivateKey, walletFromPublicKey } from './primitives.mjs';

export const POLITICAL_ESCROW_FEE = 650;
const {OP_0, OP_1, OP_2, OP_IF, OP_ELSE, OP_ENDIF, OP_DROP, OP_DUP, OP_SWAP, OP_SUB, OP_VERIFY, OP_EQUALVERIFY, OP_CHECKSIGVERIFY,
  OP_CHECKLOCKTIMEVERIFY, OP_NUMEQUALVERIFY, OP_NUMEQUAL, OP_GREATERTHANOREQUAL, OP_OUTPUTBYTECODE, OP_OUTPUTVALUE, OP_TXOUTPUTCOUNT,
  OP_TXINPUTCOUNT, OP_INPUTINDEX, OP_UTXOVALUE} = OpcodesBCH;
export const POLITICAL_ESCROW_VERSION = 2;
const REFUND_FLOOR = POLITICAL_ESCROW_FEE + 546;
const op = (...values) => Buffer.from(values);
const bytes = (value) => encodeDataPush(fromHex(value));
const numeric = (value) => encodeDataPush(bigIntToVmNumber(BigInt(value)));
const recipientCheck = (script) => [op(OP_0, OP_OUTPUTBYTECODE), bytes(script), op(OP_EQUALVERIFY)];

export function politicalEscrow({ id, operatorKey, payerKey, payeeKey, principal, refundAt, version = 1 }) {
  if (!/^[0-9a-f]{32}$/.test(id) || !Number.isSafeInteger(refundAt) || refundAt < 500_000_000 || refundAt >= 0xffffffff) {
    throw new Error('Invalid political escrow identifier or refund timestamp.');
  }
  const payer = walletFromPublicKey(payerKey);
  const payee = walletFromPublicKey(payeeKey);
  publicBytes(operatorKey);
  if (payer.script === payee.script) throw new Error('Escrow requires distinct payer and recipient wallets.');
  principal = Number(amount(principal,DUST));
  if (version === 2) return escrowV2({ id, operatorKey, payer, payee, principal, refundAt });
  if (version !== 1) throw new Error('Unknown political escrow version.');
  // The operator can release or return only the exact principal. The payer can independently refund after the timelock.
  const redeem = Buffer.concat([
    bytes(id), op(OP_DROP, OP_IF), bytes(operatorKey), op(OP_CHECKSIGVERIFY), ...recipientCheck(payee.script),
    op(OP_ELSE, OP_IF), bytes(operatorKey), op(OP_CHECKSIGVERIFY, OP_ELSE), numeric(refundAt),
    op(OP_CHECKLOCKTIMEVERIFY, OP_DROP), bytes(payer.publicKey), op(OP_CHECKSIGVERIFY, OP_ENDIF), ...recipientCheck(payer.script),
    op(OP_ENDIF, OP_0, OP_OUTPUTVALUE), numeric(principal), op(OP_NUMEQUALVERIFY),
    op(OP_1, OP_OUTPUTVALUE, OP_0, OP_NUMEQUALVERIFY, OP_TXOUTPUTCOUNT, OP_2, OP_NUMEQUAL),
  ]);
  const digest = createHash('ripemd160').update(createHash('sha256').update(redeem).digest()).digest('hex');
  const script = 'a914' + digest + '87';
  return { id, operatorKey, payerKey:payer.publicKey, payeeKey:payee.publicKey, principal, refundAt,
    script, address:toAddress(script), redeemScript:hex(redeem), payer:payer.address, payee:payee.address,
    satoshis:principal+POLITICAL_ESCROW_FEE };
}

// Version 2 releases only an exactly funded principal. Either refund lane returns whatever was actually paid, less the fixed
// fee, so an under- or overpayment is never stranded. A payment too small to carry its own fee can be rescued with a fee sponsor.
function escrowV2({ id, operatorKey, payer, payee, principal, refundAt }) {
  const redeem = Buffer.concat([
    bytes('5642504502' + id), op(OP_DROP, OP_IF),
    bytes(operatorKey), op(OP_CHECKSIGVERIFY), ...recipientCheck(payee.script),
    op(OP_INPUTINDEX, OP_UTXOVALUE), numeric(principal + POLITICAL_ESCROW_FEE), op(OP_NUMEQUALVERIFY),
    op(OP_0, OP_OUTPUTVALUE), numeric(principal), op(OP_NUMEQUALVERIFY), op(OP_TXINPUTCOUNT, OP_1, OP_NUMEQUALVERIFY),
    op(OP_ELSE, OP_IF), bytes(operatorKey), op(OP_CHECKSIGVERIFY, OP_ELSE), numeric(refundAt),
    op(OP_CHECKLOCKTIMEVERIFY, OP_DROP), bytes(payer.publicKey), op(OP_CHECKSIGVERIFY, OP_ENDIF), ...recipientCheck(payer.script),
    op(OP_INPUTINDEX, OP_UTXOVALUE, OP_DUP), numeric(REFUND_FLOOR), op(OP_GREATERTHANOREQUAL, OP_IF), numeric(POLITICAL_ESCROW_FEE),
    op(OP_SUB, OP_ENDIF, OP_0, OP_OUTPUTVALUE, OP_SWAP, OP_GREATERTHANOREQUAL, OP_VERIFY),
    op(OP_ENDIF, OP_1, OP_OUTPUTVALUE, OP_0, OP_NUMEQUALVERIFY, OP_TXOUTPUTCOUNT, OP_2, OP_GREATERTHANOREQUAL),
  ]);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { id, version:2, operatorKey, payerKey:payer.publicKey, payeeKey:payee.publicKey, principal, refundAt,
    script, address:toAddress(script), redeemScript:hex(redeem), payer:payer.address, payee:payee.address,
    satoshis:principal+POLITICAL_ESCROW_FEE };
}

function signEscrowV2({ contract, source, privateKey, lane, eventScript, sponsor }) {
  const plan = politicalEscrow(contract);
  const owner = walletFromPrivateKey(privateKey);
  const payerRefund = lane === 'payer-refund';
  const release = lane === 'release';
  if (!['payer-refund','operator-refund','release'].includes(lane) ||
      owner.publicKey !== (payerRefund ? plan.payerKey : plan.operatorKey)) throw new Error('This key cannot sign the selected escrow branch.');
  const funding = normalizeSource(source);
  if (funding.script !== plan.script || funding.token || !/^6a(?:[0-9a-f]{2}){1,100}$/.test(eventScript)) {
    throw new Error('The funding output or commitment does not match this escrow.');
  }
  if (release && (funding.satoshis !== plan.satoshis || sponsor)) throw new Error('Only an exactly funded escrow can be released.');
  const destination = walletFromPublicKey(release ? plan.payeeKey : plan.payerKey);
  const selfFunded = funding.satoshis >= REFUND_FLOOR;
  if (!release && !selfFunded && !sponsor) throw new Error('This small payment needs a fee sponsor input to be returned.');
  const backer = sponsor && { key:sponsor.privateKey, wallet:walletFromPrivateKey(sponsor.privateKey), coin:normalizeSource(sponsor.source) };
  if (backer && (backer.coin.script !== backer.wallet.script || backer.coin.token)) throw new Error('The fee sponsor must spend its own plain BCH output.');
  const returned = release ? plan.principal : selfFunded ? funding.satoshis - POLITICAL_ESCROW_FEE : Math.max(funding.satoshis, 546);
  const outputs = [{lockingBytecode:fromHex(destination.script),valueSatoshis:BigInt(returned)},
    {lockingBytecode:fromHex(eventScript),valueSatoshis:0n}];
  const sponsorFee = 420 + (selfFunded ? 0 : POLITICAL_ESCROW_FEE);
  if (backer) {
    const change = backer.coin.satoshis + funding.satoshis - returned - sponsorFee;
    if (change < 0) throw new Error('The fee sponsor output is too small.');
    if (change >= 546) outputs.push({lockingBytecode:fromHex(backer.wallet.script),valueSatoshis:BigInt(change)});
  }
  const sequenceNumber = payerRefund ? 0xfffffffe : 0xffffffff;
  const transaction = { version:2, locktime:payerRefund ? plan.refundAt : 0,
    inputs:[{outpointTransactionHash:fromHex(funding.txid),outpointIndex:funding.vout,sequenceNumber,unlockingBytecode:new Uint8Array()},
      ...(backer ? [{outpointTransactionHash:fromHex(backer.coin.txid),outpointIndex:backer.coin.vout,sequenceNumber,unlockingBytecode:new Uint8Array()}] : [])],
    outputs };
  const sourceOutputs = [{lockingBytecode:fromHex(plan.script),valueSatoshis:BigInt(funding.satoshis)},
    ...(backer ? [{lockingBytecode:fromHex(backer.wallet.script),valueSatoshis:BigInt(backer.coin.satoshis)}] : [])];
  const type = Uint8Array.of(0x61);
  const sign = (inputIndex, coveredBytecode, key) => {
    const digest = hash256(generateSigningSerializationBCH({inputIndex,sourceOutputs,transaction},{coveredBytecode,signingSerializationType:type}));
    const signed = secp256k1.signMessageHashSchnorr(fromHex(key),digest);
    if (typeof signed === 'string') throw new Error('Could not sign the political escrow.');
    return encodeDataPush(Buffer.concat([signed,type]));
  };
  const escrowSignature = sign(0,fromHex(plan.redeemScript),privateKey);
  const sponsorUnlock = backer && Buffer.concat([sign(1,fromHex(backer.wallet.script),backer.key),bytes(backer.wallet.publicKey)]);
  transaction.inputs[0].unlockingBytecode = Buffer.concat([escrowSignature,
    release ? op(OP_1) : op(payerRefund ? OP_0 : OP_1,OP_0), bytes(plan.redeemScript)]);
  if (backer) transaction.inputs[1].unlockingBytecode = sponsorUnlock;
  const raw = encodeTransaction(transaction);
  const verified = createVirtualMachineBCH().verify({transaction:readTransaction(hex(raw)).transaction,sourceOutputs});
  if (verified !== true) throw new Error('Political escrow failed VM validation: '+verified);
  const feeSatoshis = Number(sourceOutputs.reduce((sum,item)=>sum+item.valueSatoshis,0n) - outputs.reduce((sum,item)=>sum+item.valueSatoshis,0n));
  if (raw.length > feeSatoshis) throw new Error('Escrow settlement would violate the minimum fee rate.');
  return {txid:hashTransaction(raw),rawHex:hex(raw),feeSatoshis,address:destination.address,script:destination.script,
    satoshis:returned};
}

export function signPoliticalEscrow({ contract, source, privateKey, lane, eventScript, sponsor }) {
  if ((contract.version ?? 1) === 2) return signEscrowV2({ contract, source, privateKey, lane, eventScript, sponsor });
  const plan = politicalEscrow(contract);
  const owner = walletFromPrivateKey(privateKey);
  const payerRefund = lane === 'payer-refund';
  const release = lane === 'release';
  if (!['payer-refund','operator-refund','release'].includes(lane) ||
      owner.publicKey !== (payerRefund ? plan.payerKey : plan.operatorKey)) throw new Error('This key cannot sign the selected escrow branch.');
  const funding = normalizeSource(source);
  if (funding.script !== plan.script || funding.satoshis !== plan.satoshis || funding.token ||
      !/^6a(?:[0-9a-f]{2}){1,100}$/.test(eventScript)) {
    throw new Error('The funding output or commitment does not match this escrow.');
  }
  const destination = walletFromPublicKey(release ? plan.payeeKey : plan.payerKey);
  const transaction = {
    version:2, locktime:payerRefund ? plan.refundAt : 0,
    inputs:[{outpointTransactionHash:fromHex(funding.txid),outpointIndex:funding.vout,
      sequenceNumber:payerRefund ? 0xfffffffe : 0xffffffff,unlockingBytecode:new Uint8Array()}],
    outputs:[{lockingBytecode:fromHex(destination.script),valueSatoshis:BigInt(plan.principal)},
      {lockingBytecode:fromHex(eventScript),valueSatoshis:0n}],
  };
  const sourceOutputs=[{lockingBytecode:fromHex(plan.script),valueSatoshis:BigInt(funding.satoshis)}];
  const type=Uint8Array.of(0x61);
  const serialization = generateSigningSerializationBCH({inputIndex:0,sourceOutputs,transaction},
    {coveredBytecode:fromHex(plan.redeemScript),signingSerializationType:type});
  const signed = secp256k1.signMessageHashSchnorr(fromHex(privateKey),hash256(serialization));
  if (typeof signed==='string') throw new Error('Could not sign the political escrow.');
  transaction.inputs[0].unlockingBytecode=Buffer.concat([
    encodeDataPush(Buffer.concat([signed,type])), release ? op(OP_1) : op(payerRefund ? OP_0 : OP_1,OP_0), bytes(plan.redeemScript),
  ]);
  const raw=encodeTransaction(transaction);
  const verified=createVirtualMachineBCH().verify({transaction:readTransaction(hex(raw)).transaction,sourceOutputs});
  if (verified!==true) throw new Error('Political escrow failed VM validation: '+verified);
  if (raw.length>POLITICAL_ESCROW_FEE) throw new Error('Escrow settlement would violate the minimum fee rate.');
  return {txid:hashTransaction(raw),rawHex:hex(raw),feeSatoshis:POLITICAL_ESCROW_FEE,address:destination.address,script:destination.script};
}
