import {DAY, HOUR, MINUTE} from './economy.mjs'

export const units = {
  infantry: {name: 'Infantry', attack: 12, guard: 9, life: 21, time: 1100, cost: [3,0,4,6,0]},
  shield: {name: 'Shield Infantry', attack: 8, guard: 15, life: 26, time: 1300, cost: [2,2,6,6,0]},
  archer: {name: 'Archer', attack: 15, guard: 6, life: 17, time: 1400, cost: [6,0,3,6,0]},
  cavalry: {name: 'Cavalry', attack: 18, guard: 10, life: 22, time: 2000, cost: [4,0,8,10,0]},
  siege: {name: 'Siege Unit', attack: 20, guard: 5, life: 25, time: 2500, cost: [10,5,8,5,1]},
  mage: {name: 'War Mage', attack: 13, guard: 8, life: 18, time: 2200, cost: [3,2,3,7,2]}
}

export const counters = {
  infantry: [1, .82, 1.15, .9, 1.23, 1.07],
  shield: [1.17, 1, .97, 1.25, .88, .86],
  archer: [1.19, .83, 1, .74, 1.05, 1.2],
  cavalry: [1.08, .72, 1.31, 1, 1.2, .86],
  siege: [.79, 1.27, .86, .78, 1, 1.07],
  mage: [.98, 1.22, .88, 1.14, .89, 1]
}

export const heroes = {
  warden: {name: 'Warden King', rarity: 'Legendary', role: 'Defense', ability: 'Stand Fast', description: 'Reduces early defensive casualties by up to 8%.'},
  engineer: {name: 'Castle Engineer', rarity: 'Rare', role: 'Construction', ability: 'Masterwork', description: 'Shortens standard construction by 8%.', build: .92},
  keeper: {name: 'Vault Keeper', rarity: 'Epic', role: 'Logistics', ability: 'Granary Seal', description: 'Raises earned resource storage by 10%.', storage: 1.1},
  commander: {name: 'Battle Commander', rarity: 'Epic', role: 'Warfare', ability: 'Vanguard', description: 'Grants a 6% attack bonus in the opening exchange.'},
  ranger: {name: 'Scout Ranger', rarity: 'Rare', role: 'Espionage', ability: 'Veiled Approach', description: 'Raises espionage success by 8 points.', spy: .08},
  queen: {name: 'Rebel Queen', rarity: 'Legendary', role: 'Resistance', ability: 'Raise the Horn', description: 'Raises rebel morale when organizing a cell.', morale: 8},
  merchant: {name: 'Merchant Prince', rarity: 'Rare', role: 'Trade', ability: 'Fair Exchange', description: 'Improves the market rate by 3 points.', trade: .03},
  scholar: {name: 'Oracle Scholar', rarity: 'Epic', role: 'Research', ability: 'Foresight', description: 'Reduces research costs by 8%.', research: .92}
}

export const tactics = {
  balanced: {name: 'Hold the Line', description: 'Preserves soldiers and applies even pressure.'},
  assault: {name: 'Vanguard Assault', description: 'Strong opening at the expense of protection.'},
  flank: {name: 'Flanking Maneuver', description: 'Counters an assault and favors cavalry.'},
  siege: {name: 'Siege Formation', description: 'Favors artillery and reduces the wall advantage.'}
}

export const formations = {
  line: {name: 'Battle Line', description: 'Even pressure across the battlefield.'},
  wedge: {name: 'Spearhead', description: 'Concentrates damage at close range.'},
  screen: {name: 'Skirmish Screen', description: 'Disperses forces and favors archers and mages.'}
}

export const missions = {
  recon: {name: 'Basic Reconnaissance', description: 'Estimates army size and wall defenses.', points: 1, cost: [12,0,0,24,0], time: 15_000, confidence: .62},
  deep: {name: 'Deep Espionage', description: 'Estimates unit composition, formation and wall level.', points: 2, cost: [28,0,18,45,4], time: 30_000, confidence: .84},
  supply: {name: 'Supply Reconnaissance', description: 'Estimates city stockpiles.', points: 2, cost: [20,0,12,50,4], time: 25_000, confidence: .72},
  sabotage: {name: 'Logistics Sabotage', description: 'Reduces target production temporarily by 15%.', points: 3, cost: [40,0,30,70,9], time: 45_000, confidence: .69},
  decoy: {name: 'Disinformation', description: 'Deploys misleading troop reports for your city.', points: 2, cost: [42,26,10,38,3], time: 20_000, confidence: .70}
}

export const factions = {
  emerald: {name: 'Emerald Dominion', color: '#42e1a5'},
  azure: {name: 'Azure Order', color: '#51c9ff'},
  crimson: {name: 'Crimson Legion', color: '#ff7160'},
  violet: {name: 'Free Cities', color: '#c08cff'},
  gold: {name: 'Imperial Concord', color: '#f1c66d'}
}

export const terrains = {
  plains: {name: 'Open Plains', defense: 1},
  hills: {name: 'Highlands', defense: 1.07},
  forest: {name: 'Deep Forest', defense: 1.06},
  river: {name: 'River Crossing', defense: 1.09},
  coast: {name: 'Coastal Reach', defense: 1.03},
  desert: {name: 'Drylands', defense: 1.01}
}

export const balance = {
  version: 1, combatVariance: .12, fortInfluence: .52, attackWindow: .2, attacksDaily: 3, cityTerritoryCap: 2, allianceTerritoryCap: 3, allianceAttacksDaily: 10, targetIncomingDaily: 3,
  repeatAttack: 8 * HOUR, defeatShield: 4 * HOUR, scoutPoints: 5, scoutRegen: 40 * MINUTE,
  scoutRepeat: 4 * MINUTE, scoutIncomingHourly: 4, intelLifetime: 3 * HOUR,
  counterspyDuration: 4 * HOUR, counterspyCooldown: 8 * HOUR, sabotageDuration: HOUR,
  sabotageCooldown: 8 * HOUR, decoyDuration: 3 * HOUR, chatThrottle: 3_000, hostilityCooldown: DAY,
  treatyDuration: 3 * DAY, rallyDuration: 20 * MINUTE
}
