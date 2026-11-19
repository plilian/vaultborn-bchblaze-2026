import {writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {DAY, HOUR, MINUTE, economy, resources} from '../../config/economy.mjs'
import {balance} from '../../config/balance.mjs'
import {advance, attackEligibility, command, createWorld, productionPerHour, quote, quoteUpgrade} from '../game-engine/index.mjs'
import {armyPower, seeded, simulateBattle, troopTotal, unitIds} from '../game-engine/combat.mjs'
import {addPlayer, mapResources} from '../game-engine/world.mjs'

const origin = 10 * DAY
const tactics = ['balanced','assault','flank','siege']
const formations = ['line','wedge','screen']
const compositions = [
  [35,23,23,11,5,3], [41,29,13,8,4,5], [21,20,38,10,5,6], [21,15,16,36,8,4], [25,17,24,10,14,10]
]
const strategyNames = ['casual','builder','hoarder','aggressive']
const count = values => values.length
const div = (value, total) => total ? Math.round(1000 * value / total) / 10 : 0
const rounded = value => Math.round(value * 100) / 100
const average = values => values.reduce((sum,value) => sum + value,0) / Math.max(1,count(values))
const totalRes = stock => resources.reduce((sum,key) => sum + stock[key],0)
const tally = (object, key) => { object[key] = (object[key] || 0) + 1 }
const summary = values => {
  if (!values.length) return null
  const sorted = values.toSorted((a,b) => a - b)
  return Object.fromEntries([.1,.5,.9].map(share => ['p'+share*100,rounded(sorted[Math.floor(share*(sorted.length-1))])]))
}
const action = (world, actor, type, parameters, paid = false) => {
  try { return command(world,actor,{type,...parameters},world.now,{paid}) }
  catch (error) {
    if (!error.code) throw error
    return error.code
  }
}

function distribution(base, ratio = 1) {
  return Object.fromEntries(unitIds.map((unit,index) => [unit,Math.round(base[index]*ratio)]))
}

export function battleExperiment(runsPerGap = 2400, variants, fieldRules) {
  const random = seeded('BCH-Dominion/battle-simulator/2026-11')
  const groups = []
  const allWins = {}
  let intelChanged = 0
  let intelWins = 0
  let baseWins = 0
  let casualtyTotal = 0
  let premiumDivergence = 0
  const terrainMatrix = {plains:{wins:0,count:0},river:{wins:0,count:0}}
  for (const gap of [.8,.9,1,1.1,1.2]) {
    const result = {powerRatio:gap,runs:runsPerGap,wins:0,ratesByTactic:{}}
    for (let index = 0; index < runsPerGap; index++) {
      const baseA = compositions[Math.floor(random()*compositions.length)]
      const baseD = compositions[Math.floor(random()*compositions.length)]
      const ratio = armyPower(distribution(baseD))/armyPower(distribution(baseA))
      const tactic = tactics[index % tactics.length]
      const terrain = index % 8 < 4 ? 'plains' : 'river'
      const doctrine = fieldRules === undefined ? {} : {fieldRules}
      const input = {
        attacker:{troops:distribution(baseA,gap*ratio),tactic,formation:formations[index % formations.length],hero:'commander',intel:0,...doctrine},
        defender:{troops:distribution(baseD),tactic:tactics[Math.floor(random()*tactics.length)],formation:formations[Math.floor(random()*formations.length)],hero:'warden',wall:2,...doctrine},
        terrain
      }
      const seed = Math.floor(random()*2**32)
      const base = simulateBattle(input,seed,variants)
      const paying = simulateBattle({...input,attacker:{...input.attacker,premium:true}},seed,variants)
      const informed = simulateBattle({...input,attacker:{...input.attacker,intel:.84}},seed,variants)
      const won = base.winner === 'attacker'
      baseWins += Number(won)
      intelWins += Number(informed.winner === 'attacker')
      intelChanged += Number(base.winner !== informed.winner)
      premiumDivergence += Number(base.winner !== paying.winner)
      result.wins += Number(won)
      const tacticGroup = result.ratesByTactic[tactic] ||= {wins:0,count:0}
      tacticGroup.wins += Number(won)
      tacticGroup.count++
      const aggregate = allWins[tactic] ||= {wins:0,count:0}
      aggregate.wins += Number(won)
      aggregate.count++
      terrainMatrix[terrain].count++
      terrainMatrix[terrain].wins += Number(won)
      casualtyTotal += troopTotal(base.losses.attacker) + troopTotal(base.losses.defender)
    }
    groups.push({ratio:gap,count:runsPerGap,attackerWinPercent:div(result.wins,runsPerGap),
      byTactic:Object.fromEntries(Object.entries(result.ratesByTactic).map(([key,value]) => [key,div(value.wins,value.count)]))})
  }
  const runs = runsPerGap * groups.length
  return {runs, pairedCombatResolutions:runs*3,groups, overallByTactic:Object.fromEntries(Object.entries(allWins).map(([key,value]) => [key,div(value.wins,value.count)])),
    terrainWinPercent:Object.fromEntries(Object.entries(terrainMatrix).map(([key,value]) => [key,div(value.wins,value.count)])),
    premiumDivergence, intelChanged, intelWinLiftPP:rounded((intelWins - baseWins)*100/runs), meanCasualties:rounded(casualtyTotal/runs)}
}

function scenarioState(index) {
  const world = createWorld(origin)
  world.secret = 'BCH-Dominion/economy-simulator/' + index
  for (const id of Object.keys(world.cities)) if (!['p1','p2','p3','p4','p5','p6'].includes(id)) delete world.cities[id]
  return world
}

function chooseConstruction(actor, strategy, ticks) {
  const candidates = strategy === 'hoarder' ? ['vault','farm','library','hall'] :
    strategy === 'aggressive' ? ['barracks','walls','farm','workshop','scout','hall'] : ['farm','vault','workshop','library','barracks','hall']
  const unlocked = candidates.filter(key => key !== 'hall' && actor.buildings[key] < actor.buildings.hall - (strategy==='casual' ? 1 : 0))
  if (unlocked.length) return unlocked[ticks % unlocked.length]
  return 'hall'
}

function replenish(world, actor) {
  const need = Math.max(0,90-troopTotal(actor.troops))
  if (need >= 5) return action(world,actor.id,'train',{unit:'infantry',count:Math.min(need,25)})
  return null
}

function replaceGarrison(world, defender) {
  // A recurring independent matchmaking candidate, constrained to seeded composition and the Barracks cap.
  // The main player's resources, troops, scores and caps persist across all horizons.
  if (troopTotal(defender.troops) >= 65 || defender.queue.length) return
  const need = Math.min(25,88-troopTotal(defender.troops))
  if (need > 0) action(world,defender.id,'train',{unit:'infantry',count:need})
}

function measure(world, actor, startingTime, recorded) {
  const completion = level => actor.history.find(job => job.kind === 'building' && job.key === 'hall' && job.level === level)?.completedAt
  const elapsed = timestamp => timestamp == null ? null : (timestamp - startingTime)/HOUR
  const attackLoss = recorded.attempted - recorded.accepted
  return {day:(world.now-startingTime)/DAY, hall:actor.buildings.hall, levelSum:Object.values(actor.buildings).reduce((sum,level) => sum+level,0),
    farm:actor.buildings.farm, stock:totalRes(actor.resources), army:troopTotal(actor.troops),
    attempts:recorded.attempted, launched:recorded.accepted, blocked:attackLoss, reasons:{...recorded.reasons}, convenience:recorded.convenience,
    earnedScore:actor.score+world.archive.reduce((sum,season) => sum+(season.rankings.find(row => row.id===actor.id)?.score || 0),0),
    marketTrades:recorded.marketTrades, milestone3:recorded.level3 ?? elapsed(completion(3)), milestone5:recorded.level5 ?? elapsed(completion(5)), recovery:[...recorded.recovery], satoshis:recorded.satoshis}
}

export function economyRun(index, options = {}) {
  const strategy = options.strategy || strategyNames[index % strategyNames.length]
  const premium = options.premium ?? Math.floor(index / strategyNames.length) % 2 === 1
  const pairedIndex = Math.floor(index / (strategyNames.length*2)) * strategyNames.length + index%strategyNames.length
  const world = scenarioState(pairedIndex)
  const actor = world.cities.p1
  const random = seeded('economy-run/' + pairedIndex)
  const stats = {attempted:0,accepted:0,reasons:{},convenience:0,marketTrades:0,recovery:[],satoshis:0,level3:null,level5:null}
  const snapshots = []
  const sessions = strategy === 'aggressive' ? 4 + Math.floor(random()*3) : strategy === 'casual' ? 1 : strategy === 'hoarder' ? 2 : 3 + Math.floor(random()*3)
  const attendance = strategy === 'casual' ? .64 + random()*.28 : .84 + random()*.16
  const constructionJitter = Math.floor(random() * 3)
  let recoveryTarget = null
  let actionCount = 0
  action(world,'p1','tutorial')
  for (let day = 0; day < 30; day++) {
    for (let position = 0; position < sessions; position++) {
      if (day && random() > attendance) continue
      const clock = origin + day*DAY + Math.floor((position+.1+random()*.1)*DAY/sessions)
      advance(world, clock)
      if (actor.buildings.hall >= 3 && stats.level3 === null) stats.level3 = (actor.history.find(job => job.key === 'hall' && job.level === 3).completedAt-origin)/HOUR
      if (actor.buildings.hall >= 5 && stats.level5 === null) stats.level5 = (actor.history.find(job => job.key === 'hall' && job.level === 5).completedAt-origin)/HOUR
      if (recoveryTarget && troopTotal(actor.troops) >= recoveryTarget.troops) {
        stats.recovery.push((clock - recoveryTarget.at)/HOUR)
        recoveryTarget = null
      }
      if (!position) action(world,'p1','collect')
      const building = chooseConstruction(actor,strategy,actionCount+constructionJitter)
      if (strategy !== 'hoarder' || (day + position) % 2 === 0) {
        const buildingResult = action(world,'p1','upgrade',{building})
        if (typeof buildingResult !== 'string') {
          actionCount++
          if (premium && !actor.conveniences.length) {
            const rush = action(world,'p1','rush',{building},true)
            if (typeof rush !== 'string') {
              stats.convenience++
              stats.satoshis += economy.fees.rush
            }
          }
        }
      }
      if (actor.resources.crystal < 50 && actor.resources.wood > 1600 && actor.resources.food > 500 &&
          typeof action(world,'p1','trade',{give:'food',take:'crystal',amount:250}) !== 'string') stats.marketTrades++
      if (strategy !== 'hoarder' && (strategy !== 'casual' || day % 2 === 0)) {
        const training = replenish(world,actor)
        if (!training && strategy !== 'casual' && actor.tech.logistics < 3 && position%2 === 1) action(world,'p1','research',{tech:'logistics'})
      }
      if (strategy === 'aggressive' || strategy === 'builder' && !position && day%3 === 0) {
        replaceGarrison(world,world.cities.p2)
        const attackTargets = ['p2','p5','p6']
        const attempts = strategy==='aggressive' ? 3 : 1
        for (let attempt = 0; attempt < attempts; attempt++) {
          const target = attackTargets[(day+position+attempt+constructionJitter)%attackTargets.length]
          const before = troopTotal(actor.troops)
          stats.attempted++
          const raid = action(world,'p1','attack',{target,tactic:tactics[(day+pairedIndex)%tactics.length]})
          if (typeof raid === 'string') tally(stats.reasons,raid)
          else {
            stats.accepted++
            if (!recoveryTarget && raid.winner === 'defender' && before >= 20 && before-troopTotal(actor.troops) >= 3) recoveryTarget = {troops:before, at:clock}
          }
        }
      }
    }
    if ([1,7,30].includes(day+1)) {
      advance(world,origin+(day+1)*DAY)
      snapshots.push(measure(world,actor,origin,stats))
    }
  }
  return {strategy,premium,snapshots}
}

function aggregateEconomy(runs) {
  const reports = []
  for (const strategy of strategyNames) for (const premium of [false,true]) {
    const trials = runs.filter(run => run.strategy === strategy && run.premium === premium)
    const horizons = [0,1,2].map(index => {
      const rows = trials.map(run => run.snapshots[index])
      const collected = key => rows.map(row => row[key])
      const attacked = collected('attempts').reduce((sum,value) => sum+value,0)
      const blocks = collected('blocked').reduce((sum,value) => sum+value,0)
      const reasons = {}
      for (const row of rows) for (const [key,value] of Object.entries(row.reasons)) reasons[key] = (reasons[key] || 0)+value
      return {day:rows[0].day,stock:summary(collected('stock')),army:summary(collected('army')),levelSum:summary(collected('levelSum')),
        hall:summary(collected('hall')),hall3Hours:summary(collected('milestone3').filter(value => value !== null)),
        hall5Hours:summary(collected('milestone5').filter(value => value !== null)), recoveredHours:summary(collected('recovery').flat()),
        observedRecoveries:collected('recovery').flat().length, meanAttacksPerDay:rounded(average(collected('launched'))/rows[0].day),
        blockedPercent:div(blocks,attacked), attempted:attacked, blocked:blocks, blockReasons:reasons, chipnetSatoshis:summary(collected('satoshis')),
        seasonScore:summary(collected('earnedScore')),avgTrades:rounded(average(collected('marketTrades')))}
    })
    reports.push({strategy,premium,runs:trials.length,horizons})
  }
  return reports
}

function combatScenarios() {
  const probe = scenarioState(0)
  const city = addPlayer(probe,{id:'newbie',name:'New Player',cityName:'New Harbor',faction:'azure'},probe.now)
  const fallback = {
    starterProtected:attackEligibility(probe,probe.cities.p1,city).code,
    weekOldBalance:undefined,
    impossibleRaid:attackEligibility(probe,probe.cities.p1,probe.cities.p4).code,
    missingBchAction:action(probe,'p1','attack-paid',{target:'p2'}),
    premiumWithoutVerification:action(probe,'p1','premium',{building:'hall'}),
    protectorateQuote:quote(probe,'p1',{type:'protectorate',target:'p4'}).satoshis
  }
  action(probe,'newbie','tutorial')
  action(probe,'newbie','opt-in',{enabled:true})
  for (let day = 0; day < 7; day++) {
    if (day) advance(probe,origin+day*DAY)
    action(probe,'p1','upgrade',{building:'hall'})
  }
  advance(probe,origin+7*DAY)
  fallback.weekOldBalance = attackEligibility(probe,probe.cities.p1,city).code
  const attacked = []
  for (let attempt = 0; attempt < 12; attempt++) {
    const attacker = 'duplicate'+attempt
    addPlayer(probe,{id:attacker,name:'Alt Commander',cityName:'Mirror City'},probe.now)
    attacked.push(attackEligibility(probe,probe.cities[attacker],probe.cities.p2).code)
  }
  const coordinated = scenarioState(10000)
  coordinated.marches.push({kind:'raid',attacker:'p3',defender:'p2',at:coordinated.now-MINUTE,alliance:'emerald-watch'})
  fallback.coordinated = attackEligibility(coordinated,coordinated.cities.p1,coordinated.cities.p2).code
  fallback.altAccountsBlocked = attacked.filter(Boolean).length
  const altAid = addPlayer(coordinated,{id:'altvault',name:'Alt Aid',cityName:'Aid Stockpile'},coordinated.now)
  altAid.alliance = 'emerald-watch'
  fallback.altAid = action(coordinated,'p3','aid',{target:altAid.id,resource:'food',amount:100})
  return fallback
}

function diplomacyExperiment(runs = 200) {
  const outcomes = {}
  let overlaps = 0
  for (let index = 0; index < runs; index++) {
    const world = scenarioState('protectorate-' + index)
    world.cities.p4.npc = false
    const pact = action(world,'p1','protectorate',{target:'p4'},true)
    if (typeof pact === 'string') throw new Error(pact)
    if (typeof action(world,'p1','protectorate',{target:'p4'},true) !== 'string') overlaps++
    action(world,'p4','respond',{id:pact.id,decision:index % 4 === 0 ? 'resist' : 'accept'})
    if (pact.status === 'active') {
      action(world,'p4','configure',{hero:'queen',tactic:'assault',formation:'wedge'})
      action(world,'p4','rebellion-prepare',{id:pact.id})
      action(world,'p4','rebellion-prepare',{id:pact.id})
      advance(world,pact.rebellion.readyAt)
      action(world,'p4','rebel',{id:pact.id})
      if (index % 2 === 1) action(world,'p1','rebellion-respond',{id:pact.id,decision:'reinforce'})
      advance(world,pact.rebellion.resolveAt)
      tally(outcomes,'rebellion-'+pact.rebellion.status)
    } else tally(outcomes,pact.status)
  }
  return {runs,outcomes,duplicateOffersAccepted:overlaps,
    maximumAllianceTerritoryHHIWhenAllSixNodesClaimed:rounded(2*(3/6)**2),
    theoreticalMaximumProtectoratesPerAlliance:economy.protectorateSlots}
}

function payouts(amount = 1_000_000, expectedFee = 350) {
  // Model of createLedger's current 85% award base and rank weights, using illustrative miner fees.
  const weights = [40,25,15,10,10]
  const paid = weights.map(weight => Math.floor(Math.floor(amount*.85)*weight/100))
  const netPaid = paid.reduce((sum,row) => sum+row,0)
  return {entrants:100, funded:amount, paid, combinedPayout:netPaid, unclaimedReserve:amount-netPaid-expectedFee*count(paid),
    illustrativeFees:expectedFee*count(paid), shareTop1Pct:div(paid[0],netPaid),shareTop10Pct:100,shareTop50Pct:100}
}


function marketExperiment() {
  const world = scenarioState('market')
  const cities = [world.cities.p1, world.cities.p2, world.cities.p3, world.cities.p4, world.cities.p5, world.cities.p6]
  for (const city of cities) city.npc = false
  cities[0].buildings.market = 5
  cities[2].buildings.market = 4
  const trades = Object.fromEntries(cities.map(city => [city.id,0]))
  for (let day = 0; day < 30; day++) {
    advance(world,origin+(day+1)*DAY)
    for (const [index,city] of cities.entries()) {
      for (let attempt = 0; attempt < (index === 0 ? 3 : 1); attempt++) {
        const spend = (index === 0 ? 440 : 170)
        // The earlier exchange leaves space for the reverse one; both settle at a spread.
        const buy = action(world,city.id,'trade',{give:'food',take:'wood',amount:spend})
        const reverse = action(world,city.id,'trade',{give:'stone',take:'food',amount:Math.min(spend,200)})
        if (typeof buy !== 'string') trades[city.id] += buy.received
        if (typeof reverse !== 'string') trades[city.id] += reverse.received
      }
    }
  }
  const volume = Object.values(trades).reduce((sum,value) => sum + value,0)
  const stocks = cities.map(city => totalRes(city.resources))
  const stockTotal = stocks.reduce((sum,value) => sum + value,0)
  return {cities:cities.length,days:30,seasonsFinalized:world.archive.length, scriptedVolume:volume, marketLeaderVolumeShare:div(trades.p1,volume),
    stockHHI:rounded(stocks.reduce((sum,value) => sum+(value/stockTotal)**2,0)), priceControl:false}
}

function combatChart(groups) {
  const points = groups.map((item,index) => [76+index*141,232-item.attackerWinPercent*1.8])
  const curve = points.map(point => point.join(',')).join(' ')
  const labels = points.map(([x,y],index) => '<circle cx="'+x+'" cy="'+y+'" r="5" fill="#1a8f65"/><text x="'+x+'" y="'+Math.max(46,y-12)+'" text-anchor="middle">'+groups[index].attackerWinPercent+'%</text><text x="'+x+'" y="257" text-anchor="middle">'+groups[index].ratio.toFixed(1)+'×</text>').join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="290" viewBox="0 0 720 290" role="img" aria-label="Attacker win rate by power ratio"><rect width="720" height="290" fill="#f4f6f2"/><g font-family="system-ui" fill="#143229" font-size="14"><text x="25" y="30" font-size="20" font-weight="700">Attacker win rate by army-power ratio</text><path d="M76 52V232H663 M76 142H663" fill="none" stroke="#c4d2c7"/><text x="25" y="57">100%</text><text x="34" y="146">50%</text><text x="41" y="236">0%</text><polyline points="'+curve+'" stroke="#1a8f65" stroke-width="3" fill="none"/>'+labels+'</g></svg>\n'
}
function payback() {
  const sample = scenarioState('payback').cities.p1
  const before = productionPerHour(sample,origin)
  const upgrade = quoteUpgrade(sample,'farm')
  sample.buildings.farm++
  const after = productionPerHour(sample,origin)
  const yields = mapResources(resource => after[resource] - before[resource])
  return {farmLevel:upgrade.level,farmNextLevel:upgrade.nextLevel,cost:upgrade.cost,hourlyGain:yields,
    singleResourceHours:mapResources(resource => yields[resource] ? rounded(upgrade.cost[resource]/yields[resource]) : null)}
}

const calledFromCLI = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (calledFromCLI) {
  const combat = battleExperiment()
  const seasonRuns = Array.from({length:1000},(_,index) => economyRun(index))
  const report = {simulationVersion:'dominion-balance-1', combat, seasonRuns:seasonRuns.length, economy:aggregateEconomy(seasonRuns),
    earlierCombat: battleExperiment(2400,{fortInfluence:1,varianceBound:.08}),
    scenarios:combatScenarios(), diplomacy:diplomacyExperiment(), market:marketExperiment(), rewardLedgerModel:payouts(), payback:payback(), fees:economy.fees,
    fairnessLimits:{window:balance.attackWindow,attackCap:balance.attacksDaily,allianceCap:balance.allianceAttacksDaily,repeatHours:balance.repeatAttack/HOUR}}
  writeFileSync(new URL('../../docs/economy-simulation-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
  writeFileSync(new URL('../../docs/combat-power-curve.svg',import.meta.url),combatChart(combat.groups))
  process.stdout.write(JSON.stringify({
    battles:report.combat.runs, seasonRuns:report.seasonRuns, pairedCombatResolutions:report.combat.pairedCombatResolutions,
    winRateByPowerRatio:report.combat.groups.map(row => [row.ratio,row.attackerWinPercent]),payingOutcomeChanges:report.combat.premiumDivergence,
    intelWinLiftPP:report.combat.intelWinLiftPP,scenarios:report.scenarios,diplomacy:report.diplomacy
  },null,2)+'\n')
}
