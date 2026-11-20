import { PRICING, priceBook } from './pricing.mjs'
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const resources = ['wood', 'stone', 'iron', 'food', 'crystal']
export const starterResources = {wood: 1100, stone: 950, iron: 720, food: 1050, crystal: 120}
export const dailyLevy = Object.freeze({wood: 80, stone: 60, iron: 35, food: 90, crystal: 6})
export const resourceValues = Object.freeze({wood: 1, stone: 1.2, iron: 1.55, food: .85, crystal: 8})
export const production = {wood: 118, stone: 92, iron: 72, food: 140, crystal: 10}
export const startingCapacity = {wood: 2800, stone: 2400, iron: 1900, food: 3000, crystal: 370}
export const offlineCap = 12 * HOUR
// No shields this season: a new kingdom can be raided, and can raid, from its first day (weaker kingdoms stay protected
// by the power window). Kept as a setting for a later season.
export const starterShield = 0
export const demoTempo = 1
export const seasonLength = 7 * DAY
export const levelMax = 9
// What the engine quotes when no Chipnet payment route is configured (nothing can be paid then). The numbers are the
// current price book's, so every screen shows the same prices; a paid raid shows its smallest stake.
const book = priceBook(PRICING)
export const fees = {attack: book.raid.minimumStake, protectorate: book.services.protectorate, premium: book.services.premium, rush: book.services.rush}
export const economy = {
  version: 1, production, startingCapacity, starterResources, offlineCap, starterShield, demoTempo, seasonLength, levelMax, fees,
  // Construction takes real time. The first upgrade of each building stays quick (City Hall: 90 seconds); from level 2 on,
  // build times are multiplied by buildTimeScale (City Hall 2→3: about 17 minutes, 8→9: about 2.4 hours).
  farmRate: .15, vaultCapacityRate: .25, upgradeCurve: 1.56, buildTimeCurve: 1.43, buildTimeScale: 8, maintenance: .22,
  // A rush for a construction with less than this time left is applied after 1 confirmation (about 10 minutes);
  // otherwise after the usual 2. Waiting two blocks for a short build would leave little to rush.
  rushOneConfirmationBelow: 60 * 60_000,
  lootFraction: .075, lootCapacityPerTroop: 3, marketRate: .7, aidDaily: 500, rushFraction: .5,
  paidConvenienceDaily: 1, protectorateTribute: .08, protectorateSlots: 2, protectorateMinPower: 1.6,
  protectorateResponseTime: 2 * HOUR, protectorateTerm: 48 * HOUR, protectorateCooldown: DAY,
  rebellionPrepTime: 15 * MINUTE, rebellionResponseTime: 10 * MINUTE, rebellionImmunity: 12 * HOUR
}

export const buildings = {
  hall: {name: 'City Hall', description: 'Raises city level and unlocks new building tiers.', cost: [150,125,70,100,12], time: 90_000, premium: 'Founders banner and a civic collection preset'},
  barracks: {name: 'Barracks', description: 'Raises troop capacity and shortens recruitment.', cost: [125,80,95,120,7], time: 75_000},
  walls: {name: 'Wall Fortress', description: 'Absorbs incoming damage and improves defense.', cost: [75,170,95,45,8], time: 95_000},
  vault: {name: 'Vault Treasury', description: 'Raises the storage limit for earned resources.', cost: [110,130,115,45,10], time: 85_000, premium: 'Gold-trimmed treasury crest'},
  workshop: {name: 'Workshop', description: 'Reduces construction time and unlocks siege recruitment.', cost: [145,95,120,40,9], time: 105_000},
  market: {name: 'Marketplace', description: 'Improves rates on resource exchanges.', cost: [155,115,60,70,8], time: 80_000},
  library: {name: 'Research Library', description: 'Unlocks new technologies.', cost: [90,95,70,85,18], time: 100_000},
  alliance: {name: 'Alliance Hall', description: 'Raises the daily aid allowance.', cost: [120,105,75,70,12], time: 80_000, premium: 'Gold-trimmed alliance pennant'},
  scout: {name: 'Scout Tower', description: 'Improves scouting and counterintelligence.', cost: [85,105,55,65,13], time: 80_000, premium: 'Extra private intel archive slot and ranger insignia'},
  farm: {name: 'Farm & Mine', description: 'Raises hourly production for all five resources.', cost: [135,85,55,100,8], time: 65_000}
}

export const tech = {
  logistics: {name: 'Field Logistics', library: 1, cost: [125,80,40,100,18], description: 'Hourly production +6% per level.'},
  fortification: {name: 'Fortification', library: 1, cost: [75,145,85,50,18], description: 'Effective wall strength +1 per level.'},
  tactics: {name: 'War Doctrine', library: 2, cost: [75,80,120,85,26], description: 'Army attack +2% per level.'},
  signals: {name: 'Signalcraft', library: 2, cost: [110,85,65,65,25], description: 'Espionage success +4 points per level.'}
}
