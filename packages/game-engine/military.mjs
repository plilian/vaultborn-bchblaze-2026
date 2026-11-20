import {HOUR, MINUTE, economy} from '../../config/economy.mjs'
import {balance, formations, heroes, missions, tactics} from '../../config/balance.mjs'
import {clamp, digest, seeded, simulateBattle, troopTotal, unitIds} from './combat.mjs'
import {activity, attackEligibility, award, combatPower, credit, currentTactic, getCity, has, mapResources, notify, points, requireRule, roundCost, selectTarget, subtract} from './world.mjs'
import {activeCommander, awardCommanderMastery, commanderEffects, ruleClock, usableCommander} from './progression.mjs'

export function selection(city,input,now=ruleClock(city)) {
  const tactic = input.tactic ?? city.tactic
  const formation = input.formation ?? city.formation
  const hero = input.hero ?? activeCommander(city,now)
  requireRule(has(tactics,tactic) && has(formations,formation) && has(heroes,hero),'invalid_formation','Choose a valid hero, formation, and tactic.',400)
  requireRule(usableCommander(city,hero,now),'commander_unavailable','Recruit or renew this commander before deployment.')
  return {tactic, formation, hero}
}

export function battle(world, attacker, defender, now, {kind = 'raid', overrides = {}, paid = false} = {}) {
  const intel = attacker.intel[defender.id]
  const quality = intel?.expiresAt > now ? intel.confidence : 0
  const {defenderTroops, intel: bonusIntel, hero, ...attackerOptions} = overrides
  const defense = currentTactic(defender,world,now)
  if (defenderTroops) defense.troops = defenderTroops
  const input = {attacker: {...currentTactic(attacker,world,now,hero??attacker.hero),...attackerOptions,
    intel: Math.max(quality, bonusIntel || 0)}, defender: defense, terrain: defender.terrain}
  const id = 'b' + (++world.seq)
  const seed = digest([world.secret, id])
  const commitment = digest({input, seed})
  const result = simulateBattle(input, seed)
  const won = result.winner === 'attacker'
  for (const unit of unitIds) {
    attacker.troops[unit] -= Math.min(attacker.troops[unit], result.losses.attacker[unit])
    defender.troops[unit] -= Math.min(defender.troops[unit], result.losses.defender[unit])
  }
  let loot = mapResources(() => 0)
  let aftermath
  if (kind === 'raid') {
    if (won) {
      const cap = Math.floor(troopTotal(attacker.troops) * economy.lootCapacityPerTroop / 5)
      loot = credit(attacker, mapResources(resource => Math.min(cap, Math.floor(defender.resources[resource] * economy.lootFraction))))
      subtract(defender, loot)
    }
    const loser = won ? defender : attacker
    const shielded = balance.defeatShield > 0
    if (shielded) loser.shieldUntil = Math.max(loser.shieldUntil, now + balance.defeatShield)
    const victor = won ? attacker : defender
    const influence = victor.influence
    victor.influence = Math.min(100, victor.influence + 4)
    // Season points between the same attacker and defender count once per 24 hours, so two cooperating accounts cannot
    // farm the standings by raiding each other over and over. The battle itself is unaffected.
    const pairKey = attacker.id + '>' + defender.id
    world.pairScored ||= {}
    const scored = attacker.npc || defender.npc || !(world.pairScored[pairKey] > now - 86_400_000)
    if (scored) {
      points(victor, won ? 15 : 10, won ? 'campaigns' : 'defense', { kind:'battle-won', ref:id })
      points(loser, 2, 'participation', { kind:'battle-lost', ref:id })
      if (!attacker.npc && !defender.npc) world.pairScored[pairKey] = now
      for (const [name, at] of Object.entries(world.pairScored)) if (at <= now - 86_400_000) delete world.pairScored[name]
    }
    aftermath={attacker:{campaignPoints:scored?(won?15:2):0,influence:won?victor.influence-influence:0,
      ...(won||!shielded?{}:{shieldUntil:loser.shieldUntil})},defender:{campaignPoints:scored?(won?2:10):0,influence:won?0:victor.influence-influence,
      ...(won&&shielded?{shieldUntil:loser.shieldUntil}:{})}}
  }
  world.marches.unshift({id, attacker: attacker.id, defender: defender.id, alliance: attacker.alliance, at: now, endsAt: now + 54_000, kind})
  const entry = {id, kind, attacker: attacker.id, defender: defender.id, attackerName: attacker.name, defenderName: defender.name, at: now,
    commitment, input, seed, paid, loot, ...result,...(aftermath&&{aftermath})}
  world.battles.unshift(entry)
  const champion=won?attacker:defender
  const achievement='frontier-defender'
  const alreadyEarned=has(champion.achievements??{},achievement)
  award(champion,achievement,now)
  if (kind==='raid') {
    if (!alreadyEarned) aftermath[result.winner].achievement=achievement
    aftermath.attacker.mastery=awardCommanderMastery(attacker,input.attacker.hero,'raid',now)??0
    aftermath.defender.mastery=defender.npc?0:awardCommanderMastery(defender,input.defender.hero,'defense',now)??0
  }
  notify(world, attacker.id, (won ? 'Victory against ' : 'Defeat against ') + defender.name + '.', now, 'battle',
    {title:won?'Victory':'Defeat',battleId:id,...(won && !alreadyEarned && {achievement})})
  notify(world, defender.id, (won ? 'Defeat against ' : 'Victory against ') + attacker.name + '.', now, 'battle',
    {title:won?'Defeat':'Victory',battleId:id,...(!won && !alreadyEarned && {achievement})})
  activity(world, kind, (won ? attacker.name : defender.name) + ' prevailed at ' + defender.name + '.', now)
  return entry
}

export function raid(world, actor, input, now, paid) {
  const defender = selectTarget(world, actor, input.target)
  if (paid) requireRule(!defender.npc,'competitive_npc','Competitive BCH stakes require a player opponent. Use the earned-resource expedition against NPC kingdoms.')
  const allowed = attackEligibility(world,actor,defender,now)
  requireRule(allowed.ok,allowed.code,allowed.reason)
  const positioning = selection(actor,input,now)
  return battle(world, actor, defender, now, {overrides: positioning, paid})
}

function mayScout(city,target,now) {
  if (target.shieldUntil > now || !target.optIn) return false;
  return target.npc && !city.npc ? city.tutorial && !city.founding : city.optIn;
}

export function launchMission(world, city, input, now) {
  const type = input.mission ?? 'recon'
  requireRule(has(missions, type), 'invalid_mission', 'Choose an espionage operation.', 400)
  const profile = missions[type]
  const target = type === 'decoy' ? city : selectTarget(world, city, input.target)
  if (type !== 'decoy') {
    requireRule(mayScout(city,target,now), 'protected_intel', 'Seasonal or starter protection blocks this mission.')
    requireRule(!city.lastScout[target.id] || city.lastScout[target.id] <= now - balance.scoutRepeat, 'scout_cooldown', 'You recently investigated this city.')
    const inbound = world.missions.filter(mission => mission.target === target.id && mission.startedAt > now - HOUR)
    requireRule(inbound.length < balance.scoutIncomingHourly, 'scout_incoming_limit', 'This city reached the hourly incoming espionage limit.')
  }
  requireRule(city.spies > 0 && city.scoutPoints >= profile.points, 'scout_capacity','Your Scout Tower lacks available agents or scout points.')
  requireRule(!world.missions.some(mission => mission.actor === city.id && mission.status === 'pending'), 'scout_busy', 'One mission at a time can use the Scout Tower.')
  if (type === 'sabotage') requireRule(target.sabotageCooldown <= now, 'sabotage_cooldown', 'Target logistics already have sabotage protection.')
  const cost = roundCost(profile.cost)
  subtract(city, cost)
  city.scoutPoints -= profile.points
  city.lastScout[target.id] = now
  const specialist=activeCommander(city,now)
  const operation = {id: 'm' + (++world.seq), actor: city.id, target: target.id, mission: type, startedAt: now,
    specialist,specialistBonus:commanderEffects(city,specialist,now).scoutSuccess??0,
    completesAt: now + profile.time, status: 'pending', cost, scoutPoints:profile.points}
  world.missions.unshift(operation)
  return operation
}

export function completeMission(world, operation, now) {
  const city = getCity(world, operation.actor)
  const target = getCity(world, operation.target)
  const profile = missions[operation.mission]
  const random = seeded(digest([world.secret, operation.id]))
  if (operation.mission === 'decoy') {
    city.decoyUntil = now + balance.decoyDuration
    operation.status = 'success'
    notify(world, city.id, 'Decoy units are feeding false troop estimates to rival scouts.', now, 'spy')
    return
  }
  const counterspy = target.counterspyUntil > now
  const towerDifference = city.buildings.scout - target.buildings.scout
  const base = ({recon:.86, deep:.69, supply:.72, sabotage:.56})[operation.mission]
  const probability = clamp(base + towerDifference * .035 + city.tech.signals * .04 + (operation.specialistBonus??commanderEffects(city,city.hero,now).scoutSuccess??0) -
    (counterspy ? .26 : 0), .18, .93)
  const noLongerEligible = !mayScout(city,target,now) ||
    operation.mission === 'sabotage' && target.sabotageCooldown > now
  if (noLongerEligible || random() >= probability) {
    const detected = !noLongerEligible && random() < (counterspy ? .87 : .52)
    operation.status = detected ? 'detected' : 'failed'
    if (detected) {
      city.spies--
      city.spyRecovery.push(now + 45 * MINUTE)
      notify(world, target.id, 'Your watchtower intercepted an operative from ' + city.name + '.', now, 'spy', {title:'Enemy scout caught', threat:true})
    } else if (counterspy && !noLongerEligible && random() < .12) {
      notify(world, target.id, 'A sentry raised an unverified watchtower alarm. No operative was identified.', now, 'spy', {title:'Watchtower alarm', threat:true})
    }
    notify(world, city.id, detected ? 'A scout was lost. A replacement is being trained.' : 'The scout withdrew without reliable information.', now, 'spy')
    return
  }
  const decoy = target.decoyUntil > now
  const confidence = clamp(profile.confidence + towerDifference * .02 - (counterspy ? .12 : 0) - (decoy ? .17 : 0), .25, .95)
  const estimate = value => Math.round(value * (1 + (random() * 2 - 1) * (1 - confidence) + (decoy ? .24 : 0)))
  const intel = {id: operation.id, actor: city.id, target: target.id, kind: operation.mission, at: now,
    expiresAt: now + balance.intelLifetime, confidence: Math.round(confidence * 100) / 100, power: estimate(combatPower(target)),
    army: estimate(troopTotal(target.troops)), defense: estimate(target.buildings.walls * 50)}
  if (operation.mission === 'deep') {
    intel.troops = Object.fromEntries(unitIds.map(unit => [unit, estimate(target.troops[unit])]))
    intel.formation = confidence >= .65 && !decoy ? target.formation : 'uncertain'
    intel.wall = estimate(target.buildings.walls)
  }
  if (operation.mission === 'supply') intel.resources = mapResources(resource => estimate(target.resources[resource]))
  if (operation.mission === 'sabotage') {
    target.sabotageUntil = now + balance.sabotageDuration
    target.sabotageCooldown = now + balance.sabotageCooldown
    notify(world, target.id, 'Detected a disruption affecting resource production for one hour.', now, 'spy', {title:'Sabotage detected', threat:true})
  }
  city.intel[target.id] = intel
  city.intelArchive.unshift(intel)
  city.intelArchive.length = Math.min(city.intelArchive.length, city.perks.scout ? 21 : 20)
  operation.intel = intel
  operation.status = 'success'
  const firstReport = !has(city.achievements ?? {},'eyes-in-mist')
  award(city,'eyes-in-mist',now)
  if (operation.specialist==='ranger') awardCommanderMastery(city,operation.specialist,'scout',now)
  points(city, 2, 'intelligence', { kind:'intelligence', ref:operation.id, since:operation.startedAt, until:operation.completesAt })
  notify(world, city.id, 'The scout returned from ' + target.name + ' with a new intelligence report.', now, 'spy',
    {title:'Scouting report arrived',reportId:intel.id,...(firstReport && {achievement:'eyes-in-mist'})})
}

export function counterspy(world, city, now) {
  requireRule(city.counterspyCooldown <= now, 'counterspy_cooldown','Your watchtower is recovering from its last counterespionage operation.')
  const cost = roundCost([26,24,0,48,6])
  subtract(city, cost)
  city.counterspyUntil = now + balance.counterspyDuration
  city.counterspyCooldown = now + balance.counterspyCooldown
  notify(world, city.id, 'Counterespionage is active for four hours.', now, 'spy')
  return {until: city.counterspyUntil, nextAt:city.counterspyCooldown, cost}
}

export function shareIntel(world, actor, input, now) {
  requireRule(actor.alliance, 'alliance_required', 'Join an alliance to share intelligence.')
  const intel = has(actor.intel, input.target) ? actor.intel[input.target] : null
  requireRule(intel?.expiresAt > now, 'intel_stale', 'Acquire a fresh report before sharing.')
  requireRule(!intel.sharedBy, 'intel_access', 'Only the author can distribute this intelligence.')
  requireRule(actor.intelShared[intel.id] !== actor.alliance, 'intel_already_shared', 'Intelligence is already shared with this alliance.')
  const freshIds = new Set(Object.values(actor.intel).filter(report => report.expiresAt > now).map(report => report.id))
  actor.intelShared = Object.fromEntries(Object.entries(actor.intelShared).filter(([id]) => freshIds.has(id)))
  actor.intelShared[intel.id] = actor.alliance
  for (const city of Object.values(world.cities)) {
    if (city.id === actor.id || city.alliance !== actor.alliance || city.intel[intel.target]?.at >= intel.at) continue
    city.intel[intel.target] = {...intel, confidence: Math.round(intel.confidence * 90) / 100, sharedBy: actor.id, sharedWith: actor.alliance}
    notify(world, city.id, actor.name + ' shared a scouting report on ' + getCity(world,intel.target).name + '.', now, 'spy')
  }
  return intel
}
