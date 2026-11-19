import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GAMEPLAY_ALLOCATION, LEGACY_ALLOCATION} from '../../config/payments.mjs';
import {contestNet, runAudit} from './audit.mjs';

test('the candidate preserves stake principal, bounds loot, and never generates paired-wallet profit',()=>{
  for (const [policy,friction] of [[GAMEPLAY_ALLOCATION,-950],[LEGACY_ALLOCATION,-3350]]) {
    for (const commitment of [0,1000,15000,250000]) for (const won of [true,false]) {
      const {attacker,defender,capture,forfeit}=contestNet({policy,won,committed:commitment});
      assert.equal(attacker+defender,friction);
      assert.ok(capture<=Math.floor(commitment*.20));
      assert.ok(forfeit<=(policy===GAMEPLAY_ALLOCATION?1500:3000));
      if (policy===GAMEPLAY_ALLOCATION) assert.ok(capture<=3000);
      const sameWallet=contestNet({policy,won,committed:commitment,eligibleWallets:false});
      assert.equal(sameWallet.defender,0);
      assert.equal(sameWallet.capture+sameWallet.forfeit,0);
    }
  }
});

test('the paired season simulator is deterministic and conserves modeled BCH for every horizon',()=>{
  const options={grid:{100:2},short:true};
  const first=runAudit(options);
  assert.deepEqual(first,runAudit(options));
  assert.equal(first.executions,4);
  assert.equal(first.realmObservations,16);
  for (const rounds of Object.values(first.results)) for (const day of first.horizons) {
    assert.equal(rounds[100].overall[day].conserved,true);
    assert.ok(rounds[100].overall[day].power.every(Number.isFinite));
  }
});
