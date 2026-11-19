import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DAY,HOUR,MINUTE,economy,resources} from '../../config/economy.mjs'
import {balance} from '../../config/balance.mjs'
import {addPlayer,advance,attackEligibility,command,createWorld,quote,snapshot} from './index.mjs'
import {digest,simulateBattle,unitIds} from './combat.mjs'
import {stockCapacity} from './world.mjs'

const T = DAY
const seed = () => Object.assign(createWorld(T),{secret:'test-seed-v1'})
const call = (world, actor, type, data = {}, paid = false) => command(world,actor,{type,...data},world.now,{paid})
const error = code => ({code})

test('seeded demo exposes 16 cities, two independent alliances and a fair rival', () => {
  const world = seed()
  const view = snapshot(world,'p1')
  assert.equal(view.cities.length,16)
  assert.equal(view.alliances.length,2)
  assert.equal(view.player.name,'Riverhold')
  const enemy = view.cities.find(city => city.id === 'p2')
  assert.equal(enemy.eligibility.ok,true)
  assert.equal(enemy.garrison,null)
  assert.ok(!('resources' in enemy))
  assert.ok(!JSON.stringify(view).includes(world.secret))
})

test('founding, tutorial, enrollment, recruitment, Hall dependency and timer survive JSON round trip', () => {
  let world = seed()
  addPlayer(world,{id:'v1',name:'Norah',faction:'azure',cityName:'Old Harbor'},T)
  // A new kingdom is in the season, unshielded and unlocked from its first day; the guide is optional.
  assert.deepEqual([world.cities.v1.optIn,world.cities.v1.shieldUntil,world.cities.v1.tutorial,world.cities.v1.tutorialOpen],[true,0,true,true])
  call(world,'v1','found',{cityName:'New Harbor',faction:'violet'})
  assert.throws(() => call(world,'v1','found',{cityName:'Another Harbor',faction:'azure'}),error('founding_closed'))
  call(world,'v1','tutorial',{action:'skip',step:'welcome'})
  assert.throws(() => call(world,'v1','tutorial'),error('tutorial_complete'))
  call(world,'v1','opt-in',{enabled:true})
  assert.throws(() => call(world,'v1','upgrade',{building:'farm'}),error('building_locked'))
  const build = call(world,'v1','upgrade',{building:'hall'})
  const army = call(world,'v1','train',{unit:'infantry',count:10})
  assert.throws(() => call(world,'v1','upgrade',{building:'hall'}),error('construction_busy'))
  assert.throws(() => call(world,'v1','train',{unit:'infantry',count:10}),error('training_busy'))
  const troops = world.cities.v1.troops.infantry
  world = JSON.parse(JSON.stringify(world))
  advance(world,build.completesAt)
  assert.equal(world.cities.v1.buildings.hall,2)
  assert.equal(world.cities.v1.troops.infantry,troops + army.count)
  assert.equal(snapshot(world,'v1').player.name,'New Harbor')
})

test('passive production conserves integer resources over small intervals and caps warehouses', () => {
  const elapsed = HOUR * 5 + 215
  const segmented = seed()
  const whole = seed()
  for (let time = MINUTE; time < elapsed; time += MINUTE) advance(segmented,T+time)
  advance(segmented,T+elapsed)
  advance(whole,T+elapsed)
  assert.deepEqual(segmented.cities.p1.resources,whole.cities.p1.resources)
  const emptied = seed()
  for (const resource of resources) emptied.cities.p1.resources[resource] = 0
  const clone = structuredClone(emptied)
  advance(emptied,T+DAY)
  advance(clone,T+economy.offlineCap)
  assert.deepEqual(emptied.cities.p1.resources,clone.cities.p1.resources)
  advance(whole,T+10*DAY)
  for (const resource of resources) {
    const amount = whole.cities.p1.resources[resource]
    assert.ok(Number.isSafeInteger(amount) && amount <= stockCapacity(whole.cities.p1)[resource])
  }
})

test('resources, training, market and polymorphic input cannot overdraw or bypass queue rules', () => {
  const world = seed()
  const before = structuredClone(world.cities.p1.resources)
  for (const attempt of [
    {type:'upgrade',building:'constructor'},
    {type:'train',unit:'infantry',count:-1},
    {type:'trade',give:'wood',take:'iron',amount:-3},
    {type:'trade',give:'wood',take:'iron',amount:Number.MAX_SAFE_INTEGER},
    {type:'trade',give:'__proto__',take:'iron',amount:30},
  ]) assert.throws(() => command(world,'p1',attempt))
  assert.deepEqual(world.cities.p1.resources,before)
  world.cities.p1.resources.wood = 0
  assert.throws(() => call(world,'p1','upgrade',{building:'hall'}),error('insufficient_resources'))
  assert.equal(world.cities.p1.resources.wood,0)
})

test('payment quotes are pure, require external verification and respect convenience caps', () => {
  const world = seed()
  const before = structuredClone(world)
  const intent = quote(world,'p1',{type:'premium',building:'hall',satoshis:1})
  assert.equal(intent.satoshis,22_000)
  assert.deepEqual(intent.action,{type:'premium',building:'hall'})
  assert.deepEqual(world,before)
  assert.throws(() => command(world,'p1',intent.action),error('payment_required'))
  call(world,'p1','premium',{building:'hall'},true)
  assert.ok(world.cities.p1.perks.hall)
  assert.throws(() => call(world,'p1','rush',{building:'hall'},true),error('paid_daily_cap'))
  advance(world,T+DAY)
  call(world,'p1','rush',{building:'hall'},true)
  const next = call(world,'p1','upgrade',{building:'hall'})
  assert.equal(next.completesAt - next.startedAt,62_098)
  assert.equal(world.cities.p1.rushCredits.hall,0)
})

test('combat is reproducible, integer, capped and funded with ordinary resources only', () => {
  const world = seed()
  const attack = quote(world,'p1',{type:'attack-paid',target:'p2',tactic:'flank',formation:'wedge'})
  assert.equal(attack.satoshis,economy.fees.attack)
  const report = command(world,'p1',attack.action,T,{paid:true})
  assert.equal(report.commitment,digest({input:report.input,seed:report.seed}))
  assert.equal(simulateBattle(report.input,report.seed).hash,report.hash)
  for (let seedIndex = 0; seedIndex < 200; seedIndex++) {
    const result = simulateBattle(report.input,seedIndex)
    assert.equal(result.events.length,9)
    for (const side of ['attacker','defender']) for (const unit of unitIds) {
      assert.ok(Number.isInteger(result.losses[side][unit]))
      assert.ok(result.losses[side][unit] >= 0 && result.losses[side][unit] <= Math.floor(report.input[side].troops[unit] * .48))
    }
  }
  assert.deepEqual(Object.keys(report.loot).sort(),resources.toSorted())
  assert.equal(snapshot(world,'p1').player.attacksLeft,2)
  assert.throws(() => quote(world,'p1',attack.action))
  assert.equal(world.battles.length,1)
})

test('attack caps apply to both paid and free routes, protect beginners and aggregate alliances', () => {
  const world = seed()
  const actor = world.cities.p1
  const target = world.cities.p2
  assert.equal(attackEligibility(world,actor,world.cities.p4).code,'power_gap')
  target.shieldUntil = T + HOUR
  assert.equal(attackEligibility(world,actor,target).code,'protected')
  target.shieldUntil = 0
  for (let index = 0; index < 3; index++) world.marches.push({kind:'raid',attacker:'p1',defender:'p' + (index + 5),at:T-MINUTE,alliance:actor.alliance})
  assert.equal(attackEligibility(world,actor,target).code,'attack_limit')
  assert.throws(() => quote(world,'p1',{type:'attack-paid',target:'p2'}),error('attack_limit'))
  world.marches.length = 0
  world.marches.push({kind:'raid',attacker:'p3',defender:'p2',at:T-MINUTE,alliance:actor.alliance})
  assert.equal(attackEligibility(world,actor,target).code,'alliance_repeat')
})

test('espionage resolves, counterspy reduces success, sabotage is bounded and reports stay private', () => {
  let report
  let ordinarySuccess = 0
  let screenedSuccess = 0
  let sabotages = 0
  for (let iteration = 0; iteration < 80; iteration++) {
    const world = seed()
    world.secret += String(iteration)
    const screened = structuredClone(world)
    screened.cities.p2.counterspyUntil = T + balance.counterspyDuration
    const baseline = call(world,'p1','scout',{target:'p2',mission:'sabotage'})
    const monitored = call(screened,'p1','scout',{target:'p2',mission:'sabotage'})
    advance(world,baseline.completesAt)
    advance(screened,monitored.completesAt)
    if (monitored.status === 'success') screenedSuccess++
    if (baseline.status === 'success') {
      ordinarySuccess++
      report = baseline.intel
      assert.equal(snapshot(world,'p2').missions.length,0)
      assert.equal(snapshot(world,'p3').cities.find(city => city.id === 'p2').intel,null)
      assert.equal(world.cities.p2.sabotageUntil,world.now + balance.sabotageDuration)
      assert.equal(snapshot(world,'p1').cities.find(city => city.id === 'p2').intel.id,report.id)
      call(world,'p1','share-intel',{target:'p2'})
      assert.equal(snapshot(world,'p3').cities.find(city => city.id === 'p2').intel.sharedBy,'p1')
      advance(world,world.now+balance.sabotageDuration)
      assert.equal(world.cities.p2.sabotageUntil,0)
      sabotages++
    }
  }
  assert.ok(ordinarySuccess > screenedSuccess && sabotages > 0)
  assert.ok(report.confidence < 1)
  const world = seed()
  call(world,'p2','counterspy')
  assert.throws(() => call(world,'p2','counterspy'),error('counterspy_cooldown'))
})

test('protectorate has its own fee, independent recipient consent, capped production tribute, and automatic expiry', () => {
  const world = seed()
  world.cities.p4.npc = false
  const {action,satoshis} = quote(world,'p1',{type:'protectorate',target:'p4'})
  assert.equal(satoshis,economy.fees.protectorate)
  assert.equal(satoshis,24_000)
  const pact = command(world,'p1',action,T,{paid:true})
  assert.equal(pact.status,'pending')
  assert.equal(pact.respondBy,T+economy.protectorateResponseTime)
  assert.throws(() => call(world,'p1','respond',{id:pact.id,decision:'accept'}),error('not_defender'))
  assert.throws(() => quote(world,'p1',action),error('political_slot'))
  call(world,'p4','respond',{id:pact.id,decision:'accept'})
  assert.equal(pact.status,'active')
  const withPact = structuredClone(world)
  const baseline = structuredClone(world)
  baseline.governance = []
  advance(withPact,T+HOUR)
  advance(baseline,T+HOUR)
  assert.ok(withPact.cities.p4.resources.wood < baseline.cities.p4.resources.wood)
  assert.ok(withPact.cities.p1.resources.wood > baseline.cities.p1.resources.wood)
  assert.equal(withPact.cities.p1.resources.wood + withPact.cities.p4.resources.wood, baseline.cities.p1.resources.wood + baseline.cities.p4.resources.wood)
  advance(world,T+economy.protectorateTerm)
  assert.equal(pact.status,'expired')
  assert.ok(world.cities.p4.immunityUntil > world.now)
})

test('rebel preparations remain covert, mobilize after countdown and settle with success or recovery', () => {
  const outcomes = new Set()
  for (let iteration = 0; iteration < 30; iteration++) {
    const world = seed()
    world.secret += String(iteration)
    world.cities.p4.npc = false
    call(world,'p4','configure',{hero:'queen',formation:'wedge',tactic:'assault'})
    const pact = call(world,'p1','protectorate',{target:'p4'},true)
    call(world,'p4','respond',{id:pact.id,decision:'accept'})
    call(world,'p4','rebellion-prepare',{id:pact.id})
    call(world,'p4','rebellion-prepare',{id:pact.id})
    assert.equal(snapshot(world,'p1').politics[0].rebellion,null)
    assert.throws(() => call(world,'p4','rebel',{id:pact.id}),error('rebellion_not_ready'))
    advance(world,pact.rebellion.readyAt)
    call(world,'p4','rebel',{id:pact.id})
    assert.equal(snapshot(world,'p1').politics[0].rebellion.status,'mustering')
    if (iteration % 2 === 0) call(world,'p1','rebellion-respond',{id:pact.id,decision:'reinforce'})
    advance(world,pact.rebellion.resolveAt)
    assert.equal(world.battles[0].kind,'rebellion')
    outcomes.add(pact.rebellion.status)
    if (pact.rebellion.status === 'failed') {
      assert.equal(pact.status,'active')
      assert.ok(pact.rebellion.retryAt > world.now)
    } else {
      assert.equal(pact.status,'liberated')
      assert.ok(world.cities.p4.immunityUntil > world.now)
    }
  }
  assert.deepEqual(outcomes,new Set(['failed','liberated']))
})

test('alliance messages are scoped and diplomatic agreements affect attack eligibility', () => {
  const world = seed()
  const treaty = call(world,'p1','treaty',{target:'crimson-legion',kind:'nonaggression'})
  assert.throws(() => call(world,'p3','treaty-respond',{id:treaty.id,accept:true}),error('not_treaty_receiver'))
  call(world,'p2','treaty-respond',{id:treaty.id,accept:true})
  assert.equal(attackEligibility(world,world.cities.p1,world.cities.p2).code,'friendly')
  assert.throws(() => call(world,'p2','treaty',{target:'emerald-watch',kind:'war'}),error('treaty_conflict'))
  call(world,'p1','chat',{channel:'alliance',text:'Keep our plan private.'})
  assert.equal(snapshot(world,'p2').messages.length,0)
  assert.equal(snapshot(world,'p3').messages.length,1)
})

test('season rollover archives standings and resets score while active incumbents retain ownership', () => {
  const world = seed()
  call(world,'p1','tutorial')
  world.nodes[0].owner = 'p1'
  world.cities.p1.score += 8
  const season = world.season.number
  const end = world.season.endsAt
  for (let now = T + 12*HOUR; now < end; now += 12*HOUR) {
    advance(world,now)
    call(world,'p1','configure',{tactic:'balanced'})
  }
  advance(world,end)
  assert.equal(world.season.number,season+1)
  assert.equal(world.archive[0].rankings[0].id,'p1')
  assert.equal(world.archive[0].rankings[0].territories,1)
  assert.equal(world.cities.p1.score,0)
  assert.equal(world.nodes[0].owner,'p1')
})

test('treaty acceptance rechecks jurisdiction after a competing war declaration', () => {
  const world = seed()
  const proposal = call(world,'p1','treaty',{target:'crimson-legion',kind:'defense'})
  call(world,'p2','treaty',{target:'emerald-watch',kind:'war'})
  assert.throws(() => call(world,'p2','treaty-respond',{id:proposal.id,accept:true}),error('treaty_conflict'))
  assert.equal(proposal.status,'pending')
  const ceasefire = call(world,'p1','treaty',{target:'crimson-legion',kind:'ceasefire'})
  call(world,'p2','treaty-respond',{id:ceasefire.id,accept:true})
  call(world,'p2','treaty-respond',{id:proposal.id,accept:true})
  assert.equal(proposal.status,'active')
})

test('legacy instant claims cannot bypass confirmed territorial contests', () => {
  const world = seed()
  world.nodes[0].owner = 'p1'
  world.nodes[1].owner = 'p3'
  world.nodes[2].owner = 'p12'
  assert.throws(() => call(world,'p3','claim-node',{id:world.nodes[3].id}),error('territory_contest_required'))
  assert.equal(world.nodes[3].owner,undefined)
})
