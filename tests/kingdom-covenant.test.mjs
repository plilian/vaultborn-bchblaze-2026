import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attestor, covenantNode, developer, keys, operator, operatorKey, stranger, wallets } from './support/covenant-node.mjs';
import { WAR_CHEST_4, kingdomVault, planKingdomWithdrawal, signChestExit, signKingdomRecovery, signKingdomWithdrawal } from '../packages/chain-observer/kingdom-vault.mjs';
import { prizeFeeder } from '../packages/chain-observer/prize-carrier.mjs';
import { prizeFund } from '../packages/chain-observer/prize-fund.mjs';
import { PRICING, priceBook } from '../config/pricing.mjs';

async function fixture(t, options = {}) {
  const node = await covenantNode(options);
  t.after(node.close);
  return node;
}
const premium = { type:'premium', building:'hall' };
const roles = outputs => outputs.map(({ role, satoshis }) => [role, satoshis]);
const book = priceBook(PRICING);

test('one service purchase is split exactly 50/20/20/10 and is at once a War Chest that covers the smallest stake', async t => {
  const { app, chain, accept, seat, buy, mine, settle, transactions, paidTo, advance } = await fixture(t);
  assert.throws(() => app.ledger.create('p1', premium), /Connect your wallet first/);
  for (const id of ['p1', 'p2', 'p3']) seat(id);
  const first = await buy('p1', premium);
  const price = first.quote.satoshis;
  assert.equal(price, book.services.premium);
  // Exact tenths. The War Chest share needs no reserve: it is paid straight into the chest. The reward share carries the one reserve.
  assert.deepEqual(roles(first.quote.outputs), [['warChest', price / 2], ['development', price / 5], ['prize', price / 5 + 300], ['burn', price / 10]]);
  assert.deepEqual(first.row.event.data.allocation, { warChest:price / 2, prize:price / 5, development:price / 5, burn:price / 10 });
  assert.deepEqual([first.row.reserveSatoshis, first.row.event.data.pricing], [300, PRICING], 'the reserve is disclosed apart from the price, and the record names the price book');
  const paid = transactions.get(first.row.txid).transaction.outputs;
  const [share, development, feeder] = first.row.receipt.allocations;
  assert.equal(development.address, developer.address, 'the Development share goes to the one developer address');
  const burn = paid.find(output => output.lockingBytecode[0] === 0x6a);
  assert.equal(burn.valueSatoshis, BigInt(price / 10), 'the burn is real value in an unspendable OP_RETURN output');
  assert.equal(feeder.script, prizeFeeder(feeder.feeder).script);
  assert.equal(prizeFund(feeder.pool.fund).script, feeder.feeder.poolScript, 'the reward share can only move into the season pool covenant');
  // The War Chest share is an output of this payer's own matched-stakes chest: no feeder, nothing waiting.
  const chest = chain.chestOf({ ownerKey:wallets.p1.publicKey, revision:4 });
  assert.equal(share.script, chest.script);
  assert.deepEqual([kingdomVault(chest.kv).version, chest.kv.revision, chest.kv.ownerKey, chest.kv.attestors, chest.kv.threshold], [WAR_CHEST_4, 4, wallets.p1.publicKey, [attestor.publicKey], 1]);
  let balance = app.ledger.balances('p1');
  assert.deepEqual([balance.warChestSatoshis, balance.pendingChestSatoshis, balance.atRiskSatoshis], [price / 2, 0, price / 2], 'chain, account and display agree');
  assert.ok(price / 2 >= book.raid.minimumStake, 'one purchase funds a War Chest that covers the smallest stake');
  assert.equal(app.ledger.explorer().buckets.development, 0, 'the game holds no Development money');
  assert.equal(app.ledger.create('p2', premium).satoshis, book.services.premium);

  // The game key cannot send a War Chest output anywhere but its owner.
  mine(150);
  const stolen = planKingdomWithdrawal([share], {});
  stolen.transaction.outputs[0].lockingBytecode = Uint8Array.from(Buffer.from(operator.script, 'hex'));
  assert.throws(() => accept(signKingdomWithdrawal(stolen, operatorKey, { unchecked:true }).rawHex), /mandatory-script-verify/);
  // A second purchase is a second output of the same chest. A withdrawal spends both, pays the verified wallet only, and leaves one output.
  advance(86_400_001);
  await buy('p1', { type:'premium', building:'vault' });
  mine(150);
  await assert.rejects(app.ledger.payout('p1', { kind:'kingdom-withdraw', satoshis:15_000, address:stranger.address, consent:true }), /verified Chipnet wallet/);
  const payout = await app.ledger.payout('p1', { kind:'kingdom-withdraw', satoshis:15_000, address:wallets.p1.address, consent:true });
  assert.equal(paidTo(wallets.p1.script, payout.txid), payout.satoshis);
  // The amount asked for is exactly what leaves the War Chest; the wallet receives it less the network fee, and the quote said so.
  assert.equal(payout.satoshis + payout.feeSatoshis, 15_000);
  await assert.rejects(app.ledger.payout('p1', { kind:'kingdom-withdraw', satoshis:15_500, address:wallets.p1.address, consent:true }), /pending payout|multiple of 1000/);
  mine();
  await settle(1);
  assert.equal(app.store.payment(payout.id).state, 'credited');
  balance = app.ledger.balances('p1');
  const left = price - payout.satoshis - payout.feeSatoshis;
  assert.deepEqual([balance.warChestSatoshis, balance.atRiskSatoshis, left % 1000], [left, left, 0]);
  assert.equal(paidTo(chest.script, payout.txid), left, 'two outputs became one');

  // Reward shares of all payers join one season pool by keyless moves paid from their reserves.
  assert.ok(app.ledger.explorer().buckets.prize >= 2 * (price / 5), 'the exact reward shares are in the pool');
  assert.ok(app.store.payments().filter(row => row.action === 'allocation-sweep').every(row => row.state === 'credited'));
  assert.ok(paidTo(feeder.feeder.poolScript, app.store.payments().find(row => row.action === 'allocation-sweep').txid) > 0);
});

test('a direct deposit is the player\'s own principal, and the owner leaves the War Chest alone in two steps', async t => {
  const { app, chain, accept, seat, buy, mine, settle, edit, coin } = await fixture(t);
  for (const id of ['p1', 'p2']) seat(id);
  edit(world => { for (const id of ['p1', 'p2']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 }); });
  const chest = chain.chestOf({ ownerKey:wallets.p2.publicKey, revision:4 });
  await assert.rejects(buy('p2', { type:'war-chest', satoshis:3_000, consent:true }), /Deposit at least 10000/);
  await assert.rejects(buy('p2', { type:'war-chest', satoshis:10_500, consent:true }), /multiples of 1000/);
  const deposit = await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  // No service split: the whole deposit is one output of the owner's chest, and all of it is at risk at once.
  assert.deepEqual(roles(deposit.quote.outputs), [['kingdom', 20_000], ['event', 0]]);
  const [funded] = deposit.row.receipt.allocations;
  assert.equal(funded.script, chest.script, 'a deposit lands in the same one War Chest script as the owner\'s service shares');
  assert.deepEqual([app.ledger.balances('p2').warChestSatoshis, app.ledger.balances('p2').atRiskSatoshis, app.ledger.balances('p2').capturableSatoshis], [20_000, 20_000, 20_000]);
  assert.equal(app.ledger.riskCeiling('p2'), 20_000);
  // The separate protected vault is closed: there is one player treasury.
  assert.throws(() => app.ledger.create('p2', { type:'vault-deposit', satoshis:5_000, consent:true }), /one player treasury/);

  // The owner cannot take the money straight out: the only owner-signed move is into the exit script, whole.
  assert.throws(() => signKingdomRecovery([funded], keys.p2, [{ script:wallets.p2.script, satoshis:19_000 }]), /Start the exit first/);
  const purse = coin('p2');
  assert.throws(() => accept(signChestExit([funded], keys.p2, { fee:purse, unchecked:true, outputs:[{ script:wallets.p2.script, satoshis:20_000 }] }).rawHex), /mandatory-script-verify/);
  assert.throws(() => accept(signChestExit([funded], keys.p2, { fee:purse, unchecked:true, outputs:[{ script:chest.exitScript, satoshis:19_999 }] }).rawHex), /mandatory-script-verify/, 'an exit cannot shrink the chest');
  const exit = signChestExit([funded], keys.p2, { fee:purse });
  accept(exit.rawHex);
  mine();
  await settle(1);
  const moved = app.store.payments().find(row => row.action === 'chest-exit');
  assert.deepEqual([moved?.state, moved.changes[0].script, moved.changes[0].satoshis], ['credited', chest.exitScript, 20_000]);
  const leaving = app.ledger.balances('p2');
  assert.deepEqual([leaving.warChestSatoshis, leaving.exitingChestSatoshis, leaving.capturableSatoshis], [20_000, 20_000, 0],
    'exiting money is still the owner\'s War Chest, and is no longer offered to new raids');
  let refusal;
  try { app.ledger.create('p1', { type:'attack-paid', target:'p2', stake:10_000 }); } catch (error) { refusal = error; }
  assert.match(refusal.message, /cannot cover the smallest stake/);
  // The owner cannot finish the exit before the delay; after it the owner's key alone spends the output.
  const out = [{ script:wallets.p2.script, satoshis:20_000 - 700 }];
  const exited = [{ ...exit.exits[0], txid:exit.txid }];
  assert.throws(() => accept(signKingdomRecovery(exited, keys.p2, out).rawHex), /non-BIP68-final/);
  mine(200);
  assert.throws(() => accept(signKingdomRecovery(exited, keys.p2, out).rawHex), /non-BIP68-final/);
  mine(100);
  accept(signKingdomRecovery(exited, keys.p2, out).rawHex);
  mine();
  await settle(2);
  assert.equal(app.ledger.balances('p2').warChestSatoshis, 0, 'the ledger follows the owner\'s own recovery');
});

test('a checkout quoted under an earlier price book is refused, and a funded one keeps its terms', async t => {
  const { app, seat, pay } = await fixture(t);
  seat('p1');
  const quote = app.ledger.create('p1', premium);
  // The same order again returns the same open checkout.
  assert.equal(app.ledger.create('p1', premium).id, quote.id);
  // Make it look like a checkout from before the price book: its record names no book.
  const row = app.store.payment(quote.id);
  const { pricing: _pricing, ...data } = row.event.data;
  app.store.savePayment({ ...row, event:{ ...row.event, data } });
  const fresh = app.ledger.create('p1', premium);
  assert.notEqual(fresh.id, quote.id);
  assert.deepEqual([app.store.payment(quote.id).state, app.store.payment(quote.id).lastError], ['expired', 'Prices changed after this checkout was prepared. Prepare it again.']);
  assert.equal(fresh.satoshis, book.services.premium);
  // A payment that confirms keeps the book it was quoted under for good.
  await app.ledger.submit('p1', fresh.id, pay('p1', fresh));
  const paid = app.store.payment(fresh.id);
  assert.deepEqual([paid.state, paid.event.data.pricing], ['credited', PRICING]);
});
