import {commanderRules} from '../../config/progression.mjs'
import {troopTotal} from './combat.mjs'
import {credit, has, notify, requireRule} from './world.mjs'

// Campaign tasks: milestones every kingdom can reach. Each pays a reward of earned supplies once, sized by how much the
// milestone matters. A milestone reached before the tasks existed can still be claimed: each one is checked against the
// kingdom as it is now.
export const taskRewards = Object.freeze({
  small: Object.freeze({wood: 40, stone: 30, iron: 18, food: 45, crystal: 3}),
  medium: Object.freeze({wood: 90, stone: 70, iron: 40, food: 100, crystal: 8}),
  large: Object.freeze({wood: 180, stone: 140, iron: 80, food: 200, crystal: 16}),
  major: Object.freeze({wood: 300, stone: 240, iron: 140, food: 320, crystal: 30}),
})

const level = (city, building) => city.buildings?.[building] ?? 0
const hired = city => Object.entries(city.commanders?.roster ?? {}).some(([id, row]) =>
  !commanderRules.baseline.includes(id) && (row.permanent || row.recruitedAt || row.expiresAt))
const holds = (world, city) => (world.territories ?? []).some(site => site.category !== 'starter' && (site.owner === city.id || site.controller === city.id))

export const campaignTasks = Object.freeze([
  {id: 'daily', title: 'Claim your daily supplies', tier: 'small', done: city => city.lastCollect > 0},
  {id: 'hall-2', title: 'Raise City Hall to level 2', tier: 'small', done: city => level(city, 'hall') >= 2, progress: city => [level(city, 'hall'), 2]},
  {id: 'train', title: 'Train troops in the Barracks', tier: 'small',
    done: city => [...(city.history ?? []), ...(city.queue ?? [])].some(job => job.kind === 'troop')},
  {id: 'research', title: 'Research a technology', tier: 'medium', done: city => Object.values(city.tech ?? {}).some(value => value > 0)},
  {id: 'scout', title: 'Bring back a scouting report', tier: 'medium', done: city => has(city.achievements ?? {}, 'eyes-in-mist')},
  {id: 'battle', title: 'Win a battle', tier: 'medium', done: city => has(city.achievements ?? {}, 'frontier-defender')},
  {id: 'alliance', title: 'Join an alliance', tier: 'medium', done: city => Boolean(city.alliance)},
  {id: 'hall-3', title: 'Raise City Hall to level 3', tier: 'medium', done: city => level(city, 'hall') >= 3, progress: city => [level(city, 'hall'), 3]},
  {id: 'walls-3', title: 'Raise the Walls to level 3', tier: 'medium', done: city => level(city, 'walls') >= 3, progress: city => [level(city, 'walls'), 3]},
  {id: 'commander', title: 'Hire or recruit a commander', tier: 'medium', done: hired},
  {id: 'army-150', title: 'Muster an army of 150 troops', tier: 'large', done: city => troopTotal(city.troops ?? {}) >= 150,
    progress: city => [troopTotal(city.troops ?? {}), 150]},
  {id: 'territory', title: 'Hold a territory beyond your homeland', tier: 'large', done: holds},
  {id: 'hall-5', title: 'Raise City Hall to level 5', tier: 'major', done: city => level(city, 'hall') >= 5, progress: city => [level(city, 'hall'), 5]},
])

export function taskSnapshot(world, city) {
  return campaignTasks.map(task => {
    const claimedAt = city.taskRewards?.[task.id] ?? null
    const done = Boolean(claimedAt) || Boolean(task.done(city, world))
    const [value, goal] = task.progress?.(city) ?? []
    return {id: task.id, title: task.title, tier: task.tier, reward: taskRewards[task.tier], done, claimed: Boolean(claimedAt),
      ...(goal && {progress: Math.min(value, goal), goal})}
  })
}

export function claimTask(world, city, input, now) {
  const task = campaignTasks.find(item => item.id === input.task)
  requireRule(task, 'invalid_task', 'Choose a campaign task.', 400)
  city.taskRewards ??= {}
  requireRule(!city.taskRewards[task.id], 'task_claimed', 'This reward was already claimed.')
  requireRule(task.done(city, world), 'task_open', 'Finish this task first.')
  const collected = credit(city, taskRewards[task.tier], now)
  city.taskRewards[task.id] = now
  notify(world, city.id, 'Task reward: ' + task.title + '.', now, 'city', {title: 'Task reward claimed', resources: collected, task: task.id})
  return {task: task.id, title: task.title, tier: task.tier, collected}
}
