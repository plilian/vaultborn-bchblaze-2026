// The price book: one versioned place for every BCH price, and the rules each number was derived from.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAMEPLAY_ALLOCATION, LEGACY_PRICING, PRICING, SERVICE_ALLOCATION, checkoutFees, paymentAllocation, paymentPrice, priceBook, serviceSplit, sponsorshipAllocation, sponsorshipPolicy, validStake } from '../config/payments.mjs';
import { economy } from '../config/economy.mjs';

test('every service price splits exactly 50/20/20/10 and gives a War Chest share that covers the smallest stake on its own', () => {
  const book = priceBook(PRICING);
  assert.deepEqual(serviceSplit, { warChest:50, prize:20, development:20, burn:10 });
  for (const [action, price] of Object.entries(book.services)) {
    const split = paymentAllocation(price, action, SERVICE_ALLOCATION, { pricing:PRICING });
    assert.deepEqual(split, { warChest:price / 2, prize:price / 5, development:price / 5, burn:price / 10 }, action);
    assert.equal(split.warChest + split.prize + split.development + split.burn, price, 'nothing is rounded away');
    assert.ok(split.warChest >= book.raid.minimumStake, action + ': one purchase funds a War Chest a raid can be matched against');
    assert.equal(split.warChest % book.warChest.step, 0, action + ': the share sits on the 1,000-satoshi grid of stakes');
    // The fixed network cost of a purchase (reward-share reserve and a one-input wallet fee) stays under 5% of the price.
    assert.ok((book.reserves.prizeFeed + 357) / price < .05, action);
    assert.equal(paymentPrice(action, 4_000, GAMEPLAY_ALLOCATION, PRICING), price, 'the checkout price comes from the book');
  }
  assert.deepEqual([book.services.rush, book.services['espionage-paid'], book.services.premium, book.services.protectorate, book.services['political-operation']], [20_000, 20_000, 22_000, 24_000, 20_000]);
  assert.equal(book.reserves.record, 576, 'the smallest contract output the network relays');
});

test('stakes are refundable principal with a reserve of at most a tenth, and a raid stake sits on its grid', () => {
  const book = priceBook(PRICING);
  for (const [action, { principal, reserve }] of Object.entries(book.stakes)) {
    assert.ok(reserve * 10 <= principal, action + ': the settlement reserve is at most a tenth of the principal');
    assert.ok(principal / 2 >= 5 * 546, action + ': the half a contest can forfeit is several times the dust limit');
    assert.equal(paymentPrice(action, 4_000, GAMEPLAY_ALLOCATION, PRICING), principal + reserve);
    assert.deepEqual(paymentAllocation(principal + reserve, action, GAMEPLAY_ALLOCATION, { pricing:PRICING }), { battle:principal, settlement:reserve });
  }
  assert.deepEqual(book.stakes, { 'territory-claim':{ principal:6_000, reserve:600 }, 'territory-attack':{ principal:10_000, reserve:600 }, 'territory-raffle':{ principal:6_000, reserve:600 } });
  for (const stake of [10_000, 11_000, 25_000, 250_000]) assert.equal(validStake(stake), true, String(stake));
  for (const stake of [0, 9_000, 10_500, 251_000, 1e9, 10_000.5, '10000', undefined]) assert.equal(validStake(stake), false, String(stake));
  assert.equal(validStake(10_000, LEGACY_PRICING), false, 'the earlier book has no matched raid');
  // A matched raid carries its own measured reserve; a raid without one is refused.
  assert.deepEqual(paymentAllocation(12_880, 'attack-paid', GAMEPLAY_ALLOCATION, { pricing:PRICING, reserve:2_880 }), { battle:10_000, settlement:2_880 });
  assert.throws(() => paymentAllocation(12_880, 'attack-paid', GAMEPLAY_ALLOCATION, { pricing:PRICING }), /no network reserve/);
});

test('payments quoted before the price book keep their own arithmetic, and sponsorship is unchanged', () => {
  // The earlier book: the same calls without a book name return what they always did.
  assert.equal(paymentPrice('attack-paid', 6_000), 3_600);
  assert.equal(paymentPrice('territory-claim', 4_000), 2_600);
  assert.equal(paymentPrice('territory-raffle', 7_400), 5_200);
  assert.equal(paymentPrice('premium', 4_500), 4_500);
  assert.deepEqual(paymentAllocation(3_600, 'attack-paid', GAMEPLAY_ALLOCATION), { battle:3_000, settlement:600 });
  assert.deepEqual(priceBook(LEGACY_PRICING).services.rush, 4_000);
  assert.throws(() => priceBook('prices-v9'), /Unknown price book/);
  assert.deepEqual(checkoutFees(GAMEPLAY_ALLOCATION, PRICING), { attack:10_000, protectorate:24_000, premium:22_000, rush:20_000, espionage:20_000, political:20_000 });
  assert.deepEqual(economy.fees, { attack:10_000, protectorate:24_000, premium:22_000, rush:20_000 }, 'the engine quotes the same prices when no payment route is configured');
  // Sponsorship: 30% Development, 70% prizes; 0.25 BCH minimum, 25 BCH maximum; fixed in BCH.
  assert.deepEqual([sponsorshipPolicy.developmentPercent, sponsorshipPolicy.prizePercent, sponsorshipPolicy.minimumSatoshis, sponsorshipPolicy.maximumSatoshis], [30, 70, 25_000_000, 2_500_000_000]);
  assert.deepEqual(sponsorshipAllocation(50_000_000), { development:15_000_000, prize:35_000_000 });
  assert.deepEqual(sponsorshipAllocation(200_000_000), { development:60_000_000, prize:140_000_000 });
  assert.throws(() => sponsorshipAllocation(24_999_990), /Choose/);
});
