import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, HOUR, resources } from '../../config/economy.mjs';
import { simulateBattle, troopTotal } from './combat.mjs';
import { addPlayer, advance, command, createWorld, quote, snapshot } from './index.mjs';
import { expeditionRules, npcCadence } from './npc.mjs';
import { quoteTerritory, readTerritories } from './territories.mjs';
import { stockCapacity } from './world.mjs';

const start = 70 * DAY;
const id = 'solo-founder';
const makeWorld = () => Object.assign(createWorld(start),{secret:'npc-engine-test'});
const doOrder = (world,type,fields = {}) => command(world,id,{type,...fields},world.now);

function openSoloKingdom(world) {
  addPlayer(world,{id});
  doOrder(world,'found',{cityName:'New Harbor',faction:'azure'});
  doOrder(world,'tutorial',{step:'welcome',action:'skip'});
  return world.cities[id];
}

test('one protected player can scout and fight a named NPC with conserved resources and separate limits',()=>{
  const world = makeWorld();
  const actor = openSoloKingdom(world);
  const target = world.cities.p8;
  assert.equal(actor.optIn,true);
  assert.equal(actor.shieldUntil,0);
  assert.ok(snapshot(world,id).cities.find(city=>city.id===target.id).expedition.ok);
  assert.throws(()=>doOrder(world,'expedition',{target:'p2'}),{code:'expedition_target'});
  assert.throws(()=>quote(world,id,{type:'attack-paid',target:target.id}),{code:'competitive_npc'});
  const scout = doOrder(world,'scout',{target:target.id,mission:'recon'});
  advance(world,scout.completesAt);
  assert.notEqual(scout.status,'pending');
  const combined = Object.fromEntries(resources.map(resource=>[resource,actor.resources[resource]+target.resources[resource]]));
  const battle = doOrder(world,'expedition',{target:target.id,formation:'wedge',tactic:'flank'});
  assert.equal(battle.kind,'expedition');
  assert.equal(battle.paid,false);
  assert.equal(simulateBattle(battle.input,battle.seed).hash,battle.hash);
  for (const resource of resources) {
    assert.ok(battle.loot[resource]<=20);
    assert.equal(actor.resources[resource]+target.resources[resource],combined[resource]-(expeditionRules.cost[resource]??0));
  }
  assert.equal(actor.shieldUntil,0);   // an expedition neither needs nor grants a shield
  assert.equal(snapshot(world,id).player.attacksLeft,3);
  assert.equal(world.bchTreasury,undefined);
  assert.throws(()=>doOrder(world,'expedition',{target:target.id}),{code:'expedition_recovery'});
  advance(world,world.now+expeditionRules.playerCooldown);
  assert.throws(()=>doOrder(world,'expedition',{target:target.id}),{code:'expedition_rematch'});
  // Reinforced after the first fight, so that another of the five NPC kingdoms is within reach.
  actor.troops.infantry += 60;
  const allowed = snapshot(world,id).cities.find(city=>city.npc && city.expedition.ok);
  assert.ok(allowed);
  doOrder(world,'expedition',{target:allowed.id});
  advance(world,world.now+expeditionRules.playerCooldown);
  const available = snapshot(world,id).cities.find(city=>city.npc && city.expedition.code==='expedition_limit');
  assert.ok(available);
});

test('territorial PvE uses ordinary ownership, persists garrison, then returns camp without charging BCH',()=>{
  let world = makeWorld();
  const actor = openSoloKingdom(world);
  // Upgrade the available infantry roster through the same command route a player uses.
  const training = doOrder(world,'train',{unit:'infantry',count:12});
  advance(world,training.completesAt);
  const options = readTerritories(world,id).territories.filter(site=>site.frontierEligibility?.ok);
  assert.ok(options.length>0);
  const target = options.find(site=>site.id==='old-ferry-camp') ?? options[0];
  assert.throws(()=>quoteTerritory(world,id,{type:'territory-attack',territory:target.id}),{code:'frontier_camp'});
  assert.throws(()=>doOrder(world,'frontier-conquest',{territory:target.id,expectedOwner:'p2'}),{code:'territory_changed'});
  const fought = doOrder(world,'frontier-conquest',{territory:target.id,expectedOwner:target.owner});
  assert.equal(fought.winner,'attacker');
  assert.equal(fought.paid,false);
  assert.equal(simulateBattle(fought.input,fought.seed).hash,fought.hash);
  const captured = () => world.territories.find(site=>site.id===target.id);
  assert.equal(captured().owner,id);
  assert.equal(troopTotal(captured().defenses.garrison),6);
  assert.equal(world.territorySettlements.length,0);
  assert.equal(captured().blockchain.length,0);
  assert.equal(world.bchTreasury,undefined);
  assert.ok(actor.territoryActivityAt);
  world = JSON.parse(JSON.stringify(world));
  const occupiedUntil = captured().frontierOccupationUntil;
  assert.ok(occupiedUntil > world.now);
  advance(world,occupiedUntil-1);
  assert.equal(captured().owner,id);
  const garrison = troopTotal(captured().defenses.garrison);
  const troops = troopTotal(world.cities[id].troops);
  advance(world,occupiedUntil);
  assert.equal(captured().owner,target.owner);
  assert.equal(troopTotal(world.cities[id].troops),troops+garrison);
  assert.equal(captured().history.at(-1).kind,'occupation-expired');
});

test('a solo envoy spends earned supplies and either records a real ceasefire or a refusal',()=>{
  const world = makeWorld();
  const actor = openSoloKingdom(world);
  const stock = {...actor.resources};
  const accepted = doOrder(world,'npc-envoy',{target:'p8'});
  assert.equal(accepted.accepted,true);
  assert.equal(accepted.treaty.expiresAt,start+12*HOUR);
  assert.equal(actor.resources.wood,stock.wood-12);
  assert.equal(actor.resources.food,stock.food-16);
  assert.throws(()=>doOrder(world,'expedition',{target:'p8'}),{code:'friendly'});
  assert.throws(()=>doOrder(world,'npc-envoy',{target:'p10'}),{code:'envoy_cooldown'});
  assert.throws(()=>doOrder(world,'npc-envoy',{target:'p2'}),{code:'envoy_target'});
  assert.equal(world.bchTreasury,undefined);

  const hostile = makeWorld();
  openSoloKingdom(hostile);
  doOrder(hostile,'expedition',{target:'p8'});
  const refused = doOrder(hostile,'npc-envoy',{target:'p8'});
  assert.equal(refused.accepted,false);
  assert.equal(refused.treaty.status,'rejected');
  assert.match(refused.reply,/recent attack/);
  assert.equal(hostile.bchTreasury,undefined);
});

test('NPC pulses remain dormant with zero activity, and active courts pay for capacity and recovery',()=>{
  const sleeping = makeWorld();
  advance(sleeping,start+2*DAY);
  assert.equal(sleeping.npcPulseAt,undefined);
  assert.equal(sleeping.battles.length,0);
  assert.equal(sleeping.cities.p8.history.length,0);
  assert.equal(sleeping.bchTreasury,undefined);

  let active = makeWorld();
  openSoloKingdom(active);
  // Five NPC kingdoms are spread out; two neighbours are set side by side so that a border skirmish can be observed.
  Object.assign(active.cities.p10,{x:.33,y:.36});
  const target = active.cities.p8;
  const army = troopTotal(target.troops);
  // Segmented progress is how the real server exercises the scheduler.
  advance(active,start+HOUR);
  assert.equal(active.npcPulseAt,start+npcCadence.pulse);
  active = JSON.parse(JSON.stringify(active));
  advance(active,start+npcCadence.pulse);
  assert.ok(active.cities.p8.queue.some(job=>job.kind==='building'));
  assert.ok(active.cities.p8.queue.some(job=>job.kind==='troop'));
  assert.ok(active.cities.p8.queue.some(job=>job.kind==='research'));
  advance(active,start+10*HOUR);
  const city = active.cities.p8;
  assert.ok(city.buildings.hall>1);
  assert.ok(city.history.some(job=>job.kind==='troop' && job.count>0));
  assert.ok(troopTotal(city.troops)>army);
  assert.equal(active.government.kingdoms[city.id].stance,'commerce');
  assert.equal(city.commanders.roster.merchant.permanent,true);
  assert.ok(active.battles.some(report=>report.kind==='npc-skirmish'));
  assert.ok(active.battles.every(report=>active.cities[report.attacker].npc && active.cities[report.defender].npc && !report.paid));
  assert.ok(Object.values(active.diplomacy.treaties).some(row=>row.kind==='ceasefire'&&row.status==='active'));
  for (const npc of Object.values(active.cities).filter(city=>city.npc)) {
    const capacity=stockCapacity(npc,active.now);
    for (const material of resources) assert.ok(npc.resources[material]>=0 && npc.resources[material]<=capacity[material]);
  }
  const activeAt = active.npcPulseAt;
  advance(active,start+3*DAY);
  assert.ok(active.npcPulseAt>activeAt && active.npcPulseAt<=start+DAY);
  assert.equal(active.bchTreasury,undefined);
});
