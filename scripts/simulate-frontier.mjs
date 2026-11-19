import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DAY, resources } from '../config/economy.mjs';
import { addPlayer, advance, command, createWorld } from '../packages/game-engine/index.mjs';
import { atlasView } from '../packages/game-engine/frontier-layout.mjs';
import { ensureTerritories } from '../packages/game-engine/territories.mjs';
import { stockCapacity } from '../packages/game-engine/world.mjs';

const startedAt = 1_800_000_000_000;
const populations = [0,1,2,5,10,20,50,100,500,1000];
const results = [];

for (const population of populations) {
  const started = performance.now();
  const world = createWorld(startedAt);
  world.secret = 'frontier-simulation-v1';
  const players = Array.from({ length: population }, (_, index) =>
    addPlayer(world, { id: 'human-' + index }, startedAt));
  const territories = ensureTerritories(world);
  const protectedHomes = territories.filter(site => site.protected && site.owner.startsWith('human-'));
  assert.equal(protectedHomes.length, population);
  assert.equal(new Set(protectedHomes.map(site=>site.x+':'+site.y)).size,population);
  assert.equal(territories.filter(site=>site.category==='strategic').length,3);
  assert.equal(territories.filter(site=>site.category==='rare').length,2);
  const allocatedMs = Math.round(performance.now()-started);

  for (const city of players) {
    command(world,city.id,{type:'found',cityName:'March ' + city.id,name:'Commander ' + city.id,faction:'emerald'},startedAt);
    command(world,city.id,{type:'tutorial',action:'skip',step:'welcome'},startedAt);
    command(world,city.id,{type:'collect'},startedAt);
    command(world,city.id,{type:'upgrade',building:'hall'},startedAt);
    command(world,city.id,{type:'train',unit:'infantry',count:6},startedAt);
  }
  const time = startedAt+DAY;
  advance(world,time);
  for (const city of Object.values(world.cities)) {
    const capacity = stockCapacity(city,time);
    for (const id of resources) assert.ok(city.resources[id]>=0 && city.resources[id]<=capacity[id]);
  }
  const developed = players.filter(city=>city.buildings.hall===2 && city.troops.infantry===25).length;
  assert.equal(developed,population);
  const atlas = atlasView(world,players[0] ?? world.cities.p1);
  const npcs = Object.values(world.cities).filter(city=>city.npc);
  assert.ok(population>0 ? !!world.npcPulseAt : !world.npcPulseAt);
  results.push({
    activePlayers:population,
    protectedCastles:protectedHomes.length,
    regions:atlas.regions.length,
    newPermanentSites:territories.filter(site=>site.region && site.category==='unclaimed').length,
    newCamps:territories.filter(site=>site.region && site.frontierCamp).length,
    npcCastles:npcs.length,
    npcOrdersCompleted:npcs.reduce((total,city)=>total+city.history.length,0),
    castleAndRecruitsCompleted:developed,
    allocationMs:allocatedMs,
    fullDaySimulationMs:Math.round(performance.now()-started),
  });
}

console.log(JSON.stringify({
  scenario:'One game day with one logged-in ordering round per simulated player and no blockchain provider.',
  results,
}, null, 2));
