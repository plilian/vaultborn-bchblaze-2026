// The season score journal: a public, append-only, hash-chained record of every score change of a season.
//
// What it proves: the order and content of the score events the server recorded, that none was altered or removed after
// a verifier first saw it, and that the published standings and prize amounts follow from those events by the fixed rules.
// What it does not prove: that an event really happened in the game. Battles can be replayed from their public records.
// For every other event the journal carries evidence a verifier can hold against the public rules: the record it names
// (so nothing is scored twice), and for a construction, a research and a scouting mission the time the work ran, which must
// be at least what the rules give and cannot overlap other work in the city's single slot of that kind. That bounds what a
// dishonest server could invent. It still does not prove that the player gave the order: commands are not signed by players.
import { createHash } from 'node:crypto';
import { buildings, economy } from '../../config/economy.mjs';
import { missions } from '../../config/balance.mjs';

const has = (object, key) => Object.hasOwn(object, key);

export const SCORE_JOURNAL = 'score-journal';
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value ?? null);
export const entryHash = entry => { const { hash: _hash, ...body } = entry; return createHash('sha256').update(stable(body)).digest('hex'); };
export const genesis = season => createHash('sha256').update('vaultborn-season-scores:' + season).digest('hex');
const rowId = (season, n) => season + ':' + String(n).padStart(9, '0');

// Moves queued score events of the world into the journal. Called whenever the world is saved, inside the same store.
export function sealScores(store, world) {
  const cities = Object.values(world.cities ?? {}).filter(city => city.scoreEvents?.length);
  if (!cities.length && !world.scoreMarks?.length) return;
  const chain = world.scoreChain ||= {};
  const now = world.now ?? Date.now();
  const append = (season, body) => {
    const state = chain[season] ||= { count: 0, head: genesis(season) };
    // `v` is the evidence version of the entry. From version 2 every scored event names the record that earned it, and a
    // construction, a research or a mission also states when it started and ended.
    const entry = { season, n: state.count + 1, at: body.at ?? now, v: EVIDENCE_VERSION, ...body, prev: state.head };
    entry.hash = entryHash(entry);
    store.savePortal(SCORE_JOURNAL, rowId(season, entry.n), entry);
    state.count = entry.n;
    state.head = entry.hash;
  };
  const current = world.season.number;
  // Events of a season that has just closed are sealed before that season's closing entry.
  const queued = cities.flatMap(city => city.scoreEvents.map(({ season, ...event }) => ({ season: season ?? current, player: city.id, npc: Boolean(city.npc), event })));
  for (const item of queued.filter(entry => entry.season !== current)) append(item.season, { player: item.player, ...(item.npc && { npc: true }), ...item.event });
  for (const mark of world.scoreMarks ?? []) append(mark.season, { kind: mark.kind, at: mark.at, ranking: mark.ranking });
  for (const item of queued.filter(entry => entry.season === current)) append(current, { player: item.player, ...(item.npc && { npc: true }), ...item.event });
  for (const city of cities) delete city.scoreEvents;
  delete world.scoreMarks;
  for (const season of Object.keys(chain)) if (Number(season) < current - 3) delete chain[season];
}

export const readJournal = (store, season) => store.portalRows(SCORE_JOURNAL).filter(entry => entry.season === season).sort((a, b) => a.n - b.n);

export const EVIDENCE_VERSION = 2;
// The public rules a verifier holds the timing evidence against. A construction takes its base time, grown by the build
// curve per level, and can be shortened by the workshop (to 72% at most), by a commander (bounded here by a quarter) and
// by a rush (half, at most twice). A research takes exactly 45 seconds per level. A mission takes at least the shortest mission time.
// Each city has ONE construction slot, ONE research slot and ONE mission at a time.
// (A stored rush credit and a live rush can both reach one job, so a rushed job is bounded by a quarter.)
const leastConstruction = (name, level, rushed) => has(buildings, name) ? Math.floor(buildings[name].time * economy.buildTimeCurve ** (level - 2) * .72 * .75 * (rushed ? (1 - economy.rushFraction) ** 2 : 1)) : Infinity;
const researchTime = level => level * 45_000;
const leastMission = Math.min(...Object.values(missions).map(item => item.time));

// The amounts each kind of event may carry. An entry outside this table is reported, never silently accepted.
export const scoreRules = Object.freeze({ 'battle-won': [15, 10], 'battle-lost': [2], building: [3], research: [3], intelligence: [2], territory: [10, 16],
  politics: [14, 9], diplomacy: [3, 5, 16], defense: [10], 'expedition-won': [5], 'expedition-lost': [1] });

// Pure check of a journal, as an outside verifier runs it. `battles` optionally maps a battle ID to its public record's
// outcome ({ attacker, defender, winner }) after the verifier has replayed it.
export function verifyJournal(entries, season, { battles } = {}) {
  const errors = [];
  const scores = new Map();
  const seen = new Set();
  let head = genesis(season);
  let closing = null;
  const unreplayed = [];
  const levels = new Map();
  const pairs = new Map();
  const slots = new Map();
  let earlier = 0;
  entries.forEach((entry, index) => {
    if (entry.season !== season || entry.n !== index + 1) errors.push(`entry ${index + 1}: out of sequence`);
    if (entry.prev !== head) errors.push(`entry ${entry.n}: does not follow the previous entry`);
    if (entryHash(entry) !== entry.hash) errors.push(`entry ${entry.n}: content does not match its hash`);
    head = entry.hash;
    if (closing) errors.push(`entry ${entry.n}: recorded after the season closed`);
    if (entry.kind === 'season-close') { closing = entry; return; }
    if (!Number.isInteger(entry.amount) || entry.amount <= 0) errors.push(`entry ${entry.n}: invalid amount`);
    if (!scoreRules[entry.kind]?.includes(entry.amount)) errors.push(`entry ${entry.n}: ${entry.amount} points is not an amount the rules give for "${entry.kind}"`);
    if (entry.ref !== undefined) {
      // One record earns one player its points once.
      const key = entry.kind + '|' + entry.ref + '|' + entry.player;
      if (seen.has(key)) errors.push(`entry ${entry.n}: "${entry.kind}" ${entry.ref} was already scored for ${entry.player}`);
      seen.add(key);
    }
    if (entry.v >= 2) {
      // Version 2 evidence. Nothing is scored without naming its record, and timed work is held against the public rules.
      if (entry.ref === undefined) errors.push(`entry ${entry.n}: "${entry.kind}" names no record`);
      const timed = ['building', 'research', 'intelligence'].includes(entry.kind);
      if (timed && !(Number.isFinite(entry.since) && Number.isFinite(entry.until))) errors.push(`entry ${entry.n}: "${entry.kind}" does not say when the work started and ended`);
      else if (timed) {
        const [name, level] = String(entry.ref).split(':');
        const ran = entry.until - entry.since;
        if (entry.until > entry.at) errors.push(`entry ${entry.n}: scored before its work ended`);
        if (entry.kind === 'building' && ran < leastConstruction(name, Number(level), entry.rushed)) errors.push(`entry ${entry.n}: ${entry.ref} was built in ${ran} ms, faster than the rules allow`);
        if (entry.kind === 'research' && ran !== researchTime(Number(level))) errors.push(`entry ${entry.n}: ${entry.ref} took ${ran} ms; the rules give exactly ${researchTime(Number(level))}`);
        if (entry.kind === 'intelligence' && ran < leastMission) errors.push(`entry ${entry.n}: mission ${entry.ref} took ${ran} ms, less than the shortest mission`);
        // One slot per city and kind: work cannot overlap the previous work of the same kind.
        const slot = entry.player + '|' + entry.kind;
        if (entry.since < (slots.get(slot) ?? -Infinity)) errors.push(`entry ${entry.n}: ${entry.kind} ${entry.ref} overlaps earlier ${entry.kind} work of ${entry.player}, which has one slot`);
        slots.set(slot, Math.max(slots.get(slot) ?? -Infinity, entry.until));
      }
    } else if (entry.kind !== 'battle-won' && entry.kind !== 'battle-lost') earlier += 1;
    if (entry.kind === 'territory' || entry.kind === 'defense') {
      // A territory or resistance battle that is replayable must have been won by the player it scores.
      const fought = String(entry.ref ?? '').startsWith('battle:') ? battles?.get(String(entry.ref).slice(7)) : null;
      if (fought) {
        const winner = fought.winner === 'attacker' ? fought.attacker : fought.defender;
        if (entry.player !== winner) errors.push(`entry ${entry.n}: ${entry.player} is scored for battle ${entry.ref}, which the replay gives to ${winner}`);
        if (entry.kind === 'territory' && entry.amount !== (fought.winner === 'attacker' ? 16 : 10)) errors.push(`entry ${entry.n}: does not match the replayed battle ${entry.ref}`);
      } else if (String(entry.ref ?? '').startsWith('battle:')) unreplayed.push(String(entry.ref).slice(7));
    }
    if (entry.kind === 'building' || entry.kind === 'research') {
      // A building or a research line only ever goes up: level N is scored after every lower level, once.
      const [name, level] = String(entry.ref ?? '').split(':');
      const key = entry.player + '|' + entry.kind + '|' + name;
      if (!(Number(level) > (levels.get(key) ?? 0))) errors.push(`entry ${entry.n}: ${entry.kind} ${entry.ref} is not above the level already scored for ${entry.player}`);
      levels.set(key, Number(level));
    }
    if (entry.kind === 'battle-won' || entry.kind === 'battle-lost') {
      const fought = battles?.get(entry.ref);
      if (!fought) unreplayed.push(entry.ref);
      else {
        // Between the same attacker and defender only one battle per 24 hours scores.
        if (entry.kind === 'battle-won' && !fought.npc && Number.isFinite(fought.at)) {
          const pair = fought.attacker + '>' + fought.defender;
          if (pairs.get(pair) > fought.at - 86_400_000 && pairs.get(pair) !== fought.at) errors.push(`entry ${entry.n}: ${pair} was scored again within 24 hours (battle ${entry.ref})`);
          pairs.set(pair, fought.at);
        }
        const winner = fought.winner === 'attacker' ? fought.attacker : fought.defender;
        const loser = fought.winner === 'attacker' ? fought.defender : fought.attacker;
        const expected = entry.kind === 'battle-lost' ? { player: loser, amount: 2 } : { player: winner, amount: fought.winner === 'attacker' ? 15 : 10 };
        if (entry.player !== expected.player || entry.amount !== expected.amount) errors.push(`entry ${entry.n}: does not match the replayed battle ${entry.ref}`);
      }
    }
    scores.set(entry.player, (scores.get(entry.player) ?? 0) + entry.amount);
  });
  // The standings: by score, then by the tie-break values recorded when the season closed.
  let ranking = null;
  if (closing) {
    const listed = new Map(closing.ranking.map(row => [row.id, row]));
    for (const row of closing.ranking) if ((scores.get(row.id) ?? 0) !== row.score) errors.push(`closing entry: ${row.id} is listed with ${row.score} points but its events sum to ${scores.get(row.id) ?? 0}`);
    ranking = [...listed.values()].sort((a, b) => b.score - a.score || b.territories - a.territories || b.power - a.power || (a.id < b.id ? -1 : 1))
      .map((row, index) => ({ rank: index + 1, playerId: row.id, score: row.score }));
  }
  // `earlierEvidence` counts scored non-battle entries written before version 2: they carry no timing or record to check.
  return { ok: !errors.length, errors, count: entries.length, head, closed: Boolean(closing), scores, ranking, unreplayedBattles: [...new Set(unreplayed)], earlierEvidence: earlier };
}

// The prize of each rank, exactly as the game computes it.
export const entitlementsOf = (ranking, prizeBase, percentages) => ranking.slice(0, percentages.length).map(row =>
  ({ rank: row.rank, playerId: row.playerId, satoshis: Math.floor(prizeBase * percentages[row.rank - 1] / 100) }));
