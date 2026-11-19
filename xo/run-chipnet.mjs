// Opens a treaty escrow on Chipnet with three XO accounts and settles it, then saves the two invitations and the
// transaction identifiers under xo/evidence/. It stops and tells you what to do when the payer account needs test coins,
// and continues from where it stopped when you run it again.
//
//   node run-chipnet.mjs                     open, then the arbiter releases to the recipient
//   node run-chipnet.mjs --outcome return    open, then the arbiter returns to the payer
//   node run-chipnet.mjs --simulate          the same steps against the local test chain; proves nothing about Chipnet
//
// The accounts are created on this computer for Chipnet only (var/ is not committed). Never put real money on them.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBip39Mnemonic } from '@bitauth/libauth';
import { addressOf } from './flow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const option = (name, fallback) => { const index = process.argv.indexOf('--' + name); return index < 0 ? fallback : process.argv[index + 1]; };
const simulate = process.argv.includes('--simulate');
const outcome = option('outcome', 'release');
if (!['release', 'return'].includes(outcome)) throw new Error('The outcome is release or return.');
const workdir = simulate ? join(here, 'var', 'simulated-' + Date.now()) : join(here, 'var', 'chipnet');
const evidence = simulate ? join(workdir, 'evidence') : join(here, 'evidence');
mkdirSync(workdir, { recursive: true });
const file = (name) => join(workdir, name);
const state = () => JSON.parse(readFileSync(file('run.json'), 'utf8'));

if (!existsSync(file('accounts.json'))) {
  writeFileSync(file('accounts.json'), JSON.stringify({ payer: generateBip39Mnemonic(), recipient: generateBip39Mnemonic(), arbiter: generateBip39Mnemonic() }, null, 2));
  try { chmodSync(file('accounts.json'), 0o600); } catch { /* Windows keeps its own permissions */ }
}
if (!existsSync(file('run.json'))) {
  writeFileSync(file('run.json'), JSON.stringify({ network: 'chipnet', simulated: simulate, principalSatoshis: Number(option('principal', 5000)), expiryHours: 6, done: [] }, null, 2));
}
const environment = { ...process.env, ...(simulate && { XO_SIM_CHAIN: file('chain.json') }) };
function step(role, name, argument) {
  const key = `${role}:${name}`;
  if (state().done.includes(key)) return;
  console.log(`- ${role}: ${name}${argument ? ' ' + argument : ''}`);
  const result = spawnSync(process.execPath, [...(simulate ? ['--import', './sim/register.mjs'] : []), 'role-step.mjs', role, name, workdir, ...(argument ? [String(argument)] : [])],
    { cwd: here, env: environment, stdio: 'inherit' });
  if (result.status !== 0) {
    console.log('\nStopped at this step. Nothing is lost: run the same command again to continue.');
    process.exit(1);
  }
  const next = state();
  next.done.push(key);
  writeFileSync(file('run.json'), JSON.stringify(next, null, 2));
}

for (const role of ['payer', 'recipient', 'arbiter']) step(role, 'address');
if (!state().done.includes('payer:create')) {
  const run = state();
  if (simulate) step('payer', 'simulated-coin');
  else console.log(`\nSend at least ${run.principalSatoshis + 1000} Chipnet satoshis to the payer account:\n\n    ${addressOf(run.fundingAddress, 'chipnet')}\n\n` +
    'A faucet such as https://tbch.googol.cash/ pays that address. This window waits up to 20 minutes for the coin.\n');
}
step('payer', 'create');
step('recipient', 'join');
step('arbiter', 'join');
step('payer', 'fund');
step('recipient', 'sync');
step('arbiter', 'sync');
step('arbiter', 'settle', outcome);

const run = state();
const engine = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).dependencies;
mkdirSync(evidence, { recursive: true });
copyFileSync(file('open-invitation.json'), join(evidence, 'open-invitation.json'));
copyFileSync(file('settle-invitation.json'), join(evidence, 'settle-invitation.json'));
const explorer = 'https://chipnet.imaginary.cash/tx/';
writeFileSync(join(evidence, 'run.json'), JSON.stringify({
  network: simulate ? 'SIMULATED local chain, not a public network' : 'chipnet',
  template: 'VaultBorn Treaty Escrow', templateIdentifier: run.templateIdentifier, packages: engine,
  terms: { ...run.terms, payerAddress: addressOf(run.terms.payerLockingScript, 'chipnet'), recipientAddress: addressOf(run.terms.recipientLockingScript, 'chipnet') },
  open: { action: 'openEscrow', ...run.open, ...(simulate ? {} : { explorer: explorer + run.open.transactionHash }), invitation: 'open-invitation.json' },
  settle: { action: run.settle.outcome === 'release' ? 'releaseEscrow' : 'returnEscrow', ...run.settle, ...(simulate ? {} : { explorer: explorer + run.settle.transactionHash }), invitation: 'settle-invitation.json' },
}, null, 2));
console.log(`\nDone${simulate ? ' (SIMULATED, not Chipnet)' : ''}.\n  opened:  ${run.open.transactionHash}\n  ${run.settle.outcome}: ${run.settle.transactionHash}\n  saved in ${evidence}`);
