import {test} from 'node:test'
import assert from 'node:assert/strict'
import {battleExperiment,economyRun} from './index.mjs'

test('deterministic balance sample maintains defense, readiness and limited intel effects', () => {
  const trial = battleExperiment(280)
  assert.equal(trial.runs,1_400)
  assert.equal(trial.premiumDivergence,0)
  assert.ok(trial.groups[2].attackerWinPercent >= 28 && trial.groups[2].attackerWinPercent <= 45)
  assert.ok(trial.groups[3].attackerWinPercent > trial.groups[2].attackerWinPercent + 15)
  assert.ok(trial.groups[4].attackerWinPercent <= 99)
  assert.ok(trial.intelWinLiftPP > 0 && trial.intelWinLiftPP <= 8)
  assert.ok(trial.terrainWinPercent.river + 4 < trial.terrainWinPercent.plains)
})

test('matched resource strategies stay competitive without payment across a simulated month', () => {
  const free = economyRun(1,{premium:false})
  const paid = economyRun(5,{premium:true})
  assert.deepEqual(free.snapshots.map(row => row.day),[1,7,30])
  const end = free.snapshots.at(-1)
  const premium = paid.snapshots.at(-1)
  assert.equal(end.satoshis,0)
  assert.ok(premium.satoshis > 0)
  assert.ok(Math.abs(premium.hall - end.hall) <= 1)
  assert.ok(Math.abs(premium.levelSum - end.levelSum) <= 2)
  assert.ok(premium.milestone3 <= end.milestone3)
  assert.ok(end.launched + end.blocked === end.attempts)
})
