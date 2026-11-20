import { DAY, HOUR, MINUTE, resources } from '../../config/economy.mjs';
import { balance, units } from '../../config/balance.mjs';
import { fieldDoctrine } from '../../config/progression.mjs';
import { paymentPrice, stakePrice, LEGACY_ALLOCATION, LEGACY_PRICING } from '../../config/payments.mjs';
import { digest, simulateBattle, terrainFortification, troopTotal, unitIds } from './combat.mjs';
import { activity, activeTreaty, attackEligibility, currentTactic, getCity, has, notify, points, requireRule, subtract } from './world.mjs';
import { selection } from './military.mjs';
import { advance } from './economy.mjs';
import { politicalTerritoryMultiplier, recordGovernmentEvent } from './government.mjs';
import { awardCommanderMastery } from './progression.mjs';
import { diplomacyRelationship } from './diplomacy.mjs';
import { awardExpedition, expeditionEligibility, expeditionRules, prepareExpedition } from './npc.mjs';
import { regionalTerritories, settlementRegion } from './frontier-layout.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

export const territoryRules = Object.freeze({
  claimFee: 4000, attackFee: 6000, claimDuration: HOUR, entryBuffer: 2 * MINUTE, maxEntrants: 8, maxSortie: 48,
  minSortie: 12, supplyRange: .44, cooldown: 4 * HOUR, lossLimit: 1, inactivity: 72 * HOUR, upkeepInterval: 12 * HOUR,
  maxSiteLevel: 5, maxCityHoldings: 5, maxAllianceHoldings: 9,
});

const terrainByType = {mine:'hills', watchtower:'hills', 'trade-post':'river', fortress:'hills', ruins:'forest', capital:'plains'};
const baseRates = {wood:25, stone:22, iron:19, food:32, crystal:4};
const emptyTroops = () => Object.fromEntries(unitIds.map(unit => [unit, 0]));
const blankProduction = () => Object.fromEntries(resources.map(resource => [resource, 0]));
const ownershipEvents = new Set(['incumbent','claimed','conquered','abandoned','inactivity-expired','upkeep-expired','garrison-arrived','occupation-expired']);
const roles = {
  mine:'resource', watchtower:'strategic', 'trade-post':'resource', fortress:'strategic', ruins:'rare', capital:'strategic',
};
const wardens = {watch:'p10',fort:'p6',capital:'p9'};
const neutralGarrison = () => ({infantry:18,shield:10,archer:11,cavalry:3,siege:2,mage:0});
const newLand = [
  {id:'east-meadow', name:'East Meadow', category:'unclaimed', type:'farm', resource:'food', x:.47, y:.43, terrain:'plains'},
  {id:'whisperwood', name:'Whisperwood', category:'unclaimed', type:'forest', resource:'wood', x:.37, y:.53, terrain:'forest'},
  {id:'wayfarer', name:'Wayfarer Ridge', category:'unclaimed', type:'quarry', resource:'stone', x:.60, y:.57, terrain:'hills'},
  {id:'sunstone-basin', name:'Sunstone Basin', category:'rare', type:'crystal-basin', resource:'crystal', x:.72, y:.61, terrain:'desert'},
];

const campOccupation = 48 * HOUR;
const frontierCamps = [
  {id:'ashfall-camp',name:'Ashfall Camp',x:.33,y:.34,type:'forest',resource:'wood',terrain:'forest',warden:'p12'},
  {id:'blackridge-camp',name:'Blackridge Camp',x:.80,y:.43,type:'quarry',resource:'stone',terrain:'hills',warden:'p6'},
  {id:'old-ferry-camp',name:'Old Ferry Camp',x:.30,y:.69,type:'farm',resource:'food',terrain:'river',warden:'p8'},
];

function makeSite(source, at) {
  const category = source.category ?? roles[source.type] ?? 'unclaimed';
  const owner = source.owner ?? null;
  const production = blankProduction();
  if (source.resource && category !== 'starter') production[source.resource] = baseRates[source.resource] * (category === 'rare' ? 3 : 1);
  const neutralDefense = source.npc ? neutralGarrison() : emptyTroops();
  return { id:source.id, name:source.name, x:source.x, y:source.y, ...(source.region && {region:source.region}), category, type:source.type ?? category,
    terrain:source.terrain ?? terrainByType[source.type] ?? 'plains', resource:source.resource ?? null, level:source.npc ? 2 : 1,
    owner, controller:owner, protected:category === 'starter', version:owner ? 1 : 0, production,
    defenses:{level:source.npc ? 2 : 1, garrison:neutralDefense}, status:owner ? 'controlled' : category === 'rare' ? 'raffle' : 'open',
    claim:null, cooldownUntil:0, nextUpkeep:owner && category !== 'starter' ? at + territoryRules.upkeepInterval : null,
    missedUpkeep:0, lastChanged:source.changedAt ?? at, history:owner ? [{kind:'incumbent', playerId:owner, at}] : [], blockchain:[] };
}

function entity(world,id) {
  const site = world.territories.find(item => item.id === id);
  requireRule(site, 'territory_missing', 'That territory does not exist.', 404);
  return site;
}

function syncNode(world, site) {
  const node = world.nodes?.find(item => item.id === site.id);
  if (!node) return;
  if (site.owner) node.owner = site.owner;
  else delete node.owner;
  node.changedAt = site.lastChanged;
}

// Kingdoms that leave the map: their homelands go, a camp they guarded passes to the warden that inherits it, and
// anything else they held becomes open land.
export function releaseTerritories(world, gone, heirs = {}, now = world.now) {
  if (!Array.isArray(world.territories)) return;
  world.territories = world.territories.filter(site => !(site.category === 'starter' && gone.has(site.owner)));
  for (const site of world.territories) {
    if (gone.has(site.frontierWarden)) site.frontierWarden = heirs[site.frontierWarden] ?? null;
    if (site.claim?.entries) site.claim.entries = site.claim.entries.filter(entry => !gone.has(entry.player));
    if (!gone.has(site.owner) && !gone.has(site.controller)) continue;
    const heir = site.frontierCamp && world.cities[site.frontierWarden]?.npc && !gone.has(site.frontierWarden) ? site.frontierWarden : null;
    site.owner = heir;
    site.controller = heir;
    site.status = heir ? 'controlled' : site.category === 'rare' ? 'raffle' : 'open';
    if (!heir) site.nextUpkeep = null;
    site.version = (site.version ?? 0) + 1;
    site.lastChanged = now;
    (site.history ??= []).push({kind:heir ? 'garrison-arrived' : 'abandoned', playerId:heir, at:now});
    syncNode(world, site);
  }
}

export function ensureTerritories(world, now = world.now) {
  world.territorySettlements ??= [];
  world.territoryPayments ??= {};
  if (!Array.isArray(world.territories)) {
    world.territories = (world.nodes ?? []).map(node => {
      const resident = wardens[node.id];
      const npc = !node.owner && resident && world.cities[resident]?.npc;
      return makeSite({...node, ...(node.owner && roles[node.type] === 'rare' && {category:'resource'}), owner:node.owner ?? (npc ? resident : null), npc },now);
    });
    for (const land of newLand) if (!world.territories.some(site => site.id === land.id)) world.territories.push(makeSite(land,now));
    for (const site of world.territories) syncNode(world,site);
  }
  for (const site of world.territories) if (!Number.isSafeInteger(site.version)) {
    site.version = Math.max(site.owner ? 1 : 0, site.history?.filter(item => ownershipEvents.has(item.kind)).length ?? 0);
  }
  for (const site of world.territories) if (!site.owner && site.category==='strategic' && world.cities[wardens[site.id]]?.npc &&
      !['open','locked'].includes(site.claim?.status)) {
    installWardens(site);
    assign(world,site,wardens[site.id],now,'garrison-arrived');
    site.cooldownUntil=0;
  }
  const known = new Set(world.territories.map(site => site.id));
  for (const land of [...frontierCamps, ...regionalTerritories(world)]) {
    if (known.has(land.id)) continue;
    if (!land.warden) {
      world.territories.push(makeSite(land,now));
      continue;
    }
    if (!world.cities[land.warden]?.npc) continue;
    const site = makeSite({...land,category:'resource',owner:land.warden},now);
    site.frontierCamp = true;
    site.frontierWarden = land.warden;
    site.production[land.resource] = Math.floor(site.production[land.resource] / 2);
    site.defenses.garrison = {infantry:8,shield:4,archer:4,cavalry:0,siege:0,mage:0};
    world.territories.push(site);
  }
  for (const city of Object.values(world.cities)) if (!known.has('starter-' + city.id)) {
    world.territories.push(makeSite({id:'starter-' + city.id, name:city.name + ' Homelands', category:'starter',
      type:'homeland', resource:'food', terrain:city.terrain, x:city.x, y:city.y, region:city.region, owner:city.id},now));
  }
  return world.territories;
}

function holdings(world, player, omit) {
  return world.territories.filter(site => site.owner === player && !site.protected && site.id !== omit);
}

function capacity(city) {
  return Math.min(territoryRules.maxCityHoldings, 2 + Math.floor((city.buildings.hall - 1) / 2));
}

function space(world, city, omit) {
  if (holdings(world, city.id, omit).length >= capacity(city)) return false;
  return !city.alliance || world.territories.filter(site =>
    site.id !== omit && site.owner && !site.protected && world.cities[site.owner]?.alliance === city.alliance).length < territoryRules.maxAllianceHoldings;
}

function connected(world, city, site) {
  const shared=world.territories.filter(item=>item.id!==site.id && !item.protected && item.owner && item.owner!==city.id &&
    diplomacyRelationship(world,city.id,item.owner,world.now).territoryIds.includes(item.id));
  const points = [city, ...holdings(world, city.id, site.id),...shared];
  return points.some(origin => Math.hypot(origin.x - site.x,origin.y - site.y) <= territoryRules.supplyRange);
}

// Every kingdom is in the season from its first day: no tutorial to finish and no beginner protection to wait out.
// Only a kingdom that left seasonal PvP on purpose stays out of territorial contests until it joins again.
function territorialEnrollment(city, now) {
  requireRule(!city.npc, 'territory_enrollment', 'NPC kingdoms do not take part in territorial contests.');
  requireRule(city.optIn, 'territory_enrollment', 'You left seasonal PvP. Join it again to take part.');
}

function activeContest(world, player, exceptId) {
  return world.territories.find(site => site.id !== exceptId && ['open','locked'].includes(site.claim?.status) &&
    site.claim.entries.some(entry => entry.player === player));
}

function claimEligibility(world, player, site, now) {
  territorialEnrollment(player, now);
  requireRule(['unclaimed','resource'].includes(site.category) && !site.owner, 'territory_not_open', 'This site is not available for a permanent claim.');
  requireRule(site.cooldownUntil <= now, 'territory_recovery', 'This site is recovering from a prior territorial action.');
  requireRule(connected(world,player,site), 'territory_distance', 'This site lies outside your city and outpost supply range.');
  requireRule(space(world,player,site.id), 'territory_capacity', 'Your city or alliance has reached its holding limit.');
  requireRule(!activeContest(world,player.id,site.id), 'territory_commitment', 'Your city already has an entry in another territorial contest.');
  requireRule(troopTotal(player.troops) >= territoryRules.minSortie, 'territory_garrison', 'Field at least 12 available troops to enter.');
  if (site.claim && ['open','locked'].includes(site.claim.status)) {
    requireRule(site.claim.status === 'open' && now < site.claim.lockAt, 'territory_claim_locked', 'The claim has reached its army lock deadline.');
    requireRule(!site.claim.entries.some(entry => entry.player === player.id), 'territory_duplicate', 'Your city already entered this contest.');
    requireRule(!player.alliance || !site.claim.entries.some(entry => entry.alliance === player.alliance),
      'territory_alliance_entry', 'Each alliance may field one contender per claim.');
    requireRule(site.claim.entries.length < territoryRules.maxEntrants, 'territory_contenders', 'This public contest has reached eight entries.');
  }
}

function attackPreflight(world, player, site, now) {
  territorialEnrollment(player, now);
  requireRule(!site.protected && site.category !== 'rare' && site.owner && site.owner !== player.id,
    'territory_attack_target', 'Choose an opposing controllable site.');
  requireRule(!activeContest(world,player.id), 'territory_commitment', 'Finish your current claim before attempting a conquest.');
  requireRule(site.cooldownUntil <= now, 'territory_recovery', 'The site is under temporary territorial protection.');
  requireRule(connected(world,player,site), 'territory_distance', 'Establish a closer outpost or choose a reachable target.');
  requireRule(space(world,player,site.id), 'territory_capacity', 'Your city or alliance has reached its holding limit.');
  const defender = getCity(world,site.owner);
  const eligible = attackEligibility(world, player, defender, now);
  requireRule(eligible.ok, eligible.code, eligible.reason);
  const recentlyLost = world.territorySettlements.filter(item => item.kind === 'territory-attack' && item.defender === defender.id &&
    item.winner === item.attacker && item.at > now - DAY).length;
  requireRule(recentlyLost < territoryRules.lossLimit,'territory_loss_limit','This defender is protected by the daily territory loss limit.');
  return defender;
}

export function quoteTerritory(world, playerId, input, now = world.now) {
  ensureTerritories(world,now);
  const site = entity(world,input.territory ?? input.territoryId);
  requireRule(!site.frontierCamp,'frontier_camp','Frontier camps use earned supplies and do not accept BCH entry.',400);
  const city = getCity(world,playerId);
  const type = input.type;
  if (type === 'territory-claim') {
    claimEligibility(world,city,site,now);
    if (input.expectedClaim) requireRule(input.expectedClaim === site.claim?.id,'territory_claim_changed','A different claim is now active.');
    return {action:{type,territory:site.id,...(site.claim?.status === 'open' && {expectedClaim:site.claim.id})},satoshis:territoryRules.claimFee,title:'Enter claim for ' + site.name,
      description:'Opens or enters a 60-minute contest. Armies lock two minutes before close. A successful contender receives ownership and eligible entry escrows.'};
  }
  requireRule(type === 'territory-attack','territory_action','Choose a valid territory action.',400);
  const defender = attackPreflight(world,city,site,now);
  const action = {type,territory:site.id,expectedOwner:defender.id,...selection(city,input,now)};
  if (input.expectedOwner) requireRule(input.expectedOwner === defender.id,'territory_changed','The territory changed owners after checkout.');
  return {action,satoshis:territoryRules.attackFee,title:'Conquer ' + site.name,
    description:'March against a comparable defender. The battle can transfer this site and settle the explicitly committed treasury under the existing limits.'};
}

function entryReference(payment, player, fee, action) {
  // The stake is checked against the price book the payment was quoted under; payments from before the books keep half the old fee.
  const pricing=payment?.pricing??LEGACY_PRICING;
  const expected=paymentPrice(action,fee,payment?.allocationPolicy??LEGACY_ALLOCATION,pricing);
  const principal=pricing===LEGACY_PRICING ? fee / 2 : stakePrice(action,pricing)?.principal;
  requireRule(payment && typeof payment.id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(payment.id) &&
    /^[0-9a-f]{64}$/i.test(payment.txid ?? '') && payment.satoshis === expected && payment.escrowSatoshis === principal,
    'territory_receipt','A confirmed exact territory payment receipt is required.',402);
  return {id:payment.id, txid:payment.txid.toLowerCase(), player, escrowSatoshis:payment.escrowSatoshis};
}

function beginClaim(world, city, site, entry, wallet, now) {
  requireRule(typeof wallet === 'string' && ADDRESS_PATTERN.test(wallet),'territory_wallet',
    'Verify a ' + NETWORK_LABEL + ' wallet for your contest entry.',403);
  const identity = digest(['territory-wallet',wallet.toLowerCase()]);
  let claim = site.claim;
  if (!claim || !['open','locked'].includes(claim.status)) {
    const id = 'tc' + (++world.seq);
    const endsAt = now + territoryRules.claimDuration;
    const commitment = digest(digest([world.secret,id,'claim-seed']));
    claim = {id, status:'open', startedAt:now, lockAt:endsAt-territoryRules.entryBuffer, endsAt, commitment, entries:[], winner:null,fieldRules:fieldDoctrine.version};
    site.claim = claim;
    site.status = 'contested';
  }
  requireRule(!claim.entries.some(item => item.identity === identity),'territory_wallet_duplicate','This verified wallet already entered the contest.');
  const contestant = { ...entry, identity, alliance:city.alliance ?? null, at:now, status:'entered' };
  claim.entries.push(contestant);
  site.blockchain.push({kind:'entry', id:entry.id, txid:entry.txid, at:now});
  site.history.push({kind:'entered', claimId:claim.id, playerId:city.id, txid:entry.txid, at:now});
  notify(world,city.id,'Your claim entry for ' + site.name + ' was confirmed.',now,'territory');
  for (const prior of claim.entries) if (prior.player !== city.id) notify(world,prior.player,city.name + ' entered the contest for ' + site.name + '.',now,'territory');
  activity(world,'territory','A contender entered the claim for ' + site.name + '.',now);
  return {kind:'territory-entry',territoryId:site.id,claimId:claim.id,entry,endsAt:claim.endsAt,lockAt:claim.lockAt};
}

function troopQuota(troops, limit) {
  const all = troopTotal(troops);
  if (all <= limit) return Object.fromEntries(unitIds.map(unit => [unit,troops[unit] ?? 0]));
  const allocation = Object.fromEntries(unitIds.map(unit => [unit,Math.floor((troops[unit] ?? 0) * limit / all)]));
  const fractional = unitIds.toSorted((left,right) => (troops[right] * limit % all) - (troops[left] * limit % all));
  for (const unit of fractional.slice(0,limit-troopTotal(allocation))) allocation[unit]++;
  return allocation;
}

function movement(city, troops, direction) {
  for (const unit of unitIds) city.troops[unit] += direction * (troops[unit] ?? 0);
}

function recordBattle(world, site, attacker, defender, input, seed, now, kind, paid) {
  const result = simulateBattle(input,seed);
  const id = 'b' + (++world.seq);
  const report = { id, kind, territoryId:site.id, attacker:attacker.id, defender:defender.id, attackerName:attacker.name,
    defenderName:defender.name, at:now, commitment:digest({input,seed}), input, seed, paid, loot:blankProduction(), ...result };
  world.battles.unshift(report);
  return report;
}

function lockClaims(world,site,now) {
  const claim = site.claim;
  claim.status = 'locked';
  const order = claim.entries.toSorted((a,b) => digest([claim.commitment,a.player]).localeCompare(digest([claim.commitment,b.player])));
  const alliances = new Set();
  for (const entry of order) {
    const city = getCity(world,entry.player);
    if (city.alliance && alliances.has(city.alliance) || !city.optIn || city.shieldUntil > now || troopTotal(city.troops) < territoryRules.minSortie || !space(world,city,site.id)) {
      entry.status = 'recovery';
      continue;
    }
    if (city.alliance) alliances.add(city.alliance);
    const troops = troopQuota(city.troops,territoryRules.maxSortie);
    const snapshot = {...currentTactic(city,world,now,city.hero,claim.fieldRules??1),wall:0,troops};
    entry.snapshot = snapshot;
    entry.status = 'locked';
    city.territoryLocked ??= {};
    city.territoryLocked[claim.id] = troops;
    movement(city,troops,-1);
  }
}

function installWardens(site) {
  site.defenses.garrison=neutralGarrison();
  site.level=Math.max(site.level,2);
  site.defenses.level=site.level;
}

function assign(world,site,winner,now,kind) {
  const previousOwner = site.owner;
  if (site.frontierCamp) {
    delete site.frontierOccupationUntil;
    if (!winner && world.cities[site.frontierWarden]?.npc) {
      winner = site.frontierWarden;
      site.defenses.level = 1;
      site.level = 1;
      reinforceFrontierCamps(world,world.cities[winner],site);
    }
  }
  if (!winner && site.category==='strategic' && world.cities[wardens[site.id]]?.npc) {
    winner=wardens[site.id];
    installWardens(site);
  }
  if (previousOwner !== winner) site.version++;
  site.owner = winner;
  site.controller = winner;
  site.lastChanged = now;
  site.status = winner ? 'controlled' : 'open';
  site.nextUpkeep = winner ? now + territoryRules.upkeepInterval : null;
  site.missedUpkeep = 0;
  site.cooldownUntil = now + territoryRules.cooldown;
  site.history.push({kind,playerId:winner,previousOwner,version:site.version,at:now});
  if (['claimed','conquered'].includes(kind)) recordGovernmentEvent(world,kind==='conquered'?'conquest':'territory-claim',{actor:winner,target:previousOwner,territory:site.id},now);
  if (previousOwner && ['abandoned','inactivity-expired','upkeep-expired'].includes(kind)) {
    recordGovernmentEvent(world,'territory-loss',{actor:previousOwner,territory:site.id},now);
  }
  syncNode(world,site);
}

export function reinforceFrontierCamps(world,city,returningSite = null) {
  const camps = returningSite ? [returningSite] : (world.territories ?? []).filter(site=>site.frontierCamp&&site.owner===city.id);
  for (const site of camps) {
    const strength = Math.min(16-troopTotal(site.defenses.garrison),troopTotal(city.troops)-28);
    if (strength<=0) continue;
    const troops = troopQuota(city.troops,strength);
    movement(city,troops,-1);
    for (const unit of unitIds) site.defenses.garrison[unit] += troops[unit];
  }
}

function frontierPreflight(world,actor,site,now) {
  requireRule(site.frontierCamp && site.owner===site.frontierWarden && world.cities[site.owner]?.npc,
    'frontier_occupied','Only a camp currently held by an NPC warden can be occupied.');
  requireRule(site.cooldownUntil<=now,'territory_recovery','The camp is under temporary protection.');
  requireRule(connected(world,actor,site),'territory_distance','The camp lies outside your city and outpost supply range.');
  requireRule(space(world,actor,site.id) && !holdings(world,actor.id).some(item=>item.frontierCamp),
    'frontier_capacity','Your city can occupy one frontier camp at a time, within its normal territory capacity.');
  requireRule(!activeContest(world,actor.id) && !['open','locked'].includes(site.claim?.status),
    'territory_commitment','Finish any active territory contest before leading this expedition.');
  const defender = world.cities[site.owner];
  const militia = troopQuota(defender.troops,12);
  const troops = Object.fromEntries(unitIds.map(unit=>[unit,militia[unit]+site.defenses.garrison[unit]]));
  const eligible = expeditionEligibility(world,actor,defender,now,troops);
  requireRule(eligible.ok,eligible.code,eligible.reason);
  return {defender,troops};
}

function occupyFrontierCamp(world,actor,site,input,now) {
  const {defender,troops} = frontierPreflight(world,actor,site,now);
  if (input.expectedOwner) requireRule(input.expectedOwner===defender.id,'territory_changed','The camp changed hands before this expedition.');
  const {hero,...orders} = prepareExpedition(world,actor,defender,input,now,troops);
  const forces = { attacker:{...currentTactic(actor,world,now,hero),...orders,troops:troopQuota(actor.troops,48)},
    defender:{...currentTactic(defender,world,now),troops,wall:site.defenses.level+defender.tech.fortification}, terrain:site.terrain };
  const seed = digest([world.secret,site.id,actor.id,site.version,world.seq,'frontier-camp']);
  const report = recordBattle(world,site,actor,defender,forces,seed,now,'frontier-conquest',false);
  movement(actor,report.losses.attacker,-1);
  for (const unit of unitIds) {
    const localLoss = Math.min(report.losses.defender[unit],site.defenses.garrison[unit]);
    site.defenses.garrison[unit] -= localLoss;
    defender.troops[unit] -= report.losses.defender[unit]-localLoss;
  }
  const won = report.winner==='attacker';
  if (won) {
    movement(defender,site.defenses.garrison,1);
    site.defenses.garrison = troopQuota(actor.troops,Math.min(6,troopTotal(actor.troops)));
    movement(actor,site.defenses.garrison,-1);
    assign(world,site,actor.id,now,'conquered');
    site.frontierOccupationUntil = now+campOccupation;
    report.conquest = { id:site.id,name:site.name,previousOwner:defender.id,owner:actor.id,version:site.version,
      occupationUntil:site.frontierOccupationUntil };
  } else {
    site.cooldownUntil = now+territoryRules.cooldown;
    site.history.push({kind:'defended',playerId:defender.id,attacker:actor.id,at:now});
  }
  awardExpedition(world,actor,defender,report,now);
  notify(world,actor.id,(won?'Victory at ':'Defeat at ')+site.name+'.',now,'territory',
    {title:won?'Victory':'Defeat',territoryId:site.id,battleId:report.id});
  activity(world,'territory',actor.name+(won?' occupied ':' withdrew from ')+site.name+'.',now);
  world.marches.unshift({id:report.id,attacker:actor.id,defender:defender.id,alliance:actor.alliance,
    territory:site.id,at:now,endsAt:now+54_000,kind:'frontier-conquest'});
  actor.territoryActivityAt = now;
  return report;
}


export function restorePoliticalTerritory(world,territoryId,previousOwnerId,restoredOwnerId,conflict,now) {
  const site = world.territories?.find(item=>item.id===territoryId);
  const incumbent = world.cities[previousOwnerId];
  const restored = world.cities[restoredOwnerId];
  const activeClaim = ['open','locked'].includes(site?.claim?.status);
  if (!site || site.protected || site.category==='rare' || site.owner!==previousOwnerId || activeClaim ||
      !incumbent || !restored || !space(world,restored,site.id) || !connected(world,restored,site) ||
      !site.history.some(item=>item.previousOwner===restoredOwnerId && item.kind==='conquered')) return null;
  movement(incumbent,site.defenses.garrison,1);
  site.defenses.garrison = emptyTroops();
  assign(world,site,restoredOwnerId,now,'political-restoration');
  delete site.politicalControl;
  site.history.at(-1).conflict = conflict;
  return {id:site.id,name:site.name,previousOwner:previousOwnerId,owner:restoredOwnerId,version:site.version};
}

function closeClaim(world,site,now) {
  const claim = site.claim;
  const secret = digest([world.secret,claim.id,'claim-seed']);
  const ties = player => digest([secret,player]);
  let bracket = claim.entries.filter(entry => entry.status === 'locked')
    .toSorted((a,b) => ties(a.player).localeCompare(ties(b.player)));
  const participants = [...bracket];
  const loss = new Map(participants.map(entry => [entry.player,emptyTroops()]));
  const battles = [];
  let round = 0;
  while (bracket.length > 1) {
    const survivors = [];
    for (let index = 0; index < bracket.length; index += 2) {
      const left = bracket[index];
      const right = bracket[index + 1];
      if (!right) {
        survivors.push(left);
        continue;
      }
      const a = getCity(world,left.player);
      const b = getCity(world,right.player);
      const seed = digest([secret,round,left.player,right.player]);
      const first = recordBattle(world,site,a,b,{attacker:left.snapshot,defender:right.snapshot,terrain:'plains'},seed,now,'territory-contest',false);
      const other = recordBattle(world,site,b,a,{attacker:right.snapshot,defender:left.snapshot,terrain:'plains'},seed,now,'territory-contest',false);
      battles.push(first.id,other.id);
      const score = Number(first.winner === 'attacker') + Number(other.winner === 'defender');
      const difference = first.differential - other.differential;
      survivors.push(score > 1 || score === 1 && difference >= 0 ? left : right);
      for (const unit of unitIds) {
        loss.get(left.player)[unit] = Math.max(loss.get(left.player)[unit],first.losses.attacker[unit],other.losses.defender[unit]);
        loss.get(right.player)[unit] = Math.max(loss.get(right.player)[unit],first.losses.defender[unit],other.losses.attacker[unit]);
      }
    }
    bracket = survivors;
    round++;
  }
  const victor = bracket[0]?.player ?? null;
  const eligible = new Set(participants.map(entry => entry.player));
  for (const entry of participants) {
    const city = getCity(world,entry.player);
    const remaining = Object.fromEntries(unitIds.map(unit => [unit,entry.snapshot.troops[unit]-loss.get(entry.player)[unit]]));
    movement(city,remaining,1);
    delete city.territoryLocked[claim.id];
    entry.status = entry.player === victor ? 'won' : 'lost';
    if (entry.player !== victor) notify(world,entry.player,'Your army withdrew from the contest at ' + site.name + '.',now,'territory',
      {title:'Claim lost',territoryId:site.id});
  }
  claim.status = victor ? 'settled' : 'recovery';
  claim.winner = victor;
  claim.seed = secret;
  claim.closedAt = now;
  if (victor) {
    assign(world,site,victor,now,'claimed');
    const owner = getCity(world,victor);
    points(owner,10,'territory',{kind:'territory',ref:'claim:'+claim.id});
    activity(world,'territory',owner.name + ' claimed ' + site.name + '.',now);
    notify(world,victor,'Territory claimed: ' + site.name + '.',now,'territory',
      {title:'Territory gained',territoryId:site.id});
  } else {
    site.status = 'open';
    site.history.push({kind:'claim-recovered',claimId:claim.id,at:now});
  }
  const entries = claim.entries.map(({id,txid,player,escrowSatoshis}) => ({id,txid,player,escrowSatoshis}));
  const distributions = entries.map(entry => ({entryId:entry.id,playerId:eligible.has(entry.player) && victor ? victor : entry.player,
    satoshis:entry.escrowSatoshis, reason:eligible.has(entry.player) && victor ? 'claim-winner' : 'entry-recovery'}));
  const outcome = {id:claim.id,kind:'territory-claim',territoryId:site.id,version:site.version,entries,winner:victor,battles,distributions,at:now,
    rules:{seed:secret,commitment:claim.commitment,neutralTerrain:'plains',bracket:'seeded-mirrored-elimination'}};
  site.blockchain.push({kind:'settlement',id:outcome.id,txid:null,at:now});
  world.territorySettlements.unshift(outcome);
  return outcome;
}

function contestAttack(world,attacker,defender,site,action,entry,now) {
  const expedition = troopQuota(attacker.troops,territoryRules.maxSortie*2);
  const militia = troopQuota(defender.troops,24);
  const defense = Object.fromEntries(unitIds.map(unit => [unit,militia[unit] + (site.defenses.garrison[unit] ?? 0)]));
  const {hero,...orders}=selection(attacker,action,now);
  const report = recordBattle(world,site,attacker,defender,{
    attacker:{...currentTactic(attacker,world,now,hero),...orders,troops:expedition},
    defender:{...currentTactic(defender,world,now),troops:defense,wall:site.defenses.level + defender.tech.fortification},
    terrain:site.terrain,
  },digest([world.secret,site.id,entry.txid]),now,'territory-attack',true);
  movement(attacker,report.losses.attacker,-1);
  for (const unit of unitIds) {
    const garrisonLoss = Math.min(report.losses.defender[unit],site.defenses.garrison[unit] ?? 0);
    site.defenses.garrison[unit] -= garrisonLoss;
    defender.troops[unit] -= report.losses.defender[unit]-garrisonLoss;
  }
  const attackerWon = report.winner === 'attacker';
  const winner = attackerWon ? attacker : defender;
  const defeated = attackerWon ? defender : attacker;
  if (balance.defeatShield > 0) defeated.shieldUntil = Math.max(defeated.shieldUntil,now+balance.defeatShield);
  if (attackerWon) {
    movement(defender,site.defenses.garrison,1);
    site.defenses.garrison = troopQuota(attacker.troops,Math.min(12,troopTotal(attacker.troops)));
    movement(attacker,site.defenses.garrison,-1);
    site.defenses.level = Math.max(1,site.defenses.level-1);
    site.level = site.defenses.level;
    assign(world,site,attacker.id,now,'conquered');
    report.conquest = {id:site.id,name:site.name,previousOwner:defender.id,owner:attacker.id,version:site.version};
    notify(world,defender.id,'Territory lost: ' + site.name + '.',now,'territory',
      {title:'Territory lost',territoryId:site.id});
  } else {
    site.cooldownUntil = now + territoryRules.cooldown;
    site.history.push({kind:'defended',playerId:defender.id,attacker:attacker.id,at:now});
    notify(world,defender.id,'Your garrison defended ' + site.name + '.',now,'territory',
      {title:'Victory',territoryId:site.id,battleId:report.id});
  }
  points(winner,attackerWon ? 16 : 10,'territory',{kind:'territory',ref:'battle:'+report.id});
  awardCommanderMastery(attacker,report.input.attacker.hero,'territory',now);
  if (!defender.npc) awardCommanderMastery(defender,report.input.defender.hero,'defense',now);
  notify(world,attacker.id,(attackerWon ? 'Victory at ' : 'Defeat at ') + site.name + '.',now,'territory',
    {title:attackerWon?'Victory':'Defeat',territoryId:site.id,battleId:report.id});
  activity(world,'territory',winner.name + (attackerWon ? ' conquered ' : ' successfully defended ') + site.name + '.',now);
  world.marches.unshift({id:report.id,attacker:attacker.id,defender:defender.id,alliance:attacker.alliance,
    territory:site.id,at:now,endsAt:now+54_000,kind:'raid'});
  const outcome = {id:'ts' + (++world.seq),kind:'territory-attack',territoryId:site.id,version:site.version,attacker:attacker.id,defender:defender.id,
    winner:winner.id, entries:[entry],battles:[report.id],battle:report,at:now};
  site.blockchain.push({kind:'attack',id:entry.id,txid:entry.txid,at:now});
  world.territorySettlements.unshift(outcome);
  return outcome;
}

export function applyTerritoryPayment(world,playerId,input,payment,now = world.now) {
  ensureTerritories(world,now);
  const expectedFee = input.type === 'territory-claim' ? territoryRules.claimFee : territoryRules.attackFee;
  const entry = entryReference(payment,playerId,expectedFee,input.type);
  const existing = has(world.territoryPayments,payment.id) ? world.territoryPayments[payment.id] : null;
  if (existing) {
    requireRule(existing.txid === entry.txid && existing.player === playerId,'territory_receipt_reused','This payment belongs to another entry.');
    return existing.outcome;
  }
  requireRule(!Object.values(world.territoryPayments).some(record => record.txid === entry.txid),'territory_receipt_reused',
    'This transaction was used by another territorial entry.');
  const quoted = quoteTerritory(world,playerId,input,now);
  const site = entity(world,quoted.action.territory);
  const city = getCity(world,playerId);
  city.territoryActivityAt = now;
  const outcome = input.type === 'territory-claim' ? beginClaim(world,city,site,entry,payment.walletAddress,now)
    : contestAttack(world,city,getCity(world,quoted.action.expectedOwner),site,quoted.action,entry,now);
  world.territoryPayments[payment.id] = {txid:entry.txid,player:playerId,outcome};
  return outcome;
}

function canReinforce(world,actor,owner,now) {
  if (!actor||!owner||actor.id===owner.id) return false;
  const relation=diplomacyRelationship(world,actor.id,owner.id,now);
  return Boolean(actor.alliance&&actor.alliance===owner.alliance||activeTreaty(world,actor,owner,['defense'])||relation.defense||relation.assistance);
}

export function territoryCommand(world,playerId,input,now = world.now) {
  ensureTerritories(world,now);
  const site = entity(world,input.territory ?? input.territoryId ?? input.id);
  const actor = getCity(world,playerId);
  if (input.type==='frontier-conquest') return occupyFrontierCamp(world,actor,site,input,now);
  requireRule(!site.protected && site.category !== 'rare' && site.owner,'territory_managed','Choose a controllable owned territory.');
  const owner = getCity(world,site.owner);
  const own = owner.id === actor.id;
  if (input.type === 'territory-aid') {
    requireRule(canReinforce(world,actor,owner,now),
      'territory_aid','Only a current defense ally can contribute reinforcements.',403);
  } else requireRule(own,'territory_owner','Only the territory owner can order this action.',403);
  let cost;
  if (input.type === 'territory-abandon') {
    movement(owner,site.defenses.garrison,1);
    site.defenses.garrison = emptyTroops();
    assign(world,site,null,now,'abandoned');
  } else if (input.type === 'territory-fortify') {
    requireRule(site.defenses.level < territoryRules.maxSiteLevel,'territory_max_level','This stronghold reached its maximum defenses.');
    const level = site.defenses.level;
    cost={wood:40*level,stone:62*level,iron:16*level};
    subtract(actor,cost);
    site.defenses.level++;
    site.level = site.defenses.level;
    site.history.push({kind:'fortified',playerId:actor.id,level:site.level,at:now});
  } else {
    requireRule(input.type === 'territory-garrison' || input.type === 'territory-aid',
      'territory_action','Select a valid garrison command.',400);
    const {unit,count} = input;
    requireRule(has(units,unit) && Number.isSafeInteger(count) && count >= 1 && count <= 32,'territory_troops',
      'Select one troop class and a count from 1 to 32.',400);
    const recall = input.type === 'territory-garrison' && (input.recall === true || input.direction === 'recall');
    const source = recall ? site.defenses.garrison : actor.troops;
    const target = recall ? actor.troops : site.defenses.garrison;
    requireRule(source[unit] >= count,'territory_troops','That many troops are unavailable.');
    requireRule(recall || troopTotal(target)+count <= 24+site.defenses.level*12,'territory_troops','This site cannot support more troops at the current fortification.');
    source[unit] -= count;
    target[unit] += count;
    site.history.push({kind:recall ? 'recalled' : input.type === 'territory-aid' ? 'allied-reinforcement' : 'garrisoned',
      playerId:actor.id,unit,count,at:now});
  }
  actor.territoryActivityAt = now;
  return {territoryId:site.id,site,...(cost&&{cost})};
}

function siteProduction(site,multiplier) {
  const rate=(1+.12*(site.level-1))*(site.missedUpkeep?.5:1)*multiplier;
  return Object.fromEntries(resources.map(resource=>[resource,Math.floor(site.production[resource]*rate)]));
}

export function territoryProduction(world,playerId,at) {
  const rates = blankProduction();
  for (const site of world.territories ?? []) {
    const lease = world.territoryRaffles?.[site.id]?.lease;
    const leased = site.category === 'rare' && lease?.playerId === playerId && lease.startsAt <= at && at < lease.expiresAt;
    if (site.owner !== playerId && !leased) continue;
    const yieldByResource=siteProduction(site,politicalTerritoryMultiplier(world,site,at));
    for (const resource of resources) rates[resource] += yieldByResource[resource];
  }
  return rates;
}

function upkeep(world,site,now) {
  const actor = getCity(world,site.owner);
  if (actor.npc) {
    site.nextUpkeep = now + territoryRules.upkeepInterval;
    return;
  }
  const inactivity = now - Math.max(actor.territoryActivityAt ?? 0,actor.lastActionAt ?? 0,site.lastChanged);
  const scale = holdings(world,actor.id).length;
  const food = 36 * scale + troopTotal(site.defenses.garrison) * 2;
  const wood = 16 * scale * site.level;
  const canPay = actor.resources.food >= food && actor.resources.wood >= wood && inactivity < territoryRules.inactivity;
  if (canPay) {
    subtract(actor,{food,wood});
    site.missedUpkeep = 0;
  } else if (++site.missedUpkeep >= 2 || inactivity >= territoryRules.inactivity) {
    movement(actor,site.defenses.garrison,1);
    site.defenses.garrison = emptyTroops();
    assign(world,site,null,now,inactivity >= territoryRules.inactivity ? 'inactivity-expired' : 'upkeep-expired');
    notify(world,actor.id,site.name + ' reverted to neutral control.',now,'territory',
      {title:'Territory lost',territoryId:site.id});
    return;
  }
  site.nextUpkeep = now + territoryRules.upkeepInterval;
}

export function nextTerritoryEvent(world,now,cursor = world.now) {
  const events = [];
  for (const site of world.territories ?? []) {
    if (site.frontierOccupationUntil && site.frontierOccupationUntil<=now) {
      const at = site.frontierOccupationUntil;
      events.push({at,apply:() => {
        const occupant = getCity(world,site.owner);
        movement(occupant,site.defenses.garrison,1);
        site.defenses.garrison = emptyTroops();
        assign(world,site,null,at,'occupation-expired');
        notify(world,occupant.id,site.name+' returned to its NPC warden when the occupation ended.',at,'territory',
          {title:'Occupation ended',territoryId:site.id});
      }});
    }
    const claim = site.claim;
    if (claim?.status === 'open' && claim.lockAt <= now) events.push({at:claim.lockAt,apply:() => lockClaims(world,site,claim.lockAt)});
    else if (claim?.status === 'locked' && claim.endsAt <= now) events.push({at:claim.endsAt,apply:() => closeClaim(world,site,claim.endsAt)});
    if (site.owner && site.nextUpkeep !== null && site.nextUpkeep <= now) {
      const at = site.nextUpkeep;
      events.push({at,apply:() => upkeep(world,site,at)});
    }
    const lease = world.territoryRaffles?.[site.id]?.lease;
    for (const at of [lease?.startsAt, lease?.expiresAt]) if (at > cursor && at <= now) events.push({at,apply:() => {}});
  }
  return events.sort((a,b) => a.at-b.at)[0];
}

export function advanceTerritories(world,now = world.now) {
  ensureTerritories(world,world.now ?? now);
  if (now > world.now) advance(world,now);
  return world.territorySettlements;
}

function visibleSite(world,site,actor,now,historyLimit) {
  const lease = world.territoryRaffles?.[site.id]?.lease;
  const currentLease = lease?.startsAt <= now && lease?.expiresAt > now ? lease : null;
  const owner = currentLease?.playerId ?? site.owner;
  const own=actor?.id!=null&&site.owner===actor.id;
  const {missedUpkeep,nextUpkeep,politicalControl,...publicFields}=site;
  let claimEligibilityResult = {ok:false};
  let attackEligibilityResult = {ok:false};
  let frontierEligibility;
  if (actor && site.frontierCamp) {
    frontierEligibility = {ok:false,cost:expeditionRules.cost,occupationMs:campOccupation};
    try {
      frontierPreflight(world,actor,site,now);
      frontierEligibility.ok = true;
    } catch (error) {
      if (!error.code) throw error;
      Object.assign(frontierEligibility,{code:error.code,reason:error.message});
    }
    claimEligibilityResult = {ok:false,code:'frontier_camp',reason:'Frontier camps use earned supplies.'};
    attackEligibilityResult = claimEligibilityResult;
  }
  if (actor && !site.frontierCamp) {
    for (const [type,eligibility] of [['territory-claim',claimEligibilityResult],['territory-attack',attackEligibilityResult]]) {
      try {
        if (type === 'territory-claim') claimEligibility(world,actor,site,now);
        else attackPreflight(world,actor,site,now);
        eligibility.ok = true;
      }
      catch (error) { if (!error.code) throw error; eligibility.reason = error.message; eligibility.code = error.code; }
    }
  }
  const claim = site.claim && {...site.claim,entries:site.claim.entries.map(({identity,snapshot,...entry}) => entry)};
  const level=site.defenses.level;
  const controls=Boolean(actor&&owner===actor.id);
  const multiplier=controls?politicalTerritoryMultiplier(world,site,now):1;
  const historyStart=Math.max(0,site.history.length-historyLimit);
  const ownershipStart=own?site.history.findLastIndex(entry=>has(entry,'previousOwner') || entry.kind==='incumbent'):-1;
  const history=site.history.slice(historyStart).map(({unit,count,...entry},index)=>
    unit!=null && (actor?.id===entry.playerId || own && index+historyStart>ownershipStart)
      ? {...entry,unit,count} : entry);
  return {...publicFields,region:settlementRegion(site),status:currentLease ? 'leased' : site.status,controller:owner,controlAlliance:owner ? world.cities[owner]?.alliance ?? null : null,
    claim, lease:currentLease, claimEligibility:claimEligibilityResult, attackEligibility:attackEligibilityResult,
    ...(frontierEligibility && {frontierEligibility}),
    canReinforce:!site.protected&&site.category!=='rare'&&canReinforce(world,actor,world.cities[site.owner],now),
    ...(own && {missedUpkeep,nextUpkeep}),...(controls && politicalControl && {politicalControl}),
    defenses:{level,count:own?troopTotal(site.defenses.garrison):null,...(own && {garrison:site.defenses.garrison})},
    stats:{terrainDefensePercent:(terrainFortification(site.terrain)-1)*100,
      localDefensePercent:(terrainFortification(site.terrain,level)-1)*100,
      supply:{range:territoryRules.supplyRange,distance:actor?Math.hypot(site.x-actor.x,site.y-actor.y):null},
      productionType:currentLease?'lease':site.category,productionPerHour:siteProduction(controls?site:{...site,missedUpkeep:0},multiplier),
      ...(controls && {politicalProductionMultiplier:multiplier}),
      fortification:{current:level,max:territoryRules.maxSiteLevel,next:level<territoryRules.maxSiteLevel?level+1:null,
        nextCost:level<territoryRules.maxSiteLevel?{wood:40*level,stone:62*level,iron:16*level}:null,
        nextDefensePercent:level<territoryRules.maxSiteLevel?(terrainFortification(site.terrain,level+1)-1)*100:null}},
    history,blockchain:site.blockchain.slice(-60)};
}

export function readTerritories(world,player,now = world.now,{historyLimit=100} = {}) {
  ensureTerritories(world,now);
  const actor = has(world.cities,player) ? world.cities[player] : null;
  return {territories:world.territories.map(site => visibleSite(world,site,actor,now,historyLimit)),
    settlements:world.territorySettlements.slice(0,50).map(({battle,...item}) => item),
    rules:territoryRules,holdings:actor ? holdings(world,player).map(site => site.id) : [],
    capacity:actor ? capacity(actor) : 0};
}
