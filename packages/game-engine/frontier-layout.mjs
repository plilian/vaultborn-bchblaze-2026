const layoutVersion = 1
export const coreRegion = Object.freeze({ id: 'core', name: 'Emerald Frontier', x: 0, y: 0 })

// These clearings keep a margin around the authored castles and landmarks. The first seven are where the retired NPC
// kingdoms stood (npc-roster.mjs): new players found their castles there first.
export const retiredNpcPlots = [[.27,.60], [.72,.72], [.75,.55], [.23,.77], [.63,.85], [.77,.20], [.43,.59]]
const coreClearings = [
  ...retiredNpcPlots,
  [.91,.13], [.13,.26], [.91,.26], [.13,.39], [.91,.39], [.13,.52], [.91,.52], [.13,.65],
  [.91,.65], [.91,.78], [.13,.91], [.26,.91], [.39,.91], [.52,.91], [.78,.91], [.91,.91],
  // Two more places on the main map, at its western edge.
  [.07,.78], [.07,.08],
]
// Every kingdom lives on this one map. Besides the clearings above, these places were picked on land (no river,
// waterfall or mist under them), at least .056 apart and clear of every castle and landmark; kingdoms on them are drawn
// smaller. They are used once the clearings are taken.
const denseClearings = [
  [.51,.32], [.25,.42], [.63,.28], [.55,.6], [.69,.46], [.79,.8], [.41,.26], [.81,.1], [.05,.18], [.81,.64],
  [.83,.32], [.05,.32], [.05,.46], [.21,.32], [.63,.38], [.05,.58], [.47,.5], [.53,.14], [.63,.74], [.69,.92],
  [.83,.48], [.23,.68], [.23,.52], [.15,.82], [.31,.84], [.05,.68], [.05,.88], [.21,.22], [.67,.58], [.85,.72],
  [.69,.22], [.71,.82], [.49,.24], [.43,.84], [.83,.56], [.15,.74], [.19,.6], [.57,.8], [.37,.18], [.75,.28],
  [.49,.64], [.85,.22], [.55,.38], [.17,.46], [.59,.66], [.31,.54], [.21,.86], [.83,.86], [.53,.52], [.75,.48],
  [.27,.34], [.71,.16], [.79,.7], [.05,.24], [.05,.38], [.83,.38], [.63,.22], [.69,.28], [.05,.52], [.73,.42],
  [.59,.32], [.21,.38], [.81,.26], [.67,.78],
]
const plotSpacing = {city: .123, landmark: .091}
const denseSpacing = {city: .05, landmark: .045}
export const coreCapacity = coreClearings.length + denseClearings.length
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
    const plot = freePlot(region, core ? coreClearings : frontierClearings, cities, landmarks, plotSpacing) ??
      (core ? freePlot(region, denseClearings, cities, landmarks, denseSpacing) : null)
    if (plot) return { plot }
  }
  // Only when the whole main map is full does another region open.
  const opened = makeRegion(atlas.regions.length)
  atlas.regions.push(opened)
  return { plot: at(opened, ...frontierClearings[0]), opened }
}

function freePlot(region, places, cities, landmarks, spacing) {
  for (const [x,y] of places) {
    const plot = at(region,x,y)
    if (cities.some(city => distance(plot,city) < spacing.city)) continue
    if (landmarks.some(site => distance(plot,site) < spacing.landmark)) continue
    return plot
  }
  return null
}

// Earlier, kingdoms that found the main map full were settled in further regions. Everyone now shares the main map:
// kingdoms in other regions are moved onto its free places (players first, then the regions' wardens), and the
// regions' landmarks follow onto free places too, keeping their owners, garrisons and history. A region is closed when
// nothing is left in it. Runs whenever the world advances; it does nothing when nothing is outside the main map.
export function gatherRegions(world) {
  const regions = world.atlas?.regions ?? []
  if (regions.length < 2) return false
  const outer = new Set(regions.filter(region => region.id !== coreRegion.id).map(region => region.id))
  const inCore = item => !outer.has(settlementRegion(item))
  const cities = Object.values(world.cities)
  const sites = world.territories ?? world.nodes ?? []
  const landmarks = () => sites.filter(site => !site.protected && inCore(site))
  let moved = false
  const movers = cities.filter(city => !inCore(city)).sort((a, b) => Number(Boolean(a.npc)) - Number(Boolean(b.npc)))
  for (const city of movers) {
    const settled = cities.filter(item => item !== city && inCore(item))
    const plot = freePlot(coreRegion, coreClearings, settled, landmarks(), plotSpacing) ?? freePlot(coreRegion, denseClearings, settled, landmarks(), denseSpacing)
    if (!plot) break
    Object.assign(city, {x: plot.x, y: plot.y, region: coreRegion.id})
    moved = true
  }
  for (const site of sites) {
    if (inCore(site)) continue
    const owner = site.protected && world.cities[site.owner]
    if (owner) {
      if (!inCore(owner)) continue
      Object.assign(site, {x: owner.x, y: owner.y, region: coreRegion.id})
      moved = true
      continue
    }
    const settled = cities.filter(inCore)
    const plot = freePlot(coreRegion, denseClearings, settled, landmarks(), denseSpacing)
    if (!plot) continue
    Object.assign(site, {x: plot.x, y: plot.y, region: coreRegion.id})
    moved = true
  }
  const occupied = new Set([...cities, ...sites].map(settlementRegion))
  const kept = regions.filter(region => region.id === coreRegion.id || occupied.has(region.id))
  if (kept.length !== regions.length) { world.atlas.regions = kept; moved = true }
  return moved
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
