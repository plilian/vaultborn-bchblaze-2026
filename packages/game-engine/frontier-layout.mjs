const layoutVersion = 1
export const coreRegion = Object.freeze({ id: 'core', name: 'Emerald Frontier', x: 0, y: 0 })

// These clearings keep a margin around the authored castles and landmarks. The first seven are where the retired NPC
// kingdoms stood (npc-roster.mjs): new players found their castles there first.
export const retiredNpcPlots = [[.27,.60], [.72,.72], [.75,.55], [.23,.77], [.63,.85], [.77,.20], [.43,.59]]
const coreClearings = [
  ...retiredNpcPlots,
  [.91,.13], [.13,.26], [.91,.26], [.13,.39], [.91,.39], [.13,.52], [.91,.52], [.13,.65],
  [.91,.65], [.91,.78], [.13,.91], [.26,.91], [.39,.91], [.52,.91], [.78,.91], [.91,.91],
]
const rows = [.21, .403, .597, .79]
const columns = [.17, .39, .61, .83]
const frontierClearings = rows.flatMap(y => columns.map(x => [x,y]))
export const frontierCapacity = frontierClearings.length
const regionNames = [
  'Amber Reach', 'Greywood', 'Pinewater', 'Raven Downs', 'Copper Hills', 'Dawnfallow',
  'Briar Coast', 'Thornfields', 'Saltmoor', 'Stoneglen', 'Elder Crossing', 'Windmere',
  'Alderbank', 'Whitecliff', 'Ashwood', 'Rosemarch',
]
const ordinarySites = [
  { key: 'farm', name: 'Westfield', x: .10, y: .5, terrain: 'plains', resource: 'food', residents: 1 },
  { key: 'forest', name: 'Eastwood', x: .90, y: .5, terrain: 'forest', resource: 'wood', residents: 6 },
  { key: 'quarry', name: 'North Ridge', x: .5, y: .12, terrain: 'hills', resource: 'stone', residents: 11 },
]

export const settlementRegion = entity => entity.region ?? coreRegion.id
const wardenId = region => region.wardenId ?? region.id + '-warden'
const at = (region, x, y) => ({
  x: +(region.x + x).toFixed(6),
  y: +(region.y + y).toFixed(6),
  region: region.id,
})
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

function makeRegion(index) {
  // Complete a square in two legs. Every new tile has a border with the
  // existing atlas, and appending a tile cannot move previous locations.
  const ring = Math.floor(Math.sqrt(index))
  const offset = index - ring ** 2
  const [x, y] = offset < ring ? [ring, offset] : [2 * ring - offset, ring]
  const namesake = regionNames[(index - 1) % regionNames.length]
  const series = Math.floor((index - 1) / regionNames.length)
  const name = series ? namesake + ' ' + (series + 1) : namesake
  return { id: 'region-' + index, name, x, y }
}

export function allocateSettlementPlot(world) {
  const atlas = world.atlas ??= { version: layoutVersion, regions: [coreRegion] }
  const citiesByRegion = new Map()
  for (const city of Object.values(world.cities)) {
    const region = settlementRegion(city)
    if (!citiesByRegion.has(region)) citiesByRegion.set(region, [])
    citiesByRegion.get(region).push(city)
  }
  const landmarksByRegion = new Map()
  for (const site of world.territories ?? world.nodes ?? []) {
    if (site.protected) continue
    const region = settlementRegion(site)
    if (!landmarksByRegion.has(region)) landmarksByRegion.set(region, [])
    landmarksByRegion.get(region).push(site)
  }
  for (const region of atlas.regions) {
    const core = region.id === coreRegion.id
    const cities = citiesByRegion.get(region.id) ?? []
    const landmarks = landmarksByRegion.get(region.id) ?? []
    for (const [x,y] of core ? coreClearings : frontierClearings) {
      const plot = at(region,x,y)
      if (cities.some(city => distance(plot,city) < .123)) continue
      if (landmarks.some(site => distance(plot,site) < .091)) continue
      return { plot }
    }
  }
  const opened = makeRegion(atlas.regions.length)
  atlas.regions.push(opened)
  return { plot: at(opened, ...frontierClearings[0]), opened }
}

export function frontierWarden(region) {
  return {
    id: wardenId(region), name: 'Frontier Wardens', cityName: region.name + ' Watch',
    faction: 'azure', terrain: 'hills', npc: true, shields: false, troopScale: .52,
    ...at(region,.5,.87),
  }
}

export function regionalTerritories(world) {
  if (!world.atlas || world.atlas.regions.length < 2) return []
  const residents = new Map()
  for (const city of Object.values(world.cities)) {
    if (city.npc || city.founding || !city.tutorial) continue
    const region = settlementRegion(city)
    residents.set(region, (residents.get(region) ?? 0) + 1)
  }
  return world.atlas.regions.slice(1).flatMap(region => {
    const ordinary = ordinarySites
      .filter(site => (residents.get(region.id) ?? 0) >= site.residents)
      .map(site => ({
        id: region.id + '-' + site.key, name: region.name + ' ' + site.name,
        category: 'unclaimed', type: site.key, resource: site.resource, terrain: site.terrain,
        ...at(region,site.x,site.y),
      }))
    return [{
      id: region.id + '-camp', name: region.name + ' Camp', type: 'farm', resource: 'food', terrain: 'plains',
      warden: wardenId(region), ...at(region,.5,.5),
    }, ...ordinary]
  })
}

export function atlasView(world, player) {
  const regions = world.atlas?.regions ?? [coreRegion]
  const locations = new Map(regions.map(region => [region.x + ',' + region.y, region.id]))
  return {
    version: world.atlas?.version ?? layoutVersion,
    homeRegion: settlementRegion(player),
    regions: regions.map(region => ({
      ...region,
      neighbors: [[-1,0], [1,0], [0,-1], [0,1]]
        .map(([dx,dy]) => locations.get((region.x + dx) + ',' + (region.y + dy))).filter(Boolean),
    })),
  }
}
