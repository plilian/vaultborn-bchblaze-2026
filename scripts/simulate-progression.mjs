import assert from 'node:assert/strict';
import {DAY,resources} from '../config/economy.mjs';
import {createWorld} from '../packages/game-engine/index.mjs';
import {armyPower,seeded,simulateBattle,troopTotal,unitIds} from '../packages/game-engine/combat.mjs';
import {commanderSnapshot} from '../packages/game-engine/progression.mjs';
import {currentTactic} from '../packages/game-engine/world.mjs';

const world=createWorld(500*DAY);
const attacker=world.cities.p1, defender=world.cities.p2;
attacker.hero='commander';
defender.hero='warden';
const baseAttacker=currentTactic(attacker,world,world.now,attacker.hero,1), baseDefender=currentTactic(defender,world,world.now,defender.hero,1);
attacker.commanders={legacy:true,roster:{commander:{level:4,xp:110,equipment:'field-standard'}},equipment:{'field-standard':true}};
defender.commanders={legacy:true,roster:{warden:{level:4,xp:110,equipment:'sentinel-plate'}},equipment:{'sentinel-plate':true}};
const veteranAttacker=currentTactic(attacker,world,world.now,attacker.hero,1), veteranDefender=currentTactic(defender,world,world.now,defender.hero,1);
const tally=()=>({wins:0,losses:0});
const sides={baseline:tally(),veteranAttacker:tally(),veteranDefense:tally(),bothVeteran:tally(),wrongFormation:tally(),terrainDoctrine:tally()};
const profiles={
  combined:{infantry:29,shield:16,archer:25,cavalry:16,siege:7,mage:7},
  cavalry:{infantry:14,shield:14,archer:13,cavalry:48,siege:6,mage:5},
  ranged:{infantry:12,shield:14,archer:41,cavalry:9,siege:7,mage:17},
  shieldwall:{infantry:13,shield:48,archer:20,cavalry:8,siege:4,mage:7},
};
const doctrines=['balanced','assault','flank','siege'];
const terrain=['plains','hills','river','forest','coast','desert'];
const samples=12_000, random=seeded('vaultborn-progression-audit-v1');
const pick=entries=>entries[Math.floor(random()*entries.length)];
const presets=Object.keys(profiles);
const formations={combined:'line',cavalry:'wedge',ranged:'screen',shieldwall:'line'};
const roster=(key,power)=>Object.fromEntries(unitIds.map(unit=>[unit,Math.round(profiles[key][unit]*power/armyPower(profiles[key]))]));
const add=(line,result)=>{
  line.wins+=result.winner==='attacker' ? 1 : 0;
  line.losses+=troopTotal(result.losses.attacker);
};
const byBuild=Object.fromEntries(presets.map(key=>[key,{samples:0,...tally()}]));
const revisedByBuild=Object.fromEntries(presets.map(key=>[key,{samples:0,...tally()}]));
const headToHead=Object.fromEntries(presets.flatMap(a=>presets.map(d=>[a+' vs '+d,{samples:0,...tally()}])));
for (let i=0;i<samples;i++) {
  const shape=pick(presets), defenseShape=pick(presets);
  const orders={troops:roster(shape,1150+Math.floor(random()*210)),tactic:pick(doctrines),formation:formations[shape]};
  const defense={troops:roster(defenseShape,1150+Math.floor(random()*210)),tactic:pick(doctrines),formation:formations[defenseShape],
    wall:1+Math.floor(random()*4),tech:{tactics:Math.floor(random()*3)}};
  const field=pick(terrain);
  const input=(a,d,extra)=>({attacker:{...a,...orders,...extra},defender:{...d,...defense},terrain:field});
  const seed=['combat-build-audit',i];
  const baseline=simulateBattle(input(baseAttacker,baseDefender),seed);
  add(sides.baseline,baseline);
  add(sides.veteranAttacker,simulateBattle(input(veteranAttacker,baseDefender),seed));
  add(sides.veteranDefense,simulateBattle(input(baseAttacker,veteranDefender),seed));
  add(sides.bothVeteran,simulateBattle(input(veteranAttacker,veteranDefender),seed));
  add(sides.wrongFormation,simulateBattle(input(baseAttacker,baseDefender,{formation:shape==='ranged'?'wedge':'screen'}),seed));
  const revised=simulateBattle(input({...baseAttacker,fieldRules:2},{...baseDefender,fieldRules:2}),seed);
  add(sides.terrainDoctrine,revised);
  ++revisedByBuild[shape].samples;
  add(revisedByBuild[shape],revised);
  ++byBuild[shape].samples;
  add(byBuild[shape],baseline);
  const matchup=headToHead[shape+' vs '+defenseShape];
  ++matchup.samples;
  add(matchup,baseline);
}
const summary=(row,count=samples)=>({samples:count,wins:row.wins,winPercent:+(row.wins/count*100).toFixed(2),meanAttackerCasualties:+(row.losses/count).toFixed(2)});
const score=cost=>resources.reduce((total,id,index)=>total+cost[id]*[1,1.2,1.55,.85,8][index],0);
const recruitment=Object.entries(commanderSnapshot(attacker,world.now).roster).flatMap(([hero,row])=>{
  const {cost,rentals}=row.recruitment;
  if (!rentals[1]) return [];
  const baseline7=Object.fromEntries(resources.map(id=>[id,Math.ceil(rentals[1][id]*5.25)]));
  return [{hero,rarity:row.rarity,permanent:Math.round(score(cost)),rent1:Math.round(score(rentals[1])),
    rent3:Math.round(score(rentals[3])),rent7:Math.round(score(rentals[7])),
    proposedRentalPercent:+(score(baseline7)/score(cost)*100).toFixed(1),
    rentalCostAsPercentOfPermanent:+(score(rentals[7])/score(cost)*100).toFixed(1)}];
});
// Upkeep/cap and the resource-only path are tested separately against the state machine.
assert.ok(sides.baseline.wins>0 && sides.baseline.wins<samples);
assert.ok(sides.veteranAttacker.wins>sides.baseline.wins,'attack trait should affect results');
assert.ok(sides.veteranDefense.wins<sides.baseline.wins,'defense trait should affect results');
assert.ok(sides.baseline.wins>sides.wrongFormation.wins,'formation should affect results');
console.log(JSON.stringify({seed:'vaultborn-progression-audit-v1',rosterBasis:'approximately equal composite army power',samples,totalResolutions:samples*6,
  results:Object.fromEntries(Object.entries(sides).map(([key,row])=>[key,summary(row)])),
  byBuild:Object.fromEntries(Object.entries(byBuild).map(([key,row])=>[key,summary(row,row.samples)])),
  revisedByBuild:Object.fromEntries(Object.entries(revisedByBuild).map(([key,row])=>[key,summary(row,row.samples)])),
  headToHead:Object.fromEntries(Object.entries(headToHead).map(([key,row])=>[key,summary(row,row.samples)])),recruitment},null,2));
