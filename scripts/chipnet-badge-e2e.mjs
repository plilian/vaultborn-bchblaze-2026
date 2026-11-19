import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

if (!process.env.CHIPNET_FIXTURE_FILE || process.env.CHIPNET_TEST_APPROVE !== 'true') {
  throw new Error('Set CHIPNET_TEST_APPROVE=true and choose an explicitly funded fixture file.');
}
const fixture = JSON.parse(await readFile(process.env.CHIPNET_FIXTURE_FILE));
const { priv: sourceKey } = fixture.sponsor ?? fixture.player;
const owner = walletFromPrivateKey(sourceKey);
const treasury = walletFromPrivateKey(fixture.treasury.priv);
const chain = createChain({ treasuryPublicKey: treasury.publicKey, minConfirmations: 2,
  electrumHost: process.env.CHIPNET_ELECTRUM_HOST });
assert.notEqual(owner.address, treasury.address);
const initialBalance = await chain.localWalletBalance(owner.address);
assert.ok(initialBalance >= 5000, 'This test needs 5,000 Chipnet sats in its fixture signer.');
await mkdir('var', { recursive: true });
const directory = await mkdtemp(resolve('var', 'chipnet-badge-'));
const output = resolve(directory, 'receipts.json');
const evidence = { startedAt: new Date().toISOString(), wallet: owner.address, tokenWallet: owner.tokenAddress, initialBalance, network: 'chipnet' };
const save = () => writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
await save();
const app = createApp({ database: resolve(directory, 'world.sqlite'), chain, localDemo: true });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = 'http://127.0.0.1:' + app.server.address().port + '/api/';
let cookie = '';
async function request(route, body) {
  const response = await fetch(base + route, {
    headers: { Cookie: cookie, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { method: 'POST', body: JSON.stringify(body) }),
  });
  cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

try {
  console.log('Chipnet evidence file:', output);
  await request('session', { demo:'p1' });
  await request('command', { type:'upgrade', building:'hall' });
  const { result: intent } = await request('payments', { type:'rush', building:'hall' });
  const transfer = await chain.sendWithLocalKey(sourceKey, intent.address, intent.satoshis);
  evidence.rush = { intent, txid: transfer.txid, feeSatoshis: transfer.feeSatoshis };
  await save();
  console.log('Rush broadcast', transfer.txid);
  const category = await chain.sendWithLocalKey(sourceKey, owner.address, 2500);
  evidence.categorySetup = { txid: category.txid, feeSatoshis: category.feeSatoshis, address: owner.address, satoshis: 2500, vout: 0 };
  await save();
  console.log('Genesis input setup broadcast', category.txid);
  const commitment = Buffer.from('BCH Dominion Founder', 'utf8').toString('hex');
  const badge = await chain.mintBadgeWithLocalKey(sourceKey, category.txid, owner.tokenAddress, commitment);
  evidence.badge = { txid: badge.txid, category: badge.category, address: owner.tokenAddress, commitment, feeSatoshis: badge.feeSatoshis };
  await save();
  console.log('Founder NFT broadcast', badge.txid);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && (!evidence.badge.output || !evidence.rush.receipt)) {
    if (!evidence.rush.receipt) {
      const paid = await request('payments/' + intent.id + '/submit', { txid: transfer.txid });
      if (paid.result.state === 'credited') {
        assert.equal(paid.result.fulfillment.status, 'applied');
        evidence.rush.receipt = paid.result.receipt;
        evidence.rush.fulfillment = paid.result.fulfillment;
        console.log('Rush credited with', paid.result.receipt.confirmations, 'confirmations');
        await save();
      }
    }
    if (!evidence.badge.output) {
      const token = (await chain.listCashTokens(owner.tokenAddress)).find((item) => item.txid === badge.txid);
      if (token) {
        assert.equal(token.category, category.txid);
        assert.equal(token.commitment, commitment);
        assert.equal(token.capability, 'none');
        assert.equal(token.amount, '0');
        evidence.badge.output = token;
        console.log('Founder NFT verified unspent at', token.confirmations, 'confirmations');
        await save();
      }
    }
    if (!evidence.badge.output || !evidence.rush.receipt) await delay(5000);
  }
  assert.ok(evidence.rush.receipt && evidence.badge.output, 'Some Chipnet outputs were still pending at test timeout.');
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log('Chipnet rush and Founder NFT test passed.');
} catch (error) {
  evidence.error = error.message;
  await save();
  throw error;
} finally {
  const done = once(app.server, 'close');
  app.close();
  await done;
}
