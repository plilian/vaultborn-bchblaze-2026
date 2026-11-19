// The treaty escrow, step by step, for one XO account at a time. The offline test and the Chipnet runner both use these
// steps, so what is tested without a network is the code that runs on Chipnet.
import { Engine } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { deserializeInvitation, serializeInvitation } from '@xo-cash/utils';
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { treatyEscrowTemplate } from './treaty-escrow.template.mjs';

export const ESCROW_OUTPUT = 'escrowOutput';
export const PREFIX = { chipnet: 'bchtest', mainnet: 'bitcoincash', testnet4: 'bchtest' };
const OUTCOMES = {
  release: { action: 'releaseEscrow', input: 'releaseInput', output: 'recipientPayoutOutput', role: 'arbiter', destination: 'recipientLockingScript' },
  return: { action: 'returnEscrow', input: 'returnInput', output: 'payerPayoutOutput', role: 'arbiter', destination: 'payerLockingScript' },
  reclaim: { action: 'reclaimEscrow', input: 'reclaimInput', output: 'payerPayoutOutput', role: 'payer', destination: 'payerLockingScript' },
};

export const addressOf = (lockingBytecode, network) => {
  const encoded = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockingBytecode), prefix: PREFIX[network] });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
};

/** Opens one account and gives it the ordinary wallet template (for its own addresses and change) and the escrow template. */
export async function openAccount(mnemonic, { network, databasePath }) {
  const engine = await Engine.create(mnemonic, { network, databasePath });
  const wallet = (await engine.importTemplate(p2pkhTemplate)).templateIdentifier;
  await engine.setDefaultPolicies({ change: { templateIdentifier: wallet }, receive: { templateIdentifier: wallet }, address: { templateIdentifier: wallet } });
  const templateIdentifier = (await engine.importTemplate(treatyEscrowTemplate)).templateIdentifier;
  return { engine, templateIdentifier, network };
}

export const newAddress = (account) => account.engine.generateLockingBytecodeFromDefaultPolicy('receive');
export const exportInvitation = async (account, invitationIdentifier) =>
  serializeInvitation((await account.engine.getInvitation(invitationIdentifier)).invitation);
const variable = (roleIdentifier, variableIdentifier, value) => ({ variableIdentifier, roleIdentifier, value });

/** Payer: starts the invitation with the terms of the escrow. Returns the invitation identifier. */
export async function createEscrow(account, { treatyIdentifier, principalSatoshis, expiryTime, payerLockingScript }) {
  if (!/^[0-9a-f]{32}$/.test(treatyIdentifier)) throw new Error('The treaty identifier is 32 hexadecimal characters.');
  if (BigInt(principalSatoshis) < 2000n) throw new Error('Lock at least 2000 satoshis so the payout stays above the dust limit.');
  const created = await account.engine.createInvitation({ templateIdentifier: account.templateIdentifier, actionIdentifier: 'openEscrow',
    intent: treatyEscrowTemplate.start[0],
    variables: [variable('payer', 'treatyIdentifier', treatyIdentifier), variable('payer', 'principalSatoshis', BigInt(principalSatoshis)),
      variable('payer', 'expiryTime', BigInt(expiryTime)), variable('payer', 'payerLockingScript', payerLockingScript)] });
  return created.invitation.invitationIdentifier;
}

/** Recipient: joins and names the address a release pays. */
export async function joinAsRecipient(account, serialized, recipientLockingScript) {
  const invitation = deserializeInvitation(serialized);
  await account.engine.acceptInvitation(invitation, { roleIdentifier: 'recipient' });
  await account.engine.appendInvitation(invitation.invitationIdentifier, { templateIdentifier: account.templateIdentifier, actionIdentifier: 'openEscrow',
    variables: [variable('recipient', 'recipientLockingScript', recipientLockingScript)] });
  return invitation.invitationIdentifier;
}

/** Arbiter: joins, which creates its key, and adds the public key the contract needs. */
export async function joinAsArbiter(account, serialized) {
  const invitation = deserializeInvitation(serialized);
  await account.engine.acceptInvitation(invitation, { roleIdentifier: 'arbiter' });
  await account.engine.appendOwnOutputResolutions(invitation.invitationIdentifier, ESCROW_OUTPUT, 'arbiter');
  return invitation.invitationIdentifier;
}

/** Any participant: takes in the newest copy of an invitation it already holds. */
export async function syncInvitation(account, serialized) {
  const invitation = deserializeInvitation(serialized);
  await account.engine.updateInvitation(invitation);
  return invitation.invitationIdentifier;
}

/** Payer: adds its public key, pays the escrow from one of its own coins, signs and executes. Returns the transaction. */
export async function fundEscrow(account, invitationIdentifier, { broadcast = true } = {}) {
  const { engine, templateIdentifier } = account;
  const owed = await engine.listOutputResolutions(invitationIdentifier, ESCROW_OUTPUT, 'payer');
  if (owed.missingIdentifiers.length) throw new Error('Still waiting for: ' + owed.missingIdentifiers.join(', '));
  if (owed.ownResolutions.length) await engine.appendOwnOutputResolutions(invitationIdentifier, ESCROW_OUTPUT, 'payer');
  const coins = (await engine.listSpendableUnspentOutputs()).sort((a, b) => b.valueSatoshis - a.valueSatoshis);
  if (!coins.length) throw new Error('The payer account has no spendable coin.');
  await engine.appendInvitation(invitationIdentifier, { templateIdentifier, actionIdentifier: 'openEscrow',
    inputs: [{ outpointTransactionHash: hexToBin(coins[0].outpointTransactionHash), outpointIndex: coins[0].outpointIndex }],
    outputs: [{ outputIdentifier: ESCROW_OUTPUT, roleIdentifier: 'payer' }] });
  await engine.addChangeToInvitation(invitationIdentifier);
  for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) await engine.signInvitation(invitationIdentifier, inputIndex);
  return execute(account, invitationIdentifier, broadcast);
}

/** The escrow coins this account tracks, each with the terms stored when the escrow was opened. */
export async function listEscrows(account) {
  const held = [];
  for (const coin of await account.engine.listUnspentOutputs()) {
    if (coin.templateIdentifier !== account.templateIdentifier) continue;
    const [script] = await account.engine.listScriptHashData({ scriptHash: coin.scriptHash });
    if (script?.lockingScriptIdentifier === 'escrowLockingScript') held.push({ coin, terms: script.variables, role: script.roleIdentifier });
  }
  return held;
}

/**
 * Follow-up action on an escrow coin: 'release' or 'return' by the arbiter, 'reclaim' by the payer after the expiry time.
 * `destination` exists for the tests only; a destination other than the one in the contract is refused by the network.
 */
export async function settleEscrow(account, escrow, outcome, { broadcast = true, destination } = {}) {
  const plan = OUTCOMES[outcome];
  if (!plan) throw new Error('The outcome is release, return or reclaim.');
  const { engine, templateIdentifier } = account;
  const intent = treatyEscrowTemplate.lockingScripts.escrowLockingScript.roles[plan.role].actions.find((item) => item.action === plan.action);
  const variables = [variable(plan.role, 'principalSatoshis', BigInt(escrow.terms.principalSatoshis)),
    variable(plan.role, plan.destination, destination ?? escrow.terms[plan.destination])];
  if (outcome === 'reclaim') variables.push(variable(plan.role, 'expiryTime', BigInt(escrow.terms.expiryTime)));
  const created = await engine.createInvitation({ templateIdentifier, actionIdentifier: plan.action, intent, variables,
    inputs: [{ outpointTransactionHash: hexToBin(escrow.coin.outpointTransactionHash), outpointIndex: escrow.coin.outpointIndex, inputIdentifier: plan.input }] });
  const { invitationIdentifier } = created.invitation;
  await engine.appendInvitation(invitationIdentifier, { templateIdentifier, actionIdentifier: plan.action, outputs: [{ outputIdentifier: plan.output }] });
  try {
    await engine.signInvitation(invitationIdentifier, 0);
    return { invitationIdentifier, ...(await execute(account, invitationIdentifier, broadcast)) };
  } catch (error) {
    // A refused settlement must not keep the escrow coin reserved, or no later attempt could spend it.
    await engine.archiveInvitation(invitationIdentifier).catch(() => {});
    throw error;
  }
}

async function execute(account, invitationIdentifier, broadcast) {
  const missing = await account.engine.listMissingRequirements(invitationIdentifier);
  if (Object.keys(missing.templateRequirements).length || missing.inputsMissingSignatures.length || missing.participants.length) {
    throw new Error('The invitation is not complete: ' + JSON.stringify(missing, (key, value) => typeof value === 'bigint' ? String(value) : value));
  }
  const { builtTransaction } = await account.engine.executeAction(invitationIdentifier, { broadcastTransaction: broadcast });
  return { transactionHash: builtTransaction.transactionHash, serializedTransaction: builtTransaction.serializedTransaction,
    bytes: builtTransaction.transactionByteLength, invitation: await exportInvitation(account, invitationIdentifier) };
}
