import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DAY, HOUR, MINUTE } from '../../config/economy.mjs';
import { addPlayer, advance, command, createWorld } from './index.mjs';
import { digest, troopTotal, simulateBattle } from './combat.mjs';
import { applyTerritoryPayment, ensureTerritories, quoteTerritory, readTerritories, territoryCommand,
  territoryProduction, territoryRules } from './territories.mjs';

const T = 10 * DAY;
const WALLET_1 = 'bchtest:qp3w6c2x3syvjpfn3tf5muffvlnggpfzuy7s6zr6z6';
const WALLET_2 = 'bchtest:qzygq4xr0d0hq0lcku5xwj2dc6w9vvxqjqfla9ra3n';
const setup = () => {
  const world = createWorld(T);
  world.secret = 'territory-tests';
  command(world,'p1',{type:'tutorial'},T);
  return world;
};
const confirmation = (id,walletAddress,satoshis = territoryRules.claimFee) => ({id,walletAddress,satoshis,
  txid:createHash('sha256').update(id).digest('hex'),escrowSatoshis:satoshis/2});
const entry = (world,player,payment,territory='east-meadow') =>
  applyTerritoryPayment(world,player,{type:'territory-claim',territory},payment,world.now);
const siteBy = (world,id='east-meadow') => world.territories.find(site => site.id === id);

test('saved territory migration retains incumbents and issues exactly one protected starter per city', () => {
  const world = setup();
  world.nodes.find(node => node.id === 'mine').owner = 'p2';
  world.nodes.find(node => node.id === 'ruins').owner = 'p4';
  ensureTerritories(world,T);
  assert.equal(siteBy(world,'mine').controller,'p2');
  assert.equal(siteBy(world,'ruins').owner,'p4');
  assert.equal(siteBy(world,'ruins').category,'resource');
  assert.equal(siteBy(world,'fort').controller,'p6');
  assert.equal(siteBy(world,'watch').controller,'p10');
  assert.ok(world.territories.filter(site=>site.category==='strategic').every(site=>world.cities[site.owner].npc));
  assert.throws(() => quoteTerritory(world,'p1',{type:'territory-claim',territory:'watch'},T),{code:'territory_not_open'});
  addPlayer(world,{id:'new-holding',name:'New Holding',cityName:'New Holding'},T);
  const view = readTerritories(world,'new-holding',T);
  assert.deepEqual(new Set(view.territories.map(site => site.category)),new Set(['starter','unclaimed','resource','strategic','rare']));
  assert.equal(view.territories.filter(site => site.owner==='new-holding' && site.category==='starter').length,1);
  assert.equal(siteBy(world,'starter-new-holding').protected,true);
  assert.equal(view.territories.length,new Set(view.territories.map(site => site.id)).size);
  assert.throws(() => quoteTerritory(world,'p1',{type:'territory-attack',territory:'starter-p2'},T),{code:'territory_attack_target'});
  // A new kingdom is enrolled from its first day; what stops this claim is distance, not enrolment.
  assert.throws(() => quoteTerritory(world,'new-holding',{type:'territory-claim',territory:'east-meadow'},T),{code:'territory_distance'});
});

test('solo confirmed contest waits an hour, freezes a sortie, and returns funded escrow without inventing BCH', () => {
  const world = setup();
  const original = troopTotal(world.cities.p1.troops);
  const payment = confirmation('solo',WALLET_1);
  const result = entry(world,'p1',payment);
  assert.deepEqual(result,entry(world,'p1',payment));
  assert.throws(() => entry(world,'p2',payment),{code:'territory_receipt_reused'});
  assert.equal(result.endsAt-T,HOUR);
  assert.equal(result.endsAt-result.lockAt,2*MINUTE);
  assert.equal(siteBy(world).owner,null);
  advance(world,result.lockAt);
  assert.equal(siteBy(world).claim.status,'locked');
  assert.equal(troopTotal(world.cities.p1.troops),original-territoryRules.maxSortie);
  assert.throws(() => entry(world,'p2',confirmation('late',WALLET_2)),{code:'territory_claim_locked'});
  const portable = JSON.parse(JSON.stringify(world));
  advance(portable,result.endsAt);
  const record = portable.territorySettlements[0];
  assert.equal(siteBy(portable).owner,'p1');
  assert.equal(record.version,1);
  assert.equal(siteBy(portable).version,1);
  assert.equal(troopTotal(portable.cities.p1.troops),original);
  assert.deepEqual(record.distributions,[{entryId:payment.id,playerId:'p1',satoshis:2000,reason:'claim-winner'}]);
  assert.equal(record.battles.length,0);
  advance(portable,result.endsAt+MINUTE);
  assert.equal(portable.territorySettlements.length,1);
});

test('simultaneous claim receipts enforce one wallet, city and alliance per contest', () => {
  const world = setup();
  entry(world,'p1',confirmation('first',WALLET_1));
  assert.throws(() => entry(world,'p3',confirmation('ally',WALLET_2)),{code:'territory_alliance_entry'});
  assert.throws(() => entry(world,'p2',confirmation('same-wallet',WALLET_1)),{code:'territory_wallet_duplicate'});
  assert.throws(() => entry(world,'p1',confirmation('different-site',WALLET_1),'whisperwood'),{code:'territory_commitment'});
  assert.throws(() => entry(world,'p2',confirmation('wrong-price',WALLET_2,2000)),{code:'territory_receipt'});
  assert.throws(() => command(world,'p1',{type:'opt-in',enabled:false},T),{code:'territory_contest_active'});
  assert.equal(siteBy(world).claim.entries.length,1);
});

test('mirrored neutral matches freeze troop input and do not depend on entrant order', () => {
  function run(order) {
    const world = setup();
    const available = Object.fromEntries(order.map(player => [player,troopTotal(world.cities[player].troops)]));
    for (const player of order) entry(world,player,confirmation(player,player==='p1'?WALLET_1:WALLET_2));
    const claim = siteBy(world).claim;
    advance(world,claim.lockAt);
    for (const player of order) {
      assert.equal(troopTotal(world.cities[player].troops),available[player]-48);
      assert.equal(world.cities[player].territoryLocked[claim.id].infantry > 0,true);
    }
    // A post-lock strategy change cannot rewrite a locked battle input.
    command(world,'p1',{type:'configure',tactic:'siege',formation:'wedge'},claim.lockAt+10);
    advance(world,claim.endsAt);
    for (const player of order) assert.ok(troopTotal(world.cities[player].troops) < available[player]);
    const result = world.territorySettlements[0];
    assert.equal(result.battles.length,2);
    assert.equal(result.distributions.reduce((sum,allocation)=>sum+allocation.satoshis,0),4000);
    assert.ok(result.distributions.every(allocation=>allocation.playerId===result.winner));
    assert.equal(digest(result.rules.seed),result.rules.commitment);
    for (const duel of world.battles) {
      assert.equal(simulateBattle(duel.input,duel.seed).hash,duel.hash);
      assert.equal(duel.input.attacker.tactic,'balanced');
      assert.equal(duel.input.defender.tactic,'balanced');
      assert.equal(duel.input.attacker.wall,0);
    }
    return result.winner;
  }
  assert.equal(run(['p1','p2']),run(['p2','p1']));
});

test('controlled territories support promotion, reinforcement, recorded conquest and loss protection', () => {
  const world = setup();
  world.nodes.find(node=>node.id==='trade').owner = 'p2';
  ensureTerritories(world,T);
  const target = siteBy(world,'trade');
  const before = world.cities.p2.troops.infantry;
  territoryCommand(world,'p2',{type:'territory-garrison',territory:target.id,unit:'infantry',count:4},T);
  assert.equal(world.cities.p2.troops.infantry,before-4);
  territoryCommand(world,'p2',{type:'territory-fortify',territory:target.id},T);
  assert.equal(target.defenses.garrison.infantry,4);
  assert.equal(target.defenses.level,2);
  assert.throws(() => territoryCommand(world,'p1',{type:'territory-abandon',territory:target.id},T),{code:'territory_owner'});
  const quote = quoteTerritory(world,'p1',{type:'territory-attack',territory:target.id},T);
  assert.equal(quote.action.expectedOwner,'p2');
  const executed = applyTerritoryPayment(world,'p1',quote.action,confirmation('attack',WALLET_1,territoryRules.attackFee),T);
  assert.equal(executed.battle.kind,'territory-attack');
  assert.equal(executed.battle.winner,'attacker');
  assert.equal(target.owner,'p1');
  assert.equal(executed.version,2);
  assert.equal(target.version,2);
  assert.equal(target.level,1);
  assert.equal(executed.battle.conquest.previousOwner,'p2');
  assert.equal(world.marches[0].kind,'raid');
  assert.equal(simulateBattle(executed.battle.input,executed.battle.seed).hash,executed.battle.hash);
  assert.equal(world.cities.p2.shieldUntil,T+4*HOUR);
  assert.throws(() => quoteTerritory(world,'p3',{type:'territory-attack',territory:target.id},T),{code:'territory_recovery'});
});

test('rare lease extraction starts and expires at the exact persisted 72-hour timestamps', () => {
  const world = setup();
  ensureTerritories(world,T);
  const rare = world.territories.find(site=>site.category==='rare');
  const startsAt = T + HOUR;
  const expiresAt = startsAt + 72*HOUR;
  world.territoryRaffles = {[rare.id]:{lease:{playerId:'p1',startsAt,expiresAt}}};
  assert.equal(territoryProduction(world,'p1',startsAt-1).crystal,0);
  assert.equal(territoryProduction(world,'p1',startsAt).crystal,rare.production.crystal);
  assert.equal(territoryProduction(world,'p2',startsAt).crystal,0);
  assert.equal(territoryProduction(world,'p1',expiresAt).crystal,0);
  assert.equal(readTerritories(world,'p1',startsAt).territories.find(site=>site.id===rare.id).controller,'p1');
  assert.equal(readTerritories(world,'p1',expiresAt).territories.find(site=>site.id===rare.id).controller,null);
  const baseline = structuredClone(world);
  delete baseline.territoryRaffles;
  advance(world,startsAt+HOUR);
  advance(baseline,startsAt+HOUR);
  assert.equal(world.cities.p1.resources.crystal-baseline.cities.p1.resources.crystal,rare.production.crystal);
  assert.equal(rare.owner,null);
});

test('inactivity releases non-starter territory and returns its surviving garrison', () => {
  const world = setup();
  world.nodes.find(node=>node.id==='mine').owner='p1';
  ensureTerritories(world,T);
  territoryCommand(world,'p1',{type:'territory-garrison',territory:'mine',unit:'infantry',count:4},T);
  const partial = world.cities.p1.troops.infantry;
  advance(world,T+72*HOUR);
  assert.equal(siteBy(world,'mine').owner,null);
  assert.equal(siteBy(world,'mine').history.at(-1).kind,'inactivity-expired');
  assert.equal(world.cities.p1.troops.infantry,partial+4);
  assert.equal(siteBy(world,'starter-p1').owner,'p1');
});
