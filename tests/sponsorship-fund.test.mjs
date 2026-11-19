import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createVirtualMachineBCH } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { SPONSOR_ALLOCATION, sponsorshipAllocation, sponsorshipPolicy } from '../config/payments.mjs';
import { chipnetTreasuryConfig } from '../config/treasury.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { PRIZE_FUND, buildPrizeRefund, completePrizeAward, planPrizeAward, prizeFund, signPrizeAward } from '../packages/chain-observer/prize-fund.mjs';
import { advance } from '../packages/game-engine/index.mjs';

const initialTime = Date.UTC(2026, 10, 18);
const key = number => number.toString(16).padStart(64, '0');
const hash = value => createHash('sha256').update(value).digest('hex');
const operatorKey = key(700);
const operator = walletFromPrivateKey(operatorKey);
const developer = walletFromPrivateKey(key(701));
const attestorKeys = [key(702), key(703)];
const attestors = attestorKeys.map(item => walletFromPrivateKey(item));
const sponsorKey = key(704);
const sponsor = walletFromPrivateKey(sponsorKey);
const winners = [walletFromPrivateKey(key(705)), walletFromPrivateKey(key(706))];
const MINIMUM = 25_000_000;
const fund = satoshis => ({ type:'sponsor-fund', satoshis, consent:true });
const vm = createVirtualMachineBCH();

// The fixture node keeps real transactions, refuses double spends and non-final transactions, and runs the BCH VM on every broadcast.
async function fixture(t, { attestorCount = 2 } = {}) {
  let now = initialTime;
  let sequence = 0;
  const transactions = new Map();
  const spent = new Set();
  const assets = { enabled:false, list:() => [], authority:() => null, close:() => {} };
  const touches = (item, script) => item.transaction.outputs.some(output => hex(output.lockingBytecode) === script) ||
    item.transaction.inputs.some(input => {
      const output = transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex];
      return output && hex(output.lockingBytecode) === script;
    });
  function accept(raw) {
    const decoded = readTransaction(raw);
    if (transactions.has(decoded.txid)) return decoded.txid;
    const points = decoded.transaction.inputs.map(input => hex(input.outpointTransactionHash) + ':' + input.outpointIndex);
    if (points.some(point => spent.has(point))) throw new Error('txn-mempool-conflict');
    if (decoded.transaction.locktime >= 500_000_000 && decoded.transaction.locktime > now / 1000) throw new Error('non-final');
    const sourceOutputs = decoded.transaction.inputs.map(input => transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex]);
    if (!sourceOutputs.every(Boolean)) throw new Error('missing-inputs');
    const verdict = vm.verify({ transaction:decoded.transaction, sourceOutputs });
    if (verdict !== true) throw new Error('mandatory-script-verify-flag-failed: ' + verdict);
    for (const point of points) spent.add(point);
    transactions.set(decoded.txid, { ...decoded, rawHex:raw, confirmations:0, height:0 });
    return decoded.txid;
  }
  const chain = createChain({ treasuryPrivateKey:operatorKey, developmentAddress:developer.address,
    prizeAttestors:attestors.slice(0, attestorCount).map(item => item.publicKey), transport:{ withClient:run => run({
      history:async script => [...transactions.values()].filter(item => touches(item, script)).map(item => ({ txid:item.txid, height:item.height })),
      raw:async txid => transactions.get(txid)?.rawHex ?? null,
      lookup:async txid => transactions.get(txid),
      broadcast:async raw => accept(raw) }) } });
  const app = createApp({ database:':memory:', localDemo:true, clock:() => now, chain, territoryAssets:assets, politicalAssets:assets });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { const closed = once(app.server, 'close'); app.close(); await closed; });
  function pay(quote) {
    const outputs = app.store.payment(quote.id).outputs.map(({ script, satoshis }) => ({ script, satoshis }));
    const input = quote.satoshis + 10_000;
    const signed = signSpend({ privateKey:sponsorKey, sources:[{ txid:hash('sponsor-' + (++sequence)), vout:0, script:sponsor.script, satoshis:input }],
      outputs:[...outputs, { script:sponsor.script, satoshis:input - quote.satoshis - 400 }] });
    const observed = { ...readTransaction(signed.rawHex), rawHex:signed.rawHex, confirmations:2, height:392_000, blockHash:hash('block'), blockTime:now };
    transactions.set(observed.txid, observed);
    return observed.txid;
  }
  const confirmAll = () => { for (const item of transactions.values()) if (!item.confirmations) { item.confirmations = 2; item.height = 392_001; } };
  const seat = (id, wallet) => {
    app.store.addSession(hash('seat-' + id), id, initialTime + 3650 * 86_400_000);
    app.store.bindWallet(id, wallet.address, wallet.publicKey, now);
  };
  function endSeason(scores) {
    app.store.transaction(() => {
      const { world } = app.store.read();
      now = world.season.endsAt;
      for (const [id, score] of Object.entries(scores)) world.cities[id].score = score;
      advance(world, now);
      app.store.write(world);
    });
  }
  async function sponsored(satoshis = MINIMUM) {
    seat('p3', sponsor);
    const quote = app.ledger.create('p3', fund(satoshis));
    await app.ledger.submit('p3', quote.id, pay(quote));
    assert.equal(app.store.payment(quote.id).state, 'credited');
    return quote;
  }
  const port = () => app.server.address().port;
  return { app, chain, transactions, accept, pay, confirmAll, seat, endSeason, sponsored, port, advance:ms => { now += ms; }, time:() => now };
}

test('every permitted sponsorship amount splits into exactly 30% and 70% with no satoshi lost', () => {
  assert.equal(sponsorshipPolicy.minimumSatoshis, 25_000_000, 'the minimum is 0.25 BCH');
  assert.deepEqual([sponsorshipPolicy.developmentPercent, sponsorshipPolicy.prizePercent], [30, 70]);
  assert.deepEqual(sponsorshipAllocation(25_000_000), { development:7_500_000, prize:17_500_000 });
  assert.deepEqual(sponsorshipAllocation(2_500_000_000), { development:750_000_000, prize:1_750_000_000 });
  assert.throws(() => sponsorshipAllocation(24_999_990), /25,000,000/);
  assert.throws(() => sponsorshipAllocation(25_000_005), /multiples of 10/);
  assert.throws(() => sponsorshipAllocation(2_500_000_010), /2,500,000,000/);
  let seed = 20261119;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
  const steps = (sponsorshipPolicy.maximumSatoshis - sponsorshipPolicy.minimumSatoshis) / sponsorshipPolicy.satoshiStep;
  for (let index = 0; index < 20_000; index += 1) {
    const total = sponsorshipPolicy.minimumSatoshis + (next() % (steps + 1)) * sponsorshipPolicy.satoshiStep;
    const { development, prize } = sponsorshipAllocation(total);
    assert.ok(Number.isSafeInteger(development) && Number.isSafeInteger(prize));
    assert.equal(development * 10, total * 3);
    assert.equal(prize * 10, total * 7);
    assert.equal(development + prize, total);
  }
});

test('one developer address is accepted and attestor keys are validated', () => {
  const env = { CHIPNET_DEVELOPMENT_ADDRESS:developer.address, CHIPNET_PRIZE_ATTESTOR_KEYS:attestors.map(item => item.publicKey).join(',') };
  const config = chipnetTreasuryConfig(env);
  assert.equal(config.developmentAddress, developer.address);
  assert.equal(config.sponsorshipDevelopmentAddress, developer.address);
  assert.deepEqual(config.prizeAttestors, attestors.map(item => item.publicKey));
  assert.throws(() => chipnetTreasuryConfig({ ...env, CHIPNET_SPONSOR_DEVELOPMENT_ADDRESS:sponsor.address }), /one developer address/);
  assert.throws(() => chipnetTreasuryConfig({ ...env, CHIPNET_PRIZE_ATTESTOR_KEYS:'02abc' }), /compressed public keys/);
  assert.throws(() => createChain({ treasuryPrivateKey:operatorKey, prizeAttestors:[operator.publicKey] }), /must not be the game automation key/);
});

test('a sponsorship pays 30% to the developer address and 70% straight into its prize fund covenant', async t => {
  const { app, seat, pay, port } = await fixture(t);
  assert.throws(() => app.ledger.create('p3', fund(MINIMUM)), /Connect your wallet first/);
  seat('p3', sponsor);
  assert.throws(() => app.ledger.create('p3', fund(MINIMUM - 10)), /25,000,000/);
  const quote = app.ledger.create('p3', fund(MINIMUM));
  assert.deepEqual(quote.outputs.map(({ role, satoshis }) => [role, satoshis]), [['prize', 17_500_000], ['development', 7_500_000], ['event', 0]]);
  const saved = app.store.payment(quote.id);
  assert.equal(saved.event.data.allocationPolicy, SPONSOR_ALLOCATION);
  // Only the Development output reaches the developer address. It is the one output of the payment that address receives.
  assert.deepEqual(saved.outputs.filter(output => output.script === developer.script).map(output => output.role), ['development']);
  // The prize output is the covenant anyone can rebuild from the public terms. It is not an operator-key address.
  const { world } = app.store.read();
  const terms = { id:saved.id, operatorKey:operator.publicKey, attestors:attestors.map(item => item.publicKey).sort(), sponsorKey:sponsor.publicKey,
    closesAt:Math.floor(world.season.endsAt / 1000), refundAt:quote.fund.refundAt, refundFee:1000, awardPercent:40, awardAge:6, maxFee:2000,
    threshold:Math.floor(attestors.length / 2) + 1 };
  assert.equal(saved.outputs[0].script, prizeFund(terms).script);
  assert.equal(quote.fund.version, PRIZE_FUND);
  assert.ok(quote.fund.refundAt > terms.closesAt);
  assert.deepEqual(saved.event.data.fund, { version:PRIZE_FUND, script:saved.outputs[0].script, sponsor:sponsor.address, attestors:terms.attestors,
    closesAt:terms.closesAt, refundAt:terms.refundAt, awardPercent:40, awardAge:6, maxFee:2000, refundFee:1000, threshold:terms.threshold });
  await app.ledger.submit('p3', quote.id, pay(quote));
  assert.equal(app.store.payment(quote.id).state, 'credited');
  const { buckets, sponsorship } = app.ledger.explorer();
  assert.equal(buckets.prize, 17_500_000);
  assert.equal(buckets.externalDevelopment, 7_500_000);
  assert.equal(buckets.development, 0, 'the game holds no Development money');
  assert.deepEqual([sponsorship.confirmed.total, sponsorship.confirmed.development, sponsorship.confirmed.prize], [MINIMUM, 7_500_000, 17_500_000]);
  const catalogue = await (await fetch(`http://127.0.0.1:${port()}/api/public/sponsors`)).json();
  assert.deepEqual(catalogue.packages.map(item => [item.id, item.satoshis, item.allocation.development, item.allocation.prize]),
    [['standard', 50_000_000, 15_000_000, 35_000_000], ['champion', 200_000_000, 60_000_000, 140_000_000]]);
  assert.equal(catalogue.allocationRules.minimumSatoshis, 25_000_000);
});

test('a payment that changes the split or the destinations is not credited', async t => {
  const { app, seat, transactions } = await fixture(t);
  seat('p3', sponsor);
  const quote = app.ledger.create('p3', fund(MINIMUM));
  const outputs = app.store.payment(quote.id).outputs.map(({ script, satoshis }) => ({ script, satoshis }));
  // 20/80 amounts sent to the right scripts.
  outputs[0].satoshis = 20_000_000;
  outputs[1].satoshis = 5_000_000;
  const signed = signSpend({ privateKey:sponsorKey, sources:[{ txid:hash('wrong split'), vout:0, script:sponsor.script, satoshis:MINIMUM + 1_000 }], outputs });
  const observed = { ...readTransaction(signed.rawHex), rawHex:signed.rawHex, confirmations:2, height:392_000, blockHash:hash('block'), blockTime:initialTime };
  transactions.set(observed.txid, observed);
  const result = await app.ledger.submit('p3', quote.id, observed.txid).catch(error => ({ state:'refused', error }));
  assert.notEqual(result.state, 'credited');
  assert.equal(app.ledger.explorer().buckets.prize, 0);
});

test('neither the automation key nor an early signature can move a prize fund output', async t => {
  const { app, chain, accept, sponsored } = await fixture(t);
  const quote = await sponsored();
  const row = app.store.payment(quote.id);
  const source = { ...row.receipt.allocations[0] };
  const plan = planPrizeAward([source], [{ script:operator.script, satoshis:5_000_000 }, { script:source.script, satoshis:source.satoshis - 5_001_000 }]);
  const mine = signPrizeAward(plan, operatorKey);
  // The server signing in every position is refused by the script itself.
  assert.throws(() => completePrizeAward(plan, mine, Object.fromEntries(plan.contracts[0].attestors.map(item => [item, mine]))), /rejected the spend/);
  // One of two attestors is not enough.
  const one = signPrizeAward(plan, attestorKeys[0]);
  assert.throws(() => completePrizeAward(plan, mine, { [attestors[0].publicKey]:one, [attestors[1].publicKey]:mine }), /rejected the spend/);
  // Every signature present, but the season has not closed: the network refuses the transaction as non-final.
  const full = completePrizeAward(plan, mine, { [attestors[0].publicKey]:one, [attestors[1].publicKey]:signPrizeAward(plan, attestorKeys[1]) });
  assert.throws(() => accept(full.rawHex), /non-final/);
  // Even with every signature, the script refuses an award above 40% of the output, a remainder that leaves the fund, and a skim.
  const signedBy = attempt => completePrizeAward(attempt, signPrizeAward(attempt, operatorKey),
    { [attestors[0].publicKey]:signPrizeAward(attempt, attestorKeys[0]), [attestors[1].publicKey]:signPrizeAward(attempt, attestorKeys[1]) });
  assert.throws(() => signedBy(planPrizeAward([source], [{ script:operator.script, satoshis:7_000_001 }, { script:source.script, satoshis:source.satoshis - 7_001_001 }])), /rejected the spend/);
  assert.throws(() => signedBy(planPrizeAward([source], [{ script:operator.script, satoshis:5_000_000 }, { script:operator.script, satoshis:source.satoshis - 5_001_000 }])), /rejected the spend/);
  assert.throws(() => signedBy(planPrizeAward([source], [{ script:operator.script, satoshis:5_000_000 }, { script:source.script, satoshis:source.satoshis - 5_003_000 }])), /rejected the spend/);
  assert.throws(() => signedBy(planPrizeAward([source], [{ script:operator.script, satoshis:5_000_000 }, { script:source.script, satoshis:source.satoshis - 5_002_000 }, { script:operator.script, satoshis:1_000 }])), /rejected the spend/);
  assert.equal(readTransaction(full.rawHex).transaction.inputs[0].sequenceNumber, 6, 'an award needs a fund output at least six blocks old');
  // The keyless refund is closed before its date and can never pay anyone but the sponsor.
  assert.throws(() => accept(chain.prizeRefund([source]).rawHex), /non-final/);
  assert.equal(readTransaction(buildPrizeRefund([source]).rawHex).transaction.outputs.length, 1);
  assert.equal(hex(readTransaction(buildPrizeRefund([source]).rawHex).transaction.outputs[0].lockingBytecode), sponsor.script);
  assert.equal(app.ledger.explorer().buckets.prize, 17_500_000);
});

test('a prize is only a proposal until every attestor signs, then pays the ranked winner exactly', async t => {
  const { app, transactions, confirmAll, seat, endSeason, sponsored, port } = await fixture(t);
  const quote = await sponsored();
  winners.forEach((wallet, index) => seat('p' + (index + 1), wallet));
  endSeason({ p1:900, p2:500 });
  const pool = 17_500_000;
  const base = Math.floor(pool * 85 / 100);
  const award = Math.floor(base * 40 / 100);
  assert.equal(app.ledger.balances('p1').claimableSatoshis, award);
  const before = transactions.size;
  const proposal = await app.ledger.payout('p1', { kind:'claim', address:winners[0].address, consent:true });
  assert.equal(proposal.state, 'created');
  assert.equal(proposal.txid, undefined);
  assert.deepEqual(proposal.attestation.signed, []);
  assert.equal(transactions.size, before, 'nothing was broadcast');
  assert.equal(app.store.payment(proposal.id).rawHex, undefined, 'the server holds no signed transaction');

  // The attestor reads the public proposal and rebuilds the transaction independently before signing.
  const listing = await (await fetch(`http://127.0.0.1:${port()}/api/public/prize-awards`)).json();
  assert.deepEqual(listing.attestors, attestors.map(item => item.publicKey).sort());
  const [pending] = listing.pending;
  assert.deepEqual([pending.id, pending.playerId, pending.rank, pending.satoshis, pending.address, pending.verifiedWallet],
    [proposal.id, 'p1', 1, award, winners[0].address, winners[0].address]);
  assert.equal(pending.satoshis, Math.floor(pending.prizeBase * pending.percentages[pending.rank - 1] / 100));
  const plan = planPrizeAward(pending.sources, pending.outputs);
  assert.deepEqual(plan.digests, pending.digests);
  assert.deepEqual(pending.outputs.map(item => item.script), [pending.script, app.store.payment(quote.id).outputs[0].script, pending.eventScript],
    'the award pays the winner and the remainder returns to the same prize fund covenant');
  const attest = (index, signatures = signPrizeAward(plan, attestorKeys[index])) => fetch(`http://127.0.0.1:${port()}/api/public/prize-awards/${proposal.id}/attest`,
    { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ publicKey:attestors[index].publicKey, signatures }) });
  // A signature made with the automation key, or by a stranger, is not an attestation.
  assert.equal((await attest(0, signPrizeAward(plan, operatorKey))).status, 400);
  assert.equal((await attest(0, signPrizeAward(plan, key(999)))).status, 400);
  const first = await (await attest(0)).json();
  assert.equal(first.result.state, 'created');
  assert.deepEqual(first.result.attestation.signed, [attestors[0].publicKey]);
  assert.equal(transactions.size, before);
  const second = await (await attest(1)).json();
  assert.equal(second.result.state, 'submitted');
  const sent = transactions.get(second.result.txid);
  assert.ok(sent, 'the completed award passed the BCH VM in the fixture node');
  assert.equal(hex(sent.transaction.outputs[0].lockingBytecode), winners[0].script);
  assert.equal(sent.transaction.outputs[0].valueSatoshis, BigInt(award));
  assert.equal(hex(sent.transaction.outputs[1].lockingBytecode), pending.outputs[1].script);
  assert.equal(sent.transaction.outputs[1].valueSatoshis, BigInt(pool - award - pending.feeSatoshis));
  assert.equal((await attest(1)).status, 404, 'a finished award accepts no further signatures');
  confirmAll();
  await app.ledger.reconcile();
  assert.equal(app.store.payment(proposal.id).state, 'credited');
  assert.equal(app.ledger.pendingAwards()[0].sources[0].satoshis, pool - award - pending.feeSatoshis, 'the remainder is already reserved for the next winner');
  await assert.rejects(app.ledger.payout('p1', { kind:'claim', address:winners[0].address, consent:true }), /no eligible payout/);

  // The second winner is paid from the covenant remainder under the same rule, with the base fixed by the first claim.
  // Nobody asks for the second prize: the ledger proposed it by itself as soon as the first one confirmed.
  await assert.rejects(app.ledger.payout('p2', { kind:'claim', address:winners[1].address, consent:true }), /pending payout/);
  const next = app.ledger.list('p2').find(row => row.action === 'claim');
  assert.equal(next.state, 'created');
  assert.equal(next.satoshis, Math.floor(base * 25 / 100));
  const [second2] = app.ledger.pendingAwards();
  const plan2 = planPrizeAward(second2.sources, second2.outputs);
  for (const index of [1, 0]) await app.ledger.attestAward(next.id, { publicKey:attestors[index].publicKey, signatures:signPrizeAward(plan2, attestorKeys[index]) });
  confirmAll();
  await app.ledger.reconcile();
  assert.equal(app.store.payment(next.id).state, 'credited');
  const paid = award + next.satoshis + pending.feeSatoshis + second2.feeSatoshis;
  assert.equal(app.ledger.explorer().buckets.prize, pool - paid, 'every satoshi is a prize, a disclosed fee, or still in the covenant');
  await assert.rejects(app.ledger.voidPayout({ id:next.id, consent:true }), /cannot cancel/);
});

test('an award the attestors do not sign lapses and the winner can claim again', async t => {
  const { app, seat, endSeason, sponsored, advance } = await fixture(t, { attestorCount:1 });
  await sponsored();
  winners.forEach((wallet, index) => seat('p' + (index + 1), wallet));
  endSeason({ p1:900, p2:500 });
  const proposal = await app.ledger.payout('p1', { kind:'claim', address:winners[0].address, consent:true });
  await assert.rejects(app.ledger.payout('p1', { kind:'claim', address:winners[0].address, consent:true }), /pending payout/);
  advance(72 * 3_600_000 + 1);
  await app.ledger.reconcile();
  assert.equal(app.store.payment(proposal.id).state, 'expired');
  assert.equal(app.ledger.explorer().buckets.prize, 17_500_000, 'the fund output was never touched');
  const again = await app.ledger.payout('p1', { kind:'claim', address:winners[0].address, consent:true });
  assert.equal(again.satoshis, proposal.satoshis);
});

test('a contribution that is never awarded returns to its sponsor without any key', async t => {
  const { app, transactions, confirmAll, sponsored, advance, time } = await fixture(t);
  const quote = await sponsored();
  await app.ledger.reconcile();
  assert.equal(app.store.payments().some(row => row.action === 'sponsor-refund'), false);
  advance(quote.fund.refundAt * 1000 + 7_200_001 - time());
  await app.ledger.reconcile();
  const refund = [...transactions.values()].find(item => item.transaction.outputs.length === 1 && hex(item.transaction.outputs[0].lockingBytecode) === sponsor.script &&
    item.transaction.inputs.some(input => hex(input.outpointTransactionHash) === app.store.payment(quote.id).txid));
  assert.ok(refund, 'the keyless refund passed the BCH VM in the fixture node');
  assert.equal(refund.transaction.outputs[0].valueSatoshis, 17_500_000n - 600n);
  assert.equal(refund.transaction.inputs[0].unlockingBytecode[0], 0x00, 'no signature is pushed');
  confirmAll();
  await app.ledger.reconcile();
  const record = app.store.payments().find(row => row.action === 'sponsor-refund');
  assert.equal(record.txid, refund.txid);
  assert.equal(app.ledger.explorer().buckets.prize, 0, 'a refunded contribution no longer counts as prize money');
});

test('a campaign quoted at the previous prices stays visible but must be proposed again before funding', async t => {
  const { app, seat, port } = await fixture(t);
  seat('p3', sponsor);
  const start = initialTime + 120_000;
  const old = { id:'11111111-2222-4333-8444-555555555555', owner:'p3', title:'Old terms', sponsor:'Alden', blurb:'', link:'https://example.com', logo:null,
    package:'standard', placement:'banner', amount:5_000, start, end:start + 3_600_000, seasonId:1, status:'approved', createdAt:initialTime };
  app.store.savePortal('sponsor', old.id, old);
  assert.throws(() => app.ledger.create('p3', { type:'sponsor-fund', campaignId:old.id, consent:true }), /previous prices/);
  const response = await fetch(`http://127.0.0.1:${port()}/api/public/sponsors`);
  assert.equal(response.status, 200);
});
