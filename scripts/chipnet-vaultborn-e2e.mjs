import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const path = process.env.CHIPNET_FIXTURE_FILE;
if (!path || process.env.CHIPNET_TEST_APPROVE !== 'true') throw new Error('A funded disposable Chipnet fixture and CHIPNET_TEST_APPROVE=true are required.');
const keys = JSON.parse(await readFile(path, 'utf8'));
const wallet = walletFromPrivateKey(keys.player.priv);
const chain = createChain({ treasuryPrivateKey: keys.treasury.priv, minConfirmations: 2 });
const dir = await mkdtemp(resolve('var', 'vaultborn-chipnet-'));
const database = resolve(dir, 'world.sqlite');
const receiptsPath = resolve(dir, 'receipts.json');
const receipt = { network: 'chipnet', started: new Date().toISOString(), fixtureWallet: wallet.address, rows: [] };
const save = () => writeFile(receiptsPath, JSON.stringify(receipt, null, 2) + '\n');
let offset = 0;
const app = createApp({ database, chain, clock: () => Date.now() + offset, localDemo: true });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = 'http://127.0.0.1:' + app.server.address().port;

function client() {
  let cookie = null;
  return async (route, body, expected = 200) => {
    const response = await fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const result = await response.json();
    assert.equal(response.status, expected, route + ' ' + JSON.stringify(result.error ?? result));
    return result;
  };
}

const player = client();
const rival = client();
const byId = id => app.store.payment(id);
const observe = async (intent, owner) => {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    await app.ledger.reconcile();
    const row = byId(intent.id);
    if (row?.state === 'credited') {
      assert.ok(row.receipt.confirmations >= 2);
      assert.equal(row.receipt.txid, row.txid);
      if (owner) assert.equal(row.playerId, owner);
      console.log(row.action, row.txid, row.receipt.confirmations + ' confirmations');
      return row;
    }
    assert.ok(!['expired', 'rejected', 'reorg'].includes(row?.state), JSON.stringify(row?.lastError));
    await delay(6000);
  }
  throw new Error('Confirmation timeout for ' + intent.action);
};

async function send(body) {
  const { result: intent } = await player('payments', body, 201);
  assert.ok(intent.outputs?.length >= 2, 'Expected committed checkout outputs');
  const signed = await chain.sendOutputsWithLocalKey(keys.player.priv, intent.outputs);
  const row = { action: intent.action, id: intent.id, txid: signed.txid, satoshis: intent.satoshis, outputs: intent.outputs,
    sentAt: new Date().toISOString(), feeSatoshis: signed.feeSatoshis };
  receipt.rows.push(row);
  console.log('Broadcast', intent.action, signed.txid);
  await save();
  return { intent, row };
}

async function attachEvidence(intent, row) {
  const result = await observe(intent, 'p1');
  assert.equal(result.txid, row.txid, 'The watcher must discover the exact transaction without manual TXID entry.');
  row.confirmations = result.receipt.confirmations;
  row.blockHash = result.receipt.blockHash;
  row.blockHeight = result.receipt.height;
  row.event = result.receipt.event;
  row.eventVout = result.receipt.eventVout;
  row.allocations = result.receipt.allocations?.map(({ script, satoshis, vout, role }) => ({ script, satoshis, vout, role }));
  if (result.fulfillment) row.fulfillment = result.fulfillment;
  await save();
  return result;
}

try {
  const {state:initial} = await player('session',{demo:'p1'});
  assert.equal(initial.player.id, 'p1');
  await rival('session',{demo:'p2'});
  assert.ok(await chain.localWalletBalance(wallet.address) >= 25_000, 'Fund the disposable Chipnet fixture with at least 25,000 sats.');
  const { result: challenge } = await player('wallet/challenge', { address: wallet.address });
  const proof = signWalletChallenge(keys.player.priv, challenge.challenge);
  await player('wallet/verify', { address: wallet.address, publicKey: proof.publicKey, signature: proof.signature });
  await player('command', { type: 'tutorial' });
  console.log('Writing receipts to', receiptsPath);
  const premium = await send({ type: 'premium', building: 'hall' });
  const raid = await send({ type: 'attack-paid', target: 'p2' });
  const sponsor = await send({ type: 'sponsor-fund', satoshis: 8000, consent: true });
  // Observe all three, then exercise the prize claim once the funded season is archived.
  for (const step of [premium, raid, sponsor]) await attachEvidence(step.intent, step.row);
  assert.deepEqual(Object.fromEntries(sponsor.row.allocations.map(output => [output.role,output.satoshis])),
    { prize:6_400, development:1_600, event:0 });
  assert.equal(premium.row.fulfillment.status, 'applied');
  assert.equal(raid.row.fulfillment.status, 'applied');
  const { id } = raid.row.fulfillment.result;
  const deadline = Date.now() + 12 * 60_000;
  let battle;
  while (Date.now() < deadline) {
    await app.ledger.reconcile();
    battle = await player('public/battle/' + id);
    if (battle.settlement) break;
    await delay(7000);
  }
  assert.ok(battle?.settlement, 'The on-chain battle settlement did not confirm.');
  assert.equal(battle.verified, true);
  assert.equal(battle.record.initiation.txid, raid.row.txid);
  await writeFile(resolve(dir, 'battle.json'), JSON.stringify(battle, null, 2) + '\n');
  receipt.battle = { id, resultHash: battle.record.battle.hash, recordHash: battle.recordHash, settlement: battle.settlement };
  await save();
  const state = await player('state');
  offset = state.season.endsAt - Date.now() + 1000;
  await player('command', { type: 'configure' });
  const { result: quote } = await player('vault/quote', { kind: 'claim', address: wallet.address });
  const body = { kind: 'claim', address: wallet.address, consent: true, expectedFee: quote.feeSatoshis, expectedSatoshis: quote.satoshis };
  const unauthorized = await player('vault/payout', { ...body, consent: false }, 400);
  assert.ok(unauthorized.error);
  const { result: payout } = await player('vault/payout', body, 201);
  const paid = { action: payout.action, id: payout.id, txid: payout.txid, satoshis: payout.satoshis, feeSatoshis: payout.feeSatoshis };
  receipt.rows.push(paid);
  await save();
  const result = await observe(payout, 'p1');
  Object.assign(paid, { confirmations: result.receipt.confirmations, blockHash: result.receipt.blockHash,
    blockHeight: result.receipt.height, event: result.receipt.event, eventVout: result.receipt.eventVout });
  await player('vault/payout', body, 400);
  receipt.finished = new Date().toISOString();
  await save();
} finally {
  const closed = once(app.server, 'close');
  app.close();
  await closed;
}
