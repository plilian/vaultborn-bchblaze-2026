// The complete attestor lifecycle against a live local game server. Three independent attestor keys each run the real
// tool (scripts/prize-attest.mjs) as its own process, with its own key file and its own pin file, over HTTP.
// The server runs on the enforcing fixture node (BCH VM, real transactions, block ages). Nothing here is Chipnet evidence.
//   node scripts/attestor-lifecycle.mjs [evidence.json]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { covenantNode, hash, keys, key, wallets } from '../tests/support/covenant-node.mjs';
import { walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { signChestExit } from '../packages/chain-observer/kingdom-vault.mjs';
import { powerBreakdown } from '../packages/game-engine/world.mjs';
import { NETWORK_ID } from '../config/network.mjs';
import { command as engine } from '../packages/game-engine/index.mjs';

const run = promisify(execFile);
const attestorKeys = [key(651), key(652), key(653)];
const attestors = attestorKeys.map(item => walletFromPrivateKey(item));
const dir = mkdtempSync(join(tmpdir(), 'vb-attestors-'));
attestorKeys.forEach((secret, index) => writeFileSync(join(dir, `attestor-${index + 1}.key`), secret + '\n'));
// The first season must already be over on the attestors' own clocks, so the game clock starts eight days back.
const node = await covenantNode({ attestors:attestors.map(item => item.publicKey), attestStakes:false, startAt:Date.now() - 8 * 86_400_000 });
const { app, chain, edit, buy, mine, advance, accept } = node;
const origin = 'http://127.0.0.1:' + app.server.address().port;
for (const id of ['p1', 'p2', 'p3']) {
  app.store.addSession(hash(hash('cookie-' + id)), id, Date.now() + 3650 * 86_400_000);
  app.store.bindWallet(id, wallets[id].address, wallets[id].publicKey, node.time());
}
edit(world => { for (const id of ['p1', 'p2', 'p3']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 }); });
const command = (player, body) => fetch(origin + '/api/command', { method:'POST', headers:{ Cookie:'dominion=' + hash('cookie-' + player), 'Content-Type':'application/json', Origin:process.env.DOMINION_HTTPS === 'true' ? origin.replace('http:', 'https:') : origin },
  body:JSON.stringify({ ...body, requestId:crypto.randomUUID() }) }).then(response => response.json());
// One attestor runs its tool once. Returns what the tool reported for each proposal and what it signed.
async function attestor(index, { approve = true } = {}) {
  const { stdout } = await run(process.execPath, ['scripts/prize-attest.mjs', origin, ...(approve ? ['--approve'] : [])],
    { env:{ ...process.env, NODE_NO_WARNINGS:'1', PRIZE_ATTESTOR_KEY_FILE:join(dir, `attestor-${index}.key`), PRIZE_ATTESTOR_PINS:join(dir, `attestor-${index}-pins.json`), PRIZE_ATTESTOR_BUNDLE_DIR:join(dir, `attestor-${index}-bundles`) } });
  const reviews = [...stdout.matchAll(/^\{\n[\s\S]*?^\}$/gm)].map(match => JSON.parse(match[0]));
  const signed = [...stdout.matchAll(/^attested (\w+) (\d+) (\w+)$/gm)].map(match => ({ id:match[1], status:Number(match[2]), state:match[3] }));
  return { reviews, signed };
}
const settle = async (rounds = 2) => { for (let round = 0; round < rounds; round += 1) { await app.ledger.reconcile(); mine(); } await app.ledger.reconcile(); };
const pending = kind => app.ledger.pendingAwards().filter(item => (item.kind ?? 'award') === kind);
const paidTo = node.paidTo;
const scenarios = [];
const scenario = async (name, body) => { const result = await body(); scenarios.push({ name, result:'PASS', ...result }); console.log('PASS ·', name); };

// The battle is decided by the armies: a kingdom whose matchmaking power sits in its city hall instead of its army loses
// to an opponent of the same power. The scenarios use that to know who wins.
const weaken = (id, against) => edit(world => {
  const loser = world.cities[id];
  const rival = powerBreakdown(world.cities[against]);
  loser.buildings.hall = 9;
  const factor = (.86 * rival.matchmakingPower - powerBreakdown(loser).fortificationPower - 225) / rival.rosterPower;
  loser.troops = Object.fromEntries(Object.entries(world.cities[against].troops).map(([unit, count]) => [unit, Math.round(count * factor)]));
  loser.tech = { ...loser.tech, tactics:world.cities[against].tech.tactics };
  loser.shieldUntil = 0;
  world.cities[against].shieldUntil = 0;
});
const forge = (honest, lane, chests) => {
  const row = { ...chain.signStakeSettlement({ source:honest.sources.at(-1), lane, chests, event:honest.event, payload:{ ...honest.payload, lane }, now:node.time() }), settles:honest.settles, pool:'escrow', title:'forged', description:'forged' };
  app.store.savePayment({ ...app.store.payment(honest.id), state:'voided' });
  app.store.savePayment(row);
  return row;
};
const problemsOf = (report, id) => report.reviews.find(item => (item.raid ?? item.stake ?? item.capture ?? item.award) === id)?.problems ?? [];

try {
  await scenario('one service purchase is a War Chest that covers the smallest stake; three payers\' reward shares join one season pool', async () => {
    const bought = [];
    for (const player of ['p1', 'p2', 'p3']) bought.push(await buy(player, { type:'premium', building:'hall' }));
    await settle(3);
    const balance = app.ledger.balances('p1');
    assert.deepEqual([balance.warChestSatoshis, balance.pendingChestSatoshis, balance.capturableSatoshis], [11_000, 0, 11_000]);
    const sweep = app.store.payments().find(row => row.action === 'allocation-sweep' && row.state === 'credited');
    assert.ok(sweep, 'the reward shares moved into the season pool without any key');
    return { price:bought[0].quote.satoshis, warChestShare:11_000, networkReserve:bought[0].row.reserveSatoshis, capturableAtOnce:balance.capturableSatoshis, poolSatoshis:app.ledger.explorer().buckets.prize, txid:bought[0].row.txid };
  });

  await scenario('a contested territory claim is settled by the attestors: the loser\'s half goes to the contest winner\'s verified wallet', async () => {
    const site = 'east-meadow';
    const claims = [await buy('p1', { type:'territory-claim', territory:site }), await buy('p2', { type:'territory-claim', territory:site })];
    assert.equal(claims[0].row.fulfillment?.status, 'applied', JSON.stringify(claims[0].row.fulfillment));
    advance(claims[0].row.fulfillment.result.endsAt - node.time() + 1);
    await command('p1', { type:'configure' });
    await settle(4);
    const proposals = pending('stake').filter(item => claims.some(claim => claim.row.id === item.payment));
    assert.equal(proposals.length, 2, 'both claim stakes wait for the outcome panel');
    // The server cannot move either stake alone, and a forged forfeit to the game's own wallet is refused by the tool.
    const victim = proposals.find(item => item.lane === 'return');
    app.store.savePayment({ ...app.store.payment(victim.id), state:'voided' });
    const thief = walletFromPrivateKey(key(600));
    const forged = { ...chain.signStakeSettlement({ source:victim.sources[0], lane:'forfeit', payee:thief.address, event:app.store.payment(victim.id).event, payload:{ ...app.store.payment(victim.id).payload, lane:'forfeit' }, now:node.time() }),
      settles:victim.payment, pool:'escrow', title:'forged', description:'forged' };
    app.store.savePayment(forged);
    const refusal = await attestor(1);
    const complaint = problemsOf(refusal, forged.id);
    assert.ok(complaint.length && !refusal.signed.some(item => item.id === forged.id), JSON.stringify(refusal.reviews));
    app.store.savePayment({ ...app.store.payment(forged.id), state:'voided' });
    await app.ledger.reconcile();
    await attestor(1);
    const second = await attestor(2);
    mine();
    await settle(2);
    const settled = claims.map(claim => app.store.payments().find(row => row.settles === claim.row.id && row.state === 'credited'));
    assert.ok(settled.every(Boolean), JSON.stringify(second.reviews.map(item => item.problems)));
    assert.deepEqual(settled.map(row => row.lane).sort(), ['forfeit', 'return']);
    const lost = settled.find(row => row.lane === 'forfeit');
    return { territory:site, stake:claims[0].quote.satoshis - 600, lanes:settled.map(row => row.lane), loserKept:lost.layout[0].satoshis, winnerReceived:lost.layout[1].satoshis, forgedPayeeRefused:complaint[0], txids:settled.map(row => row.txid) };
  });

  let raid; let honest; let terms; let exit;
  await scenario('matched raid, attacker wins: a forged "defender wins" proposed with the server key is refused by all three attestors', async () => {
    await buy('p2', { type:'war-chest', satoshis:30_000, consent:true });
    weaken('p2', 'p1');
    edit(world => { terms = app.ledger.raidPreview(world, 'p1', 'p2', 25_000); });
    assert.deepEqual([terms.eligible, terms.stakeSatoshis, terms.defenderExposureSatoshis], [true, 25_000, 25_000]);
    raid = await buy('p1', { type:'attack-paid', target:'p2', stake:25_000 });
    await settle(2);
    honest = app.store.payments().find(row => row.settles === raid.row.id && row.state === 'created');
    assert.equal(honest.lane, 'attacker-wins');
    const forged = forge(honest, 'defender-wins');
    const reports = [await attestor(1), await attestor(2), await attestor(3)];
    const refusals = reports.map(report => problemsOf(report, forged.id));
    assert.ok(refusals.every(list => list.some(text => /does not follow from it/.test(text))), JSON.stringify(refusals));
    assert.equal(reports.some(report => report.signed.some(item => item.id === forged.id)), false, 'nobody signs the forged lane');
    app.store.savePayment({ ...app.store.payment(forged.id), state:'voided' });
    return { stakePayment:raid.row.txid, stake:25_000, walletPaid:raid.quote.satoshis, proposedByServer:'defender-wins', replayedWinner:reports[0].reviews.find(item => item.raid === forged.id).battle.winner, attestorProblems:refusals[0] };
  });

  await scenario('the defender starts an exit after the raid was funded: the settlement lapses and is proposed again against the exit script', async () => {
    await app.ledger.reconcile();
    const proposal = pending('raid').find(item => item.payment === raid.row.id);
    assert.equal(proposal.lane, 'attacker-wins');
    exit = signChestExit(proposal.sources.slice(0, -1), keys.p2, { fee:node.coin('p2') });
    accept(exit.rawHex);
    mine();
    await settle(2);
    assert.equal(app.store.payment(proposal.id).state, 'expired');
    const again = pending('raid').find(item => item.payment === raid.row.id);
    assert.equal(again.sources[0].script, chain.chestOf({ ownerKey:wallets.p2.publicKey, revision:4 }).exitScript);
    const balance = app.ledger.balances('p2');
    return { exitTxid:exit.txid, movedWhole:exit.exits[0].satoshis, exitingSatoshis:balance.exitingChestSatoshis, offeredToNewRaids:balance.capturableSatoshis };
  });

  await scenario('matched raid settled by two of three attestors in ONE transaction: one attestor alone moves nothing; the attacker receives exactly what was previewed', async () => {
    const proposal = pending('raid').find(item => item.payment === raid.row.id);
    const first = await attestor(1);
    assert.deepEqual(first.signed.filter(item => item.id === proposal.id).map(item => item.state), ['created'], 'one signature of three is not enough');
    assert.equal(app.store.payment(proposal.id).rawHex, undefined);
    const second = await attestor(2);
    assert.ok(second.signed.some(item => item.id === proposal.id && item.state === 'submitted'), JSON.stringify(second));
    mine();
    await settle(2);
    const settled = app.store.payment(proposal.id);
    assert.equal(settled.state, 'credited');
    const attackerGot = paidTo(wallets.p1.script, settled.txid);
    assert.equal(attackerGot, terms.win.receiveSatoshis, 'preview and payout agree');
    assert.equal(settled.feeSatoshis, terms.win.feeSatoshis);
    const chest = app.ledger.balances('p2');
    // 30,000 deposited and 11,000 from one purchase; exactly 25,000 left: 5,000 remain in the exit script and 11,000 in the live chest.
    assert.deepEqual([chest.warChestSatoshis, chest.exitingChestSatoshis, chest.reservedSatoshis], [16_000, 5_000, 0]);
    return { lane:settled.lane, stake:25_000, attackerReceived:attackerGot, previewed:terms.win.receiveSatoshis, defenderLost:25_000, defenderWarChestAfter:chest.warChestSatoshis, networkFee:settled.feeSatoshis,
      bytes:settled.rawHex.length / 2, inputs:settled.sources.length, signedBy:'attestors 1 and 2; attestor 3 offline', txid:settled.txid };
  });

  let lost; let lostTerms;
  await scenario('matched raid, defender wins: a forged capture of the defender\'s War Chest and an edited battle record are both refused', async () => {
    // p3 attacks p1, whose War Chest holds the 11,000 of its one purchase. p3's army is the weaker one.
    advance(86_400_001);
    weaken('p3', 'p1');
    edit(world => { for (const id of ['p1', 'p2', 'p3']) world.cities[id].alliance = null; lostTerms = app.ledger.raidPreview(world, 'p3', 'p1', 10_000); });
    assert.equal(lostTerms.eligible, true, lostTerms.reason);
    lost = await buy('p3', { type:'attack-paid', target:'p1', stake:10_000 });
    await settle(2);
    const proposal = app.store.payments().find(row => row.settles === lost.row.id && row.state === 'created');
    assert.equal(proposal.lane, 'defender-wins');
    // 1. The server claims the attacker won and proposes to take 10,000 from the defender's War Chest.
    const chests = app.store.payments().filter(row => row.playerId === 'p1' && row.state === 'credited').flatMap(row => row.receipt?.allocations ?? []).filter(output => output.kv?.revision === 4);
    const theft = forge(proposal, 'attacker-wins', chests.slice(0, 1));
    const reports = [await attestor(1), await attestor(2), await attestor(3)];
    const refusals = reports.map(report => problemsOf(report, theft.id));
    assert.ok(refusals.every(list => list.some(text => /won by the defender/.test(text))), JSON.stringify(refusals));
    app.store.savePayment({ ...app.store.payment(theft.id), state:'voided' });
    await app.ledger.reconcile();
    // 2. The server edits the stored battle record so that it names the attacker as winner.
    const again = pending('raid').find(item => item.payment === lost.row.id);
    const stored = app.store.portalRows('battle').find(({ record }) => record.initiation?.txid === lost.row.txid);
    const original = structuredClone(stored);
    app.store.savePortal('battle', stored.record.battle.id, { ...stored, record:{ ...stored.record, battle:{ ...stored.record.battle, winner:'attacker' } } });
    const fooled = [await attestor(1), await attestor(2)];
    const edited = fooled.map(report => problemsOf(report, again.id));
    assert.ok(edited.every(list => list.some(text => /replaying the recorded battle does not reproduce its result/.test(text))), JSON.stringify(edited));
    assert.equal(fooled.some(report => report.signed.length), false);
    app.store.savePortal('battle', stored.record.battle.id, original);
    return { stakePayment:lost.row.txid, forgedCaptureRefused:refusals[0], editedBattleRecordRefused:edited[0] };
  });

  await scenario('the defender receives the attacker\'s whole stake, signed by two of three attestors; the War Chest is not an input', async () => {
    const proposal = pending('raid').find(item => item.payment === lost.row.id);
    await attestor(2);
    const third = await attestor(3);
    assert.ok(third.signed.some(item => item.id === proposal.id && item.state === 'submitted'), JSON.stringify(third));
    mine();
    await settle(2);
    const settled = app.store.payment(proposal.id);
    assert.equal(settled.state, 'credited');
    const defenderGot = paidTo(wallets.p1.script, settled.txid);
    const attackerBack = paidTo(wallets.p3.script, settled.txid);
    assert.deepEqual([defenderGot, attackerBack, settled.sources.length], [10_000, lostTerms.loss.receiveSatoshis, 1]);
    assert.equal(app.ledger.balances('p1').warChestSatoshis, 11_000);
    return { lane:settled.lane, stake:10_000, defenderReceived:defenderGot, attackerLost:10_000, reserveReturnedToAttacker:attackerBack, networkFee:settled.feeSatoshis, bytes:settled.rawHex.length / 2,
      signedBy:'attestors 2 and 3; attestor 1 offline', txid:settled.txid };
  });

  await scenario('a paid political operation publishes its proof record from the payer\'s own record reserve, with no attestor and no operator money', async () => {
    let treaty;
    edit(world => {
      const offer = engine(world, 'p2', { type:'diplomacy-treaty-propose', target:'p3', kind:'non-aggression', durationHours:48, terms:{} }, node.time());
      treaty = engine(world, 'p3', { type:'diplomacy-treaty-respond', id:offer.id, accept:true, termsHash:offer.proposal.termsHash, version:offer.proposal.version }, node.time());
    });
    const charter = await buy('p2', { type:'political-operation', operation:'attest', treaty:treaty.id, consent:true });
    assert.equal(charter.row.fulfillment.status, 'applied', JSON.stringify(charter.row.fulfillment));
    await settle(3);
    const anchor = app.store.payments().find(row => row.politicalAnchor === 'po-' + charter.row.id);
    assert.equal(anchor?.state, 'credited');
    return { price:charter.quote.satoshis, recordReserve:charter.row.event.data.recordReserve, proofTxid:anchor.txid, proofFee:anchor.feeSatoshis, proofBytes:anchor.rawHex.length / 2 };
  });

  let seasonId;
  await scenario('a legitimate season prize is proposed automatically and paid after two attestors audit the season evidence', async () => {
    seasonId = app.store.read().world.season.number;
    advance(app.store.read().world.season.endsAt - node.time() + 60_000);
    await command('p1', { type:'configure' });
    mine(8);
    await settle(3);
    const award = pending('award')[0];
    assert.ok(award, 'the award was proposed without anyone asking');
    const reports = [await attestor(1), await attestor(2)];
    assert.deepEqual(reports[0].reviews.find(item => item.award === award.id).problems, []);
    assert.ok(reports[1].signed.some(item => item.id === award.id && item.state === 'submitted'), JSON.stringify(reports[1]));
    mine();
    await settle(1);
    const paid = app.store.payment(award.id);
    assert.equal(paid.state, 'credited');
    assert.equal(paidTo(walletFromPrivateKey(keys[award.playerId]).script, paid.txid), award.satoshis);
    return { season:seasonId, winner:award.playerId, rank:award.rank, score:award.score, satoshis:award.satoshis, feeSatoshis:paid.feeSatoshis, txid:paid.txid };
  });

  await scenario('the evidence bundle an attestor saved on its own run passes the season audit from the file alone', async () => {
    const { auditBundle } = await import('./attestor-payout.mjs');
    const file = join(dir, 'attestor-1-bundles', 'season-' + seasonId + '.json');
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    const audit = await auditBundle(bundle);
    assert.deepEqual(audit.problems ?? [], []);
    assert.equal(audit.ok, true);
    return { savedBy:'attestor 1, by scripts/prize-attest.mjs itself', season:bundle.season, pagesSaved:Object.keys(bundle.pages).length, auditProblems:(audit.problems ?? []).length, serverContacted:false };
  });

  await scenario('a season result altered after the fact is refused by every attestor', async () => {
    // The server rewrites the archived standings so that another player holds the next paid rank.
    edit(world => { const board = world.archive[0].rankings; const lifted = board.find(row => row.id === 'p3') ?? board.at(-1); lifted.score = 9_999; board.sort((a, b) => b.score - a.score); });
    mine(8);
    await settle(3);
    const forged = pending('award');
    const reports = [await attestor(1), await attestor(2), await attestor(3)];
    const signed = reports.flatMap(report => report.signed);
    assert.equal(signed.length, 0, 'no attestor signs anything derived from the altered result');
    const problems = reports.flatMap(report => report.reviews.flatMap(item => item.problems));
    if (forged.length) assert.ok(problems.some(text => /season evidence|changed after this attestor first saw it|does not give this player/.test(text)), JSON.stringify(problems));
    return { forgedProposals:forged.length, attestorProblems:[...new Set(problems)].slice(0, 4) };
  });

  const report = { executedAt:new Date().toISOString(), networkProfile:NETWORK_ID, server:'live local game server over HTTP on the enforcing fixture node (BCH VM). No public network was contacted and no coin of any network moved: with networkProfile "mainnet" this shows that addresses, contracts, start-up conditions and attestor checks work under the Mainnet configuration, not that anything ran on Mainnet',
    attestors:'three keys, each running scripts/prize-attest.mjs as its own process with its own key file and pin file', threshold:chain.attestorThreshold + ' of 3', scenarios };
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(scenarios.length + ' scenarios run against the live server');
} finally {
  await node.close();
}
