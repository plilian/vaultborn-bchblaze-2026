import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HOUR,MINUTE} from '../../config/economy.mjs';
import {command,advance,createWorld,snapshot} from './index.mjs';
import {digest,simulateBattle,troopTotal} from './combat.mjs';
import {applyPoliticalSupport,ensureGovernment,governmentMorale,governmentState,publicGovernmentRecord,
  quotePoliticalSupport,readSettledPoliticalConflict,recordGovernmentEvent,reservedPoliticalTroops} from './government.mjs';
import {ensureTerritories,restorePoliticalTerritory} from './territories.mjs';

const T=250*HOUR;
const act = (world,actor,type,payload={},now=world.now) => command(world,actor,{type,...payload},now);
const setup=()=>{
  const world=createWorld(T);
  world.secret='political-determinism-tests';
  act(world,'p1','tutorial');
  ensureTerritories(world,T);
  ensureGovernment(world,T);
  return world;
};
const totalBy = (world,ids) => Object.fromEntries(ids.map(id=>[id,troopTotal(world.cities[id].troops)]));
const finish = (world,c) => advance(world,c.nextAt+8*MINUTE);
const grantAssistance = (world,from,to) => {
  const pact=act(world,from,'diplomacy-treaty-propose',{kind:'military-assistance',target:to,durationHours:24,terms:{}});
  const {termsHash,version}=pact.proposal;
  return act(world,to,'diplomacy-treaty-respond',{id:pact.id,termsHash,version,accept:true});
};

test('political events are additive once, actual production pays taxes, and cooldowns block policy abuse',()=>{
  const world=setup();
  const first=governmentState(world,'p1');
  assert.equal(first.kingdom.legitimacy,60);
  assert.equal(first.kingdom.loyalty,60);
  assert.equal(first.kingdoms[0].civic,undefined);
  const legitimacy=recordGovernmentEvent(world,'conquest',{actor:'p1',target:'p2',id:'actual-land'},T);
  assert.equal(legitimacy.source,'actual-land');
  assert.equal(recordGovernmentEvent(world,'conquest',{actor:'p1',target:'p2',id:'actual-land'},T),null);
  const state=world.government.kingdoms.p1;
  assert.equal(state.legitimacy,63);
  act(world,'p1','government-policy',{tax:'heavy',stance:'mobilization'});
  assert.ok(state.unrest>20);
  assert.ok(governmentMorale(world,'p1')>=.9);
  assert.throws(()=>act(world,'p1','government-policy',{tax:'exempt',stance:'commerce'}),{code:'government_cooldown'});
  const alternate=structuredClone(world);
  alternate.government.kingdoms.p1.tax='exempt';
  advance(world,T+30*MINUTE);
  advance(alternate,T+30*MINUTE);
  for (const [key,fund] of Object.entries(state.civic)) {
    assert.equal(world.cities.p1.resources[key]+fund,alternate.cities.p1.resources[key]);
  }
  assert.ok(state.civic.wood>0);
  const unrest=state.unrest;
  act(world,'p1','government-decision',{decision:'relief'});
  assert.ok(state.unrest<unrest);
  assert.throws(()=>act(world,'p1','government-decision',{decision:'relief'}),{code:'government_cooldown'});
});

test('a coup and civil war require actual conditions and produce three replayable conflict fronts',()=>{
  const world=setup();
  assert.throws(()=>act(world,'p1','political-conflict-open',{kind:'coup'}),{code:'political_unrest'});
  act(world,'p1','government-policy',{tax:'heavy',stance:'mobilization'});
  const total=troopTotal(world.cities.p1.troops);
  const coup=act(world,'p1','political-conflict-open',{kind:'coup'});
  assert.equal(coup.status,'organizing');
  assert.equal(coup.nextAt-T,30*MINUTE);
  assert.equal(troopTotal(world.cities.p1.troops)+reservedPoliticalTroops(world,'p1'),total);
  assert.equal(governmentState(world,'p2').conflicts[0].sides.challenger.troops,undefined);
  assert.equal(publicGovernmentRecord(world).conflicts.length,0);
  assert.throws(()=>act(world,'p2','political-conflict-order',{conflict:coup.id,side:'challenger',tactic:'assault',formation:'wedge'}),{code:'political_order'});
  act(world,'p1','political-conflict-order',{conflict:coup.id,side:'challenger',tactic:'flank',formation:'wedge'});
  const reload=JSON.parse(JSON.stringify(world));
  advance(world,coup.nextAt);
  assert.equal(coup.status,'fighting');
  assert.equal(coup.rounds.length,1);
  assert.equal(governmentState(world,'p2').conflicts[0].rounds[0].seed,undefined);
  assert.equal(publicGovernmentRecord(world).conflicts.length,0);
  advance(world,coup.nextAt);
  assert.equal(coup.rounds.length,2);
  advance(world,coup.nextAt);
  finish(reload,reload.government.conflicts[coup.id]);
  assert.equal(coup.status,'resolved');
  assert.equal(coup.rounds.length,3);
  assert.equal(digest(coup.seed),coup.seedCommitment);
  for (const round of coup.rounds) assert.equal(round.seed,digest([coup.seed,round.stage-1]));
  assert.deepEqual(reload.government.conflicts[coup.id],coup);
  assert.equal(troopTotal(world.cities.p1.troops)+troopTotal(coup.casualties.p1),total);
  assert.equal(reservedPoliticalTroops(world,'p1'),0);
  assert.equal(publicGovernmentRecord(world).conflicts.length,1);
  assert.ok(world.government.kingdoms.p1.recoveryUntil>world.now);
  for (const battle of world.battles) assert.equal(simulateBattle(battle.input,battle.seed).hash,battle.hash);
  for (let i=0;i<45;i++) {
    const id='later'+i;
    world.government.conflicts[id]={...coup,id,createdAt:coup.createdAt+i+1};
  }
  assert.equal(publicGovernmentRecord(world).conflicts.some(row=>row.id===coup.id),false);
  assert.equal(readSettledPoliticalConflict(world,coup.id).seedCommitment,coup.seedCommitment);

  const separate=setup();
  const land=separate.territories.find(site=>site.id==='mine');
  land.owner=land.controller='p1';
  separate.government.kingdoms.p1.unrest=42;
  const civil=act(separate,'p1','political-conflict-open',{kind:'civil-war',territory:land.id});
  finish(separate,civil);
  assert.equal(civil.rounds.length,3);
  assert.equal(land.owner,'p1');
});

test('coalition intervention reserves real troops, accounts for each supporter and respects normal raid limits',()=>{
  const world=setup();
  const c=act(world,'p1','political-conflict-open',{kind:'coalition',target:'p2'});
  const outsider=world.cities.p3;
  assert.equal(world.marches[0].kind,'raid');
  const before=totalBy(world,['p1','p2','p3']);
  const contribution=act(world,'p3','political-conflict-support',{conflict:c.id,side:'challenger',mode:'troops',unit:'infantry',count:12});
  assert.equal(contribution.contribution.count,12);
  assert.equal(troopTotal(outsider.troops),before.p3-12);
  assert.equal(reservedPoliticalTroops(world,'p3'),12);
  assert.deepEqual(world.marches[0].contributors,['p3']);
  assert.throws(()=>act(world,'p3','political-conflict-support',{conflict:c.id,side:'challenger',mode:'resources'}),{code:'political_support_limit'});
  assert.throws(()=>act(world,'p3','political-conflict-support',{conflict:c.id,side:'government',mode:'intel'}),{code:'political_support_access'});
  assert.throws(()=>act(world,'p4','political-conflict-support',{conflict:c.id,side:'challenger',mode:'equipment'}),{code:'political_support_access'});
  const p3View=governmentState(world,'p3').conflicts[0];
  assert.equal(p3View.sides.challenger.ownTroops[0].player,'p3');
  assert.equal(governmentState(world,'p2').conflicts[0].sides.challenger.ownTroops,undefined);
  finish(world,c);
  assert.equal(c.sides.challenger.troops.find(row=>row.player==='p3').returned,true);
  assert.equal(troopTotal(outsider.troops)+troopTotal(c.casualties.p3??{}),before.p3);
  assert.equal(reservedPoliticalTroops(world,'p3'),0);
});

test('an offensive coalition cannot bypass personal repeat caps, while defensive intervention is not a raid',()=>{
  const world=setup();
  world.cities.p3.alliance=null;
  grantAssistance(world,'p1','p3');
  grantAssistance(world,'p2','p4');
  world.marches.push({id:'earlier',kind:'raid',attacker:'p3',defender:'p2',alliance:null,at:T-1});
  const c=act(world,'p1','political-conflict-open',{kind:'coalition',target:'p2'});
  const before=world.cities.p3.troops.infantry;
  assert.throws(()=>act(world,'p3','political-conflict-support',{conflict:c.id,side:'challenger',mode:'troops',unit:'infantry',count:5}),{code:'repeat_attack'});
  assert.equal(world.cities.p3.troops.infantry,before);
  const defense=act(world,'p4','political-conflict-support',{conflict:c.id,side:'government',mode:'troops',unit:'infantry',count:5});
  assert.equal(defense.contribution.count,5);
  assert.equal(world.marches[0].contributors,undefined);
  finish(world,c);
  assert.equal(c.sides.government.troops.find(row=>row.player==='p4').returned,true);
});

test('the wing captain can privately request and receive intervention during preparation',()=>{
  const world=setup();
  grantAssistance(world,'p2','p4');
  const c=act(world,'p1','political-conflict-open',{kind:'coalition',target:'p2'});
  assert.equal(readSettledPoliticalConflict(world,c.id),null);
  assert.ok(governmentState(world,'p1').conflicts[0].sides.challenger.requestTargets.includes('p3'));
  assert.throws(()=>act(world,'p2','political-conflict-request',{conflict:c.id,side:'challenger',target:'p3'}),{code:'political_request_access'});
  const resources=structuredClone(world.cities.p1.resources);
  const request=act(world,'p1','political-conflict-request',{conflict:c.id,side:'challenger',target:'p3'});
  assert.equal(world.cities.p1.resources.food,resources.food-12);
  assert.equal(world.cities.p1.resources.wood,resources.wood-8);
  assert.equal(governmentState(world,'p3').requests[0].id,request.id);
  assert.deepEqual(governmentState(world,'p2').requests,[]);
  assert.deepEqual(publicGovernmentRecord(world).requests,[]);
  assert.throws(()=>act(world,'p1','political-conflict-request',{conflict:c.id,side:'challenger',target:'p3'}),{code:'political_request_cooldown'});
  act(world,'p3','political-conflict-support',{conflict:c.id,side:'challenger',mode:'intel'});
  assert.equal(request.status,'fulfilled');
  const unused=act(world,'p2','political-conflict-request',{conflict:c.id,side:'government',target:'p4'});
  advance(world,c.nextAt);
  assert.equal(unused.status,'expired');
  assert.equal(request.status,'fulfilled');
});

test('paid logistics adds one equivalent support package, seals public receipts, and rejects replay',()=>{
  const world=setup();
  const c=act(world,'p1','political-conflict-open',{kind:'coalition',target:'p2'});
  const request={type:'political-operation',operation:'support',conflict:c.id,side:'challenger'};
  const payment=quotePoliticalSupport(world,'p1',request,T);
  assert.equal(payment.satoshis,6000);
  assert.throws(()=>applyPoliticalSupport(world,'p1',request,{id:'wrong',txid:'b'.repeat(64),satoshis:5000},T),{code:'political_payment'});
  const row={id:'fund-1',txid:'A'.repeat(64),satoshis:6000};
  const prior=structuredClone(world.cities.p1.resources);
  const done=applyPoliticalSupport(world,'p1',request,row,T);
  assert.deepEqual(applyPoliticalSupport(world,'p1',request,row,T),done);
  assert.throws(()=>applyPoliticalSupport(world,'p1',request,{...row,id:'fund-2',txid:'a'.repeat(64)},T),{code:'political_payment_duplicate'});
  assert.equal(c.sides.challenger.logistics,.025);
  assert.deepEqual(prior,world.cities.p1.resources);
  assert.equal(governmentState(world,'p2').conflicts[0].receipts.length,0);
  finish(world,c);
  assert.equal(publicGovernmentRecord(world).conflicts[0].receipts[0].txid,'a'.repeat(64));
});

test('government crises tally once, covert incidents hide early information, and temporary outcomes recover',()=>{
  const world=setup();
  act(world,'p1','government-policy',{tax:'heavy',stance:'civic'});
  const crisis=act(world,'p1','political-event-open',{kind:'crisis'});
  assert.equal(crisis.status,'open');
  assert.throws(()=>act(world,'p3','political-event-respond',{event:crisis.id,choice:'relief'}),{code:'political_event_access'});
  act(world,'p1','political-event-respond',{event:crisis.id,choice:'assembly'});
  assert.equal(crisis.result.outcome,'crisis-eased');
  assert.throws(()=>act(world,'p1','political-event-respond',{event:crisis.id,choice:'relief'}),{code:'political_event_closed'});
  world.cities.p1.intel.p2={confidence:.85,expiresAt:T+HOUR};
  const secret=act(world,'p1','political-event-open',{kind:'assassination',target:'p2'});
  assert.equal(governmentState(world,'p3').crises.some(row=>row.id===secret.id),false);
  assert.equal(governmentState(world,'p2').crises.find(row=>row.id===secret.id).actor,null);
  act(world,'p2','political-event-respond',{event:secret.id,choice:'protect'});
  assert.ok(['commander-unavailable','attempt-thwarted'].includes(secret.result.outcome));
  assert.equal(publicGovernmentRecord(world).crises.find(row=>row.id===secret.id).actor,'p1');
  const vote=act(world,'p1','political-event-open',{kind:'council-vote'});
  act(world,'p1','political-event-respond',{event:vote.id,choice:'approve'});
  assert.throws(()=>act(world,'p1','political-event-respond',{event:vote.id,choice:'reject'}),{code:'political_event_vote'});
  act(world,'p3','political-event-respond',{event:vote.id,choice:'approve'});
  assert.equal(vote.result.outcome,'approved');
});

test('successful political restoration obeys capacity, increments tenure and never grants protected starter land',()=>{
  const world=setup();
  const land=world.territories.find(site=>site.id==='mine');
  const incumbent=world.cities.p2;
  land.owner=land.controller=incumbent.id;
  land.version=2;
  land.history.push({kind:'conquered',previousOwner:'p1',playerId:'p2',at:T});
  land.defenses.garrison.infantry=3;
  const before=incumbent.troops.infantry;
  assert.equal(restorePoliticalTerritory(world,'starter-p2','p2','p1','fake',T),null);
  const restored=restorePoliticalTerritory(world,land.id,'p2','p1','civil-1',T);
  assert.equal(restored.version,3);
  assert.equal(land.owner,'p1');
  assert.equal(incumbent.troops.infantry,before+3);
  assert.equal(land.history.at(-1).conflict,'civil-1');
  assert.equal(restorePoliticalTerritory(world,land.id,'p2','p1','civil-1',T),null);
  assert.equal(snapshot(world,'p1').government.kingdom.id,'p1');
});
