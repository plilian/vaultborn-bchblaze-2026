// This season has no shields: nobody starts behind one, a defeat gives none, and shields from earlier rules are lifted once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR } from '../../config/economy.mjs';
import { addPlayer, advance, attackEligibility, command, createWorld } from './index.mjs';

const T = Date.UTC(2026, 10, 20, 12);

test('a new kingdom has no shield, and losing a raid gives no shield to either side', () => {
  const world = createWorld(T);
  const me = addPlayer(world, { id:'me', name:'Tester' }, T + 1000);
  assert.equal(me.shieldUntil > T + 1000, false);
  // A raid on the strongest kingdom on the map: whoever loses keeps fighting the next moment.
  const now = T + 2000;
  const target = Object.values(world.cities).filter(city => city.id !== 'me' && attackEligibility(world, me, city, now).ok)
    .sort((a, b) => b.buildings.hall - a.buildings.hall)[0];
  const battle = command(world, 'me', { type:'attack', target:target.id }, now);
  const loser = battle.winner === 'attacker' ? world.cities[target.id] : me;
  assert.equal(loser.shieldUntil > now, false, 'no recovery shield');
  assert.equal(JSON.stringify(battle.aftermath ?? {}).includes('shieldUntil'), false, 'the report promises no shield');
  const other = Object.values(world.cities).find(city => city.id !== 'me' && city.id !== target.id && attackEligibility(world, me, city, now + 1000).code !== 'power_gap');
  if (other) assert.notEqual(attackEligibility(world, me, other, now + 1000).code, 'protected');
});

test('shields given under the earlier rules are lifted once, at the next turn of the world', () => {
  const world = createWorld(T);
  // A world saved before this rule: no marker, and kingdoms behind starter and recovery shields.
  delete world.shieldsLifted;
  const cities = Object.values(world.cities).slice(0, 3);
  for (const city of cities) city.shieldUntil = T + 4 * HOUR;
  advance(world, T + HOUR);
  assert.ok(cities.every(city => !(city.shieldUntil > world.now)));
  assert.equal(world.shieldsLifted, true);
  // Once only: a shield set by a later rule is not touched by this.
  cities[0].shieldUntil = T + 9 * HOUR;
  advance(world, T + 2 * HOUR);
  assert.equal(cities[0].shieldUntil, T + 9 * HOUR);
});
