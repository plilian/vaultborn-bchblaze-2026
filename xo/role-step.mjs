// One step of the escrow for one account, in its own process: the engine keeps a single network connection per process,
// so each account is opened, does its part, and is closed again. Run by run-chipnet.mjs; not meant to be called by hand.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { addressOf, createEscrow, exportInvitation, fundEscrow, joinAsArbiter, joinAsRecipient, listEscrows, newAddress, openAccount, settleEscrow, syncInvitation } from './flow.mjs';

const [role, step, workdir, argument] = process.argv.slice(2);
const path = (name) => join(workdir, name);
const read = (name) => JSON.parse(readFileSync(path(name), 'utf8'));
const write = (name, value) => writeFileSync(path(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const run = read('run.json');
const update = (changes) => { Object.assign(run, changes); write('run.json', run); };
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(label, probe, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  for (let announced = false; ; await wait(5000)) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > deadline) throw new Error('Gave up waiting for ' + label + '. Run the same command again to continue from this point.');
    if (!announced) { console.log('  waiting for ' + label + ' …'); announced = true; }
  }
}

mkdirSync(path(role + '-db'), { recursive: true });
const account = await openAccount(read('accounts.json')[role], { network: run.network, databasePath: path(role + '-db') });
let failure;
try {
  if (step === 'address') {
    if (!run[role + 'Address']) update({ [role + 'Address']: await newAddress(account) });
    if (role === 'payer' && !run.fundingAddress) update({ fundingAddress: await newAddress(account) });
    update({ templateIdentifier: account.templateIdentifier });
  } else if (role === 'payer' && step === 'create') {
    const needed = run.principalSatoshis + 1000;
    await until(`${needed} satoshis at ${addressOf(run.fundingAddress, run.network)}`, async () =>
      (await account.engine.listSpendableUnspentOutputs()).some((coin) => coin.valueSatoshis >= needed), Number(argument ?? 20));
    const terms = { treatyIdentifier: run.treatyIdentifier ?? randomBytes(16).toString('hex'), principalSatoshis: run.principalSatoshis,
      expiryTime: Math.floor(Date.now() / 1000) + run.expiryHours * 3600, payerLockingScript: run.payerAddress };
    const invitationIdentifier = await createEscrow(account, terms);
    write('open-invitation.json', await exportInvitation(account, invitationIdentifier));
    update({ invitationIdentifier, terms: { ...terms, recipientLockingScript: run.recipientAddress } });
  } else if (role === 'recipient' && step === 'join') {
    const id = await joinAsRecipient(account, readFileSync(path('open-invitation.json'), 'utf8'), run.recipientAddress);
    write('open-invitation.json', await exportInvitation(account, id));
  } else if (role === 'arbiter' && step === 'join') {
    const id = await joinAsArbiter(account, readFileSync(path('open-invitation.json'), 'utf8'));
    write('open-invitation.json', await exportInvitation(account, id));
  } else if (role === 'payer' && step === 'fund') {
    await syncInvitation(account, readFileSync(path('open-invitation.json'), 'utf8'));
    const funded = await fundEscrow(account, run.invitationIdentifier);
    write('open-invitation.json', funded.invitation);
    update({ open: { transactionHash: funded.transactionHash, bytes: funded.bytes, at: new Date().toISOString() } });
  } else if (step === 'sync') {
    await syncInvitation(account, readFileSync(path('open-invitation.json'), 'utf8'));
  } else if (step === 'settle') {
    const outcome = argument;
    const escrow = await until('the escrow coin to reach this account', async () =>
      (await listEscrows(account)).find((item) => item.terms.treatyIdentifier === run.terms.treatyIdentifier), 5);
    const settled = await settleEscrow(account, escrow, outcome);
    write('settle-invitation.json', settled.invitation);
    update({ settle: { outcome, transactionHash: settled.transactionHash, bytes: settled.bytes, at: new Date().toISOString() } });
  } else if (step === 'simulated-coin') {
    const { fund } = await import('./sim/fake-electrum.mjs');
    await fund(run.fundingAddress, run.principalSatoshis + 5000);
  } else {
    throw new Error(`Unknown step ${role} ${step}.`);
  }
} catch (error) {
  failure = error;
}
await account.engine.stop().catch(() => {});
if (failure) { console.error('  ' + (failure.message ?? failure)); process.exit(1); }
process.exit(0);
