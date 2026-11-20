import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, MINUTE, dailyLevy, starterResources, starterShield } from '../../config/economy.mjs';
import { simulateBattle } from './combat.mjs';
import { addPlayer, advance, command, createWorld, snapshot } from './index.mjs';
import { readTerritories } from './territories.mjs';

const now = 40 * DAY;
const player = 'new-guide';
const firstBanner = { wood:45, stone:30, iron:18, food:50, crystal:5 };
const act = (world, type, fields) => command(world, player, { type, ...fields });
const chapter = world => snapshot(world, player).player.onboarding;
const lesson = (world, action, step = chapter(world).step) => act(world,'tutorial',{action,step});

test('the new chapter uses real kingdom orders, survives a save, and completes without BCH', () => {
  let world = createWorld(now);
  addPlayer(world,{id:player});
  assert.equal(chapter(world),null);
  assert.throws(() => act(world,'tutorial'),{code:'founding_required'});
  assert.throws(() => act(world,'tutorial',{action:'practice'}),{code:'founding_required'});
  readTerritories(world,player);
  act(world,'found',{cityName:'Cedarwatch',faction:'violet'});
  const homelands = readTerritories(world,player).territories.filter(site => site.owner === player && site.category === 'starter');
  assert.equal(homelands.length,1);
  assert.equal(homelands[0].name,'Cedarwatch Homelands');
  assert.equal(homelands[0].protected,true);
  assert.equal(chapter(world).position,1);
  assert.equal(chapter(world).total,13);
  assert.throws(() => lesson(world,'finish'),{code:'tutorial_incomplete'});

  assert.equal(lesson(world,'next').onboarding.step,'homeland');
  assert.equal(lesson(world,'back').onboarding.step,'welcome');
  assert.equal(lesson(world,'next').onboarding.step,'homeland');
  assert.equal(lesson(world,'next').onboarding.step,'construction');
  assert.throws(() => lesson(world,'next','homeland'),{code:'tutorial_step_changed'});
  assert.throws(() => lesson(world,'next'),{code:'tutorial_action_required'});
  const hall = act(world,'upgrade',{building:'hall'});
  assert.ok(hall.completesAt > now && hall.completesAt < now + 2 * MINUTE);
  assert.equal(lesson(world,'next').onboarding.step,'stores');
  const grant = act(world,'collect');
  assert.deepEqual(grant.collected,dailyLevy);
  assert.equal(lesson(world,'next').onboarding.step,'troops');

  assert.equal(lesson(world,'pause').onboarding.status,'paused');
  world = JSON.parse(JSON.stringify(world));
  assert.equal(chapter(world).step,'troops');
  assert.throws(() => lesson(world,'next'),{code:'tutorial_paused'});
  assert.equal(lesson(world,'resume').onboarding.status,'active');
  const originalTroops = world.cities[player].troops.infantry;
  assert.throws(() => lesson(world,'next'),{code:'tutorial_action_required'});
  const recruits = act(world,'train',{unit:'infantry',count:6});
  assert.equal(lesson(world,'next').onboarding.step,'commander');
  assert.equal(lesson(world,'next').onboarding.step,'tactics');
  act(world,'configure');
  assert.equal(chapter(world).ready,false);
  act(world,'configure',{formation:'wedge',tactic:'flank'});
  assert.equal(lesson(world,'next').onboarding.step,'drill');

  advance(world,now + 10 * MINUTE);
  const city = world.cities[player];
  assert.equal(city.buildings.hall,2);
  assert.equal(city.troops.infantry,originalTroops+recruits.count);
  for (const material of Object.keys(starterResources)) {
    assert.ok(city.resources[material] > 0);
  }
  const before = structuredClone({ resources:city.resources, troops:city.troops, score:city.score, influence:city.influence,
    shieldUntil:city.shieldUntil, battles:world.battles, marches:world.marches, notifications:world.notifications });
  assert.throws(() => lesson(world,'next'),{code:'tutorial_action_required'});
  const { drill } = lesson(world,'drill');
  const { battle, trace } = drill;
  assert.equal(battle.input.attacker.formation,'wedge');
  assert.equal(battle.input.attacker.troops.infantry,city.troops.infantry);
  assert.equal(simulateBattle(battle.input,battle.seed).hash,battle.hash);
  assert.equal(trace.length,battle.events.length);
  assert.deepEqual({ resources:city.resources, troops:city.troops, score:city.score, influence:city.influence,
    shieldUntil:city.shieldUntil, battles:world.battles, marches:world.marches, notifications:world.notifications },before);
  world = JSON.parse(JSON.stringify(world));
  assert.deepEqual(chapter(world).drill,drill);
  assert.equal(lesson(world,'next').onboarding.step,'discover-bch');
  assert.equal(chapter(world).position,9);
  assert.equal(lesson(world,'next').onboarding.step,'bch-wallet');
  assert.equal(lesson(world,'pause').onboarding.status,'paused');
  world = JSON.parse(JSON.stringify(world));
  assert.equal(chapter(world).step,'bch-wallet');
  assert.equal(lesson(world,'resume').onboarding.status,'active');
  assert.equal(lesson(world,'next').onboarding.step,'bch-actions');
  assert.equal(lesson(world,'next').onboarding.step,'season-rewards');
  assert.equal(lesson(world,'back').onboarding.step,'bch-actions');
  assert.equal(lesson(world,'next').onboarding.step,'season-rewards');
  assert.deepEqual(chapter(world).drill,drill);
  assert.deepEqual(world.cities[player].resources,before.resources);
  assert.deepEqual(world.cities[player].troops,before.troops);
  assert.deepEqual(world.battles,before.battles);
  assert.equal(lesson(world,'next').onboarding.step,'frontier');

  const finished = lesson(world,'finish');
  assert.equal(finished.onboarding.status,'completed');
  assert.deepEqual(finished.reward,firstBanner);
  assert.equal(world.cities[player].shieldUntil,0);
  assert.equal(world.cities[player].optIn,true);
  assert.equal(world.cities[player].tutorialOpen,undefined);
  assert.equal(world.cities[player].achievements['first-banner'],now+10*MINUTE);
  assert.throws(() => lesson(world,'finish'),{code:'tutorial_complete'});
  assert.equal(world.notifications[player].filter(entry => entry.achievement==='first-banner').length,1);
  const completedWorld = structuredClone(world);
  assert.equal(act(world,'tutorial',{action:'practice'}).drill.battle.hash,battle.hash);
  assert.deepEqual(world,completedWorld);
});

test('persisted frontier checkpoints stay finishable and the original banner cannot be claimed again', () => {
  const world = createWorld(now);
  addPlayer(world,{id:player});
  act(world,'found',{cityName:'First Harbor',faction:'azure'});
  Object.assign(world.cities[player].onboarding,{status:'paused',step:'frontier',orders:{construction:true,troops:true,tactics:true}});
  const restored = JSON.parse(JSON.stringify(world));
  assert.deepEqual(chapter(restored),{status:'paused',step:'frontier',position:13,total:13,ready:true,requirement:null,drill:null});
  assert.equal(lesson(restored,'resume').onboarding.step,'frontier');
  assert.deepEqual(lesson(restored,'finish').reward,firstBanner);
  assert.throws(() => lesson(restored,'back'),{code:'tutorial_complete'});
  assert.throws(() => lesson(restored,'finish'),{code:'tutorial_complete'});
});

test('legacy cities keep their existing tutorial state, and explicit skip unlocks the same reward once', () => {
  const world = createWorld(now);
  const city = addPlayer(world,{id:player});
  delete city.pendingOnboarding;
  act(world,'found',{cityName:'Old Harbor',faction:'azure'});
  assert.equal(chapter(world),null);
  assert.deepEqual(act(world,'tutorial').reward,firstBanner);
  assert.equal(chapter(world),null);
  assert.equal(snapshot(world,'p1').player.onboarding,null);
  const legacy = command(world,'p1',{type:'tutorial',action:'practice'});
  assert.equal(legacy.drill.battle.defenderName,'Frontier Guard');
  assert.equal(snapshot(world,'p1').player.onboarding,null);

  const fresh = createWorld(now);
  addPlayer(fresh,{id:player});
  act(fresh,'found',{cityName:'New Harbor',faction:'azure'});
  lesson(fresh,'pause');
  const skipped = lesson(fresh,'skip');
  assert.equal(skipped.onboarding.status,'skipped');
  assert.deepEqual(skipped.reward,firstBanner);
  assert.throws(() => lesson(fresh,'skip'),{code:'tutorial_complete'});
});

test('a kingdom that has just signed up is greeted once; older kingdoms are not', () => {
  const world = createWorld(now);
  const city = addPlayer(world,{id:player});
  assert.equal(snapshot(world,player).player.welcome,false,'not before the city is founded');
  act(world,'found',{cityName:'Greeting Hold',faction:'azure'});
  assert.equal(snapshot(world,player).player.welcome,true);
  // The greeting is forgotten as soon as it is shown, whatever the player then chooses.
  assert.deepEqual(act(world,'welcomed'),{welcomed:true});
  assert.equal(snapshot(world,player).player.welcome,false);
  assert.deepEqual(act(world,'welcomed'),{welcomed:false},'a second call changes nothing');
  // The tutorial itself stays available.
  assert.equal(chapter(world).status,'active');
  // A kingdom from before this greeting existed has no greeting.
  delete city.welcome;
  assert.equal(snapshot(world,player).player.welcome,false);
});
