import { DAY, HOUR, resources } from '../../config/economy.mjs';
import { heroes, missions } from '../../config/balance.mjs';
import { troopTotal } from './combat.mjs';
import { research, researchQuote, train, trainingQuote, upgrade } from './economy.mjs';
import { battle, counterspy, launchMission, selection } from './military.mjs';
import { launchRebellion, prepareRebellion } from './politics.mjs';
import { npcCeasefire, npcEnvoyCost, reconcileNpcBorder } from './diplomacy.mjs';
import { manageNpcCourt } from './government.mjs';
import { reinforceFrontierCamps } from './territories.mjs';
import { awardCommanderMastery, commanderCommand, commanderSnapshot, newCommanderBook, usableCommander } from './progression.mjs';
import { activeProtectorate, combatPower, credit, friendly, has, lastDay, mapResources,
  points, quoteUpgrade, requireRule, roundCost, selectTarget, subtract } from './world.mjs';

export const expeditionRules = Object.freeze({ dailyLimit:2, playerCooldown:2*HOUR, rematchCooldown:12*HOUR,
  targetCooldown:2*HOUR, minimumTroops:12, minimumDefenders:10, maximumPowerRatio:1.5,
  cost:Object.freeze({ wood:8, food:24 }) });

export const npcCadence = Object.freeze({ pulse:2*HOUR, activity:DAY, conflict:12*HOUR });
const profiles = {
  crimson:{name:'War host', agenda:'Builds military capacity and prepares offensives.', hall:3, army:65,
    hero:'commander', upgrades:['barracks','workshop','farm','walls'], formation:'wedge', tactic:'assault', unit:'cavalry'},
  emerald:{name:'March wardens', agenda:'Scouts borders and reinforces its defensive line.', hall:3, army:60,
    hero:'ranger', upgrades:['scout','walls','farm','barracks'], formation:'screen', tactic:'balanced', unit:'archer'},
  azure:{name:'River watch', agenda:'Protects river crossings and maintains a shield wall.', hall:2, army:55,
    hero:'warden', upgrades:['walls','farm','scout','barracks'], formation:'line', tactic:'balanced', unit:'shield'},
  violet:{name:'Freehold', agenda:'Improves local workshops and mobilizes when threatened.', hall:3, army:55,
    hero:'engineer', upgrades:['workshop','farm','walls','barracks'], formation:'line', tactic:'flank', unit:'infantry'},
  gold:{name:'Trade court', agenda:'Develops supply, research, and a standing city guard.', hall:2, army:52,
    hero:'merchant', upgrades:['market','farm','library','walls'], formation:'line', tactic:'balanced', unit:'infantry'},
};
const policy = city => profiles[city.faction] ?? profiles.emerald;
const reserve = { wood:60, stone:45, iron:45, food:100, crystal:14 };
const canPay = (city, cost, buffer = {}) => resources.every(id => city.resources[id] >= (cost[id] ?? 0) + (buffer[id] ?? 0));

export function npcProtectorateResponse(world, defender, pact) {
  const sponsor = world.cities[pact.overlord];
  const balance = combatPower(defender) / Math.max(1,combatPower(sponsor));
  if (['azure','crimson'].includes(defender.faction) && defender.buildings.walls>=2 && balance>=.45 && troopTotal(defender.troops)>=24) return 'resist';
  if (['gold','violet'].includes(defender.faction) && defender.influence>=8 && sponsor.reputation<40) return 'negotiate';
  return 'accept';
}

export function npcProfile(city) {
  if (!city.npc) return null;
  const profile = policy(city);
  return { name:profile.name, agenda:profile.agenda };
}

export function npcEnvoyEligibility(world,actor,target,now = world.now) {
  const fail = (code,reason,nextAt=null) => ({ok:false,code,reason,nextAt,cost:npcEnvoyCost});
  if (actor.npc || !target.npc || actor.id===target.id) return fail('envoy_target','Choose an NPC kingdom to receive your envoy.');
  if (actor.founding || !actor.tutorial) return fail('tutorial_required','Complete your first campaign to send an envoy.');
  if (friendly(world,actor,target)) return fail('friendly','An existing agreement protects this kingdom.');
  const lastEnvoy = Object.values(world.diplomacy?.treaties ?? {})
    .filter(row=>row.kind==='ceasefire' && row.from===actor.id && world.cities[row.to]?.npc)
    .reduce((last,row)=>Math.max(last,row.createdAt),-Infinity);
  if (lastEnvoy+12*HOUR>now) return fail('envoy_cooldown','Your envoys can visit one NPC court per 12 hours.',lastEnvoy+12*HOUR);
  if (!canPay(actor,npcEnvoyCost)) return fail('insufficient_resources','Supplies are needed to send an envoy.');
  return {ok:true,code:null,reason:null,nextAt:null,cost:npcEnvoyCost};
}

export function sendNpcEnvoy(world,actor,input,now) {
  const target = selectTarget(world,actor,input.target);
  const eligible = npcEnvoyEligibility(world,actor,target,now);
  requireRule(eligible.ok,eligible.code,eligible.reason);
  const pressure = world.marches.some(row=>row.attacker===actor.id && row.defender===target.id && row.at>now-6*HOUR);
  const warCourt = target.faction==='crimson' && troopTotal(target.troops)>=45 && combatPower(target)>combatPower(actor)*.9;
  const treaty = npcCeasefire(world,actor,target,!pressure&&!warCourt,now);
  return { treaty, accepted:treaty.status==='active', cost:npcEnvoyCost,
    reply:pressure?'The court will hear an envoy after its army has recovered from your recent attack.':
      warCourt?'The war host believes it can hold its borders.':'The court accepted a twelve-hour ceasefire.' };
}

export function expeditionEligibility(world, actor, target, now = world.now, garrison = target.troops) {
  const fail = (code, reason, nextAt=null) => ({ ok:false, code, reason, nextAt, cost:expeditionRules.cost });
  if (actor.npc || !target.npc || actor.id === target.id) return fail('expedition_target','Choose an NPC kingdom for an expedition.');
  if (!actor.tutorial || actor.founding) return fail('tutorial_required','Complete your first campaign to lead an expedition.');
  if (target.shieldUntil > now) return fail('protected','This kingdom is recovering.',target.shieldUntil);
  if (friendly(world,actor,target) || activeProtectorate(world,target.id) || activeProtectorate(world,actor.id)?.overlord === target.id) {
    return fail('friendly','An existing agreement protects this kingdom.');
  }
  const history = lastDay(world.marches,now).filter(item => ['expedition','frontier-conquest'].includes(item.kind));
  const launched = history.filter(item => item.attacker === actor.id);
  if (launched.length >= expeditionRules.dailyLimit) {
    return fail('expedition_limit','You have used both expeditions in the last 24 hours.',Math.min(...launched.map(item=>item.at))+DAY);
  }
  const recent = launched.find(item => item.at + expeditionRules.playerCooldown > now);
  if (recent) return fail('expedition_recovery','Your army is resting after an expedition.',recent.at+expeditionRules.playerCooldown);
  const rematch = launched.find(item => item.defender === target.id && item.at + expeditionRules.rematchCooldown > now);
  if (rematch) return fail('expedition_rematch','You recently faced this kingdom.',rematch.at+expeditionRules.rematchCooldown);
  const pressure = history.find(item => item.defender === target.id && item.at + expeditionRules.targetCooldown > now);
  if (pressure) return fail('expedition_garrison','This garrison is resting after an expedition.',pressure.at+expeditionRules.targetCooldown);
  if (troopTotal(actor.troops) < expeditionRules.minimumTroops) return fail('troop_minimum','Field at least 12 troops.');
  if (troopTotal(garrison) < expeditionRules.minimumDefenders) return fail('expedition_muster','The garrison is still rebuilding.');
  if (combatPower({...target,troops:garrison}) > combatPower(actor)*expeditionRules.maximumPowerRatio) {
    return fail('power_gap','This garrison exceeds one and a half times your army power.');
  }
  if (!canPay(actor,expeditionRules.cost)) return fail('insufficient_resources','Supplies are needed to lead an expedition.');
  return { ok:true, code:null, reason:null, nextAt:null, cost:expeditionRules.cost };
}

export function prepareExpedition(world, actor, target, input, now, garrison) {
  const permitted = expeditionEligibility(world,actor,target,now,garrison);
  requireRule(permitted.ok,permitted.code,permitted.reason);
  const orders = selection(actor,input,now);
  subtract(actor,expeditionRules.cost);
  return orders;
}

export function awardExpedition(world, actor, defender, report, now) {
  const won = report.winner === 'attacker';
  const merit = won ? 5 : 1;
  points(actor,merit,won ? 'campaigns' : 'participation',{kind:won ? 'expedition-won' : 'expedition-lost',ref:report.id});
  report.loot = mapResources(() => 0);
  if (won) {
    const cap = Math.min(20,troopTotal(actor.troops));
    report.loot = credit(actor,mapResources(id=>Math.min(id==='crystal'?3:cap,Math.floor(defender.resources[id]/24))),now);
    subtract(defender,report.loot);
  }
  report.aftermath = { attacker:{ campaignPoints:merit,
    mastery:won ? awardCommanderMastery(actor,report.input.attacker.hero,'territory',now) ?? 0 : 0,
    expeditionSupplies:expeditionRules.cost } };
}

export function launchExpedition(world, actor, input, now) {
  const defender = selectTarget(world,actor,input.target);
  const orders = prepareExpedition(world,actor,defender,input,now);
  const report = battle(world,actor,defender,now,{ kind:'expedition', overrides:orders });
  awardExpedition(world,actor,defender,report,now);
  return report;
}

function recentHumanPlay(world, now) {
  return Object.values(world.cities).some(city => !city.npc && !city.founding && Number.isSafeInteger(city.lastActionAt) &&
    city.lastActionAt > now - npcCadence.activity && city.lastActionAt <= now);
}

function development(world, city, profile, now) {
  if (!city.queue.some(job => job.kind === 'building')) {
    const hall = city.buildings.hall;
    const support = profile.upgrades.find(key => city.buildings[key] < hall);
    const key = support ?? (hall < profile.hall ? 'hall' : null);
    if (key && canPay(city,quoteUpgrade(city,key,now).cost,reserve)) upgrade(world,city,{building:key},now);
  }
  if (!city.queue.some(job => job.kind === 'research')) {
    const key = profile.hero === 'ranger' ? 'signals' : 'logistics';
    const plan = researchQuote(city,key,now);
    if (plan.eligible && plan.current < 2 && canPay(city,plan.cost,reserve)) research(world,city,{tech:key},now);
  }
  const goal = profile.army + Math.max(0,city.buildings.hall-1)*5;
  const total = troopTotal(city.troops);
  if (total >= goal || city.queue.some(job => job.kind === 'troop')) return;
  const name = city.troops.infantry < 14 ? 'infantry' : profile.unit;
  const space = trainingQuote(world,city,name,1,now).spaceRemaining;
  const count = Math.min(12,goal-total,space);
  if (count > 0) {
    const plan = trainingQuote(world,city,name,count,now);
    if (plan.eligible && canPay(city,plan.cost,reserve)) train(world,city,{unit:name,count},now);
  }
}

function specialize(world, city, profile, now) {
  if (!city.commanders) {
    city.commanders = newCommanderBook();
    if (has(heroes,city.hero) && city.hero!=='warden') city.commanders.roster[city.hero] = { level:1, xp:0, permanent:true };
  }
  const hero = profile.hero;
  if (!usableCommander(city,hero,now)) {
    const offer = commanderSnapshot(city,now).roster[hero].recruitment;
    if (offer.eligible && canPay(city,offer.cost,reserve)) commanderCommand(world,city,{type:'commander-recruit',hero},now);
  }
  if (usableCommander(city,hero,now)) city.hero = hero;
  city.formation = profile.formation;
  city.tactic = city.troops.siege > 6 && profile.hero === 'commander' ? 'siege' : profile.tactic;
}

function resistance(world, city, now) {
  const pact = activeProtectorate(world,city.id);
  if (!pact || troopTotal(city.troops) < 12 || pact.endsAt <= now + 2*HOUR) return;
  const sponsor = world.cities[pact.overlord];
  if (combatPower(city) < combatPower(sponsor)*.57 && sponsor.reputation > 35) return;
  const existing = pact.rebellion;
  if (existing?.status === 'preparing' && existing.cells>=2 && existing.readyAt<=now) {
    launchRebellion(world,city,{id:pact.id},now);
    return;
  }
  if ((!existing || existing.status === 'preparing' && existing.cells<2 || existing.status === 'failed' && existing.retryAt<=now) &&
      city.influence>=4 && canPay(city,roundCost([20,0,16,48,4]),reserve)) prepareRebellion(world,city,{id:pact.id},now);
}

function rivals(world, attacker, npcs, now) {
  const strength = combatPower(attacker);
  return npcs.filter(defender => attacker.id!==defender.id && defender.optIn && defender.shieldUntil<=now &&
    attacker.faction!==defender.faction && !friendly(world,attacker,defender) && !activeProtectorate(world,defender.id) &&
    Math.hypot(attacker.x-defender.x,attacker.y-defender.y)<=.32 && troopTotal(defender.troops)>=24 &&
    combatPower(defender)>=strength*.82 && combatPower(defender)<=strength*1.12);
}

function borders(world, npcs, now) {
  if ((world.npcFrontierSkirmishAt ?? -Infinity) + npcCadence.conflict > now) return;
  // Pressure follows faction relations and real local defenses. It never selects a human city.
  for (const city of npcs) {
    if (!city.optIn || city.shieldUntil>now || activeProtectorate(world,city.id) || troopTotal(city.troops)<35) continue;
    const rival = rivals(world,city,npcs,now)[0];
    if (!rival) continue;
    if (city.intel[rival.id]?.expiresAt > now && canPay(city,expeditionRules.cost,reserve)) {
      subtract(city,expeditionRules.cost);
      const report = battle(world,city,rival,now,{kind:'npc-skirmish'});
      world.npcFrontierSkirmishAt = now;
      if (troopTotal(report.losses.attacker)+troopTotal(report.losses.defender)>=16 && canPay(city,{wood:12,food:16},reserve)) {
        reconcileNpcBorder(world,city,rival,now);
      }
      return;
    }
    const lastScout = city.lastScout[rival.id];
    const started = world.missions.some(item=>item.actor===city.id&&item.status==='pending');
    if (!started && (!lastScout || lastScout + HOUR <= now) && city.spies>0 && city.scoutPoints>0 &&
        !world.missions.some(item=>item.target===rival.id && item.startedAt>now-HOUR) && canPay(city,roundCost(missions.recon.cost),reserve)) {
      launchMission(world,city,{target:rival.id,mission:'recon'},now);
      return;
    }
  }
}

export function nextNpcEvent(world, until) {
  if (!world.npcPulseAt) {
    if (!recentHumanPlay(world,world.now)) return null;
    world.npcPulseAt = world.now+npcCadence.pulse;
  }
  const at = Math.max(world.now,world.npcPulseAt);
  if (at>until || !recentHumanPlay(world,at)) return null;
  return { at, apply:() => {
    world.npcPulseAt = at+npcCadence.pulse;
    const npcs = Object.values(world.cities).filter(city=>city.npc);
    for (const city of npcs) {
      const profile = policy(city);
      const watching = world.marches.some(march=>march.defender===city.id && march.at>at-6*HOUR);
      if (watching && city.counterspyCooldown<=at && canPay(city,roundCost([26,24,0,48,6]),reserve)) counterspy(world,city,at);
      specialize(world,city,profile,at);
      development(world,city,profile,at);
      reinforceFrontierCamps(world,city);
      resistance(world,city,at);
      manageNpcCourt(world,city,city.faction==='gold'?'commerce':city.faction==='crimson'?'mobilization':'civic',at);
    }
    borders(world,npcs,at);
  } };
}
