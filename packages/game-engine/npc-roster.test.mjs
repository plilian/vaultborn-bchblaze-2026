// Five NPC kingdoms stay; seven leave a world that still has them, once, and their places go to new players.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DAY} from '../../config/economy.mjs'
import {addPlayer,advance,command,createWorld,snapshot} from './index.mjs'
import {newCity} from './world.mjs'
import {ensureTerritories} from './territories.mjs'
import {retiredNpcIds,retireNpcs} from './npc-roster.mjs'
import {retiredNpcPlots} from './frontier-layout.mjs'

const T = 80 * DAY
// The seven kingdoms as the first release seeded them.
const earlier = {p5:['Lakespire','azure',.27,.60], p7:['Sandcrest','crimson',.72,.72], p11:['Duskmarket','violet',.75,.55], p13:['Oakmere','azure',.23,.77],
  p14:['Cinderwall','crimson',.63,.85], p15:['Starfall','violet',.77,.20], p16:['Dawnport','gold',.43,.59]}
function releasedWorld() {
  const world = Object.assign(createWorld(T),{secret:'npc-roster-test'})
  delete world.npcRoster
  for (const [id,[cityName,faction,x,y]] of Object.entries(earlier)) world.cities[id] = newCity({id,name:cityName+' court',cityName,faction,x,y,npc:true,shields:false},T)
  return world
}

test('a new world has five NPC kingdoms, and new players are placed where the retired ones stood', () => {
  const world = createWorld(T)
  assert.deepEqual(Object.values(world.cities).filter(city => city.npc).map(city => city.id), ['p6','p8','p9','p10','p12'])
  assert.deepEqual(Object.entries(earlier).map(([,[, ,x,y]]) => [x,y]), retiredNpcPlots)
  const first = addPlayer(world,{id:'arrival'},T)
  assert.deepEqual([first.x,first.y],retiredNpcPlots[0])
  // Every camp still has an NPC warden.
  for (const camp of ensureTerritories(world,T).filter(site => site.frontierCamp)) assert.equal(world.cities[camp.owner].npc,true)
})

test('a world that still has the seven loses them once, with their camps, homelands, missions and treaties settled', () => {
  let world = releasedWorld()
  ensureTerritories(world,T)
  addPlayer(world,{id:'scout'},T)
  command(world,'scout',{type:'found',cityName:'Watchful',faction:'emerald'},T)
  // An earlier release: Duskmarket guarded Blackridge Camp, the scout is on its way to Starfall and has a ceasefire with Oakmere.
  const camp = world.territories.find(site => site.id === 'blackridge-camp')
  Object.assign(camp,{owner:'p11',controller:'p11',frontierWarden:'p11'})
  world.territories.push({...structuredClone(world.territories.find(site => site.id === 'starter-p1')),id:'starter-p5',owner:'p5',controller:'p5',x:.27,y:.60})
  world.missions.unshift({id:'m-old',actor:'scout',target:'p15',mission:'recon',status:'pending',startedAt:T,completesAt:T + 600_000})
  world.missions.unshift({id:'m-npc',actor:'p13',target:'scout',mission:'recon',status:'pending',startedAt:T,completesAt:T + 600_000})
  world.treaties.unshift({id:'t-old',kind:'ceasefire',from:'scout',to:'p13',status:'active',createdAt:T,expiresAt:T + DAY})
  world.cities.scout.intel.p14 = {actor:'scout',target:'p14',expiresAt:T + DAY}
  world.notifications.p7 = [{id:'n-x',text:'old',at:T}]

  advance(world,T + 1000)
  for (const id of retiredNpcIds) assert.equal(world.cities[id],undefined)
  assert.equal(Object.values(world.cities).filter(city => city.npc).length,5)
  assert.equal(world.npcRoster,5)
  assert.equal(camp.owner,'p6')
  assert.equal(camp.frontierWarden,'p6')
  assert.equal(world.territories.some(site => site.id === 'starter-p5'),false)
  assert.equal(world.missions.find(item => item.id === 'm-old').status,'cancelled')
  assert.equal(world.missions.some(item => item.id === 'm-npc'),false)
  assert.equal(world.treaties.some(item => item.id === 't-old'),false)
  assert.equal(world.cities.scout.intel.p14,undefined)
  assert.equal(world.notifications.p7,undefined)
  assert.ok(world.notifications.scout.some(entry => entry.title === 'Mission called back'))
  assert.ok(world.activity.some(entry => /left the Emerald Frontier/.test(entry.text)))
  // Once only, and the world keeps working after a save.
  assert.equal(retireNpcs(world,T + 2000),false)
  world = JSON.parse(JSON.stringify(world))
  advance(world,T + 2 * DAY)
  assert.ok(snapshot(world,'scout').cities.every(city => !retiredNpcIds.includes(city.id)))
  const arrival = addPlayer(world,{id:'arrival'},T + 2 * DAY)
  assert.deepEqual([arrival.x,arrival.y],retiredNpcPlots[0])
})
