import {createHash} from 'node:crypto'
import {balance, units, counters, terrains} from '../../config/balance.mjs'
import {fieldDoctrine} from '../../config/progression.mjs'

export const unitIds = Object.keys(units)
export const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const troopTotal = troops => unitIds.reduce((sum, unit) => sum + (troops[unit] || 0), 0)
export const armyPower = troops => unitIds.reduce((sum, unit) => {
  const profile = units[unit]
  return sum + (troops[unit] || 0) * (profile.attack * .5 + profile.guard * .3 + profile.life * .2)
}, 0)

export function seeded(seed) {
  let state = typeof seed === 'number' ? seed >>> 0 : Number.parseInt(digest(seed).slice(0, 8), 16)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function posture(side, rival, round) {
  const initial = round <= 3
  const burst = ({balanced: 1.025, assault: initial ? 1.14 : .98, flank: rival.tactic === 'assault' ? 1.12 : 1.02, siege: .98})[side.tactic] || 1
  return burst * clamp(side.politicalMorale ?? 1,.85,1.18) * (1 + (side.tech?.tactics || 0) * .02) *
    (initial ? 1 + clamp(side.commanderTraits?.openingAttack ?? (side.hero === 'commander' ? .06 : 0),0,.12) : 1) * (1 + clamp(side.intel || 0, 0, 1) * .06)
}

export function unitAttackFactors(side,unit,round=1,terrain) {
  const formation=(side.formation === 'wedge' && ['infantry','cavalry'].includes(unit)) ||
    (side.formation === 'screen' && ['archer','mage'].includes(unit)) ? 1.095 : .985
  const tactic=(side.tactic === 'flank' && unit === 'cavalry') || (side.tactic === 'siege' && unit === 'siege') ? 1.13 : 1
  const pulse=unit === 'mage' && round%3===1 ? 1.13 : 1
  const mobility=side.fieldRules===fieldDoctrine.version && unit==='cavalry' ?
    (fieldDoctrine.cavalryMobility[terrain]??1)*(round>fieldDoctrine.openingExchanges?fieldDoctrine.cavalrySustain:1) : 1
  return {formation,tactic,pulse,mobility}
}

export const unitResilience=unit=>units[unit].life+units[unit].guard*.45
export const terrainFortification=(terrain,wall=0,fortInfluence=balance.fortInfluence)=>
  1+((terrains[terrain]?.defense||1)-1+clamp(wall*.011,0,.11))*fortInfluence

export function openingProfile(side,rival={tactic:'unknown'},terrain) {
  const stance=posture(side,rival,1)
  const attack=Object.fromEntries(unitIds.map(unit=>{
    const {formation,tactic,pulse,mobility}=unitAttackFactors(side,unit,1,terrain)
    return [unit,units[unit].attack*formation*tactic*pulse*stance*mobility]
  }))
  return {attack,openingPressure:unitIds.reduce((total,unit)=>total+(side.troops[unit]||0)*attack[unit],0),stance}
}

function pressure(side, army, rival, enemies, round, terrain) {
  const targetCount = Math.max(1, troopTotal(enemies))
  const stance = posture(side, rival, round)
  return unitIds.reduce((sum, unit) => {
    const multiplier = unitIds.reduce((total, target, index) => total + (enemies[target] || 0) * counters[unit][index], 0) / targetCount
    const {formation,tactic,pulse,mobility}=unitAttackFactors(side,unit,round,terrain)
    return sum + (army[unit] || 0) * units[unit].attack * multiplier * formation * tactic * pulse * stance * mobility
  }, 0)
}

function takeDamage(army, initial, raw, reduction, random) {
  const total = Math.max(1, troopTotal(army))
  let killed = 0
  for (const unit of unitIds) {
    const count = army[unit]
    if (!count) continue
    const share = count / total
    const resilience = unitResilience(unit)
    const theoretical = raw * share / resilience * reduction * (.94 + random() * .12)
    const casualtyCap = Math.floor(initial[unit] * .48)
    const affordable = Math.max(0, casualtyCap - initial[unit] + count)
    const loss = Math.min(count, affordable, Math.floor(theoretical) + (random() < theoretical % 1 ? 1 : 0))
    army[unit] -= loss
    killed += loss
  }
  return killed
}

export function simulateBattle(input, seed, {varianceBound = balance.combatVariance, fortInfluence = balance.fortInfluence} = {}, observe) {
  const {attacker, defender} = input
  const initialA = Object.fromEntries(unitIds.map(unit => [unit, attacker.troops[unit] || 0]))
  const initialD = Object.fromEntries(unitIds.map(unit => [unit, defender.troops[unit] || 0]))
  const armyA = {...initialA}
  const armyD = {...initialD}
  const random = seeded(seed)
  const variance = 1 + (random() * 2 - 1) * varianceBound
  const fort = terrainFortification(input.terrain,defender.wall || 0,fortInfluence)
  const events = []
  let initiative = 0
  for (let round = 1; round <= 9; round++) {
    const a = pressure(attacker, armyA, defender, armyD, round,input.terrain) * variance
    const d = pressure(defender, armyD, attacker, armyA, round,input.terrain) / variance * fort
    const breach = Math.min(.075, (attacker.tactic === 'siege' ? .04 : 0) + armyA.siege / Math.max(1, troopTotal(armyA)) * .2)
    const earlyGuard=round <= 3 ? 1-clamp(defender.commanderTraits?.defenseReduction ?? (defender.hero==='warden' ? .08 : 0),0,.15) : 1
    const defend = earlyGuard * (defender.tactic === 'assault' ? 1.04 : 1)
    const before = observe && [{...armyA},{...armyD}]
    const aLoss = takeDamage(armyA, initialA, d * .075, attacker.tactic === 'assault' ? 1.08 : 1, random)
    const dLoss = takeDamage(armyD, initialD, a * .075, defend / (fort - breach * fortInfluence), random)
    initiative += a / (fort - breach * fortInfluence) - d
    events.push({round, at: (round - 1) * 6000, phase: round <= 3 ? 'Advance' : round <= 6 ? 'Engagement' : 'Rout',
      attackerLoss: aLoss, defenderLoss: dLoss, attackerRemaining: troopTotal(armyA), defenderRemaining: troopTotal(armyD)})
    if (observe) {
      const summarize=(prior,army,pressure)=>({losses:Object.fromEntries(unitIds.map(unit=>[unit,prior[unit]-army[unit]])),pressure:Math.round(pressure)})
      observe({round,attacker:summarize(before[0],armyA,a/(fort-breach*fortInfluence)),
        defender:summarize(before[1],armyD,d),fortification:fort,breach,earlyGuard})
    }
  }
  const differential = armyPower(armyA) - armyPower(armyD) * fort + initiative / 12
  const winner = troopTotal(initialA) > 0 && (troopTotal(initialD) === 0 || differential > 0) ? 'attacker' : 'defender'
  const losses = {
    attacker: Object.fromEntries(unitIds.map(unit => [unit, initialA[unit] - armyA[unit]])),
    defender: Object.fromEntries(unitIds.map(unit => [unit, initialD[unit] - armyD[unit]]))
  }
  const result = {winner, losses, events, differential: Math.round(differential)}
  return {...result, hash: digest({input, seed, ...result})}
}
