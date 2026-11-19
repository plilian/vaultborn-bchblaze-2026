import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { GAMEPLAY_ALLOCATION, LEGACY_ALLOCATION, paymentAllocation, paymentPrice } from '../config/payments.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { eventOutput } from '../packages/chain-observer/vaultborn.mjs';
import { kingdom } from '../packages/game-engine/treasury.mjs';

// These tests cover outputs and balances created before covenant custody of kingdom funds. Those must stay verifiable and spendable.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

const NOW = 1_794_845_600_000;
const key = n => n.toString(16).padStart(64, '0');
const digest = label => createHash('sha256').update(label).digest('hex');
const wallet = walletFromPrivateKey(key(601));
const roles = outputs => outputs.map(({ role, satoshis }) => [role, satoshis]);

function offlineObserver() {
  const fixtures = new Map();
  let attemptedBroadcasts = 0;
  const reader = Object.freeze({
    history: async () => [],
    lookup: async txid => fixtures.get(txid),
    raw: async () => undefined,
    broadcast: async () => {
      attemptedBroadcasts++;
      throw new Error('Payment audit does not allow broadcast, including mock broadcast.');
    },
  });
  const chain = createChain({ treasuryPrivateKey: key(600), transport: { withClient: fn => fn(reader) } });
  return { chain, get attemptedBroadcasts() { return attemptedBroadcasts; }, record(intent, outputs = intent.outputs) {
    // An invented input funds a structurally valid local fixture; it has never existed on a blockchain.
    const signed = signSpend({ privateKey: key(601), sources: [{ txid: digest(intent.id), vout: 0, script: wallet.script,
      satoshis: 100_000 }], outputs: [...outputs, { script: wallet.script, satoshis: 99_500 - intent.satoshis }] });
    const parsed = readTransaction(signed.rawHex);
    fixtures.set(parsed.txid, { ...parsed, confirmations: 2, height: 390_001, blockHash: digest('offline mock block'), blockTime: NOW });
    return parsed.txid;
  } };
}

const raid = { type: 'attack-paid', target: 'p2' };
const rush = { type: 'rush', building: 'hall' };

async function close(app) {
  const stopped = once(app.server, 'close');
  app.close();
  await stopped;
}

test('v2 keeps competitive principal and verifies the exact reserve and zero-value OP_RETURN offline', async t => {
  for (const [action, oldPrice, newPrice, principal, reserve] of [
    ['attack-paid', 6000, 3600, 3000, 600], ['territory-claim', 4000, 2600, 2000, 600],
    ['territory-attack', 6000, 3600, 3000, 600], ['territory-raffle', 7400, 5200, 3700, 1500],
  ]) {
    assert.equal(paymentAllocation(oldPrice, action, LEGACY_ALLOCATION).battle, principal);
    assert.equal(paymentPrice(action, oldPrice), newPrice);
    assert.deepEqual(paymentAllocation(newPrice, action, GAMEPLAY_ALLOCATION), { battle: principal, settlement: reserve });
  }

  const offline = offlineObserver();
  const app = createApp({ database: ':memory:', clock: () => NOW, chain: offline.chain, allocationPolicy: GAMEPLAY_ALLOCATION });
  t.after(async () => { await close(app); assert.equal(offline.attemptedBroadcasts, 0); });
  app.store.addSession(digest('seat-p2'),'p2',NOW+86_400_000);
  const quote = app.ledger.create('p1', raid);
  const raw = app.store.payment(quote.id);
  assert.equal(quote.satoshis, 3600);
  assert.equal(raw.event.data.allocationPolicy, GAMEPLAY_ALLOCATION);
  assert.deepEqual(raw.event.data.allocation, { battle: 3000, settlement: 600 });
  assert.deepEqual(roles(quote.outputs), [['battle', 3000], ['settlement', 600], ['event', 0]]);
  assert.equal(new Set(quote.outputs.map(output => output.script)).size, 3);
  assert.equal(quote.outputs[2].script, eventOutput(raw.event).script);
  assert.match(quote.outputs[2].script, /^6a/);

  const [stake, reserve, event] = quote.outputs;
  for (const invalid of [[stake, event], [stake, reserve, { ...event, satoshis: 1 }],
    [stake, { ...reserve, satoshis: 601 }, event], [stake, reserve, event, event],
    [stake, reserve, { ...event, script: '6a0100' }]]) {
    const observed = await offline.chain.observe(offline.chain.submit(raw, offline.record(quote, invalid), NOW), NOW);
    assert.equal(observed.state, 'rejected');
    assert.equal(observed.receipt, null);
  }
  const observed = await offline.chain.observe(offline.chain.submit(raw, offline.record(quote), NOW), NOW);
  assert.equal(observed.state, 'confirmed');
  assert.deepEqual(roles(observed.receipt.allocations), roles(quote.outputs));
  assert.equal(observed.receipt.eventVout, 2);
});

test('v2 services conserve satoshis, promote the low-price prize to dust, and commit the burn', async t => {
  const offline = offlineObserver();
  // The disclosed dust-floor mode stays available. The default prize carrier is covered in prize-carrier.test.mjs.
  const app = createApp({ database: ':memory:', clock: () => NOW, chain: offline.chain, allocationPolicy: GAMEPLAY_ALLOCATION, prizeDust: 'floor' });
  t.after(async () => { await close(app); assert.equal(offline.attemptedBroadcasts, 0); });
  const quote = app.ledger.create('p1', rush);
  const event = app.store.payment(quote.id).event;
  assert.deepEqual(roles(quote.outputs), [['kingdom', 2454], ['development', 800], ['prize', 546], ['burn', 200]]);
  assert.equal(quote.outputs[3].script, eventOutput(event, 200, 'burn').script);
  assert.deepEqual(event.data.allocation, { development: 800, prize: 546, burn: 200, kingdom: 2454 });
  assert.equal(quote.outputs.reduce((sum, output) => sum + output.satoshis, 0), quote.satoshis);
  assert.deepEqual(paymentAllocation(24_000, 'protectorate', GAMEPLAY_ALLOCATION),
    { development: 4800, prize: 2400, burn: 1200, kingdom: 15_600 });
  assert.throws(() => paymentAllocation(2500, 'rush', GAMEPLAY_ALLOCATION), /spendable outputs/);
  assert.throws(() => paymentAllocation(1145, 'attack-paid', GAMEPLAY_ALLOCATION), /minimum spendable/);
});

test('a classic price and required outputs survive a policy switch and SQLite restart', async t => {
  const root = fileURLToPath(new URL('../var/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'payments-audit-'));
  const database = join(directory, 'payments.sqlite');
  const offline = offlineObserver();
  let now = NOW;
  let app;
  t.after(async () => {
    if (app) await close(app);
    assert.equal(offline.attemptedBroadcasts, 0);
    for (const path of [database, database + '-shm', database + '-wal']) {
      assert.equal(dirname(path), directory);
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(directory);
  });
  const open = allocationPolicy => createApp({ database, clock: () => now, chain: offline.chain, allocationPolicy });
  app = open(LEGACY_ALLOCATION);
  app.store.addSession(digest('seat-p2'),'p2',NOW+86_400_000);
  const oldRaid = app.ledger.create('p1', raid);
  const oldRush = app.ledger.create('p1', rush);
  assert.equal(oldRaid.satoshis, 6000);
  assert.deepEqual(roles(oldRaid.outputs), [['battle', 3000], ['development', 1200], ['prize', 900], ['burn', 900]]);
  assert.equal(app.store.payment(oldRaid.id).event.data.allocationPolicy, undefined);
  await close(app);
  app = open(GAMEPLAY_ALLOCATION);

  assert.deepEqual(app.ledger.create('p1', raid), oldRaid);
  assert.deepEqual(app.ledger.create('p1', rush), oldRush);
  const settled = await app.ledger.submit('p1', oldRush.id, offline.record(oldRush));
  assert.equal(settled.state, 'credited');
  assert.deepEqual(roles(settled.receipt.allocations), [['kingdom', 2000], ['development', 800], ['prize', 600], ['burn', 600]]);
  assert.equal(app.ledger.balances('p1').kingdomSatoshis, 2000);

  now = oldRaid.expiresAt + 1;
  const newRaid = app.ledger.create('p1', raid);
  assert.notEqual(newRaid.id, oldRaid.id);
  assert.equal(newRaid.satoshis, 3600);
  assert.deepEqual(roles(newRaid.outputs), [['battle', 3000], ['settlement', 600], ['event', 0]]);
});

function verifiedReceipt(label, playerId, action, satoshis) {
  const txid = digest(label);
  const allocation = paymentAllocation(satoshis, action, GAMEPLAY_ALLOCATION);
  const roles = 'battle' in allocation ? { ...allocation, event: 0 } : allocation;
  return { id: label, playerId, action, satoshis, txid, state: 'confirmed', event: { data: { allocation,
    allocationPolicy: GAMEPLAY_ALLOCATION } }, receipt: { txid,
    allocations: Object.entries(roles).map(([role, value], vout) => ({ txid, vout, role, satoshis: value })) } };
}

test('v2 loot cannot exceed the stake, and an eligible defender wins half without committing funds', () => {
  const wallets = { p1: wallet.address, p2: walletFromPrivateKey(key(602)).address };
  const linked = id => wallets[id];
  const world = () => ({ cities: { p1: { optIn: true }, p2: { optIn: true } } });
  const outcome = winner => ({ kind: 'raid', paid: true, attacker: 'p1', defender: 'p2', winner });
  const attackerWins = world();
  kingdom.apply(attackerWins, verifiedReceipt('fictional capital', 'p2', 'premium', 160_000), null, NOW);
  kingdom.commit(attackerWins, 'p2', 90_000, NOW, linked('p2'));
  const attack = verifiedReceipt('fictional capped raid', 'p1', 'attack-paid', 3600);
  const win = kingdom.apply(attackerWins, attack, outcome('attacker'), NOW, linked);
  assert.equal(win.capturedSatoshis, 3000);
  assert.deepEqual(win.balances, { attacker: { before: 0, after: 6000 },
    defender: { before: 104_000, after: 101_000, committedBefore: 90_000, committedAfter: 87_000 } });
  const repeat = kingdom.apply(attackerWins, verifiedReceipt('fictional repeat raid', 'p1', 'attack-paid', 3600),
    outcome('attacker'), NOW + 1, linked);
  assert.equal(repeat.capturedSatoshis, 0);

  const defenderWins = world();
  const loss = kingdom.apply(defenderWins, attack, outcome('defender'), NOW, linked);
  assert.equal(loss.recipient, 'p2');
  assert.deepEqual(loss.balances, { attacker: { before: 0, after: 1500 },
    defender: { before: 0, after: 1500, committedBefore: 0, committedAfter: 0 } });
  assert.equal(kingdom.balance(defenderWins, 'p1', NOW).kingdomSatoshis, 1500);
  assert.equal(kingdom.balance(defenderWins, 'p2', NOW).kingdomSatoshis, 1500);
});
