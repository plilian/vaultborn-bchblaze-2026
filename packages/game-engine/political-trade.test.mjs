import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, command, createWorld, snapshot } from './index.mjs';
import { ensureTerritories } from './territories.mjs';
import { MINUTE, HOUR } from '../../config/economy.mjs';

const START=15*24*HOUR;
function fixture() {
  const world=createWorld(START);
  world.secret='trade-tests';
  command(world,'p1',{type:'tutorial'},START);
  const proposed=command(world,'p1',{type:'diplomacy-treaty-propose',target:'p2',kind:'trade',durationHours:72,terms:{}},START);
  const {termsHash,version}=proposed.proposal;
  command(world,'p2',{type:'diplomacy-treaty-respond',id:proposed.id,accept:true,termsHash,version},START);
  return world;
}
const perform=(world,who,type,fields={})=>command(world,who,{type:'diplomacy-'+type,...fields},world.now);

test('tariffs debit only authorized cargo and conserve the whole shipment',()=>{
  const world=fixture();
  const route=perform(world,'p1','trade-open',{target:'p2',resource:'iron'});
  const sanction=perform(world,'p2','sanction-impose',{target:'p1',kind:'tariff',resource:'iron',hours:3});
  assert.deepEqual(sanction.routeIds,[route.id]);
  const before=world.cities.p1.resources.iron;
  const shipment=perform(world,'p1','trade-ship',{id:route.id,resource:'iron',amount:100});
  assert.equal(world.cities.p1.resources.iron,before-100);
  assert.throws(()=>perform(world,'p2','trade-ship',{id:route.id,resource:'iron',amount:20}),{code:'trade_route'});
  advance(world,shipment.arrivesAt);
  assert.deepEqual(shipment.tariffs,[{to:'p2',amount:15}]);
  assert.equal(shipment.delivered,85);
  assert.equal(shipment.lost,0);
  assert.equal(snapshot(world,'p1').diplomacy.shipments[0].status,'delivered');
});

test('unrelated kingdoms cannot embargo another route, valid smuggling consumes bounded cargo and cooldown',()=>{
  const world=fixture();
  const route=perform(world,'p1','trade-open',{target:'p2',resource:'food'});
  assert.throws(()=>perform(world,'p3','sanction-impose',{target:'p2',kind:'embargo',resource:'food'}),{code:'sanction_jurisdiction'});
  const measure=perform(world,'p2','sanction-impose',{target:'p1',kind:'embargo',resource:'food',hours:1});
  assert.equal(snapshot(world,'p1').diplomacy.routes[0].status,'blocked');
  assert.throws(()=>perform(world,'p1','trade-ship',{id:route.id,resource:'food',amount:35}),{code:'trade_blocked'});
  const cargo=perform(world,'p1','trade-smuggle',{id:route.id,resource:'food',amount:35});
  assert.throws(()=>perform(world,'p2','trade-smuggle',{id:route.id,resource:'food',amount:25}),{code:'trade_cooldown'});
  advance(world,cargo.arrivesAt);
  assert.ok(cargo.lost>0 && cargo.lost<=18);
  assert.equal(cargo.delivered+cargo.lost,35);
  assert.throws(()=>perform(world,'p1','sanction-lift',{id:measure.id}),{code:'sanction_control'});
  advance(world,START+HOUR);
  assert.equal(snapshot(world,'p1').diplomacy.routes[0].status,'active');
});

test('a shipment entering an embargo in transit returns stock and cannot be replayed',()=>{
  const world=fixture();
  const route=perform(world,'p1','trade-open',{target:'p2',resource:'stone'});
  const cargo=perform(world,'p1','trade-ship',{id:route.id,resource:'stone',amount:50});
  advance(world,START+MINUTE);
  perform(world,'p2','sanction-impose',{target:'p1',kind:'embargo',resource:'stone',hours:1});
  advance(world,cargo.arrivesAt);
  assert.equal(cargo.status,'returned');
  assert.equal(cargo.refunded,50);
  const settled=cargo.settledAt;
  advance(world,cargo.arrivesAt+MINUTE);
  assert.equal(cargo.settledAt,settled);
});

test('a strategic blockade covers only its waypoint and an escort shares regular raid limits',()=>{
  const world=fixture();
  const site=ensureTerritories(world,START).find(item=>item.id==='watch');
  site.owner=site.controller='p1';
  const blocked=perform(world,'p1','trade-open',{target:'p2',resource:'iron',territory:site.id});
  const bypass=perform(world,'p1','trade-open',{target:'p2',resource:'food'});
  assert.throws(()=>perform(world,'p3','sanction-impose',{target:'p2',kind:'blockade',territory:site.id}),{code:'sanction_territory'});
  const blockade=perform(world,'p1','sanction-impose',{target:'p2',kind:'blockade',territory:site.id});
  assert.deepEqual(blockade.routeIds,[blocked.id]);
  const visible=Object.fromEntries(snapshot(world,'p2').diplomacy.routes.map(route=>[route.id,route.status]));
  assert.deepEqual(visible,{[bypass.id]:'active',[blocked.id]:'blocked'});
  assert.throws(()=>perform(world,'p3','sanction-break',{id:blockade.id}),{code:'sanction_break'});
  const attempt=perform(world,'p2','sanction-break',{id:blockade.id});
  assert.equal(attempt.sanction,blockade.id);
  assert.equal(world.marches[0].kind,'raid');
  assert.throws(()=>command(world,'p2',{type:'attack',target:'p1'},world.now),{code:'repeat_attack'});
  const rerouted=perform(world,'p1','trade-reroute',{id:blocked.id});
  assert.deepEqual(rerouted.territories,[]);
  assert.equal(snapshot(world,'p2').diplomacy.routes.find(route=>route.id===blocked.id).status,'active');
});
