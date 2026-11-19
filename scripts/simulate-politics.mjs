import assert from 'node:assert/strict';
import { HOUR, MINUTE, resources } from '../config/economy.mjs';
import { advance, command, createWorld } from '../packages/game-engine/index.mjs';
import { governmentMorale, governmentProductionMultiplier, governmentState } from '../packages/game-engine/government.mjs';

const start=1000*HOUR;
const samples=100;
const sum=stock=>resources.reduce((total,key)=>total+stock[key],0);
const act=(world,action)=>command(world,'p1',action,world.now);
const policies=[{tax:'exempt',stance:'civic'},{tax:'balanced',stance:'commerce'},{tax:'heavy',stance:'mobilization'}];
const taxResults=policies.map(policy=>{
  const world=createWorld(start);
  act(world,{type:'tutorial'});
  const opening=sum(world.cities.p1.resources);
  if (policy.tax!=='exempt') act(world,{type:'government-policy',...policy});
  const productionMultiplier=governmentProductionMultiplier(world,'p1');
  const moraleMultiplier=governmentMorale(world,'p1');
  advance(world,start+HOUR);
  const state=governmentState(world,'p1').kingdom;
  return {...policy,hours:1,privateResourceGain:sum(world.cities.p1.resources)-opening,civicReserve:sum(state.civic),
    unrest:state.unrest,productionMultiplier,moraleMultiplier};
});
assert.equal(taxResults[0].civicReserve,0);
assert.ok(taxResults[0].civicReserve < taxResults[1].civicReserve && taxResults[1].civicReserve<taxResults[2].civicReserve);
assert.ok(taxResults[2].unrest>taxResults[0].unrest);

const conflicts=['default','flank','flank-and-allied-reinforcements'].map(preparation=>{
  let successful=0,casualties=0;
  for (let i=0;i<samples;i++) {
    const world=createWorld(start);
    world.secret='political-balance-'+i;
    act(world,{type:'tutorial'});
    act(world,{type:'government-policy',tax:'heavy',stance:'mobilization'});
    const conflict=act(world,{type:'political-conflict-open',kind:'coup'});
    if (preparation!=='default') act(world,{type:'political-conflict-order',conflict:conflict.id,side:'challenger',tactic:'flank',formation:'wedge'});
    if (preparation==='flank-and-allied-reinforcements') {
      command(world,'p3',{type:'political-conflict-support',conflict:conflict.id,side:'challenger',mode:'troops',unit:'infantry',count:12},world.now);
    }
    advance(world,conflict.nextAt+8*MINUTE);
    assert.equal(conflict.rounds.length,3);
    if (conflict.winner==='challenger') successful++;
    casualties+=Object.values(conflict.casualties.p1).reduce((n,quantity)=>n+quantity,0);
  }
  return {preparation,samples,successful,meanInitiatorCasualties:Number((casualties/samples).toFixed(2))};
});
console.log(JSON.stringify({taxResults,conflicts},null,2));
