import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { covenantNode, hash, initialTime, wallets } from './support/covenant-node.mjs';
import { SCORE_JOURNAL, entitlementsOf, entryHash, genesis, readJournal, verifyJournal } from '../apps/game-server/season-evidence.mjs';
import { auditSeason } from '../scripts/season-audit.mjs';
import { points } from '../packages/game-engine/world.mjs';

async function realm(t) {
  const node = await covenantNode();
  t.after(node.close);
  const { app, edit } = node;
  // A browser session per player: the server stores the hash of the cookie value.
  for (const id of ['p1', 'p2', 'p3']) {
    app.store.addSession(hash(hash('cookie-' + id)), id, initialTime + 3650 * 86_400_000);
    app.store.bindWallet(id, wallets[id].address, wallets[id].publicKey, node.time());
  }
  edit(world => { for (const id of ['p1', 'p2', 'p3']) Object.assign(world.cities[id], { optIn:true, tutorial:true, shieldUntil:0 }); });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const as = player => ({ Cookie:'dominion=' + hash('cookie-' + player), 'Content-Type':'application/json', Origin:origin });
  const command = async (player, body) => {
    const response = await fetch(origin + '/api/command', { method:'POST', headers:as(player), body:JSON.stringify({ ...body, requestId:crypto.randomUUID() }) });
    const answer = await response.json();
    assert.equal(response.ok, true, JSON.stringify(answer).slice(0, 300));
    return answer;
  };
  const touch = player => fetch(origin + '/api/state', { headers:as(player) }).then(response => response.json());
  return { ...node, origin, command, touch };
}

test('season standings can be recomputed by anyone from the public score journal, and tampering is detected', async t => {
  const { app, edit, advance, time, origin, command, buy, settle } = await realm(t);
  // Real play: a raid scores both sides and names the battle that earned the points.
  await command('p1', { type:'attack', target:'p2' });
  // Other score-producing rules, run through the same engine function the game uses.
  // Each carries the evidence the engine records: the record it names, and when the work started and ended.
  edit(world => {
    points(world.cities.p2, 3, 'development', { kind:'building', ref:'hall:2', since:world.now - 90_000, until:world.now });
    points(world.cities.p3, 3, 'science', { kind:'research', ref:'tactics:1', since:world.now - 45_000, until:world.now });
    points(world.cities.p3, 2, 'intelligence', { kind:'intelligence', ref:'m7', since:world.now - 15_000, until:world.now });
  });
  const season = app.store.read().world.season.number;
  const live = await (await fetch(origin + '/api/public/season-events?season=' + season)).json();
  assert.equal(live.count, 5);
  assert.deepEqual(live.entries.slice(0, 2).map(entry => [entry.kind, typeof entry.ref, entry.prev === (entry.n === 1 ? genesis(season) : live.entries[0].hash)]),
    [[live.entries[0].kind, 'string', true], [live.entries[1].kind, 'string', true]]);
  assert.deepEqual(live.entries.slice(0, 2).map(entry => entry.kind).sort(), ['battle-lost', 'battle-won']);
  const checked = verifyJournal(live.entries, season);
  assert.deepEqual([checked.ok, checked.count, checked.head, checked.closed], [true, 5, live.head, false]);
  const { world } = app.store.read();
  for (const id of ['p1', 'p2', 'p3']) assert.equal(checked.scores.get(id), world.cities[id].score, 'the journal reproduces the score of ' + id);
  assert.equal(Object.values(world.cities).some(city => city.scoreEvents), false, 'nothing stays queued outside the journal');
  // A verifier pins what it has seen.
  const pinFile = join(mkdtempSync(join(tmpdir(), 'vb-pins-')), 'pins.json');
  const first = await auditSeason(origin, season, { pinFile });
  assert.deepEqual([first.ok, first.entries, first.closed], [true, 5, false], JSON.stringify(first.problems));
  // A player payment anchors the journal on chain: its record output commits to the journal's length and head.
  const paid = await buy('p1', { type:'premium', building:'hall' });
  await settle(1);
  assert.deepEqual(paid.row.event.data.journal, { n:5, head:live.head });
  const { anchors } = await (await fetch(origin + '/api/public/season-anchors?season=' + season)).json();
  assert.deepEqual(anchors.map(item => [item.txid, item.n, item.head, item.eventDigest]), [[paid.row.txid, 5, live.head, paid.row.event.digest]]);

  // The season closes. The closing entry fixes the standings with their tie-break values, and the result commits to the journal.
  advance(app.store.read().world.season.endsAt - time() + 60_000);
  await command('p1', { type:'configure' });
  const { result } = await (await fetch(origin + '/api/public/season-result')).json();
  const closed = readJournal(app.store, season);
  assert.equal(closed.at(-1).kind, 'season-close');
  assert.deepEqual([result.version, result.seasonId, result.evidence], [2, season, { journalEntries:closed.length, journalHead:closed.at(-1).hash }]);
  const audit = await auditSeason(origin, season, { pinFile });
  assert.equal(audit.ok, true, JSON.stringify(audit.problems));
  assert.equal(audit.battlesReplayed, 1, 'the raid was replayed from its public record');
  assert.deepEqual(audit.ranking.filter(row => row.score > 0).map(row => [row.playerId, row.score]), result.rankings.map(row => [row.playerId, row.score]));
  assert.deepEqual(entitlementsOf(result.rankings, result.prizeBase, result.rules.percentages).map(row => row.satoshis), result.entitlements.map(row => row.satoshis));

  // What an outside verifier catches, on the journal alone.
  const copy = () => structuredClone(closed);
  const rechain = entries => { let prev = genesis(season); for (const entry of entries) { entry.prev = prev; entry.hash = entryHash(entry); prev = entry.hash; } return entries; };
  const altered = copy(); altered[0].amount += 5;
  assert.match(verifyJournal(altered, season).errors.join(' | '), /content does not match its hash/);
  const dropped = copy(); dropped.splice(2, 1);
  assert.match(verifyJournal(dropped, season).errors.join(' | '), /out of sequence/);
  const inflated = copy(); inflated[2].amount = 300; rechain(inflated);
  assert.match(verifyJournal(inflated, season).errors.join(' | '), /not an amount the rules give/);
  const farmed = copy(); farmed.splice(1, 0, { ...farmed[0] }); farmed.forEach((entry, index) => { entry.n = index + 1; }); rechain(farmed);
  assert.match(verifyJournal(farmed, season).errors.join(' | '), /was already scored/);
  const wrongWinner = verifyJournal(closed, season, { battles:new Map([[closed[0].ref, { attacker:'p2', defender:'p1', winner:'attacker' }]]) });
  assert.match(wrongWinner.errors.join(' | '), /does not match the replayed battle/);

  // Invented work is held against the public rules: too fast, the wrong research time, two constructions in one slot,
  // a mission shorter than any mission, or points that name no record at all.
  const building = closed.findIndex(entry => entry.kind === 'building');
  const tooFast = copy(); tooFast[building].since = tooFast[building].until - 10_000; rechain(tooFast);
  assert.match(verifyJournal(tooFast, season).errors.join(' | '), /hall:2 was built in 10000 ms, faster than the rules allow/);
  const wrongTime = copy(); wrongTime.find(entry => entry.kind === 'research').since += 5_000; rechain(wrongTime);
  assert.match(verifyJournal(wrongTime, season).errors.join(' | '), /tactics:1 took 40000 ms; the rules give exactly 45000/);
  const twoAtOnce = copy();
  twoAtOnce.splice(building + 1, 0, { ...twoAtOnce[building], ref:'farm:2', since:twoAtOnce[building].since + 1_000, until:twoAtOnce[building].until + 60_000, at:twoAtOnce[building].until + 60_000 });
  twoAtOnce.forEach((entry, index) => { entry.n = index + 1; });
  twoAtOnce.at(-1).ranking = twoAtOnce.at(-1).ranking.map(row => ({ ...row, score:twoAtOnce.slice(0, -1).filter(entry => entry.player === row.id).reduce((sum, entry) => sum + entry.amount, 0) }));
  rechain(twoAtOnce);
  assert.match(verifyJournal(twoAtOnce, season).errors.join(' | '), /building farm:2 overlaps earlier building work of p2, which has one slot/);
  const quickSpy = copy(); const spy = quickSpy.find(entry => entry.kind === 'intelligence'); spy.since = spy.until - 1_000; rechain(quickSpy);
  assert.match(verifyJournal(quickSpy, season).errors.join(' | '), /mission m7 took 1000 ms, less than the shortest mission/);
  const nameless = copy(); delete nameless.find(entry => entry.kind === 'intelligence').ref; rechain(nameless);
  assert.match(verifyJournal(nameless, season).errors.join(' | '), /"intelligence" names no record/);
  const untimed = copy(); delete untimed[building].since; rechain(untimed);
  assert.match(verifyJournal(untimed, season).errors.join(' | '), /"building" does not say when the work started and ended/);
  assert.equal(verifyJournal(closed, season).earlierEvidence, 0, 'every entry of this season carries version 2 evidence');

  // A server that rewrites history consistently (new hashes throughout) is caught by the verifier's pin.
  const rewritten = copy();
  rewritten.find(entry => entry.kind === 'building').player = 'p1';
  rechain(rewritten.slice(0, -1));
  rewritten.at(-1).ranking = rewritten.at(-1).ranking.map(row => ({ ...row, score:rewritten.slice(0, -1).filter(entry => entry.player === row.id).reduce((sum, entry) => sum + entry.amount, 0) }));
  rechain(rewritten);
  for (const entry of rewritten) app.store.savePortal(SCORE_JOURNAL, season + ':' + String(entry.n).padStart(9, '0'), entry);
  assert.equal(verifyJournal(rewritten, season).ok, true, 'the rewritten journal is internally consistent');
  const caught = await auditSeason(origin, season, { pinFile });
  assert.equal(caught.ok, false);
  assert.match(caught.problems.join(' | '), /history was rewritten/);
  // A verifier who never looked before catches the same rewrite from the on-chain anchor alone.
  const fresh = await auditSeason(origin, season);
  assert.match(fresh.problems.join(' | '), /anchored on chain by transaction [0-9a-f]{64} is no longer in the journal/);
  // Out-of-order levels are refused as well.
  const skipped = copy(); skipped.find(entry => entry.kind === 'building').ref = 'hall:0'; rechain(skipped);
  assert.match(verifyJournal(skipped, season).errors.join(' | '), /is not above the level already scored/);
  assert.match(caught.problems.join(' | '), /does not commit to this journal|not the ranking the journal produces/);
});

test('a score that no recorded event produced does not survive the audit', async t => {
  const { app, edit, advance, time, origin, command, touch } = await realm(t);
  await command('p1', { type:'attack', target:'p2' });
  // A dishonest server raises a standing directly, without any score event.
  edit(world => { world.cities.p3.score += 500; });
  const season = app.store.read().world.season.number;
  advance(app.store.read().world.season.endsAt - time() + 60_000);
  await command('p1', { type:'configure' });
  const audit = await auditSeason(origin, season);
  assert.equal(audit.ok, false);
  assert.match(audit.problems.join(' | '), /p3 is listed with 500 points but its events sum to 0/);
});

test('season points between the same two players count once per 24 hours', async t => {
  const { app, edit, advance, command } = await realm(t);
  await command('p1', { type:'attack', target:'p2' });
  const before = app.store.read().world.cities.p1.score;
  // The game refuses a repeat attack for 8 hours; the scoring limit lasts 24.
  advance(9 * 3_600_000);
  edit(world => { world.cities.p2.shieldUntil = 0; world.cities.p2.troops = { ...world.cities.p1.troops }; });
  await command('p1', { type:'attack', target:'p2' });
  const { world } = app.store.read();
  const again = world.battles.find(battle => battle.attacker === 'p1' && battle.defender === 'p2');
  assert.deepEqual([world.cities.p1.score, again.aftermath.attacker.campaignPoints, again.aftermath.defender.campaignPoints], [before, 0, 0], 'the repeat raid is fought but earns no season points');
  // An auditor applies the same rule to the journal: a second scored battle of one pair inside 24 hours is an error.
  const season = world.season.number;
  const entries = [];
  const add = body => { const entry = { season, n:entries.length + 1, at:1, ...body, prev:entries.at(-1)?.hash ?? genesis(season) }; entry.hash = entryHash(entry); entries.push(entry); };
  add({ player:'p1', amount:15, category:'campaigns', kind:'battle-won', ref:'b1' });
  add({ player:'p1', amount:15, category:'campaigns', kind:'battle-won', ref:'b2' });
  const battles = new Map([['b1', { attacker:'p1', defender:'p2', winner:'attacker', at:1_000 }], ['b2', { attacker:'p1', defender:'p2', winner:'attacker', at:1_000 + 9 * 3_600_000 }]]);
  assert.match(verifyJournal(entries, season, { battles }).errors.join(' | '), /p1>p2 was scored again within 24 hours/);
});
