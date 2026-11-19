import {DAY, HOUR, buildings, economy, resources} from '../../config/economy.mjs'
import {balance, factions, terrains} from '../../config/balance.mjs'
import {clamp} from './combat.mjs'
import {GameError, activeProtectorate, activeTreaty, allianceMembers, attackEligibility, cleanName, combatPower, config, createWorld,
  getCity, has, lastDay, productionPerHour, protectorateEligibility, quoteUpgrade, rankings, requireRule, addPlayer} from './world.mjs'
import {advance, collect, convenience, dailyReward, market, research, train, upgrade} from './economy.mjs'
import {counterspy, launchMission, raid, selection, shareIntel} from './military.mjs'
import {ensureTerritories, territoryCommand} from './territories.mjs'
import {kingdom} from './treasury.mjs'
import {governmentState, governmentCommand, isGovernmentAction, recordGovernmentEvent} from './government.mjs'
import {diplomacySnapshot, diplomacyCommand} from './diplomacy.mjs'
import {politicalTradeSnapshot, politicalTradeCommand} from './political-trade.mjs'
import {allianceCreate, allianceInvite, allianceJoin, allianceLeave, launchRebellion, prepareRebellion, propose, rally, release, respond, respondRebellion,
  sendAid, supportRebellion, treatyOffer, treatyResponse} from './politics.mjs'
import {buildingEffects, enemyObservation, kingdomStats} from './stats.mjs'
import {commanderCommand, commanderProgressionTypes} from './progression.mjs'
import {onboardingSnapshot, recordOnboardingOrder, startOnboarding, tutorialCommand} from './onboarding.mjs'
import {atlasView, settlementRegion} from './frontier-layout.mjs'
import {expeditionEligibility, expeditionRules, launchExpedition, npcEnvoyEligibility, npcProfile, sendNpcEnvoy} from './npc.mjs'
import { NETWORK_LABEL } from '../../config/network.mjs';
export {GameError, addPlayer, advance, attackEligibility, combatPower, createWorld, productionPerHour, protectorateEligibility, quoteUpgrade}
export {simulateBattle} from './combat.mjs'
export {attackPreview} from './stats.mjs'

const paidTypes = new Set(['rush','premium','attack-paid','protectorate','political-operation','political-escrow'])

function publicCity(world, city, actor, now) {
  const ally = actor.id === city.id || actor.alliance && actor.alliance === city.alliance
  const power = combatPower(city)
  const displayedPower = ally ? power : Math.round(power / 25) * 25
  const intel = actor.intel[city.id]
  const observation=enemyObservation(city,actor,now)
  const rules=({allowed,reason,code,ratio})=>({ok:allowed,allowed,reason,code,...(ally && {ratio})})
  const politics = activeProtectorate(world,city.id)
  return {
    id:city.id, name:city.name, owner:city.owner, faction:city.faction, alliance:city.alliance, x:city.x, y:city.y, region:settlementRegion(city), terrain:city.terrain,
    terrainName:terrains[city.terrain].name, npc:city.npc, level:city.buildings.hall, shieldUntil:city.shieldUntil, power:displayedPower,
    powerRange:[Math.floor(displayedPower * .9 / 10) * 10,Math.ceil(displayedPower * 1.1 / 10) * 10], defense:observation.defense,
    garrison:observation.army,optIn:city.optIn,powerEstimate:!ally,battleIntel:observation,
    eligibility:rules(attackEligibility(world,actor,city,now)),protectorateEligibility:rules(protectorateEligibility(world,actor,city,now)),
    intel:intel ? {...intel, stale:intel.expiresAt <= now} : null,
    ...(city.npc && {npcProfile:npcProfile(city), expedition:expeditionEligibility(world,actor,city,now),
      npcEnvoy:npcEnvoyEligibility(world,actor,city,now)}),
    protectorate:politics ? {id:politics.id, overlord:politics.overlord, endsAt:politics.endsAt, status:politics.status} : null
  }
}

export function snapshot(world, actorId, now = world.now) {
  const actor = getCity(world,actorId)
  const cities = Object.values(world.cities).map(city => publicCity(world,city,actor,now))
  const displayPower=(power,id,alliance)=>id===actor.id || actor.alliance&&actor.alliance===alliance ? power : Math.round(power/25)*25
  const displayRankings=rows=>rows.map(row=>({...row,power:displayPower(row.power,row.id,row.alliance)}))
  const alliances = Object.values(world.alliances).map(alliance => {
    const members = allianceMembers(world,alliance.id).map(member => ({
      id:member.id,name:member.owner,city:member.name,faction:member.faction,score:member.score,power:displayPower(combatPower(member),member.id,member.alliance),npc:member.npc,
      role:member.id === alliance.leader ? 'leader' : 'member'
    }))
    return {id:alliance.id,name:alliance.name,leader:alliance.leader,privacy:alliance.privacy,members,
      power:members.reduce((sum,member) => sum + member.power,0), score:members.reduce((sum,member) => sum + member.score,0),
      rallies:actor.alliance === alliance.id ? alliance.rallies.filter(item => item.endsAt > now) : [],
      invited:alliance.invites.some(invite => invite.target === actor.id && invite.expiresAt > now)}
  })
  const own = cities.find(city => city.id === actorId)
  const stats=kingdomStats(world,actor,now)
  const player = {...own, resources:actor.resources, buildings:actor.buildings, troops:actor.troops, hero:actor.hero, tactic:actor.tactic, formation:actor.formation,
    tech:actor.tech, queue:actor.queue, history:actor.history, perks:actor.perks, rushCredits:actor.rushCredits || {}, achievements:actor.achievements || {},
    settings:Object.fromEntries(Object.entries(actor.settings || {}).filter(([name]) => ['muted','musicVolume','sfxVolume','reducedMotion','highContrast'].includes(name))),
    scoutPoints:actor.scoutPoints, spies:actor.spies, counterspyUntil:actor.counterspyUntil, counterspyCooldown:actor.counterspyCooldown,
    sabotageUntil:actor.sabotageUntil, reputation:actor.reputation, influence:actor.influence, score:actor.score, contribution:actor.contribution,
    tutorial:actor.tutorial, guideOpen:actor.tutorialOpen ?? !actor.tutorial, onboarding:onboardingSnapshot(actor), collectAvailableAt:actor.lastCollect ? actor.lastCollect + DAY : 0, immunityUntil:actor.immunityUntil,
    dailyReward:dailyReward(actor,now), marketHistory:actor.marketHistory ?? [],
    founding:!!actor.founding, production:stats.economy.production,capacity:stats.economy.capacity,troopCapacity:stats.military.capacity,stats,
    attacksLeft:Math.max(0,balance.attacksDaily - world.marches.filter(march => (march.attacker===actor.id || march.contributors?.includes(actor.id)) && march.kind === 'raid' && march.at > now - DAY).length),
    paidConvenienceLeft:Math.max(0,economy.paidConvenienceDaily - lastDay(actor.conveniences,now).length),
    upgrades:Object.fromEntries(Object.keys(buildings).map(key => [key,{...quoteUpgrade(actor,key,now),effects:buildingEffects(world,actor,key,now)}]))}
  const politics = world.governance.flatMap(pact => {
    const defender = getCity(world,pact.defender)
    const ally = actor.id !== pact.overlord && (actor.alliance && actor.alliance === defender.alliance || activeTreaty(world,actor,defender,['defense']))
    if (actor.id !== pact.overlord && actor.id !== pact.defender && !ally) return []
    const covert = pact.rebellion?.status === 'preparing' && actor.id === pact.overlord
    return [{...pact, rebellion:covert ? null : pact.rebellion}]
  }).slice(0,45)
  const messages = world.chat.filter(message => message.channel === 'world' || message.alliance && actor.alliance === message.alliance).slice(0,80)
  const ownBattles = world.battles.filter(item => [item.attacker,item.defender].includes(actor.id) &&
    (!item.politicalConflict || ['resolved','cancelled'].includes(world.government?.conflicts?.[item.politicalConflict]?.status)))
  const diplomacy=diplomacySnapshot(world,actorId,now)
  const {history:tradeHistory,...trade}=politicalTradeSnapshot(world,actorId,now)
  return {now, player,cities,atlas:atlasView(world,actor),targets:cities.filter(city => city.id !== actorId), nodes:world.nodes,
    config:{...config,expeditionRules}, alliances,
    government:governmentState(world,actorId,now),diplomacy:{...diplomacy,...trade,history:[...diplomacy.history,...tradeHistory].sort((a,b)=>b.at-a.at).slice(0,160)},
    alliance:alliances.find(item => item.id === actor.alliance) || null, treaties:world.treaties.filter(item => item.kind === 'war' ||
      item.status === 'active' || [item.from,item.to].includes(actor.alliance)), messages, activity:world.activity,
    battles:ownBattles.slice(0,30), marches:world.marches.filter(march => march.endsAt > now), politics, notifications:(world.notifications[actorId] || []).slice(0,60),
    missions:world.missions.filter(mission => mission.actor === actor.id).slice(0,25), intel:actor.intel, intelArchive:actor.intelArchive,
    season:world.season, archive:world.archive.slice(0,10).map(row=>({...row,rankings:displayRankings(row.rankings??[])})), rankings:displayRankings(rankings(world))}
}

function postChat(world, city, input, now) {
  const channel = input.channel ?? 'world'
  requireRule(['world','alliance'].includes(channel),'invalid_channel','Choose the world or alliance channel.',400)
  requireRule(channel !== 'alliance' || city.alliance,'alliance_required','Join an alliance to send messages here.')
  requireRule(!city.lastChat || city.lastChat <= now - balance.chatThrottle,'chat_throttle','Wait before posting again.',429)
  const text = typeof input.text === 'string' ? input.text.trim().replace(/[\x00-\x1f\x7f]/g,' ') : ''
  requireRule(text.length > 0 && text.length <= 300,'invalid_message','Messages can have between 1 and 300 characters.',400)
  city.lastChat = now
  const message = {id:'c' + (++world.seq),actor:city.id,name:city.owner,city:city.name,faction:city.faction,text,channel,at:now,alliance:channel === 'alliance' ? city.alliance : null}
  world.chat.unshift(message)
  world.chat.length = Math.min(world.chat.length,250)
  return message
}

function updateProfile(world, city, input, now) {
  if (input.type === 'found') {
    requireRule(city.founding,'founding_closed','This city has already been founded.')
    const name = cleanName(input.cityName)
    const owner = cleanName(input.name,city.owner)
    requireRule(name && has(factions,input.faction),'invalid_founding','Choose a city name and faction.',400)
    city.name = name
    city.owner = owner
    city.faction = input.faction
    city.founding = false
    startOnboarding(city,now)
    const homeland = ensureTerritories(world,now).find(site => site.id === 'starter-' + city.id)
    homeland.name = name + ' Homelands'
    return {id:city.id,name,owner,faction:city.faction}
  }
  const settings = city.settings ||= {}
  delete settings.language
  for (const setting of ['musicVolume','sfxVolume']) {
    if (Number.isSafeInteger(input[setting]) && input[setting] >= 0 && input[setting] <= 100) settings[setting] = input[setting]
  }
  for (const setting of ['muted','reducedMotion','highContrast']) if (typeof input[setting] === 'boolean') settings[setting] = input[setting]
  return settings
}

function enroll(world, city, input, now) {
  requireRule(typeof input.enabled === 'boolean','invalid_consent','Seasonal PvP needs an explicit consent choice.',400)
  requireRule(!input.enabled || city.tutorial,'tutorial_required','Complete the tutorial before entering seasonal PvP.')
  if (!input.enabled) {
    requireRule(kingdom.balance(world,city.id,now).atRiskSatoshis === 0,'kingdom_committed',
      'Release your committed kingdom funds before leaving seasonal PvP.')
    requireRule(!(world.territories ?? []).some(site => ['open','locked'].includes(site.claim?.status) &&
      site.claim.entries.some(entry => entry.player === city.id)),'territory_contest_active',
      'Wait for your territorial contest to resolve before leaving seasonal PvP.')
    requireRule(!world.governance.some(item => [item.overlord,item.defender].includes(city.id) &&
      ['pending','active'].includes(item.status)),'pact_blocks_opt_out','Resolve your protectorate before leaving seasonal PvP.')
    requireRule(!world.marches.some(item => [item.attacker,item.defender].includes(city.id) && item.at > now - HOUR),
      'active_combat','Wait one hour after the latest battle before leaving seasonal PvP.')
  }
  city.optIn = input.enabled
  return {optIn:city.optIn}
}

export function command(world, actorId, input, now = world.now, options = {}) {
  const result = applyCommand(world,actorId,input,now,options)
  if (input.type === 'tutorial' && input.action === 'practice') return result
  const actor = getCity(world,actorId)
  actor.lastActionAt = now
  recordOnboardingOrder(actor,input)
  if (result?.winner && result.kind==='raid') {
    recordGovernmentEvent(world,result.winner==='attacker'?'raid-win':'raid-loss',
      {actor:result.attacker,target:result.defender,id:result.id},now)
  }
  return result
}

function applyCommand(world,actorId,input,now,options) {
  const actor = getCity(world,actorId)
  requireRule(!actor.npc,'npc_actor','NPC settlements are controlled by the simulation.',403)
  requireRule(input && typeof input === 'object' && typeof input.type === 'string','invalid_command','Choose a valid command.',400)
  if (now !== world.now) advance(world,now)
  if (paidTypes.has(input.type)) requireRule(options.paid === true,'payment_required','This action requires an independently verified ' + NETWORK_LABEL + ' receipt.',402)
  if (commanderProgressionTypes.has(input.type)) return commanderCommand(world,actor,input,now)
  if (isGovernmentAction(input.type)) return governmentCommand(world,actorId,input,now)
  if (input.type.startsWith('diplomacy-')) {
    const result=diplomacyCommand(world,actorId,input,now) ?? politicalTradeCommand(world,actorId,input,now)
    requireRule(result!==undefined,'invalid_command','Choose a valid diplomatic command.',400)
    return result
  }
  switch (input.type) {
    case 'upgrade': return upgrade(world,actor,input,now)
    case 'premium':
    case 'rush': return convenience(world,actor,input,now)
    case 'train': return train(world,actor,input,now)
    case 'configure': {
      const positioning = selection(actor,input,now)
      Object.assign(actor,positioning)
      return positioning
    }
    case 'research': return research(world,actor,input,now)
    case 'collect': return collect(world,actor,now)
    case 'trade': return market(actor,input,now)
    case 'tutorial': return tutorialCommand(world,actor,input,now)
    case 'opt-in': return enroll(world,actor,input,now)
    case 'found':
    case 'settings': return updateProfile(world,actor,input,now)
    case 'scout': return launchMission(world,actor,input,now)
    case 'counterspy': return counterspy(world,actor,now)
    case 'share-intel': return shareIntel(world,actor,input,now)
    case 'attack':
    case 'attack-paid': return raid(world,actor,input,now,input.type === 'attack-paid')
    case 'expedition': return launchExpedition(world,actor,input,now)
    case 'npc-envoy': return sendNpcEnvoy(world,actor,input,now)
    case 'protectorate': return propose(world,actor,input,now)
    case 'respond': return respond(world,actor,input,now)
    case 'rebellion-prepare': return prepareRebellion(world,actor,input,now)
    case 'rebellion-support': return supportRebellion(world,actor,input,now)
    case 'rebel': return launchRebellion(world,actor,input,now)
    case 'rebellion-respond': return respondRebellion(world,actor,input,now)
    case 'release': return release(world,actor,input,now)
    case 'alliance-create': return allianceCreate(world,actor,input,now)
    case 'alliance-join': return allianceJoin(world,actor,input,now)
    case 'alliance-invite': return allianceInvite(world,actor,input,now)
    case 'alliance-leave': return allianceLeave(world,actor,now)
    case 'treaty': return treatyOffer(world,actor,input,now)
    case 'treaty-respond': return treatyResponse(world,actor,input,now)
    case 'aid': return sendAid(world,actor,input,now)
    case 'rally': return rally(world,actor,input,now)
    case 'chat': return postChat(world,actor,input,now)
    case 'claim-node': throw new GameError('territory_contest_required','Enter a verified ' + NETWORK_LABEL + ' territory claim from the campaign map.',402)
    case 'territory-garrison':
    case 'frontier-conquest':
    case 'territory-aid':
    case 'territory-abandon':
    case 'territory-fortify': return territoryCommand(world,actorId,input,now)
    default: throw new GameError('unknown_command','That game command is unavailable.',400)
  }
}

export function quote(world, actorId, input, now = world.now) {
  requireRule(input && paidTypes.has(input.type),'bad_payment_action','Select a supported paid action.',400)
  const clone = structuredClone(world)
  let title, description, satoshis, action
  if (input.type === 'rush' || input.type === 'premium') {
    const profile = has(buildings,input.building) ? buildings[input.building] : null
    requireRule(profile,'invalid_building','Select a valid building.',400)
    action = {type:input.type,building:input.building}
    title = input.type === 'rush' ? 'Rush ' + profile.name : profile.name + ' premium upgrade'
    description = input.type === 'rush' ? 'Halves remaining build time, or stores a single-use rush for the next eligible upgrade if construction is idle when payment confirms.' : profile.premium
    satoshis = economy.fees[input.type]
  } else {
    const actor = getCity(clone,actorId)
    const target = getCity(clone,input.target)
    action = input.type === 'attack-paid' ? {type:input.type,target:target.id,...selection(actor,input,now)} : {type:input.type,target:target.id}
    title = input.type === 'attack-paid' ? 'Paid raid on ' + target.name : 'Protectorate offer to ' + target.name
    description = input.type === 'attack-paid' ? 'Initiates one eligible standard raid under the seasonal cap. Loot consists of earned resources.' :
      'Pays a fixed 24,000-satoshi proposal fee. The defender may accept, decline, or resist. A protectorate grants a limited earned resource tribute for up to 48 hours.'
    satoshis = input.type === 'attack-paid' ? economy.fees.attack : economy.fees.protectorate
  }
  command(clone,actorId,action,now,{paid:true})
  return {title,description,satoshis,action,target:action.target,building:action.building}
}
