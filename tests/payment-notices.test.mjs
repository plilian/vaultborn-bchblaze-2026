// A player is told about their own payment: when the network has it, and when it is final. Run on the enforcing fixture node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { covenantNode } from './support/covenant-node.mjs';

test('a War Chest deposit is announced once when it is sent and once when it is in the War Chest', async t => {
  const node = await covenantNode();
  t.after(node.close);
  node.seat('p2');
  node.edit(world => Object.assign(world.cities.p2, { optIn:true, tutorial:true, shieldUntil:0 }));
  const notices = () => (node.app.store.read().world.notifications.p2 ?? []).filter(entry => entry.kind === 'receipt').map(entry => [entry.title, entry.text]);
  const quote = node.app.ledger.create('p2', { type:'war-chest', satoshis:10_000, consent:true });
  assert.deepEqual(notices(), [], 'nothing before the wallet sends');
  // The wallet's transaction is in the mempool, not yet in a block.
  const txid = node.pay('p2', quote);
  node.transactions.get(txid).height = 0;
  await node.app.ledger.submit('p2', quote.id, txid);
  await node.app.ledger.reconcile();
  const sent = node.app.store.payment(quote.id);
  assert.ok(['submitted', 'seen_in_mempool', 'confirming'].includes(sent.state), sent.state);
  assert.deepEqual(notices(), [['Payment sent', 'War Chest deposit of 10,000 sats sent. It joins your War Chest after 2 confirmations, usually about 20 minutes.']]);
  await node.app.ledger.reconcile();
  assert.equal(notices().length, 1, 'told once while it waits');
  // On its way: not in the War Chest yet, and nothing at risk.
  assert.equal(node.app.ledger.balances('p2').warChestSatoshis, 0);
  node.mine();
  await node.app.ledger.reconcile();
  assert.equal(node.app.store.payment(quote.id).state, 'credited');
  assert.deepEqual(notices()[0], ['War Chest funded', 'War Chest funded: +10,000 sats. All of it is at risk in PvP.']);
  await node.settle();
  assert.equal(notices().length, 2, 'and once when it is final');
  assert.equal(node.app.ledger.balances('p2').warChestSatoshis, 10_000);
});

// A rush waits for 1 confirmation when its construction has less than an hour left, otherwise for the usual 2.
async function rushWith(t, hall) {
  const node = await covenantNode();
  t.after(node.close);
  node.seat('p2');
  node.edit(world => Object.assign(world.cities.p2, { optIn:true, tutorial:true, shieldUntil:0 }));
  const job = () => node.app.store.read().world.cities.p2.queue.find(item => item.kind === 'building' && item.key === 'hall');
  assert.throws(() => node.app.ledger.create('p2', { type:'rush', building:'hall' }), /Start the upgrade first/);
  const { command } = await import('../packages/game-engine/index.mjs');
  node.edit(world => { const city = world.cities.p2; city.buildings.hall = hall;
    for (const key of Object.keys(city.resources)) city.resources[key] = 1_000_000;
    command(world, 'p2', { type:'upgrade', building:'hall' }, node.time()); });
  const before = job().completesAt;
  const quote = node.app.ledger.create('p2', { type:'rush', building:'hall' });
  const txid = node.pay('p2', quote);
  node.transactions.get(txid).height = 0;
  await node.app.ledger.submit('p2', quote.id, txid);
  await node.app.ledger.reconcile();
  const notices = () => (node.app.store.read().world.notifications.p2 ?? []).filter(entry => entry.kind === 'receipt').map(entry => entry.text);
  return { node, job, before, quote, txid, notices };
}

test('a rush for a short construction is applied after 1 confirmation, and its War Chest share when final', async t => {
  const { node, job, before, quote, notices } = await rushWith(t, 3);
  assert.ok(before - node.time() < 60 * 60_000);
  assert.equal(quote.appliesAfter, 1);
  assert.match(quote.description, /Applied after 1 confirmation, about 10 minutes/);
  assert.equal(node.app.store.payment(quote.id).fulfillment, undefined, 'not in the mempool');
  assert.equal(job().rushed, undefined);
  assert.match(notices()[0], /sent\. It is applied after 1 confirmation, usually about 10 minutes/);
  node.mine(1);
  await node.app.ledger.reconcile();
  const seen = node.app.store.payment(quote.id);
  assert.equal(seen.state, 'confirming');
  assert.equal(seen.fulfillment?.status, 'applied', 'applied at the first confirmation');
  assert.equal(job().rushed, true);
  assert.ok(job().completesAt < before);
  assert.equal(node.app.ledger.balances('p2').warChestSatoshis, 0, 'the share waits for the final payment');
  assert.throws(() => node.app.ledger.create('p2', { type:'rush', building:'hall' }));
  node.mine(1);
  await node.app.ledger.reconcile();
  const final = node.app.store.payment(quote.id);
  assert.equal(final.state, 'credited');
  assert.equal(final.fulfillment.status, 'applied');
  assert.equal(final.fulfillment.early, undefined);
  await node.settle();
  assert.equal(node.app.ledger.balances('p2').warChestSatoshis, quote.outputs.find(output => output.role === 'warChest').satoshis);
});

test('a rush for a long construction waits for the usual 2 confirmations', async t => {
  const { node, job, before, quote } = await rushWith(t, 7);
  assert.ok(before - node.time() >= 60 * 60_000);
  assert.equal(quote.appliesAfter, 2);
  assert.match(quote.description, /Applied after 2 confirmations, about 20 minutes/);
  node.mine(1);
  await node.app.ledger.reconcile();
  assert.equal(node.app.store.payment(quote.id).fulfillment, undefined, 'one confirmation is not enough here');
  assert.equal(job().rushed, undefined);
  node.mine(1);
  await node.app.ledger.reconcile();
  const final = node.app.store.payment(quote.id);
  assert.equal(final.state, 'credited');
  assert.equal(final.fulfillment.status, 'applied');
  assert.equal(job().rushed, true);
  assert.ok(job().completesAt < before);
});
