import {DAY, HOUR, buildings, dailyLevy, economy, resources, resourceValues, tech} from '../../config/economy.mjs'
import {balance, heroes, units} from '../../config/balance.mjs'
import {troopTotal} from './combat.mjs'
import {openFromDayOne, activeProtectorate, activity, award, credit, creditableResources, getCity, has, lastDay, limitHistory, mapResources, marketRate, notify, points, productionPerHour,
  quoteUpgrade, rankings, requireRule, roundCost, stockCapacity, subtract, trainingSlots, trainingTimeFactor, troopCap} from './world.mjs'
import {completeMission} from './military.mjs'
import {nextGovernanceEvents} from './politics.mjs'
import {ensureTerritories,nextTerritoryEvent,territoryProduction} from './territories.mjs'
import {ensureGovernment,nextGovernmentEvent,governmentProductionMultiplier,collectGovernmentTax,reservedPoliticalTroops} from './government.mjs'
import {nextDiplomacyEvents} from './diplomacy.mjs'
import {nextPoliticalTradeEvents,politicalTradeCommand} from './political-trade.mjs'
import {activeCommander, awardCommanderMastery, commanderEffects, commanderOwnership, ruleClock} from './progression.mjs'
import {nextNpcEvent} from './npc.mjs'
import {retireNpcs} from './npc-roster.mjs'

export function deployedTroops(world,city) {
  return {claim:Object.values(city.territoryLocked??{}).reduce((total,roster)=>total+troopTotal(roster),0),
    political:reservedPoliticalTroops(world,city.id),
    garrison:(world.territories??[]).filter(site=>site.owner===city.id).reduce((total,site)=>total+troopTotal(site.defenses.garrison),0)}
}

function passiveAccrual(world, at) {
  const tributes = []
  for (const city of Object.values(world.cities)) {
    const elapsed = at - city.warehouseAt
    if (elapsed <= 0) continue
    const previous = city.warehouseAt
    const productiveTime = Math.max(0, at - Math.max(previous, world.accrualCutoff))
    const deployed=deployedTroops(world,city)
    const rates = productionPerHour(city,previous,governmentProductionMultiplier(world,city.id,previous),deployed.claim+deployed.political+deployed.garrison)
    const pact = activeProtectorate(world,city.id)
    const territoryRates = territoryProduction(world,city.id,previous)
    const earned = mapResources(resource => {
      const numerator = (rates[resource] + territoryRates[resource]) * productiveTime + city.remainders[resource]
      city.remainders[resource] = numerator % HOUR
      return Math.floor(numerator / HOUR)
    })
    if (pact) {
      const remainder = pact.tributeRemainder ||= mapResources(() => 0)
      const tribute = mapResources(resource => {
        const raw = earned[resource] * Math.round(pact.tribute * 100) + remainder[resource]
        remainder[resource] = raw % 100
        const amount = Math.floor(raw / 100)
        earned[resource] -= amount
        return amount
      })
      tributes.push({overlord:pact.overlord, tribute})
    }
    collectGovernmentTax(world,city.id,earned,previous)
    // This interval ends before the action at `at` (including a rental expiration).
    credit(city,earned,Math.max(previous,at-1))
    city.warehouseAt = at
    const regenerated = Math.floor((at - city.scoutAt) / balance.scoutRegen)
    if (regenerated > 0) {
      city.scoutPoints = Math.min(balance.scoutPoints,city.scoutPoints + regenerated)
      city.scoutAt += regenerated * balance.scoutRegen
    }
    city.spyRecovery = city.spyRecovery.filter(when => {
      if (when <= at) city.spies = Math.min(3,city.spies + 1)
      return when > at
    })
  }
  for (const item of tributes) credit(getCity(world,item.overlord),item.tribute,at-1)
}

export function completeJob(world, city, job, now) {
  const completed = {...job,completedAt:now}
  const notice = {job:completed, status:'completed'}
  if (job.kind === 'building') {
    city.buildings[job.key] = job.level
    const firstBuild = !has(city.achievements ?? {}, 'the-builder')
    award(city,'the-builder',now)
    points(city,3,'development',{kind:'building',ref:job.key+':'+job.level,since:job.startedAt,until:job.completesAt,rushed:job.rushed})
    if (['engineer','keeper'].includes(job.commander)) awardCommanderMastery(city,job.commander,'construction',now)
    notify(world,city.id,buildings[job.key].name + ' reached level ' + job.level + '.',now,'city',
      {...notice, title:'Construction complete', ...(firstBuild && {achievement:'the-builder'})})
  }
  if (job.kind === 'troop') {
    city.troops[job.key] += job.count
    notify(world,city.id,job.count + ' ' + units[job.key].name + ' completed training.',now,'army',
      {...notice,title:'Training complete'})
  }
  if (job.kind === 'research') {
    city.tech[job.key] = job.level
    points(city,3,'science',{kind:'research',ref:job.key+':'+job.level,since:job.startedAt,until:job.completesAt})
    if (job.commander==='scholar') awardCommanderMastery(city,job.commander,'research',now)
    notify(world,city.id, tech[job.key].name + ' level ' + job.level + ' researched.',now,'city',
      {...notice,title:'Research complete'})
  }
  city.queue = city.queue.filter(item => item.id !== job.id)
  limitHistory(city,completed)
}

function rollSeason(world, at) {
  const board = rankings(world).filter(city => !city.npc)
  const table = Object.fromEntries(Object.keys(world.alliances).map(id => [id,{id,name:world.alliances[id].name,score:0,territories:0}]))
  for (const row of board) if (row.alliance && has(table,row.alliance)) {
    table[row.alliance].score += row.score
    table[row.alliance].territories += row.territories
  }
  // Score events still queued belong to the season that is closing. Its final standings, with the tie-break values the
  // ranking uses, are queued as the last entry of that season's journal.
  for (const city of Object.values(world.cities)) for (const event of city.scoreEvents ?? []) event.season ??= world.season.number
  ;(world.scoreMarks ||= []).push({ season:world.season.number, kind:'season-close', at,
    ranking:board.map(row => ({ id:row.id, score:row.score, territories:row.territories, power:row.power })) })
  world.archive.unshift({...world.season, rankings:board, alliances:Object.values(table).sort((a,b) => b.score - a.score || b.territories - a.territories), finalizedAt:at})
  world.season = {number:world.season.number + 1, name:'Frontier Campaign ' + (world.season.number + 1), startedAt:at, endsAt:at + economy.seasonLength}
  for (const city of Object.values(world.cities)) {
    city.score = 0
    city.contribution = {}
  }
  activity(world,'season','A new season has opened. Prior rankings remain archived.',at)
}

function nextEvent(world, now) {
  const items = [...nextGovernanceEvents(world,now),...nextDiplomacyEvents(world,now,politicalTradeCommand),...nextPoliticalTradeEvents(world,now)]
  const npc = nextNpcEvent(world,now)
  if (npc) items.push(npc)
  const political = nextGovernmentEvent(world,now)
  if (political) items.push(political)
  const territorial = nextTerritoryEvent(world,now)
  if (territorial) items.push(territorial)
  if (world.season.endsAt <= now) {
    const at = world.season.endsAt
    items.push({at,apply:() => rollSeason(world,at)})
  }
  for (const city of Object.values(world.cities)) {
    for (const job of city.queue) if (job.completesAt <= now) items.push({at:job.completesAt,apply:() => completeJob(world,city,job,job.completesAt)})
    if (city.sabotageUntil && city.sabotageUntil <= now) items.push({at:city.sabotageUntil,apply:() => {city.sabotageUntil = 0}})
    for (const [commander, row] of Object.entries(city.commanders?.roster ?? {})) {
      const rentalEnd = row.expiresAt
      if (rentalEnd > now || !rentalEnd || row.expiryNotifiedAt === rentalEnd) continue
      if (!has(heroes,commander) || commanderOwnership(city,commander,rentalEnd-1) !== 'rented') continue
      // Splitting at the contract boundary gives the old specialist benefit only until the contract ends.
      items.push({at:Math.max(rentalEnd,world.now),apply:() => {
        row.expiryNotifiedAt = rentalEnd
        if (!city.npc) notify(world,city.id,heroes[commander].name + ' finished their contract.',rentalEnd,'army',
          {title:'Rental expired',commander,status:'expired'})
      }})
    }
  }
  for (const mission of world.missions) if (mission.status === 'pending' && mission.completesAt <= now) {
    items.push({at:mission.completesAt, apply:() => completeMission(world,mission,mission.completesAt)})
  }
  for (const treaty of world.treaties) if (['active','pending'].includes(treaty.status) && treaty.endsAt <= now) {
    items.push({at:treaty.endsAt,apply:() => {treaty.status = 'expired'}})
  }
  return items.sort((a,b) => a.at - b.at)[0]
}

export function advance(world, now = Date.now()) {
  requireRule(Number.isSafeInteger(now) && now >= world.now, 'bad_clock','Game time cannot move backwards.',400)
  retireNpcs(world,world.now)
  ensureTerritories(world,world.now)
  ensureGovernment(world,world.now)
  world.accrualCutoff = now - economy.offlineCap
  let next = nextEvent(world,now)
  while (next) {
    passiveAccrual(world,next.at)
    world.now = Math.max(world.now,next.at)
    next.apply()
    next = nextEvent(world,now)
  }
  passiveAccrual(world,now)
  world.now = now
  world.marches = world.marches.filter(march => march.at > now - DAY)
  world.missions = world.missions.filter(mission => mission.startedAt > now - 7 * DAY || mission.status === 'pending')
  // Shields given under the earlier rules (starter and recovery shields) are lifted once: this season has none.
  const liftShields = !world.shieldsLifted && !balance.defeatShield
  if (liftShields) world.shieldsLifted = true
  for (const city of Object.values(world.cities)) {
    if (liftShields && city.shieldUntil > now) city.shieldUntil = now
    openFromDayOne(city, world, now)
    city.conveniences = lastDay(city.conveniences,now)
    city.aid = lastDay(city.aid,now)
    for (const [target,intel] of Object.entries(city.intel)) if (intel.expiresAt <= now - DAY) delete city.intel[target]
  }
  return world
}

export function upgrade(world, city, input, now) {
  const preview = quoteUpgrade(city,input.building,now)
  requireRule(preview.eligible, 'building_locked',preview.reason)
  requireRule(!city.queue.some(job => job.kind === 'building'),'construction_busy','A construction slot is already in use.')
  subtract(city,preview.cost)
  const rush = city.rushCredits?.[preview.building] || 0
  if (rush > 0) city.rushCredits[preview.building]--
  const job = {id:'j' + (++world.seq),kind:'building', key:preview.building, level:preview.nextLevel, startedAt:now,commander:activeCommander(city,now),
    completesAt:now + Math.ceil(preview.duration * (rush > 0 ? 1 - economy.rushFraction : 1)), cost:preview.cost, ...(rush > 0 && {rushed:true})}
  city.queue.push(job)
  // The history of the notification centre records what was started, not only what finished.
  notify(world,city.id,buildings[job.key].name + ' upgrade to level ' + job.level + ' started.',now,'construction',{title:'Construction started',until:job.completesAt})
  return job
}

export function trainingQuote(world,city,unitId,count=1,now=world.now) {
  requireRule(has(units,unitId) && Number.isInteger(count) && count >= 1 && count <= 30,'invalid_training','Select a unit and quantity from 1–30.',400)
  const unit=units[unitId]
  const prerequisite=unitId==='siege'?{building:'workshop',level:2}:unitId==='mage'?{building:'library',level:2}:null
  const jobs = city.queue.filter(job => job.kind === 'troop')
  const deployed=deployedTroops(world,city)
  const remaining=Math.max(0,troopCap(city)-troopTotal(city.troops)-deployed.claim-deployed.political-deployed.garrison-jobs.reduce((sum,job)=>sum+job.count,0))
  const duration = Math.round(unit.time*count*trainingTimeFactor(city));
  const cost = roundCost(unit.cost,count);
  const unlocked = !prerequisite || city.buildings[prerequisite.building]>=prerequisite.level;
  const slots = trainingSlots(city);
  const startsAt = Math.max(now,...jobs.map(job => job.completesAt));
  let blocked;
  if (!unlocked) blocked = ['unit_locked','Siege requires Workshop 2 and War Mage requires Research Library 2.'];
  else if (jobs.length >= slots) blocked = ['training_busy','The Barracks training queue is full.'];
  else if (count > remaining) blocked = ['troop_capacity','Your army capacity would be exceeded.'];
  else if (resources.some(resource => city.resources[resource] < cost[resource])) {
    blocked = ['insufficient_resources','There are insufficient earned resources for this action.'];
  }
  return {unit:unitId,count,duration,cost,prerequisite,unlocked,slots,spaceRemaining:remaining,queued:jobs.length,
    upkeepPerHour:economy.maintenance*count,startsAt,completesAt:startsAt+duration,available:!blocked,eligible:!blocked,
    code:blocked?.[0]??null,reason:blocked?.[1]??null};
}

export function train(world, city, input, now) {
  requireRule(Number.isInteger(input.count),'invalid_training','Select a unit and quantity from 1–30.',400)
  const preview=trainingQuote(world,city,input.unit,input.count,now)
  requireRule(preview.eligible,preview.code,preview.reason)
  subtract(city,preview.cost)
  const job = {id:'j' + (++world.seq),kind:'troop',key:input.unit,count:input.count,startedAt:preview.startsAt,
    completesAt:preview.completesAt,cost:preview.cost}
  city.queue.push(job)
  notify(world,city.id,'Training ' + job.count + ' ' + units[job.key].name + '.',now,'training',{title:'Training started',until:job.completesAt})
  return job
}

export function researchQuote(city,key,now=ruleClock(city)) {
  requireRule(has(tech,key),'invalid_research','Select a technology.',400)
  const profile=tech[key], current=city.tech[key], next=current<4?current+1:null
  const unrounded={logistics:6,fortification:1,tactics:2,signals:4}[key]
  return {current,next,maxLevel:4,requiresLibrary:next?profile.library+next-1:null,
    eligible:!!next&&city.buildings.library>=profile.library+next-1,
    value:current*unrounded,nextValue:next===null?null:next*unrounded,unit:key==='fortification'?'wall level':'%',
    cost:next?roundCost(profile.cost,1.5**(next-1)*(1-(commanderEffects(city,city.hero,now).researchReduction??0))):null,
    duration:next===null?null:next*45_000}
}

export function research(world, city, input, now) {
  const preview=researchQuote(city,input.tech,now)
  requireRule(preview.eligible,'research_locked','Upgrade the Research Library to unlock this tier.')
  requireRule(!city.queue.some(job => job.kind === 'research'),'research_busy','One technology is already being researched.')
  const cost = preview.cost
  subtract(city,cost)
  const job = {id:'j' + (++world.seq),kind:'research',key:input.tech,level:preview.next,startedAt:now,completesAt:now+preview.duration,cost,commander:activeCommander(city,now)}
  city.queue.push(job)
  notify(world,city.id,tech[job.key].name + ' tier ' + job.level + ' research started.',now,'research',{title:'Research started',until:job.completesAt})
  return job
}

export function marketQuote(city,input,now=ruleClock(city)) {
  const {give,take,amount} = input
  const valid = typeof give === 'string' && typeof take === 'string' && has(city.resources,give) && has(city.resources,take) && give !== take
  requireRule(valid && Number.isSafeInteger(amount) && amount >= 10 && amount <= 500,'invalid_exchange','Select different resources and an amount from 10 to 500.',400)
  const rate = marketRate(city,now)
  const unitRate = resourceValues[give] / resourceValues[take] * rate
  const received = Math.floor(amount * resourceValues[give] / resourceValues[take] * rate)
  const balance = city.resources[give]
  const receiveBalance = city.resources[take]
  const receiveCapacity = stockCapacity(city,now)[take]
  const blocked = received <= 0 ? ['exchange_too_small','Increase the exchange quantity.'] :
    receiveBalance + received > receiveCapacity ? ['storage_full','Your warehouse lacks space for the trade.'] :
    balance < amount ? ['insufficient_resources','There are insufficient earned resources for this action.'] : null
  return {give,take,amount,received,rate,unitRate,feePercent:Math.round((1-rate)*100),
    balance,receiveBalance,receiveCapacity,eligible:!blocked,code:blocked?.[0] ?? null,reason:blocked?.[1] ?? null}
}

export function market(city,input,now=ruleClock(city)) {
  const quote = marketQuote(city,input,now)
  requireRule(quote.eligible,quote.code,quote.reason)
  const {give,take,amount,received} = quote
  requireRule(input.quotedReceived === undefined || input.quotedReceived === received,
    'market_quote_changed','The exchange rate changed. Review the updated quote before trading.')
  subtract(city,{[give]:amount})
  credit(city,{[take]:received},now)
  if (amount>=100 && activeCommander(city,now)==='merchant') awardCommanderMastery(city,'merchant','trade',now)
  const history = city.marketHistory ??= []
  const receipt = {...quote,id:'trade-' + ((history[0]?.sequence ?? 0)+1),sequence:(history[0]?.sequence ?? 0)+1,at:now}
  history.unshift(receipt)
  if (history.length > 30) history.pop()
  return receipt
}

export function dailyReward(city,now) {
  const lastClaimedAt = city.dailyClaim?.at ?? (city.lastCollect || null)
  const availableAt = lastClaimedAt === null ? 0 : lastClaimedAt + DAY
  return {status:availableAt <= now ? 'available' : 'claimed',reward:dailyLevy,
    claimable:creditableResources(city,dailyLevy,now),lastClaimedAt,availableAt,lastClaim:city.dailyClaim ?? null}
}

export function collect(world,city,now) {
  requireRule(dailyReward(city,now).status==='available', 'levy_recent','The civic levy is available once per rolling day.')
  city.lastCollect = now
  const collected = credit(city,dailyLevy,now)
  city.dailyClaim = {collected,at:now,availableAt:now + DAY}
  notify(world,city.id,'The civic levy was delivered to your warehouse.',now,'city',
    {title:'Reward claimed',resources:collected,status:'claimed'})
  return city.dailyClaim
}

export function convenience(world, city, input, now) {
  requireRule(has(buildings,input.building),'invalid_building','Select a building.',400)
  const profile = buildings[input.building]
  requireRule(city.conveniences.length < economy.paidConvenienceDaily,'paid_daily_cap','Paid convenience is capped at one per rolling day.')
  if (input.type === 'premium') {
    requireRule(profile.premium,'premium_unavailable','This building has no premium upgrade.')
    requireRule(!city.perks[input.building],'premium_owned','Your city already owns this premium improvement.')
    city.perks[input.building] = {name:profile.premium,at:now}
  } else {
    // A rush speeds up a construction in progress, once. It is not sold for a building that is not being built.
    const key = input.building
    const job = city.queue.find(item => item.kind === 'building' && item.key === key)
    requireRule(job,'rush_no_construction','Start the upgrade first: a rush speeds up a construction in progress.')
    requireRule(!job.rushed,'rush_used','This construction has already been rushed.')
    job.completesAt = now + Math.ceil((job.completesAt - now) * (1 - economy.rushFraction))
    job.rushed = true
  }
  city.conveniences.push({type:input.type,building:input.building,at:now})
  const job = city.queue.find(item => item.kind === 'building' && item.key === input.building)
  const message = input.type === 'premium' ? profile.premium + ' is now yours.' : profile.name + ' rushed: it finishes sooner.'
  notify(world,city.id,message,now,'receipt',{title:input.type === 'premium' ? 'Premium upgrade' : 'Construction rushed',building:input.building,
    ...(job && {completesAt:job.completesAt})})
  return {building:input.building,perks:city.perks,rushCredits:city.rushCredits,queue:city.queue}
}
