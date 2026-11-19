import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { advance } from '../packages/game-engine/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const fixturePath = process.env.CHIPNET_FIXTURE_FILE;
if (!fixturePath || process.env.CHIPNET_TEST_APPROVE !== 'true') {
  throw new Error('A funded Chipnet fixture and CHIPNET_TEST_APPROVE=true are required to send test BCH.');
}
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const { priv: playerKey } = fixture.player;
const { priv: treasuryPrivateKey } = fixture.treasury;
const player = walletFromPrivateKey(playerKey);
const treasury = walletFromPrivateKey(treasuryPrivateKey);
assert.notEqual(player.address, treasury.address);
const chain = createChain({ treasuryPrivateKey, minConfirmations: 2, electrumHost: process.env.CHIPNET_ELECTRUM_HOST });
const initialBalance = await chain.localWalletBalance(player.address);
assert.ok(initialBalance >= 65_000, 'The funded Chipnet fixture needs at least 65,000 satoshis.');
await mkdir('var', { recursive: true });
const temp = await mkdtemp(resolve('var', 'chipnet-run-'));
const database = resolve(temp, 'world.sqlite');
const output = resolve(temp, 'receipts.json');
const evidence = {
  startedAt: new Date().toISOString(), network: 'chipnet', minimumConfirmations: chain.minConfirmations,
  fixtureWallet: player.address, treasuryPublicKey: treasury.publicKey, initialBalance, rows: [],
};
let clockOffset = 0;
let app;
let origin;

async function save() {
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
}

async function start() {
  app = createApp({ database, chain, clock: () => Date.now() + clockOffset, localDemo: true });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  origin = 'http://127.0.0.1:' + app.server.address().port;
}

async function stop() {
  if (!app?.server.listening) return;
  const done = once(app.server, 'close');
  app.close();
  await done;
}

function setGameTime(target) {
  clockOffset = target - Date.now();
  app.store.transaction(() => {
    const { world } = app.store.read();
    advance(world, Date.now() + clockOffset);
    app.store.write(world);
  });
}

function client() {
  let cookie = '';
  return async (route, body) => {
    const response = await fetch(origin + '/api/' + route, {
      headers: { Cookie: cookie, ...(body && { 'Content-Type': 'application/json' }) },
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
    });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const result = await response.json();
    return { status: response.status, body: result };
  };
}

async function checked(request, route, body, expected = 200) {
  const result = await request(route, body);
  assert.equal(result.status, expected, route + ' ' + JSON.stringify(result.body.error ?? result.body));
  return result.body;
}

async function waitForCredit(request, intent, submittedTxid) {
  const status = async () => submittedTxid
    ? (await checked(request, 'payments/' + intent.id + '/submit', {txid:submittedTxid})).result
    : (await checked(request, 'payments')).find((row) => row.id === intent.id);
  const deadline = Date.now() + 600_000;
  const phases = [];
  while (Date.now() < deadline) {
    const row = await status();
    if (!phases.some(({ state, confirmations }) => row.state === state && row.receipt?.confirmations === confirmations)) {
      phases.push({ state: row.state, confirmations: row.receipt?.confirmations });
      console.log('  ', intent.action, row.state, row.receipt?.confirmations ?? '');
    }
    if (row.state === 'credited') {
      assert.equal(row.receipt.network, 'chipnet');
      assert.ok(row.receipt.confirmations >= chain.minConfirmations);
      return {row, phases};
    }
    assert.ok(!['expired', 'rejected', 'reorg'].includes(row.state), JSON.stringify(row));
    await delay(4000);
  }
  throw new Error('Chipnet did not confirm ' + intent.action + ' before the test timeout.');
}

async function stagePayment(request, payload, verify) {
  const { result: intent } = await checked(request, 'payments', payload, 201);
  const attempt = { action: intent.action, payload, address: intent.address, satoshis: intent.satoshis, id: intent.id, network: intent.network };
  evidence.rows.push(attempt);
  console.log('Signing', intent.action, intent.satoshis, 'Chipnet sats', intent.address);
  const sent = await chain.sendWithLocalKey(playerKey, intent.address, intent.satoshis);
  Object.assign(attempt, { txid: sent.txid, actualNetworkFeeSatoshis: sent.feeSatoshis });
  await save();
  return { request, intent, sent, attempt, verify };
}
async function confirmPayment({ request, intent, sent, attempt, verify }) {
  const {row, phases} = await waitForCredit(request, intent, sent.txid);
  const state = await checked(request, 'state');
  verify(row, state);
  Object.assign(attempt, { completedAt: new Date().toISOString(), phases, receipt: row.receipt, fulfillment: row.fulfillment });
  await save();
  return row;
}

async function stagePayout(request, body, verify) {
  const { result: intent } = await checked(request, 'vault/payout', { ...body, address: player.address, consent: true }, 201);
  const attempt = { action: intent.action, address: intent.address, satoshis: intent.satoshis, id: intent.id, network: intent.network,
    txid: intent.txid, actualNetworkFeeSatoshis: intent.feeSatoshis };
  evidence.rows.push(attempt);
  console.log('Operator submitted', intent.action, intent.satoshis, 'Chipnet sats', intent.txid);
  await save();
  return { request, intent, attempt, verify };
}
async function confirmPayout({ request, intent, attempt, verify }) {
  const { row, phases } = await waitForCredit(request, intent);
  verify(row, await checked(request, 'state'));
  Object.assign(attempt, { completedAt: new Date().toISOString(), phases, receipt: row.receipt, fulfillment: row.fulfillment });
  await save();
}

await save();
console.log('Evidence file:', output, '| funded Chipnet fixture:', initialBalance, 'sats');
try {
  await start();
  const first = client();
  const second = client();
  const third = client();

  const queued = [];
  await checked(first, 'session', {demo:'p1'});
  await checked(second, 'session', {demo:'p2'});
  await checked(third, 'session', {demo:'p3'});
  const seasonEndsAt = (await checked(first,'state')).season.endsAt;
  const startState = await checked(first, 'state');
  if (!startState.player.tutorial) await checked(first,'command',{type:'tutorial'});
  queued.push(await stagePayment(first, {type:'premium', building:'hall'}, (row, state) => {
    assert.equal(row.fulfillment.status, 'applied');
    assert.ok(state.player.perks.hall);
  }));
  queued.push(await stagePayment(first, {type:'attack-paid', target:'p2', tactic:'flank', formation:'wedge'}, (row, state) => {
    assert.equal(row.fulfillment.status, 'applied');
    assert.ok(row.fulfillment.result.hash);
    assert.equal(state.player.attacksLeft, 2);
  }));
  queued.push(await stagePayment(second, {type:'premium', building:'scout'}, (row, state) => {
    assert.equal(row.fulfillment.status, 'applied');
    assert.ok(state.player.perks.scout);
  }));
  queued.push(await stagePayment(third, {type:'premium', building:'vault'}, (row, state) => {
    assert.equal(row.fulfillment.status, 'applied');
    assert.ok(state.player.perks.vault);
  }));
  queued.push(await stagePayment(first, {type:'vault-deposit', satoshis:8000, consent:true}, (row, state) => {
    assert.equal(row.receipt.satoshis, 8000);
    assert.equal(state.vault.depositedSatoshis, 8000);
    assert.equal(state.vault.atRiskSatoshis, 0);
  }));
  queued.push(await stagePayment(first, {type:'sponsor-fund', satoshis:18000, consent:true}, (row, state) => {
    assert.equal(row.receipt.satoshis, 18000);
    assert.equal(state.vault.sponsoredSatoshis, 18000);
  }));
  const [firstPayment, ...otherPayments] = queued;
  const upgrade = await confirmPayment(firstPayment);
  await stop();
  await start();
  const repeated = await checked(first, 'payments/' + upgrade.id + '/submit', {txid:upgrade.txid});
  assert.equal(repeated.result.state, 'credited');
  assert.equal(repeated.state.payments.filter(row => row.id === upgrade.id).length, 1);
  assert.ok(repeated.state.player.perks.hall);
  for (const payment of otherPayments) await confirmPayment(payment);
  const {result:training} = await checked(first,'command',{type:'train',unit:'archer',count:24});
  setGameTime(training.completesAt + 10);
  await confirmPayment(await stagePayment(first, {type:'protectorate', target:'p4'}, (row) => {
    assert.equal(row.fulfillment.status, 'applied');
    assert.equal(row.fulfillment.result.status, 'pending');
  }));
  const withdrawal = await stagePayout(first, {kind:'withdraw', satoshis:2000}, (row, state) => {
    assert.equal(row.receipt.address, player.address);
    assert.equal(row.receipt.change.satoshis, 8000 - 2000 - row.receipt.feeSatoshis);
    assert.equal(state.vault.depositedSatoshis, row.receipt.change.satoshis);
  });
  assert.ok(Number.isFinite(seasonEndsAt));
  // Local game calendar is accelerated after settlement. Chain timestamps,
  // Merkle inclusion and chain confirmations always come from public Chipnet.
  setGameTime(seasonEndsAt + 1000);
  const state = await checked(first, 'state');
  assert.ok(state.vault.claimableSatoshis >= 600);
  await confirmPayout(withdrawal);
  const claim = await stagePayout(first, {kind:'claim'}, (row, after) => {
    assert.equal(row.receipt.address, player.address);
    assert.equal(after.vault.claimableSatoshis, 0);
    assert.equal(row.receipt.change.satoshis + row.receipt.satoshis + row.receipt.feeSatoshis, 18000);
  });
  await confirmPayout(claim);
  const repeat = await first('vault/payout', {kind:'claim',address:player.address,consent:true});
  assert.equal(repeat.status,400);
  assert.equal((await checked(first,'payments')).filter(row => row.action === 'claim').length,1);
  evidence.finishedAt = new Date().toISOString();
  await save();
  console.log('Live Chipnet game verification passed. Receipt log:', output);
} catch (error) {
  evidence.error = error.message;
  await save();
  throw error;
} finally {
  await stop();
}
