import {randomBytes} from 'node:crypto'
import {DAY, HOUR, MINUTE, buildings, economy, resources, starterResources, production, startingCapacity, tech} from '../../config/economy.mjs'
import {balance, counters, factions, formations, heroes, missions, tactics, terrains, units} from '../../config/balance.mjs'
import {commanderRules, fieldDoctrine} from '../../config/progression.mjs'
import {armyPower, clamp, seeded, troopTotal, unitIds} from './combat.mjs'
import {diplomacyRelationship} from './diplomacy.mjs'
import {governmentCommander,governmentMorale} from './government.mjs'
import {battleCommander, commanderEffects, newCommanderBook, ruleClock} from './progression.mjs'
import {allocateSettlementPlot, frontierWarden} from './frontier-layout.mjs'

export const mapResources = map => Object.fromEntries(resources.map((resource, index) => [resource, map(resource, index)]))
export const has = (table, id) => typeof id === 'string' && Object.hasOwn(table, id)
export const roundCost = (base, growth = 1) => mapResources((_, index) => Math.ceil(base[index] * growth))
export const human = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(id) && !['__proto__','constructor','prototype'].includes(id)

export class GameError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'GameError'
    this.code = code
    this.status = status
  }
}

export function requireRule(condition, code, message, status) {
  if (!condition) throw new GameError(code, message, status)
}

export const config = {resources, buildings, units, heroes, tactics, formations, tech, missions, factions, terrains, counters, fees: economy.fees, rules: balance,
  economy: {levelMax: economy.levelMax, protectorateTribute: economy.protectorateTribute, protectorateTerm: economy.protectorateTerm,
    protectorateResponseTime: economy.protectorateResponseTime, rebellionPrepTime: economy.rebellionPrepTime, rushOneConfirmationBelow: economy.rushOneConfirmationBelow}}

export const getCity = (world, id) => {
  requireRule(human(id) && has(world.cities, id), 'city_missing', 'That city could not be found.', 404)
  return world.cities[id]
}

export const getAlliance = (world, id) => {
  requireRule(has(world.alliances, id), 'alliance_missing', 'That alliance could not be found.', 404)
  return world.alliances[id]
}

export const subtract = (city, cost) => {
  requireRule(resources.every(resource => city.resources[resource] >= (cost[resource] || 0)), 'insufficient_resources', 'There are insufficient earned resources for this action.')
  for (const resource of resources) city.resources[resource] -= cost[resource] || 0
}

export function stockCapacity(city,now=ruleClock(city)) {
  const storage=1+(commanderEffects(city,city.hero,now).storageBonus??0)
  return mapResources(resource => Math.floor(startingCapacity[resource] * (1 + (city.buildings.vault - 1) * economy.vaultCapacityRate) * storage))
}

export function creditableResources(city, reward, now=ruleClock(city)) {
  const cap = stockCapacity(city,now)
  return mapResources(resource => Math.max(0, Math.min(reward[resource] || 0, cap[resource] - city.resources[resource])))
}

export function credit(city, reward, now=ruleClock(city)) {
  const received = creditableResources(city,reward,now)
  for (const resource of resources) city.resources[resource] += received[resource]
  return received
}

export function productionPerHour(city, now = Date.now(), government = 1, committedTroops=0) {
  const farm = 1 + (city.buildings.farm - 1) * economy.farmRate
  const logistics = 1 + city.tech.logistics * .06
  const sabotage = city.sabotageUntil > now ? .85 : 1
  const population = troopTotal(city.troops)+committedTroops
  return mapResources(resource => Math.max(0, Math.round(production[resource] * farm * logistics * sabotage * government -
    (resource === 'food' ? population * economy.maintenance : 0))))
}

export function powerBreakdown(city) {
  const rosterPower=armyPower(city.troops)*(1+city.tech.tactics*.02)
  const fortificationPower=(city.buildings.walls+city.tech.fortification)*50
  const infrastructurePower=city.buildings.hall*25
  return {rosterPower,fortificationPower,infrastructurePower,matchmakingPower:Math.round(rosterPower+fortificationPower+infrastructurePower)}
}
export const combatPower = city => powerBreakdown(city).matchmakingPower
export const troopCap = city => 100 + (city.buildings.barracks - 1) * 34
export const trainingSlots=city=>city.buildings.barracks>=4?2:1
export const trainingTimeFactor=city=>Math.max(.7,1-(city.buildings.barracks-1)*.04)
export const marketRate=(city,now=ruleClock(city))=>Math.min(.86,economy.marketRate+.02*(city.buildings.market-1)+(commanderEffects(city,city.hero,now).marketBonus??0))
export const constructionTimeFactor=(city,now=ruleClock(city))=>Math.max(.72,1-.035*(city.buildings.workshop-1))*(1-(commanderEffects(city,city.hero,now).constructionReduction??0))
export const aidAllowance=city=>economy.aidDaily+city.buildings.alliance*50
export const currentTactic = (city, world, now=world?.now ?? ruleClock(city), selected=city.hero, fieldRules=fieldDoctrine.version) => ({troops: {...city.troops},
  ...battleCommander(city,world ? governmentCommander(world,city.id,selected,now) : selected,now),
  ...(fieldRules===fieldDoctrine.version && {fieldRules}),
  tactic: city.tactic, formation: city.formation, tech: {...city.tech}, wall: city.buildings.walls + city.tech.fortification,
  ...(world && {politicalMorale:governmentMorale(world,city.id,now)})})
// Every score change is also queued as a season score event. When the world is saved, the server seals queued events
// into the season's public, hash-chained score journal, from which anyone can recompute the standings.
// `evidence` names what earned the points (`kind`) and the record that proves it (`ref`), where one exists.
export const points = (city, amount, category = 'participation', evidence) => {
  city.score += amount
  city.contribution[category] = (city.contribution[category] || 0) + amount
  // `since` and `until` are the game times between which the scored work ran (a construction, a research, a mission).
  // A verifier checks them against the durations the public rules give and against the one-at-a-time queues.
  ;(city.scoreEvents ||= []).push({ amount, category, kind: evidence?.kind ?? category, ...(evidence?.ref !== undefined && { ref: String(evidence.ref) }),
    ...(Number.isFinite(evidence?.since) && Number.isFinite(evidence?.until) && { since: evidence.since, until: evidence.until }), ...(evidence?.rushed && { rushed: true }) })
}
export const award = (city, milestone, now) => {
  const achievements = city.achievements ||= {}
  achievements[milestone] ??= now
}

export function quoteUpgrade(city, building, now=ruleClock(city)) {
  requireRule(has(buildings, building), 'invalid_building', 'Select a valid building.', 400)
  const level = city.buildings[building]
  const profile = buildings[building]
  const cost = roundCost(profile.cost, economy.upgradeCurve ** (level - 1))
  const duration = Math.round(profile.time * (level > 1 ? economy.buildTimeScale ?? 1 : 1) * economy.buildTimeCurve ** (level - 1) *
    constructionTimeFactor(city,now))
  return {building, name: profile.name, level, nextLevel: Math.min(level + 1, economy.levelMax), cost, duration,
    eligible: level < economy.levelMax && (building === 'hall' || level < city.buildings.hall),
    reason: level >= economy.levelMax ? 'Maximum building level reached.' : building !== 'hall' && level >= city.buildings.hall ? 'Upgrade City Hall first.' : ''}
}

export function notify(world, cityId, text, now, kind = 'system', details = {}) {
  const entry = {...details, id: 'n' + (++world.seq), text, at: now, kind}
  const list = world.notifications[cityId] ||= []
  list.unshift(entry)
  list.length = Math.min(list.length, 75)
  return entry
}

export function activity(world, type, text, now, extra = {}) {
  const entry = {id: 'e' + (++world.seq), type, text, at: now, ...extra}
  world.activity.unshift(entry)
  world.activity.length = Math.min(world.activity.length, 150)
  return entry
}

export function newCity({id, name, cityName, faction, x, y, region, npc = false, terrain = 'plains', troopScale = .55, shields = true, level = 1}, now) {
  const baseline = {infantry: 36, shield: 17, archer: 25, cavalry: 12, siege: 5, mage: 5}
  const city = {id, owner: name, name: cityName, faction, x, y, ...(region && {region}), terrain, npc, alliance: null,
    resources: {...starterResources}, remainders: mapResources(() => 0), warehouseAt: now, buildings: Object.fromEntries(Object.keys(buildings).map(key => [key, level])),
    troops: Object.fromEntries(unitIds.map(unit => [unit, Math.floor(baseline[unit] * troopScale)])), hero: 'warden', tactic: 'balanced', formation: 'line',
    tech: Object.fromEntries(Object.keys(tech).map(key => [key, 0])), queue: [], history: [], perks: {}, shieldUntil: shields ? now + economy.starterShield : 0,
    scoutPoints: balance.scoutPoints, scoutAt: now, spies: 3, spyRecovery: [], intel: {}, intelArchive: [], lastScout: {}, sabotageUntil: 0,
    sabotageCooldown: 0, counterspyUntil: 0, counterspyCooldown: 0, decoyUntil: 0, intelShared: {}, immunityUntil: 0, optIn: !shields, tutorial: !shields,
    score: 0, contribution: {}, reputation: 50, influence: 10, attacks: [], aid: [], conveniences: [], lastChat: 0, lastCollect: 0}
  return city
}

const citySeeds = [
  ['Riverhold','Warden','emerald',.29,.25,'river',.91,false],
  ['Ironhaven','Blackthorn','crimson',.57,.46,'plains',.79,false],
  ['Northcrest','Aster','emerald',.44,.16,'forest',.94,false],
  ['Stonevale','Lady Sable','violet',.53,.72,'hills',.42,false],
  ['Lakespire','Rowan','azure',.27,.60,'coast',.79,true],
  ['Embergate','Ardent','crimson',.73,.35,'hills',.97,true],
  ['Sandcrest','Dune Marshal','crimson',.72,.72,'desert',.75,true],
  ['Millbrook','Merchant Guild','gold',.37,.77,'plains',.42,true],
  ['Imperial Palace','Regent','gold',.63,.15,'hills',1.45,true],
  ['Frostwatch','The Pale Guard','azure',.22,.13,'hills',.8,true],
  ['Duskmarket','Free Traders','violet',.75,.55,'forest',.58,true],
  ['Pinegate','Ashwood Guard','emerald',.38,.42,'forest',.72,true],
  ['Oakmere','Trident Guild','azure',.23,.77,'coast',.8,true],
  ['Cinderwall','Kestrel','crimson',.63,.85,'hills',.91,true],
  ['Starfall','Observatory','violet',.77,.20,'coast',.84,true],
  ['Dawnport','Golden Fleet','gold',.43,.59,'river',.61,true]
]

const retiredSeeds = new Set(['p5','p7','p11','p13','p14','p15','p16'])
export const retiredPlots = citySeeds.filter((seed, index) => retiredSeeds.has('p' + (index + 1))).map(seed => [seed[3], seed[4]])

export function createWorld(now = Date.now()) {
  const world = {version: 1, seed: 'dominion-frontier-v1', secret: randomBytes(32).toString('hex'), now, seq: 0, shieldsLifted: true, npcRoster: 5, cities: {}, alliances: {},
    notifications: {}, chat: [], activity: [], battles: [], marches: [], governance: [], treaties: [], missions: [],
    season: {number: 1, name: 'The Emerald Frontier', startedAt: now, endsAt: now + economy.seasonLength}, archive: [],
    nodes: [
      {id: 'mine', name: 'Silver Mine', x: .44, y: .32, type: 'mine', resource: 'iron'},
      {id: 'watch', name: 'Raven Watch', x: .55, y: .27, type: 'watchtower', resource: 'stone'},
      {id: 'trade', name: 'King’s Crossing', x: .40, y: .67, type: 'trade-post', resource: 'food'},
      {id: 'fort', name: 'Dawn Bastion', x: .65, y: .51, type: 'fortress', resource: 'wood'},
      {id: 'ruins', name: 'Oracle Ruins', x: .65, y: .65, type: 'ruins', resource: 'crystal'},
      {id: 'capital', name: 'Imperial Gate', x: .58, y: .19, type: 'capital', resource: 'stone'}
    ]}
  for (const [index, seed] of citySeeds.entries()) {
    const [cityName,name,faction,x,y,terrain,troopScale,npc] = seed
    const id = 'p' + (index + 1)
    // Seven of the twelve NPC kingdoms were retired (npc-roster.mjs); their places are the first plots for new players.
    if (retiredSeeds.has(id)) continue
    const level = id === 'p9' ? 4 : ['p1','p2','p3','p5','p6','p15'].includes(id) ? 2 : 1
    const city = newCity({id,name,cityName,faction,x,y,terrain,troopScale,npc,level,shields:false}, now)
    if (id === 'p1') {
      city.score = 0
      city.influence = 35
      city.tutorial = false
    }
    world.cities[id] = city
    if (faction === 'emerald') city.alliance = 'emerald-watch'
    if (faction === 'crimson') city.alliance = 'crimson-legion'
  }
  world.alliances['emerald-watch'] = {id: 'emerald-watch', name: 'Emerald Watch', leader: 'p1', createdAt: now, privacy: 'open', invites: [], rallies: []}
  world.alliances['crimson-legion'] = {id: 'crimson-legion', name: 'Crimson Legion', leader: 'p2', createdAt: now, privacy: 'open', invites: [], rallies: []}
  activity(world, 'season', 'Season I opens. The Imperial Gate is unclaimed.', now)
  activity(world, 'world', 'Raven Watch scouts sighted movement near Ironhaven.', now)
  return world
}

export function addPlayer(world, input, now = world.now) {
  requireRule(human(input.id), 'bad_player', 'Invalid player identifier.', 400)
  if (has(world.cities, input.id)) return world.cities[input.id]
  // A kingdom that chose no name gets its own: a commander and a city name no other kingdom uses.
  const named = kingdomNames(world, input.id)
  const playerName = cleanName(input.name, named.owner)
  const cityName = cleanName(input.cityName ?? input.name, named.name)
  const faction = has(factions, input.faction) ? input.faction : 'emerald'
  const {plot,opened} = allocateSettlementPlot(world)
  const district = seeded(world.seed + ':' + plot.x + ':' + plot.y)
  const terrain = Object.keys(terrains)[Math.floor(district() * Object.keys(terrains).length)]
  if (opened) {
    const base = frontierWarden(opened).id
    let candidate = base
    for (let suffix = 2; candidate === input.id || has(world.cities,candidate); suffix++) candidate = base + '-' + suffix
    if (candidate !== base) opened.wardenId = candidate
    const guard = frontierWarden(opened)
    world.cities[guard.id] = newCity(guard,now)
  }
  const city = newCity({id: input.id, name: playerName, cityName, faction, ...plot, terrain}, now)
  city.founding = true
  city.pendingOnboarding = true
  city.commanders = newCommanderBook()
  openFromDayOne(city)
  world.cities[input.id] = city
  notify(world, input.id, 'Your kingdom is ready. Every operation is open from the first day; the guide is there if you want it.', now)
  return city
}

// A new kingdom has no starter shield and is in the season from its first day. The Warden King leads its army; every
// other commander is hired for 1, 3 or 7 days or recruited permanently, both with earned supplies, from the first day.
// The guide stays available and still pays its reward, but nothing waits for it (`tutorialOpen` marks a guide not yet
// finished). Applied once per kingdom, also to kingdoms created under the earlier rules.
export function openFromDayOne(city, world, now = world?.now ?? 0) {
  if (city.npc) return city
  // The first version of these rules handed every commander to a new kingdom, which left nothing to hire. Those handed
  // out are taken back once (a commander recruited with supplies records when, and is kept); the kingdom is told.
  if (city.dayOne && city.dayOneRoster !== 2) {
    let taken = 0
    for (const [id, row] of Object.entries(city.commanders?.roster ?? {})) {
      if (commanderRules.baseline.includes(id) || !row.permanent || row.recruitedAt) continue
      delete row.permanent
      taken++
    }
    city.dayOneRoster = 2
    if (taken && world) notify(world, city.id, 'Commanders are hired or recruited again. The Warden King leads your army; hire any other commander for 1, 3 or 7 days, or recruit one permanently, in Commanders.', now, 'army', {title: 'Commanders for hire'})
    return city
  }
  if (city.dayOne || !(city.pendingOnboarding || city.onboarding || city.commanders?.legacy === false)) return city
  city.dayOne = true
  city.dayOneRoster = 2
  if (!city.tutorial) { city.tutorial = true; city.tutorialOpen = true }
  city.optIn = true
  city.shieldUntil = 0
  city.commanders ??= newCommanderBook()
  return city
}

const cityStarts = ['Block','Cash','Chain','Coin','Hash','Ledger','Mint','Node','Satoshi','Token','Amber','Ash','Bright','Copper','Dawn',
  'Elder','Ember','Frost','Gold','Hawk','High','Iron','Lion','Moon','North','Oak','Raven','River','Silver','Stone','Storm','Sun','Wolf']
const cityEnds = ['brook','crest','dale','fall','ford','gate','guard','haven','hold','hollow','keep','mere','moor','reach','ridge',
  'shire','spire','stead','vale','watch','wick']
const givenNames = ['Aldric','Anya','Bastian','Brenna','Cassian','Cora','Darius','Elara','Edric','Freya','Gideon','Helena','Ivo','Isolde',
  'Jorah','Kael','Lyra','Magnus','Mira','Nadia','Orin','Petra','Quinn','Roran','Sabine','Talia','Ulric','Vera','Wren','Yara','Zane','Rowan']
const epithets = ['the Miner','the Validator','the Cashbearer','the Blockwright','the Bold','the Steadfast','the Wise','the Swift','the Brave',
  'the Just','the Wary','the Bright','the Patient','the Keen','the Proud','the Free']
export const placeholderNames = {owner: 'New Commander', name: 'New Settlement'}

// A city and a commander name, picked from the kingdom's own id and the world's seed and checked against every
// other kingdom, so no two kingdoms share one.
export function kingdomNames(world, id) {
  const taken = new Set(Object.values(world.cities).filter(city => city.id !== id).flatMap(city => [city.name, city.owner])
    .filter(Boolean).map(name => name.toLowerCase()))
  const random = seeded(String(world.seed) + ':names:' + id)
  const gcd = (a, b) => b ? gcd(b, a % b) : a
  const pick = (make, size) => {
    const start = Math.floor(random() * size)
    // A stride that shares no factor with the size visits every name once before any repeats.
    const stride = [13, 17, 19, 23, 29].find(prime => gcd(prime, size) === 1)
    for (let round = 0; ; round++) {
      for (let step = 0; step < size; step++) {
        const name = make((start + step * stride) % size) + (round ? ' ' + (round + 1) : '')
        if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name }
      }
    }
  }
  const name = pick(at => cityStarts[at % cityStarts.length] + cityEnds[Math.floor(at / cityStarts.length)], cityStarts.length * cityEnds.length)
  const owner = pick(at => givenNames[at % givenNames.length] + ' ' + epithets[Math.floor(at / givenNames.length)], givenNames.length * epithets.length)
  return {name, owner}
}

// Kingdoms created before names were picked are still called New Settlement. Only those are renamed, once; their
// commander too if it still has the placeholder name. A name the player chose is never changed.
export function replacePlaceholderNames(world, city) {
  if (city.npc || city.name !== placeholderNames.name) return city
  const named = kingdomNames(world, city.id)
  city.name = named.name
  const homeland = world.territories?.find(site => site.id === 'starter-' + city.id)
  if (homeland?.name === placeholderNames.name + ' Homelands') homeland.name = named.name + ' Homelands'
  if (city.owner === placeholderNames.owner) city.owner = named.owner
  return city
}

export function cleanName(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/\s+/g, ' ')
  requireRule(trimmed.length >= 2 && trimmed.length <= 30 && /^[\p{L}\p{N} .’'_-]+$/u.test(trimmed), 'invalid_name', 'Use 2–30 letters, numbers, or spaces for this name.', 400)
  return trimmed
}

export const activeProtectorate = (world, cityId) => world.governance.find(pact => pact.defender === cityId && pact.status === 'active')
export const governanceRegions = (world, cityId) => world.governance.filter(pact => pact.overlord === cityId && pact.status === 'active')
export const allianceMembers = (world, id) => Object.values(world.cities).filter(city => city.alliance === id)
export const activeTreaty = (world, a, b, kinds) => a.alliance && b.alliance && world.treaties.some(treaty =>
  treaty.status === 'active' && kinds.includes(treaty.kind) &&
  ((treaty.from === a.alliance && treaty.to === b.alliance) || (treaty.to === a.alliance && treaty.from === b.alliance)))
export const friendly = (world, a, b) => a.alliance && a.alliance === b.alliance || activeTreaty(world, a, b, ['nonaggression','defense','ceasefire']) ||
  diplomacyRelationship(world,a.id,b.id,world.now).blocksAttack
export const lastDay = (events, now) => events.filter(entry => entry.at > now - DAY)
export const recentBattles = (world, now) => world.marches.filter(entry => entry.at > now - DAY)
export const normalMarch = march => march.kind === 'raid'
export const selectTarget = (world, actor, id) => {
  const target = getCity(world, id)
  requireRule(target.id !== actor.id, 'self_target', 'Select a different city.')
  return target
}

export function attackEligibility(world, actor, target, now = world.now, { omitMarch } = {}) {
  const ratio = combatPower(target) / Math.max(1, combatPower(actor))
  const result = (ok, reason = '', code = '') => ({ok, allowed: ok, reason, code, ratio: Math.round(ratio * 1000) / 1000})
  if (actor.id === target.id) return result(false, 'Your own city.', 'self_target')
  if (!actor.optIn || !target.optIn) return result(false, 'Both cities must opt in to seasonal PvP.', 'pvp_opt_out')
  if (actor.shieldUntil > now || target.shieldUntil > now) return result(false, 'A city has an active shield.', 'protected')
  if (friendly(world, actor, target)) return result(false, 'An alliance or treaty protects this target.', 'friendly')
  if (activeProtectorate(world, target.id) || activeProtectorate(world, actor.id)?.overlord === target.id) return result(false, 'Protectorate rules protect this city from standard attacks.', 'protectorate')
  // Weaker kingdoms are protected: a target may be at most 20% weaker than the attacker. Raiding a STRONGER kingdom is
  // always allowed, so a new kingdom can raid from its first day; the risk is the attacker's own.
  if (ratio < 1 - balance.attackWindow) return result(false, 'This city is more than 20% weaker than yours. Choose a stronger opponent.', 'power_gap')
  if (troopTotal(actor.troops) < 10) return result(false, 'An army requires at least 10 troops.', 'troop_minimum')
  const raids = recentBattles(world, now).filter(march => normalMarch(march) && (!omitMarch || march.id !== omitMarch))
  const fromAlliance = march => march.alliance === actor.alliance || march.contributorAlliances?.includes(actor.alliance)
  const outgoing = raids.filter(march => march.attacker === actor.id || march.contributors?.includes(actor.id))
  const incoming = raids.filter(march => march.defender === target.id)
  if (outgoing.length >= balance.attacksDaily) return result(false, 'Your rolling daily attack limit is exhausted.', 'attack_limit')
  if (incoming.length >= balance.targetIncomingDaily) return result(false, 'Target has reached its incoming daily raid limit.', 'target_limit')
  if (outgoing.some(march => march.defender === target.id && march.at > now - balance.repeatAttack)) return result(false, 'You recently attacked this city.', 'repeat_attack')
  if (actor.alliance && raids.filter(fromAlliance).length >= balance.allianceAttacksDaily) return result(false, 'Your alliance has reached its rolling daily raid limit.', 'alliance_limit')
  if (actor.alliance && incoming.some(march => fromAlliance(march) && march.at > now - balance.repeatAttack)) return result(false, 'Your alliance recently attacked this city.', 'alliance_repeat')
  return result(true)
}

export function protectorateEligibility(world, actor, target, now = world.now) {
  const ratio = combatPower(actor) / Math.max(1, combatPower(target))
  const result = (ok, reason = '', code = '') => ({ok, allowed: ok, reason, code, ratio: Math.round(ratio * 1000) / 1000})
  if (actor.id === target.id) return result(false, 'Select a different city.', 'self_target')
  if (!actor.alliance || world.alliances[actor.alliance]?.leader !== actor.id) return result(false, 'An alliance leader must sponsor the offer.', 'alliance_leader')
  if (!actor.optIn || !target.optIn || target.shieldUntil > now || actor.shieldUntil > now || target.immunityUntil > now) return result(false, 'A city has seasonal protection.', 'protected')
  if (friendly(world, actor, target)) return result(false, 'An existing agreement prevents coercion.', 'friendly')
  if (ratio < economy.protectorateMinPower) return result(false, 'The sponsor needs a 60% power advantage.', 'power_gap')
  if (actor.reputation < 20 || actor.influence < 12) return result(false, 'Requires 12 Influence and at least 20 reputation.', 'influence')
  if (governanceRegions(world, target.id).length) return result(false, 'Resolve the target alliance’s existing protectorates first.', 'sovereign_target')
  if (activeProtectorate(world, actor.id)) return result(false, 'A vassal cannot propose a protectorate.', 'vassal')
  const open = world.governance.filter(pact => ['active','pending'].includes(pact.status))
  if (open.some(pact => pact.defender === target.id)) return result(false, 'The target already has an active negotiation or protectorate.', 'political_slot')
  if (open.filter(pact => pact.alliance === actor.alliance).length >= economy.protectorateSlots) return result(false, 'Your alliance has used its protectorate slots.', 'political_slot')
  if (world.governance.some(pact => pact.defender === target.id && pact.createdAt > now - economy.protectorateCooldown)) return result(false, 'The target is immune to new proposals for 24 hours.', 'political_cooldown')
  return result(true)
}

export function rankings(world) {
  const holdings = new Map()
  for (const site of world.territories ?? world.nodes) if (site.owner && !site.protected) {
    holdings.set(site.owner, (holdings.get(site.owner) ?? 0) + 1)
  }
  return Object.values(world.cities).map(city => ({
    id: city.id, name: city.name, owner: city.owner, faction: city.faction, alliance: city.alliance, score: city.score, power: combatPower(city),
    territories: holdings.get(city.id) ?? 0, npc: city.npc,
  })).sort((a,b) => b.score - a.score || b.territories - a.territories || b.power - a.power || (a.id < b.id ? -1 : 1))
}

export function limitHistory(city, entry) {
  city.history.unshift(entry)
  city.history.length = Math.min(city.history.length, 100)
}



export function territoryCapacity(world, city, ignoredNodeId) {
  const owned = world.nodes.filter(node => node.owner && node.id !== ignoredNodeId)
  if (owned.filter(node => node.owner === city.id).length >= balance.cityTerritoryCap) return false
  return !city.alliance || owned.filter(node => world.cities[node.owner]?.alliance === city.alliance).length < balance.allianceTerritoryCap
}
