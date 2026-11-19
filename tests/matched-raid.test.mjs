// Matched-stakes paid raids, end to end on the enforcing fixture node: real transactions, the BCH VM on every broadcast.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attestor, attestorKey, covenantNode, keys, operator, operatorKey, scriptOf, wallets } from './support/covenant-node.mjs';
import { signAttestorRequest } from '../packages/chain-observer/index.mjs';
import { signChestExit, signKingdomRecovery } from '../packages/chain-observer/kingdom-vault.mjs';
import { completeMatchedCapture, completeRaidSpend, planMatchedCapture, planRaidSpend, raidEscrow, signMatchedDigests, signRaidDigest } from '../packages/chain-observer/matched-raid.mjs';
import { checkRaid } from '../scripts/attestor-review.mjs';
import { PRICING, priceBook } from '../config/pricing.mjs';
import { powerBreakdown } from '../packages/game-engine/world.mjs';

const { raid: rules } = priceBook(PRICING);
async function arena(t, options = {}) {
  const node = await covenantNode(options);
  t.after(node.close);
  for (const id of ['p1', 'p2', 'p3']) node.seat(id);
  node.edit(world => { for (const id of ['p1', 'p2', 'p3']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 }); });
  // The battle is decided by the armies. A kingdom whose matchmaking power sits in its city hall instead of its army
  // loses to an opponent of the same power, whichever side it is on; the tests use that to decide who wins.
  const weaken = (id, against = id === 'p1' ? 'p2' : 'p1') => node.edit(world => {
    const loser = world.cities[id];
    const rival = powerBreakdown(world.cities[against]);
    loser.buildings.hall = 9;
    // The same army as the rival, scaled so that the loser's matchmaking power is 86% of the rival's: inside the ±20% bracket, with a much smaller army.
    const factor = (.86 * rival.matchmakingPower - powerBreakdown(loser).fortificationPower - 225) / rival.rosterPower;
    loser.troops = Object.fromEntries(Object.entries(world.cities[against].troops).map(([unit, count]) => [unit, Math.round(count * factor)]));
    loser.tech = { ...loser.tech, tactics:world.cities[against].tech.tactics };
  });
  const refusal = (player, order) => { try { node.app.ledger.create(player, order); } catch (error) { return error; } return null; };
  const preview = (player, target, stake) => { let terms; node.edit(world => { terms = node.app.ledger.raidPreview(world, player, target, stake); }); return terms; };
  const entryOf = id => node.app.store.read().world.bchTreasury.records.find(record => record.payment === id && record.kind === 'battle');
  const settlementOf = id => node.app.store.payments().find(row => row.settles === id && !['expired', 'rejected'].includes(row.state));
  const evidence = id => node.app.ledger.evidence(id, { publicKey:attestor.publicKey, signature:signAttestorRequest(id, attestorKey) });
  return { ...node, weaken, refusal, preview, entryOf, settlementOf, evidence };
}
const raidOn = (target, stake) => ({ type:'attack-paid', target, stake });
const chestOf = (app, player) => app.ledger.balances(player);

test('no paid raid without matched exposure: an empty War Chest, a short one, and no override', async t => {
  const { app, buy, refusal, preview } = await arena(t);
  // Empty War Chest.
  const empty = refusal('p1', raidOn('p2', 10_000));
  assert.equal(empty.status, 409);
  assert.match(empty.message, /cannot cover the smallest stake.*free raid/s);
  assert.deepEqual([empty.preview.eligible, empty.preview.defenderCapturableSatoshis, empty.preview.maximumStakeSatoshis], [false, 0, 0]);
  // The old override is gone: asking for a paid raid "without a reward" changes nothing.
  assert.equal(refusal('p1', { ...raidOn('p2', 10_000), acceptNoReward:true })?.status, 409);
  assert.equal(app.store.payments().filter(row => row.action === 'attack-paid').length, 0, 'no checkout was prepared');
  // The defender holds less than S.
  await buy('p2', { type:'war-chest', satoshis:10_000, consent:true });
  const short = refusal('p1', raidOn('p2', 25_000));
  assert.match(short.message, /can cover at most 10000 satoshis/);
  assert.deepEqual([short.preview.eligible, short.preview.defenderCapturableSatoshis, short.preview.maximumStakeSatoshis, short.preview.suggestedStakes], [false, 10_000, 10_000, [10_000]]);
  // Off the stake grid, or below the smallest stake.
  assert.match(refusal('p1', raidOn('p2', 5_000)).message, /Choose a stake from 10000/);
  assert.match(refusal('p1', raidOn('p2', 10_500)).message, /Choose a stake from 10000/);
  // An unconfirmed deposit is not exposure: only confirmed War Chest outputs count.
  const pending = app.ledger.create('p3', { type:'war-chest', satoshis:50_000, consent:true });
  assert.equal(pending.state, 'awaiting_signature');
  assert.equal(preview('p1', 'p3', 10_000).eligible, false);
  // A free raid needs no stake and no War Chest on either side.
  assert.equal(rules.minimumStake, 10_000);
});

test('defender holds exactly S: the attacker wins both stakes in one transaction and the chest is emptied to the satoshi', async t => {
  const { app, buy, settle, preview, weaken, entryOf, settlementOf, paidTo, transactions } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:10_000, consent:true });
  weaken('p2');
  const terms = preview('p1', 'p2', 10_000);
  assert.deepEqual([terms.eligible, terms.stakeSatoshis, terms.defenderExposureSatoshis, terms.defenderCapturableSatoshis, terms.maxWinSatoshis, terms.maxLossSatoshis],
    [true, 10_000, 10_000, 10_000, 10_000, 10_000], 'equal principal exposure on both sides');
  const raid = await buy('p1', raidOn('p2', 10_000));
  // The wallet pays the stake and the disclosed network reserve, nothing else.
  assert.equal(raid.quote.satoshis, terms.totalPaymentSatoshis);
  assert.equal(raid.quote.satoshis, 10_000 + terms.networkReserveSatoshis);
  assert.deepEqual(raid.quote.outputs.map(({ role, satoshis }) => [role, satoshis]), [['escrow', raid.quote.satoshis], ['event', 0]]);
  const staked = raid.row.receipt.allocations[0];
  const contract = raidEscrow(staked.escrow);
  assert.deepEqual([contract.script, contract.ownerScript, contract.opponent, contract.principal, contract.panel],
    [staked.script, wallets.p1.script, wallets.p2.script, 10_000, { keys:[operator.publicKey, attestor.publicKey].sort(), threshold:2 }]);
  await settle(3);
  const entry = entryOf(raid.row.id);
  assert.deepEqual([entry.winner, entry.stakeLane, entry.capturedSatoshis, entry.stakePayouts], ['attacker', 'attacker-wins', 10_000, { attacker:20_000, defender:0 }]);
  const settlement = settlementOf(raid.row.id);
  assert.equal(settlement.state, 'credited');
  const { transaction } = transactions.get(settlement.txid);
  assert.equal(transaction.inputs.length, 2, 'the defender\'s War Chest and the attacker\'s escrow are spent together');
  assert.deepEqual(transaction.outputs.filter(output => output.valueSatoshis > 0n).map(output => [scriptOf(output), Number(output.valueSatoshis)]),
    [[wallets.p1.script, 20_000], [wallets.p1.script, terms.networkReserveSatoshis - terms.win.feeSatoshis]], 'both stakes, then the unused reserve; nothing is left of a chest that held exactly the stake');
  // Preview, contract, accounting and payout agree.
  assert.equal(paidTo(wallets.p1.script, settlement.txid), terms.win.receiveSatoshis);
  assert.equal(terms.win.receiveSatoshis, 20_000 + terms.networkReserveSatoshis - terms.win.feeSatoshis);
  assert.equal(settlement.feeSatoshis, terms.win.feeSatoshis);
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').atRiskSatoshis, chestOf(app, 'p2').capturableSatoshis], [0, 0, 0], 'the defender lost exactly S');
  // Net effect on the attacker: +S less the measured settlement fee (the wallet's own payment fee aside).
  assert.equal(paidTo(wallets.p1.script, settlement.txid) - raid.quote.satoshis, 10_000 - terms.win.feeSatoshis);
  assert.equal(terms.win.netSatoshis, 10_000 - terms.win.feeSatoshis);
  assert.equal(app.store.payments().filter(row => row.settles === raid.row.id && row.state === 'credited').length, 1, 'one raid, one settlement');
});

test('defender holds more than S: exactly S is captured and the rest returns to the War Chest', async t => {
  const { app, buy, settle, preview, weaken, entryOf, settlementOf, paidTo, chain } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:60_000, consent:true });
  weaken('p2');
  const terms = preview('p1', 'p2', 25_000);
  assert.deepEqual([terms.eligible, terms.defenderExposureSatoshis, terms.defenderCapturableSatoshis, terms.suggestedStakes], [true, 25_000, 60_000, [10_000, 25_000, 50_000]]);
  const raid = await buy('p1', raidOn('p2', 25_000));
  // While the raid is open, 25,000 of the War Chest are claimed and the rest is still on offer.
  assert.deepEqual([chestOf(app, 'p2').reservedSatoshis, chestOf(app, 'p2').capturableSatoshis], [25_000, 35_000]);
  await settle(3);
  assert.equal(entryOf(raid.row.id).capturedSatoshis, 25_000);
  const settlement = settlementOf(raid.row.id);
  assert.equal(paidTo(wallets.p1.script, settlement.txid), terms.win.receiveSatoshis);
  assert.equal(paidTo(chain.chestOf({ ownerKey:wallets.p2.publicKey, revision:4 }).script, settlement.txid), 35_000, 'the remainder is back in the defender\'s own chest');
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').atRiskSatoshis, chestOf(app, 'p2').reservedSatoshis, chestOf(app, 'p2').capturableSatoshis], [35_000, 35_000, 0, 35_000]);
});

test('defender wins: the defender receives the attacker\'s whole stake and the War Chest is untouched', async t => {
  const { app, buy, settle, preview, weaken, entryOf, settlementOf, paidTo, transactions } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  weaken('p1');
  const terms = preview('p1', 'p2', 10_000);
  const raid = await buy('p1', raidOn('p2', 10_000));
  await settle(3);
  const entry = entryOf(raid.row.id);
  assert.deepEqual([entry.winner, entry.stakeLane, entry.capturedSatoshis, entry.stakePayouts], ['defender', 'defender-wins', 0, { attacker:0, defender:10_000 }]);
  const settlement = settlementOf(raid.row.id);
  assert.equal(settlement.state, 'credited');
  assert.equal(transactions.get(settlement.txid).transaction.inputs.length, 1, 'the escrow alone: the War Chest is not an input');
  assert.equal(paidTo(wallets.p2.script, settlement.txid), 10_000, 'the whole stake, not half of it');
  // The attacker loses S; of the reserve only the measured fee is spent and the rest comes back, as previewed.
  assert.equal(paidTo(wallets.p1.script, settlement.txid), terms.loss.receiveSatoshis);
  assert.equal(settlement.feeSatoshis, terms.loss.feeSatoshis);
  assert.equal(raid.quote.satoshis - paidTo(wallets.p1.script, settlement.txid), 10_000 + terms.loss.feeSatoshis);
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').capturableSatoshis], [20_000, 20_000]);
});

test('concurrent raids never claim the same War Chest satoshi twice, and a withdrawal cannot touch what is claimed', async t => {
  const { app, buy, pay, mine, refusal, preview, advance, weaken } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  weaken('p2');
  mine(150);
  // p1 prepares a raid for 10,000 but has not paid yet: the amount is already claimed.
  const quoted = app.ledger.create('p1', raidOn('p2', 10_000));
  assert.equal(preview('p3', 'p2', 20_000).defenderCapturableSatoshis, 10_000);
  assert.match(refusal('p3', raidOn('p2', 20_000)).message, /can cover at most 10000 satoshis/);
  const second = app.ledger.create('p3', raidOn('p2', 10_000));
  // Both are quoted: nothing is left for a third attacker.
  assert.equal(preview('p3', 'p2', 10_000).reason ?? 'ok', 'A paid raid between these two kingdoms is still being prepared or settled.');
  assert.equal(preview('p3', 'p2', 10_000).defenderCapturableSatoshis, 0);
  // The defender is not shown a raid that is only being prepared: seeing it would invite a withdrawal before the stake arrives.
  assert.deepEqual([chestOf(app, 'p2').capturableSatoshis, chestOf(app, 'p2').reservedSatoshis, chestOf(app, 'p2').quotedSatoshis], [20_000, 0, undefined]);
  assert.ok(quoted.id !== second.id);
  // A checkout that was only prepared does not freeze the defender's money: nobody can lock a War Chest by preparing raids and never paying.
  // Once one stake is really paid, exactly that amount is held.
  await app.ledger.submit('p1', quoted.id, pay('p1', quoted));
  assert.equal(chestOf(app, 'p2').reservedSatoshis, app.store.payment(quoted.id).fulfillment ? chestOf(app, 'p2').reservedSatoshis : 10_000);
  await assert.rejects(app.ledger.payout('p2', { kind:'kingdom-withdraw', satoshis:15_000, address:wallets.p2.address, consent:true }), /10000 satoshis of your War Chest are matched against paid raids/);
  // An unpaid checkout stops claiming the chest when it expires.
  assert.equal(preview('p1', 'p3', 10_000).defenderCapturableSatoshis, 0);
  advance(31 * 60_000);
  assert.ok(second.expiresAt < app.store.read().world.now + 31 * 60_000);
});

test('a prepared but unpaid raid cannot freeze a War Chest; a raid whose cover is gone when it is paid is void', async t => {
  const { app, buy, pay, mine, settle, weaken, settlementOf, paidTo } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  weaken('p2');
  mine(150);
  const quote = app.ledger.create('p1', raidOn('p2', 20_000));
  // The defender, who cannot see the checkout, withdraws most of the chest before the attacker pays.
  const payout = await app.ledger.payout('p2', { kind:'kingdom-withdraw', satoshis:15_000, address:wallets.p2.address, consent:true });
  mine();
  await settle(1);
  assert.equal(app.store.payment(payout.id).state, 'credited');
  // The attacker pays anyway. The War Chest no longer covers the stake, so there is no BCH outcome for either side.
  await app.ledger.submit('p1', quote.id, pay('p1', quote));
  await settle(3);
  const entry = app.store.read().world.bchTreasury.records.find(record => record.payment === quote.id && record.kind === 'battle');
  assert.deepEqual([entry.stakeLane, entry.capturedSatoshis], ['void', 0]);
  const settlement = settlementOf(quote.id);
  assert.deepEqual([settlement.state, settlement.lane], ['credited', 'void']);
  assert.equal(paidTo(wallets.p1.script, settlement.txid), quote.preview.void.receiveSatoshis, 'the stake and the unused reserve are back with the attacker');
  assert.match(quote.description, /the raid has no BCH outcome: your stake and reserve return/);
  assert.equal(chestOf(app, 'p2').warChestSatoshis, 20_000 - payout.satoshis - payout.feeSatoshis, 'nothing left the defender\'s War Chest');
});

test('two raids against one chest both settle, in turn, for exactly their own stake', async t => {
  const { app, buy, pay, settle, edit, preview, weaken, entryOf, settlementOf, paidTo } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  weaken('p2');
  // Two attackers who are not allies (a game rule stops allies from attacking the same city in turn).
  edit(world => { for (const id of ['p1', 'p2', 'p3']) world.cities[id].alliance = null; });
  // Both raids are quoted while the chest is whole: together they claim all of it.
  const first = app.ledger.create('p1', raidOn('p2', 10_000));
  const second = app.ledger.create('p3', raidOn('p2', 10_000));
  assert.equal(preview('p1', 'p2', 10_000).defenderCapturableSatoshis, 0);
  await app.ledger.submit('p1', first.id, pay('p1', first));
  await settle(3);
  assert.equal(settlementOf(first.id).state, 'credited');
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, preview('p1', 'p2', 10_000).defenderCapturableSatoshis], [10_000, 0], 'what is left is exactly what the second raid was quoted');
  // The second attacker arrives after the defender's recovery shield has run out and its army has been rebuilt.
  edit(world => { world.cities.p2.shieldUntil = 0; });
  weaken('p2', 'p3');
  await app.ledger.submit('p3', second.id, pay('p3', second));
  await settle(3);
  for (const [player, quote] of [['p1', first], ['p3', second]]) {
    const entry = entryOf(quote.id);
    assert.ok(entry, JSON.stringify(app.store.payment(quote.id).fulfillment ?? app.store.payment(quote.id).state));
    assert.deepEqual([entry.winner, entry.stakeLane, entry.capturedSatoshis], ['attacker', 'attacker-wins', 10_000]);
    const settlement = settlementOf(quote.id);
    assert.equal(settlement?.state, 'credited');
    assert.equal(paidTo(wallets[player].script, settlement.txid), quote.preview.win.receiveSatoshis);
  }
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').reservedSatoshis], [0, 0]);
  assert.equal(preview('p1', 'p3', 10_000).eligible, false);
});

test('a raid that cannot be fought is void: the stake and the unused reserve return, and nothing leaves the War Chest', async t => {
  const { app, buy, pay, settle, edit, settlementOf, paidTo, evidence, setAttesting } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  const quote = app.ledger.create('p1', raidOn('p2', 10_000));
  // Between the quote and the confirmed payment the defender came under a shield: the raid command is refused when the payment confirms.
  edit(world => { world.cities.p2.shieldUntil = world.now + 3_600_000; });
  setAttesting(false);
  await app.ledger.submit('p1', quote.id, pay('p1', quote));
  await settle(2);
  assert.equal(app.store.payment(quote.id).fulfillment.status, 'review');
  const [item] = app.ledger.pendingAwards().filter(entry => entry.kind === 'raid');
  assert.equal(item.lane, 'void');
  assert.deepEqual(checkRaid({ item, evidence:evidence(item.id), pins:{}, me:attestor.publicKey }).problems, [], 'no battle was started by this payment, so returning the stake is the only outcome');
  setAttesting(true);
  await settle(3);
  const settlement = settlementOf(quote.id);
  assert.equal(settlement.state, 'credited');
  assert.equal(paidTo(wallets.p1.script, settlement.txid), quote.preview.void.receiveSatoshis);
  assert.equal(quote.satoshis - paidTo(wallets.p1.script, settlement.txid), quote.preview.void.feeSatoshis, 'the attacker is out the settlement fee only');
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').reservedSatoshis, chestOf(app, 'p2').capturableSatoshis], [20_000, 0, 20_000]);
});

test('a defender who starts an exit after the raid was funded is still captured, from the exit script', async t => {
  const { app, chain, buy, settle, mine, accept, coin, setAttesting, weaken, entryOf, settlementOf, paidTo, preview } = await arena(t);
  const deposit = await buy('p2', { type:'war-chest', satoshis:30_000, consent:true });
  weaken('p2');
  const terms = preview('p1', 'p2', 10_000);
  setAttesting(false);
  const raid = await buy('p1', raidOn('p2', 10_000));
  await settle(2);
  // The attacker won and the atomic settlement is proposed against the live chest output.
  const proposal = app.store.payments().find(row => row.settles === raid.row.id);
  assert.deepEqual([proposal.state, proposal.lane, proposal.rawHex], ['created', 'attacker-wins', undefined]);
  assert.equal(entryOf(raid.row.id).stakeLane, 'attacker-wins');
  // The defender tries to leave before the attestor signs: the owner's key moves the whole chest into its exit script.
  const [funded] = deposit.row.receipt.allocations;
  const exit = signChestExit([funded], keys.p2, { fee:coin('p2') });
  accept(exit.rawHex);
  mine();
  await settle(2);
  assert.equal(app.store.payment(proposal.id).state, 'expired', 'the proposal against the moved output lapses');
  const again = app.store.payments().find(row => row.settles === raid.row.id && row.state === 'created');
  const chest = chain.chestOf({ ownerKey:wallets.p2.publicKey, revision:4 });
  assert.equal(again.sources[0].script, chest.exitScript, 'the settlement is proposed again against the exit script');
  // While the settlement is only proposed, nothing has moved: the defender still sees the whole chest, 10,000 of it matched.
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').exitingChestSatoshis, chestOf(app, 'p2').reservedSatoshis], [30_000, 30_000, 10_000]);
  // The owner cannot finish the exit before the capture can confirm.
  mine(100);
  assert.throws(() => accept(signKingdomRecovery([{ ...exit.exits[0], txid:exit.txid }], keys.p2, [{ script:wallets.p2.script, satoshis:29_000 }]).rawHex), /non-BIP68-final/);
  setAttesting(true);
  await settle(3);
  const settlement = settlementOf(raid.row.id);
  assert.equal(settlement.state, 'credited');
  assert.equal(paidTo(wallets.p1.script, settlement.txid), terms.win.receiveSatoshis, 'the attacker receives exactly what was previewed');
  assert.equal(paidTo(chest.exitScript, settlement.txid), 20_000, 'the remainder stays in the exit script, for its owner');
  assert.deepEqual([chestOf(app, 'p2').warChestSatoshis, chestOf(app, 'p2').exitingChestSatoshis, chestOf(app, 'p2').capturableSatoshis], [20_000, 20_000, 0]);
  // After the delay the owner takes the rest alone.
  mine(300);
  const rest = { ...settlement.changes[0], txid:settlement.txid };
  accept(signKingdomRecovery([rest], keys.p2, [{ script:wallets.p2.script, satoshis:19_300 }]).rawHex);
});

test('a fake result gets no signature: the game key alone opens no lane, and an honest attestor refuses what the battle does not show', async t => {
  const { app, buy, settle, accept, setAttesting, evidence, weaken } = await arena(t);
  const deposit = await buy('p2', { type:'war-chest', satoshis:20_000, consent:true });
  weaken('p1');
  setAttesting(false);
  const raid = await buy('p1', raidOn('p2', 10_000));
  await settle(2);
  const staked = raid.row.receipt.allocations[0];
  const [chest] = deposit.row.receipt.allocations;
  // The server (or a thief holding its key) tries each lane with its own key only.
  for (const lane of ['void', 'defender-wins']) {
    const forged = planRaidSpend(staked, { lane });
    const mine = signRaidDigest(forged.digest, operatorKey);
    assert.throws(() => completeRaidSpend(forged, { [operator.publicKey]:mine }), /attestor signature is missing/);
    assert.throws(() => accept(completeRaidSpend(forged, { [operator.publicKey]:mine, [attestor.publicKey]:mine }, { unchecked:true }).rawHex), /mandatory-script-verify/);
  }
  const theft = planMatchedCapture([chest], staked);
  assert.throws(() => completeMatchedCapture(theft, operatorKey, {}), /attestor signature is missing/);
  assert.throws(() => accept(completeMatchedCapture(theft, operatorKey, { [attestor.publicKey]:signMatchedDigests(theft, operatorKey) }, { unchecked:true }).rawHex), /mandatory-script-verify/);
  // The honest proposal: the defender won. The attestor's own checks pass for it.
  const [item] = app.ledger.pendingAwards().filter(entry => entry.kind === 'raid');
  assert.equal(item.lane, 'defender-wins');
  const proof = evidence(item.id);
  const honest = checkRaid({ item, evidence:proof, pins:{}, me:attestor.publicKey });
  assert.deepEqual(honest.problems, []);
  assert.deepEqual(honest.battle.winner, 'defender');
  // A server that claims the attacker won: the lane does not follow from the replayed battle.
  const lie = { ...item, lane:'attacker-wins', sources:[chest, ...item.sources], digests:theft.digests };
  assert.match(checkRaid({ item:lie, evidence:proof, pins:{}, me:attestor.publicKey }).problems.join(' | '), /won by the defender; the proposed lane "attacker-wins" does not follow/);
  // A server that quietly returns the stake to deny the defender the win.
  const back = planRaidSpend(staked, { lane:'void', eventScript:item.eventScript ?? undefined });
  assert.match(checkRaid({ item:{ ...item, lane:'void', digests:[back.digest] }, evidence:proof, pins:{}, me:attestor.publicKey }).problems.join(' | '), /returning the stake does not follow/);
  // A battle record edited to show another winner no longer replays.
  const edited = structuredClone(proof);
  edited.battles[0].record.battle.winner = 'attacker';
  assert.match(checkRaid({ item:lie, evidence:edited, pins:{}, me:attestor.publicKey }).problems.join(' | '), /replaying the recorded battle does not reproduce its result/);
  // Evidence of another payment, a different stake, or a second outcome for a stake this attestor already signed.
  assert.match(checkRaid({ item, evidence:{ ...proof, payment:{ ...proof.payment, txid:'00'.repeat(32) } }, pins:{}, me:attestor.publicKey }).problems.join(' | '), /belongs to another payment/);
  assert.match(checkRaid({ item:{ ...item, stakeSatoshis:5_000 }, evidence:proof, pins:{}, me:attestor.publicKey }).problems.join(' | '), /different stake/);
  assert.match(checkRaid({ item, evidence:proof, pins:{ ['raid:' + staked.txid + ':' + staked.vout]:'void' }, me:attestor.publicKey }).problems.join(' | '), /already signed a different outcome/);
  // Signed honestly, the defender is paid.
  setAttesting(true);
  await settle(3);
  assert.equal(app.store.payments().find(row => row.settles === raid.row.id).state, 'credited');
});

test('the stake decides how much is at risk and nothing else: the battle is the same at any stake', async t => {
  const outcomes = [];
  for (const stake of [10_000, 100_000]) {
    const { app, buy, settle, edit, weaken, entryOf } = await arena(t);
    // The same world twice: same armies and the same battle seed. Only the stake differs.
    edit(world => { world.secret = '5a'.repeat(32); });
    await buy('p2', { type:'war-chest', satoshis:100_000, consent:true });
    weaken('p2');
    const raid = await buy('p1', raidOn('p2', stake));
    await settle(2);
    const battle = app.store.read().world.battles.find(item => item.id === raid.row.fulfillment.result.id);
    outcomes.push({ winner:battle.winner, differential:battle.differential, losses:battle.losses, hash:battle.hash });
    assert.equal(entryOf(raid.row.id).capturedSatoshis, stake);
  }
  assert.deepEqual(outcomes[0], outcomes[1], 'a tenfold stake changes no combat number');
});

test('a second paid raid between the same two kingdoms within 24 hours is refused, and allies cannot stake against each other', async t => {
  const { app, buy, settle, refusal, edit, advance, weaken, preview } = await arena(t);
  weaken('p2');
  await buy('p2', { type:'war-chest', satoshis:40_000, consent:true });
  await buy('p1', { type:'war-chest', satoshis:40_000, consent:true });
  const raid = await buy('p1', raidOn('p2', 10_000));
  await settle(3);
  assert.equal(app.store.payments().find(row => row.settles === raid.row.id).state, 'credited');
  // The loser's recovery shield is one rule; the 24-hour limit on paid raids between the same two kingdoms is another.
  edit(world => { world.cities.p1.shieldUntil = 0; world.cities.p2.shieldUntil = 0; });
  weaken('p2');
  // The game's own repeat-attack rule refuses the checkout; the BCH rule is separate and covers both directions.
  assert.match(refusal('p1', raidOn('p2', 10_000)).message, /recently attacked this city|already fought a paid raid/);
  assert.match(preview('p1', 'p2', 10_000).reason, /already fought a paid raid in the last 24 hours/);
  assert.match(preview('p2', 'p1', 10_000).reason, /already fought a paid raid in the last 24 hours/);
  assert.deepEqual([preview('p1', 'p2', 10_000).eligible, preview('p1', 'p2', 10_000).pairCooldownHours], [false, 24]);
  advance(86_400_001);
  edit(world => { world.cities.p1.shieldUntil = 0; world.cities.p2.shieldUntil = 0; });
  weaken('p2');
  assert.equal(preview('p1', 'p2', 10_000).eligible, true, 'a day later the two may stake against each other again');
  edit(world => { world.cities.p1.alliance = 'a1'; world.cities.p2.alliance = 'a1'; });
  assert.match(preview('p1', 'p2', 10_000).reason, /Allies cannot stake BCH against each other/);
});

test('a withdrawal in flight is not exposure: a raid is matched only against what is confirmed and not being spent', async t => {
  const { app, buy, mine, settle, preview, refusal, weaken } = await arena(t);
  await buy('p2', { type:'war-chest', satoshis:30_000, consent:true });
  weaken('p2');
  mine(150);
  assert.equal(preview('p1', 'p2', 25_000).eligible, true);
  // The defender withdraws 10,000 through the game. Until that transaction confirms, the outputs it spends are not counted.
  const payout = await app.ledger.payout('p2', { kind:'kingdom-withdraw', satoshis:10_000, address:wallets.p2.address, consent:true });
  assert.equal(app.store.payment(payout.id).state, 'submitted');
  assert.deepEqual([preview('p1', 'p2', 25_000).eligible, preview('p1', 'p2', 10_000).eligible, chestOf(app, 'p2').capturableSatoshis], [false, false, 0]);
  assert.match(refusal('p1', raidOn('p2', 10_000)).message, /cannot cover the smallest stake/);
  mine();
  await settle(1);
  // Confirmed: what is left is one output on the 1,000-satoshi grid, and exactly that much can be matched.
  const left = chestOf(app, 'p2').warChestSatoshis;
  assert.deepEqual([left, left % 1000, chestOf(app, 'p2').capturableSatoshis], [30_000 - payout.satoshis - payout.feeSatoshis, 0, left]);
  assert.equal(preview('p1', 'p2', 25_000).eligible, false);
  assert.equal(preview('p1', 'p2', left).eligible, true);
  // And the other way round: once a raid is funded, the defender cannot withdraw what it claims.
  await buy('p1', raidOn('p2', left));
  await assert.rejects(app.ledger.payout('p2', { kind:'kingdom-withdraw', satoshis:5_000, address:wallets.p2.address, consent:true }), /pending payout|matched against paid raids/);
});
