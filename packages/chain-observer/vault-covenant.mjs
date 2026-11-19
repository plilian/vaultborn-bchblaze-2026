import { cashAssemblyToBin, createVirtualMachineBCH, encodeDataPush, encodeTransaction, generateSigningSerializationBCH,
  hashTransaction, secp256k1 } from '@bitauth/libauth';
import { fromHex, hash256, hex, normalizeSource, publicBytes, readTransaction, toAddress, walletFromPrivateKey, walletFromPublicKey } from './primitives.mjs';

// Personal War Vault custody. A deposit is locked to this script instead of an operator-only output.
//
// Lane 1, assisted withdrawal: the operator signs, but the script lets the money go to one place only: the owner's own
// wallet script, with optional change back into this same vault and an optional zero-value record. The operator can
// therefore neither take a deposit nor redirect it. At most `maxFee` satoshis may leave as the network fee.
// Lane 0, owner recovery: after `recoverAt` the owner's key alone spends the output anywhere. No server, operator key
// or game state is needed, so a lost operator key or a dead server cannot strand a deposit.
export const VAULT_COVENANT = 'vault-covenant-v1';
export const VAULT_MAX_FEE = 1000;
const P2SH32_DUST = 576;
const type = Uint8Array.of(0x61);
const push = value => `<0x${value}>`;

export function vaultCovenant({ id, operatorKey, ownerKey, recoverAt, maxFee = VAULT_MAX_FEE }) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('A vault needs its 16-byte deposit ID.');
  if (!Number.isInteger(recoverAt) || recoverAt < 500_000_000 || recoverAt >= 0xffffffff) throw new Error('A vault needs an absolute recovery time in seconds.');
  if (!Number.isInteger(maxFee) || maxFee < 400 || maxFee > 5000) throw new Error('Choose a vault fee cap from 400 to 5,000 satoshis.');
  const operator = hex(publicBytes(operatorKey));
  const owner = walletFromPublicKey(hex(publicBytes(ownerKey)));
  if (operator.slice(2) === owner.publicKey.slice(2)) throw new Error('The operator and the vault owner must have different keys.');
  const source = `${push('5642564c31' + id)} OP_DROP
    OP_INPUTINDEX OP_UTXOTOKENCATEGORY OP_0 OP_EQUALVERIFY
    OP_IF
      ${push(operator)} OP_CHECKSIGVERIFY
      OP_TXINPUTCOUNT OP_1 OP_NUMEQUALVERIFY
      OP_TXOUTPUTCOUNT OP_3 OP_LESSTHANOREQUAL OP_VERIFY
      OP_0 OP_OUTPUTBYTECODE ${push(owner.script)} OP_EQUALVERIFY
      OP_0 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY
      OP_0 OP_OUTPUTVALUE
      OP_TXOUTPUTCOUNT OP_1 OP_GREATERTHAN OP_IF
        OP_1 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUAL
        OP_IF OP_1 OP_OUTPUTTOKENCATEGORY OP_0 OP_EQUALVERIFY OP_1 OP_OUTPUTVALUE OP_ADD
        OP_ELSE OP_1 OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF
      OP_ENDIF
      OP_TXOUTPUTCOUNT OP_2 OP_GREATERTHAN OP_IF OP_2 OP_OUTPUTVALUE OP_0 OP_NUMEQUALVERIFY OP_ENDIF
      OP_INPUTINDEX OP_UTXOVALUE <${maxFee}> OP_SUB OP_GREATERTHANOREQUAL
    OP_ELSE
      <${recoverAt}> OP_CHECKLOCKTIMEVERIFY OP_DROP ${push(owner.publicKey)} OP_CHECKSIG
    OP_ENDIF`;
  const redeem = cashAssemblyToBin(source);
  if (typeof redeem === 'string') throw new Error(redeem);
  const script = 'aa20' + hex(hash256(redeem)) + '87';
  return { id, version: VAULT_COVENANT, operatorKey: operator, ownerKey: owner.publicKey, ownerAddress: owner.address, ownerScript: owner.script,
    recoverAt, maxFee, script, address: toAddress(script), redeemScript: hex(redeem) };
}

function build(contract, source, outputs, locktime = 0) {
  const funding = normalizeSource(source);
  if (funding.script !== contract.script || funding.token) throw new Error('The source is not this vault output.');
  const transaction = { version: 2, locktime, inputs: [{ outpointTransactionHash: fromHex(funding.txid), outpointIndex: funding.vout,
    sequenceNumber: locktime ? 0xfffffffe : 0xffffffff, unlockingBytecode: new Uint8Array() }],
    outputs: outputs.map(item => ({ lockingBytecode: fromHex(item.script), valueSatoshis: BigInt(item.satoshis) })) };
  const sourceOutputs = [{ lockingBytecode: fromHex(contract.script), valueSatoshis: BigInt(funding.satoshis) }];
  return { funding, transaction, sourceOutputs };
}

function finish(contract, plan, privateKey, selector) {
  const digest = hash256(generateSigningSerializationBCH({ inputIndex: 0, transaction: plan.transaction, sourceOutputs: plan.sourceOutputs },
    { coveredBytecode: fromHex(contract.redeemScript), signingSerializationType: type }));
  const signature = secp256k1.signMessageHashSchnorr(fromHex(privateKey), digest);
  if (typeof signature === 'string') throw new Error('Could not sign the vault spend.');
  plan.transaction.inputs[0].unlockingBytecode = Buffer.concat([encodeDataPush(Buffer.concat([signature, type])),
    Uint8Array.of(selector ? 0x51 : 0x00), encodeDataPush(fromHex(contract.redeemScript))]);
  const raw = encodeTransaction(plan.transaction);
  const verdict = createVirtualMachineBCH().verify({ transaction: readTransaction(hex(raw)).transaction, sourceOutputs: plan.sourceOutputs });
  if (verdict !== true) throw new Error('The vault covenant rejected this spend: ' + verdict);
  const fee = Number(plan.sourceOutputs[0].valueSatoshis - plan.transaction.outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n));
  if (fee < raw.length) throw new Error('The vault spend would violate the minimum fee rate.');
  return { txid: hashTransaction(raw), rawHex: hex(raw), feeSatoshis: fee };
}

// Plans an assisted withdrawal. `satoshis` undefined pays the whole output to the owner.
export function planVaultWithdrawal(descriptor, source, { satoshis, eventScript } = {}) {
  const contract = vaultCovenant(descriptor);
  const funding = normalizeSource(source);
  const record = eventScript ? [{ script: eventScript, satoshis: 0 }] : [];
  if (eventScript && !/^6a(?:[0-9a-f]{2}){1,100}$/.test(eventScript)) throw new Error('Invalid vault record output.');
  const bytes = fee => 10 + 41 + 70 + 3 + contract.redeemScript.length / 2 + 34 + fee;
  const withChange = bytes(44 + (eventScript ? 9 + eventScript.length / 2 : 0)) + 10;
  const whole = bytes(eventScript ? 9 + eventScript.length / 2 : 0) + 10;
  if (Math.max(withChange, whole) > contract.maxFee) throw new Error('The vault fee cap cannot cover this spend.');
  const requested = satoshis ?? funding.satoshis - whole;
  if (!Number.isSafeInteger(requested) || requested < 546) throw new Error('The vault output is too small to withdraw.');
  const remainder = funding.satoshis - requested - withChange;
  if (satoshis !== undefined && remainder < 0 && funding.satoshis - requested - whole < 0) throw new Error('This vault output does not cover the amount and network fee.');
  // A remainder too small to stand as a vault output is paid to the owner with the withdrawal.
  const change = satoshis !== undefined && remainder >= P2SH32_DUST ? remainder : 0;
  const paid = change ? requested : funding.satoshis - whole;
  const outputs = [{ script: contract.ownerScript, satoshis: paid }, ...(change ? [{ script: contract.script, satoshis: change }] : []), ...record];
  return { contract, ...build(contract, funding, outputs), paid, change, feeSatoshis: funding.satoshis - paid - change };
}

export const signVaultWithdrawal = (plan, operatorPrivateKey) => {
  if (walletFromPrivateKey(operatorPrivateKey).publicKey !== plan.contract.operatorKey) throw new Error('This key is not the vault operator.');
  return finish(plan.contract, plan, operatorPrivateKey, true);
};

// Owner-only recovery after the timeout. Any outputs; the owner chooses the fee.
export function signVaultRecovery(descriptor, source, ownerPrivateKey, outputs) {
  const contract = vaultCovenant(descriptor);
  if (walletFromPrivateKey(ownerPrivateKey).publicKey !== contract.ownerKey) throw new Error('This key is not the vault owner.');
  return finish(contract, build(contract, source, outputs, contract.recoverAt), ownerPrivateKey, false);
}
