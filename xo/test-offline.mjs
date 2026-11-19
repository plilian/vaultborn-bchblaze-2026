// Runs the real XO engine against a local chain (sim/fake-electrum.mjs) that checks every transaction with the BCH virtual
// machine. Nothing here touches a public network; it shows that the template works in the engine, not that it ran on Chipnet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTransaction, hexToBin, binToHex } from '@bitauth/libauth';
import { deserializeInvitation, serializeTemplate } from '@xo-cash/utils';
import { chain, fund } from './sim/fake-electrum.mjs';
import { treatyEscrowTemplate } from './treaty-escrow.template.mjs';
import { createEscrow, exportInvitation, fundEscrow, joinAsArbiter, joinAsRecipient, listEscrows, newAddress, openAccount, settleEscrow, syncInvitation } from './flow.mjs';

// Published BIP39 test vectors: these words are public and must never hold money.
const WORDS = {
  payer: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  recipient: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  arbiter: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
};
const FEE = 600;
const accounts = {};
const balance = async (account) => (await account.engine.listSpendableUnspentOutputs()).reduce((sum, coin) => sum + coin.valueSatoshis, 0);
let serial = 0;

async function open({ principal = 5000, expiresIn = -7200 } = {}) {
  const { payer, recipient, arbiter } = accounts;
  const terms = { treatyIdentifier: (++serial).toString(16).padStart(32, '0'), principalSatoshis: principal, expiryTime: chain.time + expiresIn,
    payerLockingScript: await newAddress(payer), recipientLockingScript: await newAddress(recipient) };
  const id = await createEscrow(payer, terms);
  await joinAsRecipient(recipient, await exportInvitation(payer, id), terms.recipientLockingScript);
  await joinAsArbiter(arbiter, await exportInvitation(recipient, id));
  await syncInvitation(payer, await exportInvitation(arbiter, id));
  const funded = await fundEscrow(payer, id);
  await syncInvitation(recipient, funded.invitation);
  await syncInvitation(arbiter, funded.invitation);
  return { terms, funded, id };
}
const find = async (account, terms) => (await listEscrows(account)).find((item) => item.terms.treatyIdentifier === terms.treatyIdentifier);

test.before(async () => {
  for (const [role, words] of Object.entries(WORDS)) accounts[role] = await openAccount(words, { network: 'chipnet', databasePath: mkdtempSync(join(tmpdir(), 'xo-' + role + '-')) });
  await fund(await newAddress(accounts.payer), 100_000);
});
test.after(async () => { for (const account of Object.values(accounts)) await account.engine.stop(); });

test('the template is valid, survives export, and its contract uses the same fee as its outputs', async () => {
  const exported = serializeTemplate(treatyEscrowTemplate);
  assert.equal(readFileSync(new URL('./treaty-escrow.template.json', import.meta.url), 'utf8').trim(), exported, 'run "npm run build" after changing the template');
  assert.equal((await accounts.arbiter.engine.importTemplate(exported)).templateIdentifier, accounts.arbiter.templateIdentifier);
  assert.equal(treatyEscrowTemplate.constants.settlementFeeSatoshis.value, FEE);
  assert.match(treatyEscrowTemplate.scripts.escrowRedeemScript, new RegExp(`OP_UTXOVALUE <${FEE}> OP_SUB`));
  assert.equal(new Set(Object.values(accounts).map((account) => account.templateIdentifier)).size, 1);
});

test('three accounts open an escrow; every one of them tracks it and none can spend it as an ordinary coin', async () => {
  const before = await balance(accounts.payer);
  const { terms, funded } = await open();
  const transaction = decodeTransaction(hexToBin(funded.serializedTransaction));
  const escrowOutput = transaction.outputs.find((output) => output.valueSatoshis === 5000n);
  assert.equal(escrowOutput.lockingBytecode.length, 35, 'pay to script hash 32');
  assert.deepEqual([escrowOutput.lockingBytecode[0], escrowOutput.lockingBytecode[1], escrowOutput.lockingBytecode[34]], [0xaa, 0x20, 0x87]);
  for (const role of ['payer', 'recipient', 'arbiter']) {
    const held = await find(accounts[role], terms);
    assert.equal(held.role, role);
    assert.equal(held.coin.selectable, false);
    assert.equal(held.terms.recipientLockingScript, terms.recipientLockingScript);
  }
  assert.ok(before - (await balance(accounts.payer)) - 5000 <= 500, 'network fee of the opening transaction');
  const shared = deserializeInvitation(funded.invitation);
  assert.equal(shared.actionIdentifier, 'openEscrow');
});

test('the arbiter releases to the recipient named in the contract', async () => {
  const { terms } = await open();
  const before = await balance(accounts.recipient);
  const settled = await settleEscrow(accounts.arbiter, await find(accounts.arbiter, terms), 'release');
  const transaction = decodeTransaction(hexToBin(settled.serializedTransaction));
  assert.equal(transaction.inputs.length, 1);
  assert.equal(binToHex(transaction.outputs[0].lockingBytecode), terms.recipientLockingScript);
  assert.equal(transaction.outputs[0].valueSatoshis, 5000n - BigInt(FEE));
  assert.equal(await balance(accounts.recipient), before + 5000 - FEE);
  assert.equal(await find(accounts.arbiter, terms), undefined);
  assert.equal(chain.accepted.at(-1).txid, settled.transactionHash);
});

test('the arbiter returns to the payer', async () => {
  const { terms } = await open();
  const before = await balance(accounts.payer);
  const settled = await settleEscrow(accounts.arbiter, await find(accounts.arbiter, terms), 'return');
  assert.equal(binToHex(decodeTransaction(hexToBin(settled.serializedTransaction)).outputs[0].lockingBytecode), terms.payerLockingScript);
  assert.equal(await balance(accounts.payer), before + 5000 - FEE);
});

test('the arbiter cannot send the escrow anywhere else', async () => {
  const { terms } = await open();
  const elsewhere = await newAddress(accounts.arbiter);
  const refused = /virtual machine refused/;
  await assert.rejects(settleEscrow(accounts.arbiter, await find(accounts.arbiter, terms), 'release', { destination: elsewhere }), refused);
  await assert.rejects(settleEscrow(accounts.arbiter, await find(accounts.arbiter, terms), 'return', { destination: elsewhere }), refused);
  assert.equal(await balance(accounts.arbiter), 0);
  // The coin is still there and the honest outcome still works.
  await settleEscrow(accounts.arbiter, await find(accounts.arbiter, terms), 'return');
});

test('the payer reclaims alone, but only after the expiry time', async () => {
  const { terms } = await open({ expiresIn: 3600 });
  await assert.rejects(settleEscrow(accounts.payer, await find(accounts.payer, terms), 'reclaim'), /non-final/);
  chain.time += 7200;
  const before = await balance(accounts.payer);
  const settled = await settleEscrow(accounts.payer, await find(accounts.payer, terms), 'reclaim');
  const transaction = decodeTransaction(hexToBin(settled.serializedTransaction));
  assert.equal(transaction.locktime, terms.expiryTime);
  assert.equal(binToHex(transaction.outputs[0].lockingBytecode), terms.payerLockingScript);
  assert.equal(await balance(accounts.payer), before + 5000 - FEE);
});
