// Five NPC kingdoms stay on the core map. The other seven of the first season's twelve leave it, so that arriving players
// can found their castles where those stood (see the first plots in frontier-layout.mjs). A world created now never has
// them; a world that still has them loses them once, the first time it advances, with every reference to them settled.
import {activity, notify} from './world.mjs'
import {releaseTerritories} from './territories.mjs'

export const npcRosterVersion = 5
export const retiredNpcIds = Object.freeze(['p5','p7','p11','p13','p14','p15','p16'])
// A frontier camp guarded by a kingdom that leaves passes to the nearest NPC that stays.
export const npcHeirs = Object.freeze({p11:'p6'})

export function retireNpcs(world, now = world.now) {
  if (world.npcRoster === npcRosterVersion) return false
  world.npcRoster = npcRosterVersion
  const gone = new Set(retiredNpcIds.filter(id => world.cities[id]?.npc))
  if (!gone.size) return false
  const names = new Map([...gone].map(id => [id, world.cities[id].name]))
  releaseTerritories(world, gone, npcHeirs, now)
  // A scout mission on its way to a kingdom that left is called back.
  for (const mission of world.missions ?? []) if (mission.status === 'pending' && gone.has(mission.target) && !gone.has(mission.actor)) {
    mission.status = 'cancelled'
    if (world.cities[mission.actor]) notify(world, mission.actor, 'Your scouts were called back: ' + names.get(mission.target) + ' has left the frontier.', now, 'spy', {title:'Mission called back'})
  }
  world.missions = (world.missions ?? []).filter(mission => !gone.has(mission.actor))
  world.marches = (world.marches ?? []).filter(march => !gone.has(march.attacker) && !gone.has(march.defender))
  const involved = row => [row.from, row.to, row.defender, row.overlord, row.actor, row.target].some(id => gone.has(id))
  world.treaties = (world.treaties ?? []).filter(row => !involved(row))
  world.governance = (world.governance ?? []).filter(row => !involved(row))
  for (const id of gone) {
    delete world.cities[id]
    delete world.notifications?.[id]
    delete world.government?.kingdoms?.[id]
  }
  for (const city of Object.values(world.cities)) for (const id of gone) {
    delete city.intel?.[id]
    delete city.lastScout?.[id]
  }
  activity(world, 'world', 'Seven NPC kingdoms left the Emerald Frontier. Their lands are open to new rulers.', now)
  return true
}
