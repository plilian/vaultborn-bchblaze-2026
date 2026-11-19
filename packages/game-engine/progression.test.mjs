import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {DAY,HOUR,starterShield} from '../../config/economy.mjs';
import {registerBattle,verifyBattle} from '../../apps/game-server/battle-records.mjs';
import {createApp} from '../../apps/game-server/index.mjs';
import {createChain} from '../chain-observer/index.mjs';
import {protocolHash} from '../chain-observer/vaultborn.mjs';
import {addPlayer,advance,attackPreview,command,createWorld,simulateBattle,snapshot} from './index.mjs';
import {openingProfile,troopTotal,unitAttackFactors} from './combat.mjs';
import {ensureGovernment} from './government.mjs';
import {awardCommanderMastery,commanderEffects} from './progression.mjs';
import {readTerritories,territoryProduction} from './territories.mjs';

const T=500*DAY;
const act=(world,player,type,body={},at=world.now)=>command(world,player,{type,...body},at);
const list=(world,id)=>snapshot(world,id).player.stats.commands;
// Recruiting and renting still exist for kingdoms that do not hold a commander. New kingdoms hold all of them from the
// first day, so these tests take the others away again to exercise the rules.
const onlyBaseline=city=>{city.commanders={legacy:false,roster:{},equipment:{},rentAfter:0};return city;};

async function localApi(t,clock) {
  const assets={enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
  const chain=createChain({enabled:false,transport:{withClient:async()=>{throw new Error('Offline fixture');}}});
  const app=createApp({database:':memory:',clock,chain,territoryAssets:assets,politicalAssets:assets});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async()=>{
    const closed=once(app.server,'close');
    app.close();
    await closed;
  });
  return {...app,get:async path=>{
    const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/'+path);
    assert.equal(response.status,200,path);
    return response.json();
  }};
}

test('legacy entitlements survive; new commanders rent with finite terms and keep earned mastery when recruited permanently',()=>{
  const world=createWorld(T);
  act(world,'p1','tutorial');
  assert.equal(Object.values(list(world,'p1').roster).every(row=>row.ownership==='permanent'),true);
  const city=addPlayer(world,{id:'recruit',name:'New Commander'},T);
  assert.equal(Object.values(list(world,'recruit').roster).every(row=>row.ownership==='permanent'),true,'every commander from the first day');
  act(world,'recruit','configure',{hero:'ranger'});
  act(world,'recruit','configure',{hero:'warden'});
  onlyBaseline(city);
  act(world,'recruit','found',{cityName:'New Harbor',faction:'azure'});
  act(world,'recruit','tutorial',{action:'skip',step:'welcome'});
  assert.equal(list(world,'recruit').roster.warden.ownership,'permanent');
  assert.equal(list(world,'recruit').roster.ranger.ownership,'locked');
  assert.throws(()=>act(world,'recruit','configure',{hero:'ranger'}),{code:'commander_unavailable'});
  assert.throws(()=>act(world,'recruit','commander-recruit',{hero:'ranger'}),{code:'commander_recruitment'});
  const first=list(world,'recruit').roster.ranger.recruitment.rentals[1];
  const start=city.resources.wood;
  act(world,'recruit','commander-rent',{hero:'ranger',days:1});
  assert.equal(start-city.resources.wood,first.wood);
  assert.throws(()=>act(world,'recruit','commander-rent',{hero:'scholar',days:1}),{code:'commander_rental'});
  act(world,'recruit','configure',{hero:'ranger'});
  act(world,'recruit','opt-in',{enabled:true},T+starterShield);
  assert.throws(()=>act(world,'recruit','commander-rent',{hero:'ranger',days:7}),{code:'commander_rental_limit'});
  const task=act(world,'recruit','scout',{target:'p2',mission:'deep'},T+DAY-5000);
  assert.equal(task.specialist,'ranger');
  assert.equal(task.specialistBonus,.08);
  advance(world,T+DAY);
  assert.equal(list(world,'recruit').roster.ranger.ownership,'expired');
  assert.equal(list(world,'recruit').effective,'warden');
  assert.equal(commanderEffects(city,'ranger',world.now).scoutSuccess,undefined);
  const saved=JSON.parse(JSON.stringify(world));
  advance(saved,task.completesAt);
  assert.equal(saved.missions.find(item=>item.id===task.id).specialistBonus,.08);
  saved.cities.recruit.buildings.scout=2;
  const before=list(saved,'recruit').roster.ranger.xp;
  act(saved,'recruit','commander-recruit',{hero:'ranger'});
  assert.equal(list(saved,'recruit').roster.ranger.ownership,'permanent');
  assert.equal(list(saved,'recruit').roster.ranger.xp,before);
});

test('mastery and equipment change the same opening attack stats that the new battle snapshots replay',()=>{
  const world=createWorld(T);
  world.secret='mastery-snapshot-regression';
  const city=world.cities.p1;
  act(world,'p1','tutorial');
  city.buildings.barracks=3;
  act(world,'p1','configure',{hero:'commander',formation:'wedge',tactic:'flank'});
  const base=attackPreview(world,'p1',{target:'p2'}).own.openingPressure;
  for (let i=0;i<8;i++) awardCommanderMastery(city,'commander','raid',T);
  assert.equal(list(world,'p1').roster.commander.xp,24);
  assert.equal(list(world,'p1').roster.commander.nextEffects.openingAttack,.07);
  act(world,'p1','commander-upgrade',{hero:'commander'});
  act(world,'p1','commander-forge',{equipment:'field-standard'});
  act(world,'p1','commander-equip',{hero:'commander',equipment:'field-standard'});
  assert.throws(()=>act(world,'p1','commander-equip',{hero:'warden',equipment:'field-standard'}),{code:'equipment_unavailable'});
  assert.throws(()=>act(world,'p1','commander-equip',{hero:'commander',equipment:null}),{code:'equipment_cooldown'});
  const stats=snapshot(world,'p1').player.stats;
  assert.equal(stats.commands.roster.commander.effects.openingAttack,.085);
  const preview=attackPreview(world,'p1',{target:'p2'});
  assert.ok(preview.own.openingPressure>base);
  assert.equal(stats.military.openingTerrain,city.terrain);
  const battle=act(world,'p1','attack',{target:'p2'});
  assert.ok(preview.eligibility.allowed);
  assert.equal(preview.own.openingPressure,Math.round(openingProfile(battle.input.attacker,undefined,battle.input.terrain).openingPressure*100)/100);
  assert.equal(battle.input.attacker.commanderTraits.openingAttack,.085);
  assert.equal(simulateBattle(battle.input,battle.seed).hash,battle.hash);
  const previous=JSON.parse(readFileSync(new URL('../../docs/VAULTBORN_VERIFIABLE_BATTLE.json',import.meta.url),'utf8'));
  assert.ok(verifyBattle(previous.record.battle),'historic anchored replay remains deterministic');
});

test('capacity rented from the Keeper accrues through expiry without destroying goods held above the new cap',()=>{
  const world=createWorld(T);
  const city=onlyBaseline(addPlayer(world,{id:'keeper-recruit',name:'Storage Keeper'},T));
  act(world,city.id,'found',{cityName:'Storage Keep',faction:'emerald'});
  act(world,city.id,'tutorial',{action:'skip',step:'welcome'});
  act(world,city.id,'commander-rent',{hero:'keeper',days:1});
  act(world,city.id,'configure',{hero:'keeper'});
  advance(world,T+DAY-HOUR);
  city.resources.wood=2800;
  advance(world,T+DAY+HOUR);
  assert.equal(list(world,city.id).roster.keeper.ownership,'expired');
  assert.equal(snapshot(world,city.id).player.capacity.wood,2800);
  assert.equal(city.resources.wood,2918,'one productive hour fit before expiry; no deferred stock was deleted');
});

test('attack risk depends only on authorized observations; stale intelligence and numeric eligibility ratios stay private',()=>{
  const world=createWorld(T);
  act(world,'p1','tutorial');
  const target=world.cities.p2;
  const actor=world.cities.p1;
  const options={target:'p2',formation:'screen',tactic:'siege'};
  const silent=attackPreview(world,'p1',options);
  assert.equal(silent.enemy.source,'unknown');
  assert.equal(silent.risk,null);
  const report={id:'recon-demo',at:T,expiresAt:T+HOUR,confidence:.72,army:80,wall:2,defense:100,
    formation:'screen',troops:{infantry:28,shield:16,archer:22,cavalry:10,siege:2,mage:2}};
  actor.intel.p2=report;
  const estimated=attackPreview(world,'p1',options);
  assert.deepEqual(estimated.enemy.troops,report.troops);
  assert.equal(estimated.risk.samples,48);
  target.troops.mage+=200;
  target.tech.fortification=4;
  const changed=attackPreview(world,'p1',options);
  assert.deepEqual(changed.enemy,estimated.enemy);
  assert.deepEqual(changed.risk,estimated.risk,'hidden state did not alter the displayed sample');
  assert.equal('ratio' in changed.eligibility,false);
  const stale=snapshot(world,'p1',T+HOUR).targets.find(city=>city.id==='p2');
  assert.equal(stale.garrison,null);
  assert.equal(stale.defense,null);
  assert.equal(stale.intel.stale,true);
  assert.equal(stale.battleIntel.source,'unknown');
  assert.equal('ratio' in stale.protectorateEligibility,false);
});

test('garrison deployment preserves billeted troop upkeep and training cap; displayed research quote is the charged job',()=>{
  const world=createWorld(T);
  const city=world.cities.p1;
  act(world,'p1','tutorial');
  readTerritories(world,'p1');
  const site=world.territories.find(row=>row.id==='mine');
  site.owner=site.controller=city.id;
  const before=snapshot(world,'p1').player;
  act(world,'p1','territory-garrison',{territory:site.id,unit:'infantry',count:20});
  const after=snapshot(world,'p1').player;
  assert.equal(after.stats.military.reserved.garrison,20);
  assert.equal(after.stats.military.available,troopTotal(city.troops));
  assert.equal(after.stats.economy.foodUpkeepPerHour,before.stats.economy.foodUpkeepPerHour);
  assert.equal(after.production.food,before.production.food);
  city.buildings.barracks=1;
  assert.throws(()=>act(world,'p1','train',{unit:'infantry',count:20}),{code:'troop_capacity'});
  act(world,'p1','configure',{hero:'scholar'});
  const technology=snapshot(world,'p1').player.stats.research.tactics;
  const job=act(world,'p1','research',{tech:'tactics'});
  assert.deepEqual(job.cost,technology.cost);
  assert.equal(job.completesAt-job.startedAt,technology.duration);
  advance(world,job.completesAt);
  const updated=snapshot(world,'p1').player;
  assert.equal(updated.stats.military.doctrinePercent,technology.nextValue);
  assert.equal(updated.stats.commands.roster.scholar.xp,3);
});

test('version two mobility changes previews and combat for all players while the archived rules keep legacy outcomes',()=>{
  const world=createWorld(T);
  act(world,'p1','tutorial');
  world.cities.p2.terrain='forest';
  const wooded=attackPreview(world,'p1',{target:'p2',formation:'wedge',tactic:'flank'});
  const plain=attackPreview({...world,cities:{...world.cities,p2:{...world.cities.p2,terrain:'plains'}}},'p1',{target:'p2',formation:'wedge',tactic:'flank'});
  assert.equal(wooded.terrain.cavalryOpeningPercent,-24);
  assert.ok(wooded.own.openingPressure<plain.own.openingPressure);
  const report=act(world,'p1','attack',{target:'p2',formation:'wedge',tactic:'flank'});
  assert.equal(report.input.attacker.fieldRules,2);
  assert.equal(unitAttackFactors(report.input.attacker,'cavalry',1,'forest').mobility,.76);
  assert.equal(unitAttackFactors(report.input.attacker,'cavalry',4,'forest').mobility,.76*.94);
  assert.ok(verifyBattle(report));
});

test('territory owners see actual productive yield and private troop orders stay out of both hostile and public ledgers',async t=>{
  const app=await localApi(t,()=>T);
  const {world}=app.store.read();
  const site=world.territories.find(row=>row.id==='mine');
  const ally=addPlayer(world,{id:'mine-aid',name:'Mine Reinforcements'},T);
  world.cities.p1.alliance=ally.alliance='mine-alliance';
  site.owner=site.controller='p1';
  site.defenses.level=site.level=3;
  site.history.push({kind:'garrisoned',playerId:'p2',unit:'mage',count:9,at:T},
    {kind:'conquered',playerId:'p1',previousOwner:'p2',at:T});
  const txid='bc'.repeat(32);
  site.history.push({kind:'entered',claimId:'historic-claim',playerId:'p1',txid,at:T});
  site.blockchain.push({kind:'entry',id:'historic-entry',txid,at:T});
  act(world,'p1','territory-garrison',{territory:site.id,unit:'infantry',count:7});
  act(world,ally.id,'territory-aid',{territory:site.id,unit:'infantry',count:4});
  act(world,'p1','territory-garrison',{territory:site.id,unit:'infantry',count:3,recall:true});
  ensureGovernment(world).kingdoms.p1.unrest=70;
  site.politicalControl={conflict:'current-campaign',until:T+HOUR};
  site.missedUpkeep=1;
  app.store.write(world);

  const view=(id,at=T)=>readTerritories(world,id,at).territories.find(row=>row.id===site.id);
  const own=view('p1');
  const rival=view('p3');
  const allied=view(ally.id);
  assert.equal(own.defenses.count,8);
  assert.equal(own.defenses.garrison.infantry,8);
  assert.equal(own.stats.politicalProductionMultiplier,.425);
  assert.deepEqual(own.stats.productionPerHour,territoryProduction(world,'p1',T));
  assert.ok(view('p1',T+HOUR).stats.productionPerHour.iron>own.stats.productionPerHour.iron);
  assert.equal(own.history.find(item=>item.playerId==='p2').count,undefined,'current owners cannot see a prior owner’s troop orders at the same timestamp');
  assert.equal(own.history.find(item=>item.kind==='allied-reinforcement').count,4);
  assert.equal(allied.history.find(item=>item.kind==='allied-reinforcement').count,4);
  assert.equal(allied.history.find(item=>item.kind==='recalled').count,undefined);
  assert.equal(allied.defenses.count,null);

  const publicView=(await app.get('public/territories/'+site.id)).territory;
  for (const other of [rival,publicView]) {
    assert.deepEqual(other.defenses,{level:3,count:null});
    assert.equal(other.missedUpkeep,undefined);
    assert.equal(other.politicalControl,undefined);
    assert.equal(other.stats.politicalProductionMultiplier,undefined);
    assert.ok(other.stats.productionPerHour.iron>own.stats.productionPerHour.iron);
    assert.ok(other.history.some(item=>item.kind==='allied-reinforcement'));
    assert.ok(other.history.every(item=>!('count' in item) && !('unit' in item)));
    assert.equal(other.history.find(item=>item.kind==='entered').txid,txid);
    assert.equal(other.blockchain.at(-1).txid,txid);
  }
});

test('the public battle API reports and verifies the rules committed by each battle across versions',async t=>{
  let now=T;
  const app=await localApi(t,()=>now);
  const archived=JSON.parse(readFileSync(new URL('../../docs/VAULTBORN_VERIFIABLE_BATTLE.json',import.meta.url),'utf8'));
  const {world}=app.store.read();
  world.seq=100;
  world.secret='rules-api-fixture';
  act(world,'p1','tutorial');
  world.cities.p2.terrain='forest';
  const report=act(world,'p1','attack',{target:'p2'});
  registerBattle(app.store,report,null,T);
  const {record,recordHash,event,publicAt}=archived;
  app.store.savePortal('battle',record.battle.id,{record,recordHash,event,publicAt});
  now=Math.max(now+DAY,publicAt);

  const old=await app.get('public/battle/'+record.battle.id);
  const current=await app.get('public/battle/'+report.id);
  assert.equal(old.rules.version,'vaultborn-combat-1');
  assert.equal(old.rules.fieldDoctrine,undefined);
  assert.equal(old.record.rulesHash,record.rulesHash);
  assert.equal(old.recordHash,recordHash);
  assert.equal(current.rules.version,'vaultborn-combat-2');
  assert.equal(current.rules.fieldDoctrine.version,2);
  assert.equal(current.record.battle.input.attacker.fieldRules,2);
  assert.equal(current.record.battle.input.defender.fieldRules,2);
  for (const proof of [old,current]) {
    assert.equal(proof.verified,true);
    assert.equal(protocolHash(proof.rules),proof.record.rulesHash);
    assert.equal(protocolHash(proof.record),proof.recordHash);
  }
});
