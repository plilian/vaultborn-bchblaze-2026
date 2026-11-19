import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';

// These tests cover outputs and balances created before covenant custody of kingdom funds. Those must stay verifiable and spendable.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

const initialTime = Date.UTC(2026,10,19);
const key = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const deposit = satoshis => ({ type:'vault-deposit', satoshis, consent:true });

async function fixture(t, { wrap = chain => chain, admin } = {}) {
  let now = initialTime;
  let sequence = 0;
  const transactions = new Map();
  const network = { rejectBroadcast:true, broadcasts:0, history:new Map(), spent:new Set() };
  const buyerKey = key(701);
  const buyer = walletFromPrivateKey(buyerKey);
  const assets = { enabled:false, list:() => [], authority:() => null, close:() => {} };
  const real = createChain({ treasuryPrivateKey:key(700), transport:{ withClient:run => run({
    history:async script => network.history.get(script) ?? [], lookup:async txid => transactions.get(txid),
    broadcast:async raw => {
      network.broadcasts++;
      if (network.rejectBroadcast) throw new Error('bad-txns-inputs-missingorspent');
      const decoded = readTransaction(raw);
      // Like a node, the fixture refuses a second spend of an outpoint it already accepted.
      const points = decoded.transaction.inputs.map(input => Buffer.from(input.outpointTransactionHash).toString('hex') + ':' + input.outpointIndex);
      if (!transactions.has(decoded.txid) && points.some(point => network.spent.has(point))) throw new Error('txn-mempool-conflict');
      for (const point of points) network.spent.add(point);
      transactions.set(decoded.txid, transactions.get(decoded.txid) ?? { ...decoded, confirmations:0, height:0 });
      return decoded.txid;
    } }) } });
  // These rows exercise the shared ledger machinery with operator-held deposits. Covenant vaults have their own test file.
  const app = createApp({ database:':memory:', localDemo:true, clock:() => now, chain:wrap(real), adminToken:admin, vaultCustody:'operator', personalVault:'open',
    territoryAssets:assets, politicalAssets:assets });
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async () => { const closed=once(app.server,'close'); app.close(); await closed; });
  // Synthetic inputs never touched a chain. The observer decodes and verifies the exact outputs.
  function pay(quote, confirmations = 2) {
    const signed = signSpend({ privateKey:buyerKey, sources:[{ txid:hash('resilience-' + (++sequence)), vout:0, script:buyer.script, satoshis:400_000 }],
      outputs:[...(quote.outputs ?? [{ script:real.createIntent ? app.store.payment(quote.id).script : '', satoshis:quote.satoshis }]),
        { script:buyer.script, satoshis:400_000 - quote.satoshis - 350 }] });
    const observed = { ...readTransaction(signed.rawHex), confirmations, height:390_100, blockHash:hash('block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return observed.txid;
  }
  const confirm = txid => { const item = transactions.get(txid); item.confirmations = 2; item.height = 390_101; };
  const seat = (id, wallet) => {
    app.store.addSession(hash('seat-' + id), id, initialTime + 365 * 86_400_000);
    if (wallet) app.store.bindWallet(id, wallet.address, wallet.publicKey, now);
  };
  return { app, real, network, transactions, pay, confirm, seat, origin:`http://127.0.0.1:${app.server.address().port}`,
    advance:ms => { now += ms; } };
}

test('a funded deposit is credited in one cycle behind a flood of newer unpaid checkouts', async t => {
  const { app, pay, confirm } = await fixture(t);
  const victim = app.ledger.create('p1', deposit(10_000));
  const txid = pay(victim, 0);
  assert.equal((await app.ledger.submit('p1', victim.id, txid)).state, 'seen_in_mempool');
  for (let index = 0; index < 150; index++) app.ledger.create('flood-' + index, deposit(1_000 + index));
  confirm(txid);
  await app.ledger.reconcile();
  assert.equal(app.store.payment(victim.id).state, 'credited');
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 10_000);
});

test('unpaid checkouts still rotate, and one account cannot hold more than twelve open', async t => {
  const { app, network, pay } = await fixture(t);
  const quotes = Array.from({ length:150 }, (_, index) => app.ledger.create('walker-' + index, deposit(2_000 + index)));
  // The oldest request is paid by address without calling submit. Discovery must reach it despite 149 newer rows.
  const oldest = app.store.payment(quotes[0].id);
  const paid = pay({ id:oldest.id, satoshis:oldest.satoshis, outputs:oldest.outputs.map(({ script, satoshis }) => ({ script, satoshis })) });
  network.history.set(oldest.script, [{ txid:paid, height:390_100 }]);
  let cycles = 0;
  while (app.store.payment(oldest.id).state !== 'credited' && cycles < 6) { await app.ledger.reconcile(); cycles++; }
  assert.equal(app.store.payment(oldest.id).state, 'credited');
  assert.ok(cycles <= 3, 'rotation reaches every unpaid row within three cycles of 64');
  for (let index = 0; index < 12; index++) {
    app.store.savePayment({ id:'synthetic-' + index, playerId:'hoarder', action:'synthetic-' + index, direction:'incoming',
      state:'awaiting_signature', satoshis:1_000, expiresAt:initialTime + 60_000, createdAt:initialTime });
  }
  assert.throws(() => app.ledger.create('hoarder', deposit(3_000)), /open Chipnet checkouts/);
});

test('a faulty payment row is isolated, then finalized for review, while other rows and lanes proceed', async t => {
  let poison;
  const { app, pay, confirm } = await fixture(t, { wrap:real => ({ ...real, observe:async (intent, now) => intent.id === poison ?
    { ...intent, state:'confirmed', receipt:{ txid:intent.txid, confirmations:2, allocations:[{ role:'kingdom', satoshis:1, txid:intent.txid, vout:0 }] } } : real.observe(intent, now) }) });
  const bad = app.ledger.create('p1', { type:'premium', building:'hall' });
  poison = bad.id;
  app.store.savePayment({ ...app.store.payment(bad.id), txid:hash('poison'), state:'submitted' });
  const good = app.ledger.create('p2', deposit(8_000));
  const txid = pay(good, 0);
  await app.ledger.submit('p2', good.id, txid);
  confirm(txid);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => { console.error = original; });
  await app.ledger.reconcile();
  assert.equal(app.store.payment(good.id).state, 'credited');
  assert.equal(app.store.payment(bad.id).state, 'submitted');
  await app.ledger.reconcile();
  await app.ledger.reconcile();
  const final = app.store.payment(bad.id);
  assert.equal(final.state, 'credited');
  // The service is owed to the payer as a credit, and the fault still reaches the operator's attention list.
  assert.deepEqual([final.fulfillment.status, final.fulfillment.fault], ['credit', true]);
  assert.match(final.fulfillment.reason, /internal fault/);
  assert.ok(errors.some(line => line.includes(bad.id)));
  assert.ok(app.ledger.attention().some(row => row.id === bad.id));
});

test('a rejected payout is cancelled by a confirmed replacement and the balance returns once', async t => {
  const owner = walletFromPrivateKey(key(702));
  const { app, network, transactions, pay, confirm, seat } = await fixture(t);
  seat('p1', owner);
  const quote = app.ledger.create('p1', deposit(20_000));
  await app.ledger.submit('p1', quote.id, pay(quote));
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 20_000);
  const payout = await app.ledger.payout('p1', { kind:'withdraw', satoshis:5_000, address:owner.address, consent:true });
  assert.equal(payout.state, 'submitted');
  await app.ledger.reconcile();
  assert.match(app.store.payment(payout.id).broadcastError, /missingorspent/);
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 0);
  await assert.rejects(app.ledger.payout('p1', { kind:'withdraw', satoshis:600, address:owner.address, consent:true }), /pending payout/);
  await assert.rejects(app.ledger.voidPayout({ id:payout.id }), /Confirm/);
  network.rejectBroadcast = false;
  const cancel = await app.ledger.voidPayout({ id:payout.id, consent:true });
  assert.equal(cancel.action, 'payout-void');
  await assert.rejects(app.ledger.voidPayout({ id:payout.id, consent:true }), /cancelled|changed/);
  const replacement = transactions.get(cancel.txid);
  assert.ok(replacement, 'the cancellation was broadcast');
  // The replacement spends exactly the reserved input back to a treasury script.
  const stuck = readTransaction(app.store.payment(payout.id).rawHex).transaction;
  assert.deepEqual(replacement.transaction.inputs.map(input => Buffer.from(input.outpointTransactionHash).toString('hex') + ':' + input.outpointIndex),
    stuck.inputs.map(input => Buffer.from(input.outpointTransactionHash).toString('hex') + ':' + input.outpointIndex));
  await app.ledger.reconcile();
  assert.equal(app.store.payment(payout.id).state, 'submitted');
  confirm(cancel.txid);
  await app.ledger.reconcile();
  await app.ledger.reconcile();
  assert.equal(app.store.payment(payout.id).state, 'voided');
  const restored = app.ledger.balances('p1').depositedSatoshis;
  assert.equal(restored, 20_000 - cancel.feeSatoshis);
  assert.equal(app.ledger.balances('p2').depositedSatoshis, 0);
  const again = app.ledger.quotePayout('p1', { kind:'withdraw', satoshis:5_000, address:owner.address });
  assert.equal(again.satoshis, 5_000);
});

test('a payout the network already knows cannot be cancelled', async t => {
  const owner = walletFromPrivateKey(key(703));
  const { app, network, pay, seat } = await fixture(t);
  seat('p1', owner);
  network.rejectBroadcast = false;
  const quote = app.ledger.create('p1', deposit(9_000));
  await app.ledger.submit('p1', quote.id, pay(quote));
  const payout = await app.ledger.payout('p1', { kind:'withdraw', satoshis:3_000, address:owner.address, consent:true });
  await assert.rejects(app.ledger.voidPayout({ id:payout.id, consent:true }), /already know/);
});

test('a reorganized deposit pauses its payer only, and a write-off clears it', async t => {
  const { app, transactions, pay } = await fixture(t);
  const mine = app.ledger.create('p1', deposit(12_000));
  const txid = pay(mine);
  await app.ledger.submit('p1', mine.id, txid);
  const other = app.ledger.create('p2', deposit(7_000));
  await app.ledger.submit('p2', other.id, pay(other));
  transactions.delete(txid);
  await app.ledger.reconcile();
  assert.equal(app.store.payment(mine.id).state, 'reorg');
  assert.equal(app.ledger.balances('p1').quarantined, true);
  assert.equal(app.ledger.balances('p2').quarantined, false);
  assert.equal(app.ledger.balances('p2').depositedSatoshis, 7_000);
  assert.throws(() => app.ledger.create('p1', deposit(1_000)), /paused/);
  assert.equal(app.ledger.create('p2', deposit(1_500)).satoshis, 1_500);
  assert.throws(() => app.ledger.resolveReorg({ id:other.id, consent:true }), /reorganized/);
  assert.equal(app.ledger.resolveReorg({ id:mine.id, consent:true }).state, 'reversed');
  assert.equal(app.ledger.balances('p1').quarantined, false);
  assert.equal(app.ledger.balances('p1').depositedSatoshis, 0);
});

test('each signed-in player has an own request budget and recovery routes need the administrator', async t => {
  const admin = 'a'.repeat(40);
  const { app, origin } = await fixture(t, { admin });
  const enter = async seatId => {
    const response = await fetch(origin + '/api/session', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ demo:seatId, includeState:false }) });
    return response.headers.get('set-cookie').split(';')[0];
  };
  const first = await enter('p1');
  const second = await enter('p2');
  let limited = 0;
  for (let index = 0; index < 485; index++) {
    const response = await fetch(origin + '/api/vault', { method:'POST', headers:{ Cookie:first, 'Content-Type':'application/json' }, body:'{}' });
    if (response.status === 429) limited++;
    await response.arrayBuffer();
  }
  assert.ok(limited > 0, 'the busy player is limited');
  const calm = await fetch(origin + '/api/state?background=1', { headers:{ Cookie:second } });
  assert.equal(calm.status, 200);
  await calm.arrayBuffer();
  assert.equal((await fetch(origin + '/api/admin/payments')).status, 403);
  const listed = await fetch(origin + '/api/admin/payments', { headers:{ Authorization:'Bearer ' + admin } });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).payments, []);
  assert.ok(app.ledger.attention);
});
