// A paid service is never lost. If the action it was bought for cannot be applied when the payment is final, the player
// holds a credit and the next request of the same kind is delivered without a payment, exactly once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { covenantNode } from './support/covenant-node.mjs';
import { command } from '../packages/game-engine/index.mjs';
import { PRICING, priceBook } from '../config/pricing.mjs';

const price = priceBook(PRICING).services.premium;
const prepare = world => { Object.assign(world.cities.p1, { tutorial:true }); for (const name of Object.keys(world.cities.p1.resources)) world.cities.p1.resources[name] = 500_000; };

test('a premium improvement that can no longer be applied when its payment is final becomes a credit, and the next one is free, once', async t => {
  const { app, seat, edit, pay, time, advance } = await covenantNode();
  t.after(() => app.close());
  seat('p1');
  edit(prepare);
  const quote = app.ledger.create('p1', { type:'premium', building:'hall' });
  assert.equal(quote.satoshis, price);
  // While the payment confirms, the improvement stops being available for that building.
  edit(world => { world.cities.p1.perks = { ...world.cities.p1.perks, hall:true }; });
  await app.ledger.submit('p1', quote.id, pay('p1', quote));
  const paid = app.store.payment(quote.id);
  assert.deepEqual([paid.state, paid.fulfillment.status, paid.fulfillment.credit.action], ['credited', 'credit', 'premium'], JSON.stringify(paid.fulfillment));
  assert.equal(paid.fulfillment.fault, undefined, 'an expected outcome is not an operator matter');
  // The money went where a service payment goes; the service itself is still owed.
  const balances = () => app.ledger.balances('p1');
  assert.equal(balances().warChestSatoshis, price / 2);
  assert.deepEqual(balances().serviceCredits, { premium:1 });

  // A request that cannot be applied is refused and leaves the credit alone; another kind of service is an ordinary purchase.
  assert.throws(() => app.ledger.create('p1', { type:'premium', building:'hall' }));
  assert.deepEqual(balances().serviceCredits, { premium:1 });
  edit(world => { command(world, 'p1', { type:'upgrade', building:'hall' }, time()); });
  assert.equal(app.ledger.create('p1', { type:'rush', building:'hall' }).state, 'awaiting_signature');
  assert.deepEqual(balances().serviceCredits, { premium:1 });

  // The next premium improvement uses the credit: no checkout, no payment, applied in the same step.
  const rows = app.store.payments('p1').length;
  const redeemed = app.ledger.create('p1', { type:'premium', building:'vault' });
  assert.equal(redeemed.id, quote.id, 'the original payment is the one that is fulfilled');
  assert.equal(redeemed.fulfillment.status, 'applied');
  assert.ok(redeemed.fulfillment.redeemedCredit.reason.length > 0);
  assert.ok(app.store.read().world.cities.p1.perks.vault, 'the improvement was applied');
  assert.equal(app.store.payments('p1').length, rows, 'no new payment was prepared');
  assert.deepEqual(balances().serviceCredits, {});
  assert.equal(balances().warChestSatoshis, price / 2, 'no money moved for the redemption');

  // Used once: the following improvement is an ordinary checkout at the ordinary price (a day later: paid convenience is capped per day).
  advance(25 * 60 * 60_000);
  const next = app.ledger.create('p1', { type:'premium', building:'alliance' });
  assert.notEqual(next.id, quote.id);
  assert.deepEqual([next.state, next.satoshis], ['awaiting_signature', price]);
});

test('a payment seen only after its checkout expired is owed in the same way', async t => {
  const { app, seat, edit, pay, advance } = await covenantNode();
  t.after(() => app.close());
  seat('p1');
  edit(prepare);
  const quote = app.ledger.create('p1', { type:'premium', building:'hall' });
  const raw = pay('p1', quote);
  advance(45 * 60_000);
  await app.ledger.submit('p1', quote.id, raw);
  const paid = app.store.payment(quote.id);
  assert.deepEqual([paid.state, paid.late, paid.fulfillment.status], ['credited', true, 'credit'], JSON.stringify(paid.fulfillment));
  assert.match(paid.fulfillment.reason, /expired before the payment was seen/);
  assert.deepEqual(app.ledger.balances('p1').serviceCredits, { premium:1 });
  const redeemed = app.ledger.create('p1', { type:'premium', building:'hall' });
  assert.deepEqual([redeemed.id, redeemed.fulfillment.status], [quote.id, 'applied']);
});
