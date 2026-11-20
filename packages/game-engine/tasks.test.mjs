import assert from 'node:assert/strict'
import test from 'node:test'
import {addPlayer, command, createWorld, snapshot} from './index.mjs'
import {taskRewards} from './tasks.mjs'

const T = Date.UTC(2026, 10, 1)

test('a campaign task pays its reward once, only when reached, and a milestone reached earlier is claimable', () => {
  const world = createWorld(T)
  addPlayer(world, {id: 'tasker'}, T)
  command(world, 'tasker', {type: 'found', name: 'Ada Tasker', cityName: 'Taskhold', faction: 'emerald'}, T)
  assert.throws(() => command(world, 'tasker', {type: 'task-claim', task: 'daily'}, T), /Finish this task first/)
  command(world, 'tasker', {type: 'collect'}, T)
  const before = {...world.cities.tasker.resources}
  const claimed = command(world, 'tasker', {type: 'task-claim', task: 'daily'}, T)
  assert.deepEqual(claimed.collected, taskRewards.small)
  for (const [resource, amount] of Object.entries(taskRewards.small)) assert.equal(world.cities.tasker.resources[resource], before[resource] + amount)
  assert.throws(() => command(world, 'tasker', {type: 'task-claim', task: 'daily'}, T), /already claimed/)
  assert.throws(() => command(world, 'tasker', {type: 'task-claim', task: 'nothing'}, T), /Choose a campaign task/)
  // Reached before the tasks were offered: still claimable.
  world.cities.tasker.buildings.hall = 3
  const tasks = snapshot(world, 'tasker', T).player.tasks
  assert.deepEqual(tasks.filter(task => task.done && !task.claimed).map(task => task.id), ['hall-2', 'hall-3'])
  assert.equal(tasks.find(task => task.id === 'daily').claimed, true)
})
