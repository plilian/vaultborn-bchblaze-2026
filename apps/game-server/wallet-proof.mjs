// How a WizardConnect wallet proves that it holds a key, the moment it connects, without the player doing anything
// but approving it in the wallet.
//
// WizardConnect wallets sign transactions, not messages. So the game asks the wallet to sign a PROOF TRANSACTION:
//   input 0    one coin that does not exist. Its identifier is the hash of the statement below, so no real coin can
//              ever have it. The game says it is worth 1,000 satoshis and locked to the wallet's first address.
//   output 0   the same 1,000 satoshis back to the same address, so the wallet shows "nothing leaves this wallet".
//   output 1   a data record carrying the hash of the statement.
// The signature covers all of it (statement, site, purpose, expiry, one-time number). The transaction is never sent,
// and could not be confirmed if someone sent it, because its only input does not exist. It moves no BCH and costs
// nothing. A valid signature shows what a signed message would show: the signer holds the key of that address.
import { createHash } from 'node:crypto';
import { createVirtualMachineBCH, encodeTransaction } from '@bitauth/libauth';
import { fromHex, hex, readTransaction, walletFromPublicKey } from '../../packages/chain-observer/primitives.mjs';
import { NETWORK_ID, NETWORK_LABEL } from '../../config/network.mjs';

const VALUE = 1000;
const sha256 = text => createHash('sha256').update(text).digest();
const unsigned = transaction => hex(encodeTransaction({ ...transaction, inputs: transaction.inputs.map(input => ({ ...input, unlockingBytecode: new Uint8Array() })) }));

/** The proof transaction for one statement. Deterministic: the server rebuilds it when the signature comes back. */
export function proofPlan({ publicKey, origin, nonce, expiresAt }) {
  const wallet = walletFromPublicKey(publicKey);
  const statement = `VaultBorn wallet proof\nNetwork: ${NETWORK_ID}\nSite: ${origin}\nAddress: ${wallet.address}\nExpires: ${new Date(expiresAt * 1000).toISOString()}\nNonce: ${nonce}\nThis proves the wallet is yours. It sends nothing and spends nothing.`;
  const coin = hex(sha256('vaultborn proof coin\n' + statement));
  const record = '6a' + '04' + Buffer.from('VBPF').toString('hex') + '20' + hex(sha256(statement));
  const transaction = hex(encodeTransaction({ version: 2, locktime: 0,
    inputs: [{ outpointTransactionHash: fromHex(coin), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: fromHex(wallet.script), valueSatoshis: BigInt(VALUE) }, { lockingBytecode: fromHex(record), valueSatoshis: 0n }] }));
  return { wallet, statement, transaction,
    sourceOutputs: [{ lockingBytecode: wallet.script, valueSatoshis: `<bigint: ${VALUE}n>`, outpointTransactionHash: coin, outpointIndex: 0, unlockingBytecode: '', sequenceNumber: 0xffffffff }],
    inputPaths: [[0, 'receive', 0]],
    userPrompt: 'VAULTBORN ' + NETWORK_LABEL + ' · prove this wallet is yours · sends nothing, spends nothing, never broadcast' };
}

/** True when `signedTransaction` is exactly the proof transaction of this statement, signed by the key of its address. */
export function proofIsValid(statementFields, signedTransaction) {
  try {
    if (typeof signedTransaction !== 'string' || signedTransaction.length > 2000) return false;
    const plan = proofPlan(statementFields);
    const { transaction } = readTransaction(signedTransaction);
    if (unsigned(transaction) !== plan.transaction) return false;
    // The unlocking data must be an ordinary signature and this very public key; the virtual machine checks the signature.
    const unlock = transaction.inputs[0].unlockingBytecode;
    const key = fromHex(plan.wallet.publicKey);
    if (unlock.length < 100 || hex(unlock.subarray(unlock.length - 33)) !== hex(key) || unlock[unlock.length - 34] !== 33) return false;
    return createVirtualMachineBCH().verify({ transaction, sourceOutputs: [{ lockingBytecode: fromHex(plan.wallet.script), valueSatoshis: BigInt(VALUE) }] }) === true;
  } catch { return false; }
}
