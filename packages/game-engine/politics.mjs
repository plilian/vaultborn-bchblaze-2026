import {DAY, HOUR, MINUTE, economy, resources} from '../../config/economy.mjs'
import {balance} from '../../config/balance.mjs'
import {activeCommander, awardCommanderMastery, commanderEffects} from './progression.mjs'
import {clamp, troopTotal, unitIds} from './combat.mjs'
import {activity, activeProtectorate, activeTreaty, allianceMembers, cleanName, credit, getAlliance, getCity, governanceRegions, has, lastDay, notify, points,
  protectorateEligibility, requireRule, roundCost, selectTarget, stockCapacity, subtract} from './world.mjs'
import {battle} from './military.mjs'
import {recordGovernmentEvent} from './government.mjs'
import {npcProtectorateResponse} from './npc.mjs'

function findPact(world, id) {
  const pact = world.governance.find(item => item.id === id)
  requireRule(pact, 'pact_missing', 'That protectorate could not be found.', 404)
  return pact
}

export function propose(world, sponsor, input, now) {
  const defender = selectTarget(world, sponsor, input.target)
  const result = protectorateEligibility(world, sponsor, defender, now)
  requireRule(result.ok, result.code, result.reason)
  subtract(sponsor, roundCost([85,65,45,100,18]))
  sponsor.influence -= 12
  sponsor.reputation = Math.max(0, sponsor.reputation - (4 + governanceRegions(world, sponsor.id).length * 4))
  const pact = {id: 'pact' + (++world.seq), defender: defender.id, overlord: sponsor.id, alliance: sponsor.alliance, status: 'pending', createdAt: now,
    respondBy: now + economy.protectorateResponseTime, tribute: economy.protectorateTribute, rebellion: null, upkeepAt: 0}
  world.governance.unshift(pact)
  notify(world, defender.id, sponsor.name + ' proposed a temporary protectorate. Choose a diplomatic response before the deadline.', now, 'politics')
  activity(world, 'protectorate', sponsor.name + ' proposed terms to ' + defender.name + '.', now)
  return pact
}

function endPact(world, pact, status, now) {
  pact.status = status
  pact.endedAt = now
  const overlord = getCity(world, pact.overlord)
  const defender = getCity(world, pact.defender)
  defender.immunityUntil = Math.max(defender.immunityUntil, now + economy.rebellionImmunity)
  if (pact.rebellion?.status === 'mustering') pact.rebellion.status = 'cancelled'
  if (status==='liberated' || status==='released') recordGovernmentEvent(world,'liberation',{actor:pact.defender,target:pact.overlord,id:pact.id},now)
  notify(world, defender.id, 'The protectorate with ' + overlord.name + ' is ' + status + '.', now, 'politics')
  notify(world, overlord.id, 'The protectorate with ' + defender.name + ' is ' + status + '.', now, 'politics')
  activity(world, 'protectorate', defender.name + ' is independent.', now)
}

function startPact(world, pact, now) {
  pact.status = 'active'
  pact.startedAt = now
  pact.endsAt = now + economy.protectorateTerm
  pact.upkeepAt = now + 6 * HOUR
  points(getCity(world,pact.overlord),5,'diplomacy',{kind:'diplomacy',ref:'pact:'+pact.id+':accepted'})
  recordGovernmentEvent(world,'treaty',{actor:pact.overlord,target:pact.defender,id:pact.id},now)
  notify(world, pact.overlord, getCity(world,pact.defender).name + ' entered a temporary protectorate.', now, 'politics')
  notify(world, pact.defender, 'The protectorate is active. The tribute is eight percent of earned production.', now, 'politics')
}

export function upkeep(world, pact, now) {
  const overlord = getCity(world,pact.overlord)
  const regions = governanceRegions(world,pact.overlord).length
  const fee = roundCost([22,14,0,32,1], regions * 1.05)
  if (resources.some(resource => overlord.resources[resource] < fee[resource])) {
    overlord.reputation = Math.max(0, overlord.reputation - 6)
    endPact(world,pact,'lapsed',now)
    return
  }
  subtract(overlord,fee)
  pact.upkeepAt += 6 * HOUR
}

export function nextGovernanceEvents(world, now) {
  const items = []
  for (const pact of world.governance) {
    if (pact.status === 'pending') {
      const npc = getCity(world, pact.defender).npc
      const response = npc ? Math.min(pact.respondBy, pact.createdAt + 30_000) : pact.respondBy
      if (response <= now) items.push({at: response, apply: () => {
        if (pact.status !== 'pending') return
        if (npc) {
          const defender = getCity(world,pact.defender)
          respond(world,defender,{id:pact.id,decision:npcProtectorateResponse(world,defender,pact)},response)
        }
        else endPact(world,pact,'expired',response)
      }})
    }
    if (pact.status === 'active') {
      if (pact.endsAt <= now) items.push({at: pact.endsAt, apply: () => {
        if (pact.status === 'active') endPact(world,pact,'expired',pact.endsAt)
      }})
      if (pact.upkeepAt <= now && pact.upkeepAt < pact.endsAt) items.push({at: pact.upkeepAt, apply: () => {
        if (pact.status === 'active') upkeep(world,pact,pact.upkeepAt)
      }})
      if (pact.rebellion?.status === 'mustering' && pact.rebellion.resolveAt <= now) {
        const time = pact.rebellion.resolveAt
        items.push({at: time, apply: () => {
          if (pact.status === 'active' && pact.rebellion.status === 'mustering') resolveRebellion(world,pact,time)
        }})
      }
    }
  }
  return items
}

export function respond(world, defender, input, now) {
  const pact = findPact(world, input.id)
  requireRule(pact.defender === defender.id, 'not_defender', 'Only the defending city can respond.', 403)
  requireRule(pact.status === 'pending' && now <= pact.respondBy, 'response_closed', 'The response window has closed.')
  requireRule(['accept','reject','resist','negotiate'].includes(input.decision), 'invalid_decision', 'Choose an available response.', 400)
  if (input.decision === 'reject' || !defender.optIn) {
    endPact(world,pact,'refused',now)
    return pact
  }
  if (input.decision === 'negotiate') {
    requireRule(defender.influence >= 8, 'influence', 'Diplomatic refusal requires 8 Influence.')
    defender.influence -= 8
    defender.reputation = Math.min(100, defender.reputation + 2)
    endPact(world,pact,'negotiated',now)
    return pact
  }
  if (input.decision === 'resist') {
    const overlord = getCity(world,pact.overlord)
    const response = cappedForce(overlord, Math.max(12, troopTotal(defender.troops) * .98))
    const result = battle(world,overlord,defender,now,{kind:'resistance',overrides:{troops: response}})
    pact.challenge = result.id
    if (result.winner === 'defender') {
      points(defender,10,'defense',{kind:'defense',ref:'battle:'+result.id})
      endPact(world,pact,'resisted',now)
      return pact
    }
  }
  startPact(world,pact,now)
  return pact
}

function cappedForce(city, cap) {
  const factor = Math.min(1, cap / Math.max(1, troopTotal(city.troops)))
  return Object.fromEntries(unitIds.map(unit => [unit, Math.floor(city.troops[unit] * factor)]))
}

function requireVassal(world, actor, id) {
  const pact = id ? findPact(world,id) : activeProtectorate(world,actor.id)
  requireRule(pact?.defender === actor.id && pact.status === 'active', 'not_vassal', 'An active protectorate is required.', 403)
  return pact
}

export function prepareRebellion(world, actor, input, now) {
  const pact = requireVassal(world,actor,input.id)
  const overlord = getCity(world,pact.overlord)
  const previous = pact.rebellion
  requireRule(!previous || previous.status === 'preparing' || previous.status === 'failed' && previous.retryAt <= now,
    'rebellion_wait', 'Rebel cells are already mobilized or recovering.')
  requireRule(pact.endsAt > now + economy.rebellionPrepTime + economy.rebellionResponseTime, 'term_ending', 'The protectorate expires before a rebellion could muster.')
  requireRule(actor.influence >= 4, 'influence', 'Preparing a rebel cell requires 4 Influence.')
  const rebellion = previous?.status === 'preparing' ? previous : {status:'preparing', startedAt:now, readyAt:now + economy.rebellionPrepTime, cells:0, supporters:[],
    commander:activeCommander(actor,now),
    morale: 35 + (commanderEffects(actor,actor.hero,now).rebellionMorale??0), stability: clamp(overlord.reputation - governanceRegions(world,overlord.id).length * 8,20,85)}
  requireRule(rebellion.cells < 4, 'rebellion_cells', 'Four cells are already organized.')
  subtract(actor,roundCost([20,0,16,48,4]))
  actor.influence -= 4
  rebellion.cells++
  rebellion.morale = Math.min(85,rebellion.morale + 12)
  pact.rebellion = rebellion
  notify(world,actor.id,'A rebel cell is preparing in secret.',now,'rebellion')
  return rebellion
}

export function supportRebellion(world, actor, input, now) {
  const pact = findPact(world,input.id)
  const defender = getCity(world,pact.defender)
  const overlord = getCity(world,pact.overlord)
  requireRule(pact.status === 'active' && pact.rebellion?.status === 'preparing', 'rebellion_missing', 'No rebel cells are requesting support.')
  requireRule(actor.id !== defender.id && actor.id !== overlord.id &&
    ((actor.alliance && actor.alliance === defender.alliance) || activeTreaty(world,actor,defender,['defense'])),
    'rebellion_ally', 'Only a defense ally may support the rebellion.', 403)
  requireRule(pact.rebellion.supporters.length < 3 && !pact.rebellion.supporters.includes(actor.id),
    'rebellion_support', 'This rebellion has enough support or has already received your aid.')
  subtract(actor,roundCost([20,20,14,66,0]))
  pact.rebellion.supporters.push(actor.id)
  pact.rebellion.morale = Math.min(94,pact.rebellion.morale + 6)
  points(actor,3,'diplomacy',{kind:'diplomacy',ref:'pact:'+pact.id+':'+pact.rebellion.resolveAt+':support'})
  notify(world,defender.id,actor.name + ' pledged support to your rebel cells.',now,'rebellion')
  return pact.rebellion
}

export function launchRebellion(world, actor, input, now) {
  const pact = requireVassal(world,actor,input.id)
  const rebellion = pact.rebellion
  requireRule(rebellion?.status === 'preparing' && rebellion.readyAt <= now && rebellion.cells >= 2,
    'rebellion_not_ready', 'Mobilization requires two cells and a completed preparation timer.')
  requireRule(pact.endsAt > now + economy.rebellionResponseTime,'term_ending','The protectorate expires before mobilization finishes.')
  requireRule(troopTotal(actor.troops) >= 10,'troop_minimum','Raise at least 10 troops to mobilize.')
  rebellion.status = 'mustering'
  rebellion.resolveAt = now + economy.rebellionResponseTime
  if (rebellion.commander==='queen') awardCommanderMastery(actor,'queen','rebellion',now)
  recordGovernmentEvent(world,'rebellion',{actor:actor.id,target:pact.overlord,id:pact.id+':'+rebellion.resolveAt},now)
  notify(world,pact.overlord,actor.name + ' is mustering a rebellion. Reinforce or offer release before the battle.',now,'rebellion')
  activity(world,'rebellion',actor.name + ' has raised the horn of independence.',now)
  return rebellion
}

export function respondRebellion(world, actor, input, now) {
  const pact = findPact(world,input.id)
  requireRule(pact.overlord === actor.id,'not_overlord','Only the protectorate sponsor can respond.',403)
  requireRule(pact.status === 'active' && pact.rebellion?.status === 'mustering','rebellion_missing','No rebellion is mustering.')
  if (input.decision === 'release') return release(world,actor,input,now)
  requireRule(input.decision == null || input.decision === 'reinforce','invalid_decision','Choose reinforcement or release.',400)
  requireRule(!pact.rebellion.reinforced,'already_reinforced','The sponsor has already reinforced.')
  subtract(actor,roundCost([38,40,50,80,5]))
  pact.rebellion.reinforced = true
  notify(world,pact.defender,'Your sponsor has deployed reinforcements.',now,'rebellion')
  return pact.rebellion
}

function resolveRebellion(world, pact, now) {
  const rebel = getCity(world,pact.defender)
  const overlord = getCity(world,pact.overlord)
  const will = (pact.rebellion.morale - pact.rebellion.stability) / 200
  const defenders = cappedForce(overlord, Math.max(10, troopTotal(rebel.troops) * clamp(1.03 - will + (pact.rebellion.reinforced ? .11 : 0),.72,1.27)))
  const result = battle(world,rebel,overlord,now,{kind:'rebellion',overrides:{intel: Math.min(1,pact.rebellion.morale / 100), defenderTroops: defenders}})
  pact.rebellion.battle = result.id
  if (result.winner === 'attacker') {
    pact.rebellion.status = 'liberated'
    rebel.reputation = Math.min(100,rebel.reputation + 7)
    overlord.reputation = Math.max(0,overlord.reputation - 8)
    points(rebel,16,'diplomacy',{kind:'diplomacy',ref:'pact:'+pact.id+':'+pact.rebellion.resolveAt+':liberated'})
    endPact(world,pact,'liberated',now)
  } else {
    pact.rebellion.status = 'failed'
    pact.rebellion.retryAt = now + economy.rebellionImmunity
    if (balance.defeatShield > 0) rebel.shieldUntil = Math.max(rebel.shieldUntil,now + balance.defeatShield)
    notify(world,rebel.id,'The rebellion was repelled. New cells can organize after a 12-hour recovery period.',now,'rebellion')
  }
}

export function release(world, actor, input, now) {
  const pact = findPact(world,input.id)
  requireRule(pact.overlord === actor.id && pact.status === 'active','not_overlord','Only the active protectorate sponsor can release the city.',403)
  actor.reputation = Math.min(100,actor.reputation + 3)
  endPact(world,pact,'released',now)
  return pact
}

export function allianceCreate(world, actor, input, now) {
  requireRule(!actor.alliance,'alliance_exists','Leave your current alliance before founding another.')
  const name = cleanName(input.name)
  requireRule(name.length >= 2,'invalid_name','An alliance name is required.',400)
  requireRule(!Object.values(world.alliances).some(item => item.name.toLowerCase() === name.toLowerCase()),'alliance_name_taken','An alliance already uses that name.')
  subtract(actor,roundCost([110,100,70,60,12]))
  const alliance = {id:'a' + (++world.seq), name, leader:actor.id, createdAt:now, privacy: input.privacy === 'invite' ? 'invite' : 'open', invites:[], rallies:[]}
  world.alliances[alliance.id] = alliance
  actor.alliance = alliance.id
  activity(world,'alliance',actor.name + ' founded ' + name + '.',now)
  return alliance
}

export function allianceJoin(world, actor, input, now) {
  requireRule(!actor.alliance,'alliance_exists','Leave your current alliance before joining another.')
  requireRule(!actor.allianceCooldown || actor.allianceCooldown <= now,'alliance_cooldown','There is a transfer cooldown after leaving an alliance.')
  const alliance = getAlliance(world,input.id)
  requireRule(allianceMembers(world,alliance.id).length < 20,'alliance_at_capacity','This alliance already has twenty members.')
  const territories = world.nodes.filter(node => node.owner === actor.id || node.owner && world.cities[node.owner]?.alliance === alliance.id)
  requireRule(territories.length <= balance.allianceTerritoryCap,'alliance_territories','Joining would exceed the alliance’s territory limit.')
  requireRule(alliance.privacy === 'open' || alliance.invites.some(invite => invite.target === actor.id && invite.expiresAt > now),
    'alliance_invite','This alliance needs an invitation.',403)
  actor.alliance = alliance.id
  alliance.invites = alliance.invites.filter(invite => invite.target !== actor.id)
  notify(world,alliance.leader,actor.name + ' joined your alliance.',now,'alliance')
  return alliance
}

export function allianceInvite(world, actor, input, now) {
  requireRule(actor.alliance && getAlliance(world,actor.alliance).leader === actor.id,'alliance_leader','Only the leader can send invitations.',403)
  const target = selectTarget(world,actor,input.target)
  requireRule(!target.alliance,'already_allied','Choose an unallied city.')
  const alliance = getAlliance(world,actor.alliance)
  requireRule(!alliance.invites.some(invite => invite.target === target.id && invite.expiresAt > now),'already_invited','An invitation is already pending.')
  alliance.invites = alliance.invites.filter(invite => invite.expiresAt > now)
  alliance.invites.push({target:target.id, expiresAt:now + DAY})
  return notify(world,target.id,'You have been invited to join ' + alliance.name + '.',now,'alliance')
}

export function allianceLeave(world, actor, now) {
  const alliance = getAlliance(world,actor.alliance)
  requireRule(!world.governance.some(pact => pact.overlord === actor.id && ['active','pending'].includes(pact.status)),
    'protectorates_open','Resolve open protectorates before leaving your alliance.')
  const successor = allianceMembers(world,alliance.id).find(member => member.id !== actor.id && !member.npc)
  if (alliance.leader === actor.id) {
    requireRule(successor || !allianceMembers(world,alliance.id).some(member => member.id !== actor.id),
      'alliance_succession','The alliance requires another human leader before you can leave.')
    if (successor) alliance.leader = successor.id
    else delete world.alliances[alliance.id]
  }
  actor.alliance = null
  actor.allianceCooldown = now + DAY
  for (const [target,intel] of Object.entries(actor.intel)) if (intel.sharedBy) delete actor.intel[target]
  return {alliance:null}
}

const treatyActions = {defense:'Defense Pact', nonaggression:'Nonaggression Pact', ceasefire:'Ceasefire', war:'War Declaration', demand:'Diplomatic Demand', trade:'Trade Accord'}

function recordLegacyDiplomacy(world,source,target,kind,now) {
  const pair=[source.id,target.id].sort().join(':');
  const day=Math.floor(now/DAY);
  for (const city of Object.values(world.cities)) if ([source.id,target.id].includes(city.alliance)) {
    recordGovernmentEvent(world,kind,{actor:city.id,id:`legacy:${pair}:${day}`},now)
  }
}

export function treatyOffer(world, actor, input, now) {
  const source = getAlliance(world,actor.alliance)
  requireRule(source.leader === actor.id,'alliance_leader','Only an alliance leader can issue diplomatic orders.',403)
  const target = getAlliance(world,input.target)
  requireRule(target.id !== source.id && has(treatyActions,input.kind),'invalid_treaty','Choose another alliance and a diplomatic action.',400)
  const pair = world.treaties.filter(treaty => [source.id,target.id].includes(treaty.from) && [source.id,target.id].includes(treaty.to))
  requireRule(!pair.some(treaty => treaty.kind === input.kind && (treaty.status === 'pending' || treaty.status === 'active') && treaty.endsAt > now),
    'treaty_duplicate','This agreement already exists or awaits a response.')
  if (input.kind === 'war') requireRule(!pair.some(item => item.status === 'active' && ['defense','nonaggression','ceasefire'].includes(item.kind) && item.endsAt > now),
    'treaty_conflict','An active defense, ceasefire, or nonaggression treaty prevents a war declaration.')
  if (input.kind === 'nonaggression' || input.kind === 'defense') requireRule(!pair.some(item => item.kind === 'war' && item.status === 'active'),
    'treaty_conflict','Resolve the war with a ceasefire before proposing a defense pact.')
  requireRule(!pair.some(treaty => treaty.kind === input.kind && treaty.createdAt > now - HOUR),'treaty_cooldown','Wait an hour before repeating this proposal.')
  const treaty = {id:'t' + (++world.seq), from:source.id, to:target.id, kind:input.kind,
    name:treatyActions[input.kind], status:input.kind === 'war' ? 'active' : 'pending', createdAt:now, endsAt:now + (input.kind === 'war' ? balance.treatyDuration : DAY)}
  world.treaties.unshift(treaty)
  if (input.kind === 'war') recordLegacyDiplomacy(world,source,target,'war',now)
  notify(world,target.leader,source.name + ' issued a ' + treaty.name.toLowerCase() + '.',now,'diplomacy')
  activity(world,'diplomacy',source.name + ' issued a ' + treaty.name.toLowerCase() + ' to ' + target.name + '.',now)
  return treaty
}

export function treatyResponse(world, actor, input, now) {
  const treaty = world.treaties.find(item => item.id === input.id)
  const own = getAlliance(world,actor.alliance)
  requireRule(treaty && treaty.to === own.id && own.leader === actor.id,'not_treaty_receiver','Only the recipient alliance leader can respond.',403)
  requireRule(treaty.status === 'pending' && treaty.endsAt > now,'treaty_closed','That offer is closed.')
  requireRule(typeof input.accept === 'boolean','invalid_decision','Choose accept or decline.',400)
  const origin = getAlliance(world,treaty.from)
  const rivalWar = world.treaties.some(item => item.kind === 'war' && item.status === 'active' &&
    [treaty.from,treaty.to].includes(item.from) && [treaty.from,treaty.to].includes(item.to))
  requireRule(!input.accept || !rivalWar || !['defense','nonaggression'].includes(treaty.kind),'treaty_conflict','Resolve the active war before accepting a defense or nonaggression treaty.')
  if (input.accept && treaty.kind === 'demand') {
    requireRule(actor.influence >= 5,'influence','Accepting this demand transfers 5 Influence to the requesting commander.')
    actor.influence -= 5
    const sender = getCity(world,origin.leader)
    sender.influence = Math.min(100,sender.influence + 5)
    treaty.settlement = {influence:5,at:now}
  }
  treaty.status = input.accept ? 'active' : 'refused'
  if (input.accept) {
    recordLegacyDiplomacy(world,origin,own,'treaty',now)
    treaty.endsAt = now + balance.treatyDuration
    points(actor,5,'diplomacy',{kind:'diplomacy',ref:'treaty:'+treaty.id})
    actor.reputation = Math.min(100,actor.reputation + 1)
    if (treaty.kind === 'ceasefire') for (const item of world.treaties) if (item.kind === 'war' &&
      [treaty.from,treaty.to].includes(item.to) && [treaty.from,treaty.to].includes(item.from) && item.status === 'active') {
      item.status = 'ended'
      item.endsAt = now
    }
  }
  notify(world,origin.leader,own.name + ' ' + (input.accept ? 'accepted' : 'declined') + ' the ' + treaty.name.toLowerCase() + '.',now,'diplomacy')
  return treaty
}

export function sendAid(world, actor, input, now) {
  const target = selectTarget(world,actor,input.target)
  const isVassal = activeProtectorate(world,target.id)?.overlord === actor.id
  requireRule(actor.alliance && actor.alliance === target.alliance || isVassal || activeTreaty(world,actor,target,['defense','trade']),
    'aid_allies', 'Aid can be sent to members, treaty partners, or your protectorate.')
  requireRule(actor.tutorial && target.tutorial && actor.shieldUntil <= now && target.shieldUntil <= now,'aid_starter','New and shielded settlements cannot send or receive aid.')
  requireRule(resources.includes(input.resource) && Number.isSafeInteger(input.amount) && input.amount >= 10 && input.amount <= 500,
    'invalid_aid','Select a resource and a quantity from 10 to 500.',400)
  const spent = lastDay(actor.aid,now).reduce((sum,event) => sum + event.amount,0)
  const incoming = Object.values(world.cities).reduce((sum,city) => sum + lastDay(city.aid,now).filter(item => item.target === target.id).reduce((subtotal,event) => subtotal + event.amount,0),0)
  requireRule(spent + input.amount <= economy.aidDaily + actor.buildings.alliance * 50 && incoming + input.amount <= economy.aidDaily + target.buildings.alliance * 50,
    'aid_limit','An aid allowance was reached for the rolling day.')
  const reward = {[input.resource]:Math.floor(input.amount * .95)}
  requireRule(stockCapacity(target)[input.resource] - target.resources[input.resource] >= reward[input.resource],'aid_storage_full','The recipient has insufficient warehouse space.')
  subtract(actor,{[input.resource]:input.amount})
  const received = credit(target,reward)[input.resource]
  actor.aid = [...lastDay(actor.aid,now), {target:target.id, amount:input.amount, at:now}]
  notify(world,target.id,actor.name + ' sent ' + received + ' ' + input.resource + ' as aid.',now,'diplomacy')
  return {target:target.id, received}
}

export function rally(world, actor, input, now) {
  const alliance = getAlliance(world,actor.alliance)
  const target = selectTarget(world,actor,input.target)
  alliance.rallies = alliance.rallies.filter(item => item.endsAt > now)
  let rally = alliance.rallies.find(item => item.target === target.id)
  if (!rally) {
    requireRule(alliance.leader === actor.id || actor.buildings.alliance >= 2,'rally_rank','An alliance officer or level 2 hall is required to open a rally.')
    requireRule(alliance.rallies.length < 2,'rally_capacity','The alliance already has two active rallies.')
    rally = {id:'r' + (++world.seq), target:target.id, createdAt:now, endsAt:now + balance.rallyDuration, participants:[]}
    alliance.rallies.unshift(rally)
  }
  requireRule(!rally.participants.includes(actor.id),'rally_joined','You already joined this rally.')
  rally.participants.push(actor.id)
  for (const city of allianceMembers(world,alliance.id)) if (city.id !== actor.id) notify(world,city.id,actor.name + ' joined the rally for ' + target.name + '.',now,'alliance')
  return rally
}
