// Independent audit of a season's standings from the public evidence of a VaultBorn server. It needs no key.
//   node scripts/season-audit.mjs <server origin> [season number]
// It downloads the season score journal, checks its hash chain, checks every entry against the scoring rules, replays
// every battle whose record is public, recomputes the standings and the prize of each rank, and compares them with the
// published season result. With a pin file it also proves that nothing it saw on an earlier run was changed or removed.
// It cannot prove that a recorded event really happened in the game; see `apps/game-server/season-evidence.mjs`.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { entitlementsOf, entryHash, genesis, verifyJournal } from '../apps/game-server/season-evidence.mjs';
import { verifyBattle } from '../apps/game-server/battle-records.mjs';

export async function auditSeason(origin, seasonId, { pinFile, fetcher = fetch } = {}) {
  const read = async path => { const response = await fetcher(origin + path); if (!response.ok) throw new Error(path + ' answered ' + response.status); return response.json(); };
  const problems = [];
  const notes = [];
  const { result } = await read('/api/public/season-result');
  const season = seasonId ?? result?.seasonId;
  if (!Number.isSafeInteger(season)) return { ok: false, problems: ['the server publishes no season to audit'], notes };
  const entries = [];
  for (let from = 1; ; from += 2000) {
    const page = await read(`/api/public/season-events?season=${season}&from=${from}`);
    entries.push(...page.entries);
    if (entries.length >= page.count || !page.entries.length) break;
  }
  // Replay every battle the journal scores and whose record the server has published.
  const battles = new Map();
  const scoredBattles = entries.flatMap(entry => entry.kind === 'battle-won' || entry.kind === 'battle-lost' ? [entry.ref] : String(entry.ref ?? '').startsWith('battle:') ? [String(entry.ref).slice(7)] : []);
  for (const id of new Set(scoredBattles)) {
    const published = await read('/api/public/battle/' + id).catch(() => null);
    const battle = published?.record?.battle;
    if (!battle) continue;
    if (verifyBattle(battle) !== true) { problems.push(`battle ${id}: replaying its public record does not reproduce its result`); continue; }
    battles.set(id, { attacker: battle.attacker, defender: battle.defender, winner: battle.winner, at: battle.at });
  }
  const journal = verifyJournal(entries, season, { battles });
  problems.push(...journal.errors);
  if (journal.earlierEvidence) notes.push(`${journal.earlierEvidence} scored event(s) were recorded before timing and record evidence existed and could only be checked against the amount table`);
  if (journal.unreplayedBattles.length) notes.push(`${journal.unreplayedBattles.length} scored battle(s) have no public record yet (records open 24 hours after the battle) and were not replayed`);
  // Reward farming between two cooperating accounts shows up as battle points earned mostly against one opponent.
  const wins = new Map();
  for (const entry of entries) {
    const fought = entry.kind === 'battle-won' && battles.get(entry.ref);
    if (!fought) continue;
    const rival = entry.player === fought.attacker ? fought.defender : fought.attacker;
    const tally = wins.get(entry.player) ?? wins.set(entry.player, new Map()).get(entry.player);
    tally.set(rival, (tally.get(rival) ?? 0) + entry.amount);
  }
  for (const [player, tally] of wins) {
    const total = [...tally.values()].reduce((sum, value) => sum + value, 0);
    const [rival, most] = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (total >= 60 && most * 2 > total) notes.push(`${player} earned ${most} of ${total} battle points against one opponent (${rival}); check for cooperation between the two accounts`);
  }
  // On-chain anchors. Every player payment commits, in its own transaction's record output, to the journal's length and
  // head at the moment it was prepared. An anchor that no longer matches the journal proves a rewrite, even to a
  // verifier who has never looked before. (Confirming that a listed transaction is on chain takes any block explorer.)
  const { anchors = [] } = await read('/api/public/season-anchors?season=' + season).catch(() => ({}));
  for (const anchor of anchors) {
    if ((anchor.n === 0 ? genesis(season) : entries[anchor.n - 1]?.hash) !== anchor.head) problems.push(`the journal head anchored on chain by transaction ${anchor.txid} is no longer in the journal: history was rewritten after it was anchored`);
  }
  if (anchors.length) notes.push(`${anchors.length} payment transaction(s) anchor the journal on chain; the latest covers entries 1 to ${Math.max(...anchors.map(item => item.n))} of ${entries.length}`);
  else notes.push('no payment has anchored this journal on chain yet; only this verifier\'s own pins protect it against a rewrite');
  // Nothing this verifier saw before may have changed: the entry it pinned last time must still be in the chain, unchanged.
  if (pinFile) {
    const pins = await readFile(pinFile, 'utf8').then(JSON.parse).catch(() => ({}));
    const pin = pins['journal:' + season];
    if (pin && (entries[pin.count - 1]?.hash ?? (pin.count === 0 ? genesis(season) : null)) !== pin.head) problems.push('the journal no longer contains what this verifier saw on an earlier run: history was rewritten');
    if (!problems.length) { pins['journal:' + season] = { count: journal.count, head: journal.head }; await writeFile(pinFile, JSON.stringify(pins, null, 2) + '\n'); }
  }
  // The published result must be the one these events produce.
  if (result?.seasonId === season) {
    if (!journal.closed) problems.push('the season result is published but the journal has no closing entry');
    if (result.evidence?.journalHead !== journal.head || result.evidence?.journalEntries !== journal.count) problems.push('the season result does not commit to this journal');
    const ranked = (journal.ranking ?? []).filter(row => row.score > 0);
    const published = result.rankings.map(row => ({ playerId: row.playerId, score: row.score }));
    // The result lists eligible players only (not computer-run cities, and only players with a seat), in journal order.
    const order = ranked.filter(row => published.some(item => item.playerId === row.playerId));
    if (JSON.stringify(order.map(row => ({ playerId: row.playerId, score: row.score }))) !== JSON.stringify(published)) problems.push('the published ranking is not the ranking the journal produces');
    const left = ranked.filter(row => !published.some(item => item.playerId === row.playerId));
    if (left.length) notes.push(`${left.length} scored city/cities are not in the published ranking; the server reports them as computer-run or without a seat: ${left.map(row => row.playerId).join(', ')}`);
    const prizes = entitlementsOf(result.rankings, result.prizeBase, result.rules.percentages);
    if (JSON.stringify(prizes.map(row => row.satoshis)) !== JSON.stringify(result.entitlements.map(row => row.satoshis))) problems.push('the published prize amounts are not rank share × prize base');
    // The prize base is fixed by the first award. Until then it must fit the confirmed pool; afterwards the pool shown is what is left.
    if (!result.awardsCommitted && result.prizeBase > Math.floor(result.poolSatoshis * (100 - result.rules.reservePercent) / 100)) problems.push('the prize base exceeds the confirmed pool less its reserve');
  } else notes.push('the server has not published a result for this season yet; only the journal was checked');
  return { ok: !problems.length, season, anchors: anchors.length, entries: journal.count, head: journal.head, closed: journal.closed, battlesReplayed: battles.size,
    scores: Object.fromEntries(journal.scores), ranking: journal.ranking, result: result?.seasonId === season ? { resultHash: result.resultHash, entitlements: result.entitlements } : null, problems, notes };
}
export { entryHash };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [origin, season] = process.argv.slice(2);
  if (!origin) throw new Error('Usage: node scripts/season-audit.mjs <server origin> [season number]');
  const report = await auditSeason(origin.replace(/\/$/, ''), season ? Number(season) : undefined, { pinFile: process.env.SEASON_AUDIT_PINS });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
