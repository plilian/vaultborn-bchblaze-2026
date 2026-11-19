import assert from 'node:assert/strict'
import {test} from 'node:test'
import {economy} from '../../config/economy.mjs'
import {command} from './index.mjs'
import {atlasView,frontierCapacity} from './frontier-layout.mjs'
import {ensureTerritories,territoryRules} from './territories.mjs'
import {addPlayer,createWorld,newCity} from './world.mjs'

const now = 1_800_000_000_000
const add = (world, number) => addPlayer(world,{id:'resident-'+number},now)
const position = ({x,y}) => [x,y]
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y)

test('legacy settlement locations and the original atlas survive migration', () => {
  const world = createWorld(now)
  const original = Object.values(world.cities).map(position)
  // Older releases could create a settlement on a clearing without a plot identifier.
  const historical = newCity({id:'historic',name:'Commander Rowan',cityName:'Moor Hall',faction:'emerald',x:.91,y:.13},now)
  world.cities[historical.id] = historical
  const city = add(world,1)
  assert.deepEqual(Object.values(world.cities).slice(0,original.length).map(position),original)
  assert.equal(world.cities[historical.id],historical)
  assert.ok(distance(city,historical) >= .123)
  assert.deepEqual(atlasView(world,historical).regions.map(region=>region.id), ['core'])
  assert.equal(add(world,1),city)
  const homeland = ensureTerritories(world).find(site=>site.id==='starter-'+city.id)
  assert.equal(homeland.protected,true)
  assert.equal(homeland.owner,city.id)
  assert.deepEqual(position(homeland),position(city))
})

test('opens the next region only on demand, with a reachable camp and staged ordinary sites', () => {
  const world = createWorld(now)
  const initial = ensureTerritories(world).filter(site=>!site.protected).map(site=>[site.id,...position(site)])
  for (let number=0;number<frontierCapacity;number++) add(world,number)
  assert.equal(world.atlas.regions.length,1)
  for (let residents=1;residents<=frontierCapacity;residents++) {
    const city = add(world,frontierCapacity+residents-1)
    assert.equal(city.region,'region-1')
    const before = ensureTerritories(world).filter(site=>site.region===city.region&&site.category==='unclaimed')
    assert.equal(before.length,residents<2 ? 0 : residents<7 ? 1 : residents<12 ? 2 : 3)
    command(world,city.id,{type:'found',name:'Guide',cityName:'Amber House '+residents,faction:'emerald'},now)
    command(world,city.id,{type:'tutorial',action:'skip',step:'welcome'},now)
    const regional = ensureTerritories(world).filter(site=>site.region===city.region&&!site.protected)
    assert.equal(regional.filter(site=>site.category==='unclaimed').length,
      residents<6 ? 1 : residents<11 ? 2 : 3)
    const camp = regional.find(site=>site.frontierCamp)
    assert.ok(distance(city,camp)<=territoryRules.supplyRange)
    assert.equal(world.cities[camp.owner].npc,true)
  }
  assert.equal(world.atlas.regions.length,2)
  assert.deepEqual(ensureTerritories(world).filter(site=>!site.protected&&!site.region).map(site=>[site.id,...position(site)]),initial)
  const next = add(world,2*frontierCapacity)
  assert.equal(next.region,'region-2')
})

test('one thousand protected placements remain unique after save and reload', () => {
  let world = createWorld(now)
  const original = Object.values(world.cities)
  const initialSites = ensureTerritories(world).filter(site=>['rare','strategic'].includes(site.category)).map(site=>site.id)
  for (let number=0;number<1000;number++) {
    if (number===500) world = JSON.parse(JSON.stringify(world))
    add(world,number)
  }
  const players = Object.values(world.cities).filter(city=>city.id.startsWith('resident-'))
  const sites = ensureTerritories(world)
  const byOwner = new Map()
  for (const site of sites.filter(site=>site.protected)) {
    if (!byOwner.has(site.owner)) byOwner.set(site.owner,[])
    byOwner.get(site.owner).push(site)
  }
  assert.equal(players.length,1000)
  const guards = Object.values(world.cities).filter(city=>city.id.endsWith('-warden'))
  assert.equal(guards.length,62)
  const occupied = [...original,...guards]
  for (const city of players) {
    assert.ok(occupied.every(previous=>distance(city,previous)>=.123),city.id)
    occupied.push(city)
    const home = byOwner.get(city.id)
    assert.equal(home.length,1)
    assert.equal(home[0].id,'starter-'+city.id)
    assert.equal(home[0].nextUpkeep,null)
    assert.ok(Object.values(home[0].production).every(amount=>amount===0))
    assert.equal(city.shieldUntil,0)   // no starter shield: everything is open from the first day
  }
  assert.deepEqual(sites.filter(site=>['rare','strategic'].includes(site.category)).map(site=>site.id),initialSites)
  const atlas = atlasView(world,players.at(-1))
  assert.equal(atlas.regions.length,63)
  const seen = new Set(['core'])
  for (const region of atlas.regions.slice(1)) {
    assert.ok(region.neighbors.some(id=>seen.has(id)),region.id)
    seen.add(region.id)
  }
  assert.deepEqual(atlasView(JSON.parse(JSON.stringify(world)),players.at(-1)),atlas)
})
