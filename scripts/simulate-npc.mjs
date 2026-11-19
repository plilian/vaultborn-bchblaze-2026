import assert from 'node:assert/strict';
import { DAY, HOUR, resources } from '../config/economy.mjs';
import { addPlayer, advance, command, createWorld } from '../packages/game-engine/index.mjs';
import { expeditionEligibility, expeditionRules } from '../packages/game-engine/npc.mjs';
import { combatPower, stockCapacity } from '../packages/game-engine/world.mjs';

const start = 70 * DAY;
const populations = [0,1,2,5,10,20,50,100,500,1000];

function frontier(population) {
  const world = createWorld(start);
  world.secret = 'npc-population-fixture';
  const players = Array.from({length:population},(_,index)=>{
    const city = addPlayer(world,{id:'expedition-test-'+index});
    command(world,city.id,{type:'found',cityName:'Harbor '+(index+1),faction:'azure'});
    command(world,city.id,{type:'tutorial',step:'welcome',action:'skip'});
    return city;
  });
  const npcs = Object.values(world.cities).filter(city=>city.npc);
  let launches = 0;
  let victories = 0;
  let scoutingMissions = 0;
  const sorties = new Map();
  const targetLastChallenged = new Map();
  const loot = Object.fromEntries(resources.map(resource=>[resource,0]));

  for (const hour of [0,2,4,6,8]) {
    advance(world,start+hour*HOUR);
    scoutingMissions = Math.max(scoutingMissions,world.missions.filter(mission=>world.cities[mission.actor].npc).length);
    // Rotate which human tests availability first in each window.
    const cursor = (hour*17) % Math.max(1,players.length);
    const ordered = [...players.slice(cursor),...players.slice(0,cursor)];
    const targets = npcs.toSorted((left,right)=>combatPower(left)-combatPower(right));
    for (const player of ordered) {
      const target = targets.find(city=>expeditionEligibility(world,player,city).ok);
      if (!target) continue;
      const at = world.now;
      const last = targetLastChallenged.get(target.id) ?? -Infinity;
      assert.ok(at-last>=expeditionRules.targetCooldown);
      targetLastChallenged.set(target.id,at);
      const combined = Object.fromEntries(resources.map(resource=>[resource,player.resources[resource]+target.resources[resource]]));
      const report = command(world,player.id,{type:'expedition',target:target.id,formation:'wedge',tactic:'flank'},at);
      launches++;
      victories += Number(report.winner==='attacker');
      const count = (sorties.get(player.id) ?? 0)+1;
      sorties.set(player.id,count);
      assert.ok(count<=expeditionRules.dailyLimit);
      assert.equal(report.paid,false);
      for (const resource of resources) {
        loot[resource] += report.loot[resource];
        assert.equal(player.resources[resource]+target.resources[resource],combined[resource]-(expeditionRules.cost[resource]??0));
      }
    }
  }

  const npcJobs = npcs.reduce((total,city)=>total+city.history.length,0);
  const skirmishes = world.battles.filter(report=>report.kind==='npc-skirmish').length;
  const armistices = Object.values(world.diplomacy?.treaties ?? {}).filter(treaty=>treaty.kind==='ceasefire').length;
  assert.equal(world.bchTreasury,undefined);
  assert.equal(world.territoryPayments && Object.keys(world.territoryPayments).length,0);
  assert.ok(skirmishes<=1);
  if (population===0) {
    assert.equal(npcJobs,0);
    assert.equal(skirmishes,0);
  } else {
    assert.ok(launches>0 && npcJobs>0);
  }
  for (const npc of npcs) {
    const capacity = stockCapacity(npc,world.now);
    for (const resource of resources) assert.ok(npc.resources[resource]>=0 && npc.resources[resource]<=capacity[resource]);
  }
  return { population, playersWithExpeditions:sorties.size, launches, victories, npcJobs, scoutingMissions, skirmishes, armistices, loot };
}

console.log(JSON.stringify({ simulatedHours:8, expeditions:expeditionRules, realms:populations.map(frontier) },null,2));
