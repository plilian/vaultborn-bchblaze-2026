import { balance, counters, terrains, units } from '../../config/balance.mjs';
import { fieldDoctrine } from '../../config/progression.mjs';
import { digest, simulateBattle } from '../../packages/game-engine/combat.mjs';
import { gameEvent, protocolHash } from '../../packages/chain-observer/vaultborn.mjs';

const rules = Object.freeze({
  version: 'vaultborn-combat-1',
  units, counters, terrains,
  options: { varianceBound: balance.combatVariance, fortInfluence: balance.fortInfluence },
});
const fieldRules=Object.freeze({...rules,version:'vaultborn-combat-2',fieldDoctrine});
const rulesFor=input=>input?.attacker?.fieldRules===fieldDoctrine.version || input?.defender?.fieldRules===fieldDoctrine.version ? fieldRules : rules;
const publicationDelay = 24 * 60 * 60_000;
const evidence = row => ({ txid: row.txid, explorerUrl: row.receipt.explorerUrl,
  blockHash: row.receipt.blockHash, vout: row.receipt.eventVout, event: row.receipt.event });

export function registerBattle(store, result, payment, now) {
  if (!result?.input || !Array.isArray(result.events) || !result.attacker || !result.defender) return;
  if (store.portal('battle', result.id)) return;
  const record = { rulesHash:protocolHash(rulesFor(result.input)), battle: result, initiation: payment?.receipt?.event ? evidence(payment) : null };
  const recordHash = protocolHash(record);
  const event = gameEvent('battle-settlement', result.id, { recordHash, initiationTxid: record.initiation?.txid ?? null });
  store.savePortal('battle', result.id, { record, recordHash, event, publicAt: now + publicationDelay });
}

export function registerNewBattles(store, world, previousId, paidBattleId, payment, now) {
  for (const battle of world.battles) {
    if (battle.id === previousId) break;
    registerBattle(store, battle, battle.id === paidBattleId ? payment : null, now);
  }
}

export function readBattle(store, id, player, now, {cinematic=false} = {}) {
  const saved = store.portal('battle', id);
  const current = saved?.record.battle ?? store.read().world.battles.find(battle => battle.id === id);
  if (!current) return;
  if (current.politicalConflict && !['resolved','cancelled'].includes(store.read().world.government?.conflicts?.[current.politicalConflict]?.status)) return;
  const participant = [current.attacker, current.defender].includes(player);
  const territory = store.payments().find(row => row.territoryBattles?.includes(id));
  if (!participant && (!saved || saved.publicAt > now) && territory?.state !== 'credited') return;
  const trace=[];
  const verified = verifyBattle(current,cinematic ? row=>trace.push(row) : undefined);
  const anchor = saved && store.payments().find(row => row.anchorFor === id);
  const activeRules=rulesFor(current.input);
  return { ...(saved ? saved : { record: { rulesHash:protocolHash(activeRules), battle: current, initiation: null }, recordHash: null }),
    rules:activeRules, verified, ...(cinematic && verified && {trace}),
    settlement: anchor?.receipt?.event && anchor.state === 'credited' ? evidence(anchor) : null,
    territorySettlement:territory?.state === 'credited' && territory.receipt?.event ?
      { ...evidence(territory), territory:territory.payload.territory, record:territory.territoryAnchor } : null,
    anchorStatus: anchor?.state ?? territory?.state ?? (saved?.record.initiation ? 'pending' : 'unfunded'),
  };
}

export function verifyBattle(battle, observe) {
  if (!battle?.input || typeof battle.seed !== 'string') return false;
  const recomputed = simulateBattle(battle.input,battle.seed,rulesFor(battle.input).options,observe);
  return battle.commitment === digest({ input: battle.input, seed: battle.seed }) &&
    recomputed.hash === battle.hash &&
    protocolHash(recomputed.events) === protocolHash(battle.events) &&
    protocolHash(recomputed.losses) === protocolHash(battle.losses) &&
    recomputed.winner === battle.winner && recomputed.differential === battle.differential;
}
