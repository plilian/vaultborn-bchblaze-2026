import {DAY,HOUR,MINUTE,resources} from '../../config/economy.mjs';
import {fieldDoctrine} from '../../config/progression.mjs';
import {formations,tactics,units} from '../../config/balance.mjs';
import {clamp,digest,seeded,simulateBattle,troopTotal,unitIds} from './combat.mjs';
import {restorePoliticalTerritory} from './territories.mjs';
import {diplomacyRelationship} from './diplomacy.mjs';
import {awardCommanderMastery} from './progression.mjs';
import {activeProtectorate,activeTreaty,activity,attackEligibility,credit,currentTactic,friendly,getCity,has,notify,points,requireRule,subtract} from './world.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';

const limits = Object.freeze({
  policyCooldown:6*HOUR, decisionCooldown:3*HOUR, proxyCooldown:DAY, conflictCooldown:DAY, recovery:12*HOUR,
  preparation:30*MINUTE, frontDuration:4*MINUTE, maxInterveners:3, maxProxyTroops:12, maxLocalReinforcement:12, politicalSupportFee:6000,
  interventionRequestCooldown:2*MINUTE, interventionRequestCost:{food:12,wood:8},
  civicCap:10_000, maxHistory:200, decisions:['relief','public-works','audit','outreach','levy'],
});
const taxes = {exempt:0,balanced:8,heavy:15};
const stances = {civic:'Civic Stewardship',commerce:'Merchant Charter',mobilization:'Military Mobilization'};
const conflictKinds = {
  coup:'Coup d’État', 'civil-war':'Civil War', independence:'Independence Movement', coalition:'Coalition War',
};
const sides = new Set(['challenger','government']);
const modes = new Set(['troops','resources','intel','equipment','logistics']);
const modeCosts = {
  resources:{food:65,wood:35}, intel:{food:25,crystal:8}, equipment:{iron:42,wood:24}, logistics:{food:50,wood:26,stone:18},
};
const zeros = keys => Object.fromEntries(keys.map(key => [key,0]));
const terminal = status => ['resolved','cancelled'].includes(status);
const range = value => clamp(Math.round(value),0,100);
const dayBucket = (book,actor) => (book.cooldowns[actor] ??= {});
const siteFor = (world,id) => (world.territories ?? []).find(site => site.id === id);
const fresh = (record,now) => (record ?? 0) <= now;

function initial(id,now) {
  return {id,legitimacy:60,loyalty:60,influence:30,unrest:20,tax:'exempt',stance:'civic',civic:zeros(resources),
    taxRemainder:zeros(resources),policyAt:0,recoveryUntil:0,commanderUntil:0,reliefUntil:0,changesAt:now};
}

export function ensureGovernment(world,now = world.now) {
  const book = world.government ??= {version:1,kingdoms:{},conflicts:{},crises:{},history:[],cooldowns:{},payments:{},seenEvents:{},reviewAt:now+HOUR};
  book.requests ??= [];
  for (const id of Object.keys(world.cities)) if (!has(book.kingdoms,id)) book.kingdoms[id] = initial(id,now);
  return book;
}

function kingdom(world,id,now = world.now) {
  const book = ensureGovernment(world,now);
  requireRule(has(book.kingdoms,id),'government_missing','That kingdom has no political office.',404);
  return book.kingdoms[id];
}

function adjust(state,delta,now) {
  for (const key of ['legitimacy','loyalty','influence','unrest']) state[key] = range(state[key] + (delta[key] ?? 0));
  state.changesAt = now;
}

function history(world,kind,data,now) {
  const book = ensureGovernment(world,now);
  const event = {id:'gh' + (++world.seq),kind,...data,at:now};
  book.history.unshift(event);
  book.history.length = Math.min(book.history.length,limits.maxHistory);
  return event;
}

const eventChanges = {
  treaty:[{influence:3,legitimacy:1},{influence:2,loyalty:1}],
  'treaty-breach':[{legitimacy:-5,influence:-4,unrest:3},{influence:2,unrest:2}],
  sanction:[{influence:1},{loyalty:-3,unrest:5}],
  'sanction-lifted':[{influence:2},{loyalty:3,unrest:-3}],
  war:[{loyalty:-1,unrest:3},{loyalty:-1,unrest:3}],
  reparations:[{legitimacy:2,influence:1},{loyalty:2,unrest:-2}],
  'raid-win':[{legitimacy:2,influence:1},{legitimacy:-2,loyalty:-2,unrest:3}],
  'raid-loss':[{legitimacy:-2,loyalty:-2,unrest:3},{legitimacy:2,influence:1}],
  conquest:[{legitimacy:3,influence:2,unrest:1},{legitimacy:-3,loyalty:-4,unrest:6}],
  'territory-claim':[{legitimacy:1,influence:1}],
  'territory-loss':[{legitimacy:-3,loyalty:-4,unrest:6}],
  rebellion:[{unrest:4}],
  liberation:[{legitimacy:4,loyalty:3,influence:3,unrest:-7},{legitimacy:-3,influence:-2,unrest:4}],
};

export function recordGovernmentEvent(world,kind,{actor,target,id,reason,territory} = {},now = world.now) {
  const book = ensureGovernment(world,now);
  if (!has(eventChanges,kind) || !has(book.kingdoms,actor)) return null;
  const idKey = id ? [kind,actor,target,id].join(':') : null;
  if (idKey && has(book.seenEvents,idKey)) return null;
  if (idKey) book.seenEvents[idKey] = now;
  const [actorEffect,targetEffect] = eventChanges[kind];
  adjust(book.kingdoms[actor],actorEffect,now);
  if (targetEffect && actor !== target && has(book.kingdoms,target)) adjust(book.kingdoms[target],targetEffect,now);
  return history(world,kind,{actor,target:target ?? null,source:id ?? null, ...(reason && {reason}), ...(territory && {territory})},now);
}

export function governmentProductionMultiplier(world,playerId,now = world.now) {
  const state = world.government?.kingdoms[playerId];
  if (!state) return 1;
  return clamp(1 + (state.loyalty-60)*.002 - (state.unrest-20)*.002 +
    (state.stance === 'commerce' ? .06 : state.stance === 'mobilization' ? -.05 : 0) +
    (state.reliefUntil > now ? .04 : 0), .78,1.15);
}

export function collectGovernmentTax(world,playerId,earned,now = world.now) {
  const state = world.government?.kingdoms[playerId];
  const rate = taxes[state?.tax] ?? 0;
  if (!rate) return earned;
  for (const key of resources) {
    const quantity = earned[key];
    if (!(quantity > 0)) continue;
    const numerator = quantity*rate + state.taxRemainder[key];
    const tax = Math.min(Math.floor(numerator/100),limits.civicCap-state.civic[key]);
    state.taxRemainder[key] = numerator % 100;
    state.civic[key] += tax;
    earned[key] -= tax;
  }
  return earned;
}

export function governmentMorale(world,playerId,now = world.now) {
  const state = world.government?.kingdoms[playerId];
  if (!state) return 1;
  return clamp(1 + (state.loyalty-60)*.001 + (state.legitimacy-60)*.0008 - (state.unrest-20)*.0009 +
    (state.stance === 'mobilization' ? .03 : 0), .9,1.1);
}

export function governmentCommander(world,id,hero,now = world.now) {
  return world.government?.kingdoms[id]?.commanderUntil > now ? null : hero;
}

export function politicalTerritoryMultiplier(world,site,now = world.now) {
  const administration = site.politicalControl;
  const state = world.government?.kingdoms[site.owner];
  const instability = state && state.unrest >= 65 ? .85 : 1;
  return administration?.until > now ? instability * .5 : instability;
}

function spendCivic(city,state,cost) {
  const cityCosts = Object.fromEntries(Object.entries(cost).map(([key,value]) => [key,Math.max(0,value - state.civic[key])]));
  subtract(city,cityCosts);
  for (const [key,value] of Object.entries(cost)) state.civic[key] -= value - cityCosts[key];
}

const decisions = {
  relief:{cost:{food:90,wood:35},delta:{loyalty:9,legitimacy:2,unrest:-7}},
  'public-works':{cost:{wood:90,stone:90,iron:22},delta:{legitimacy:5,loyalty:5,unrest:-4}},
  audit:{cost:{iron:28,crystal:13},delta:{legitimacy:7,loyalty:2,unrest:-3}},
  outreach:{cost:{food:45,crystal:12},delta:{influence:7,unrest:-2}},
  levy:{cost:{food:25},delta:{legitimacy:-2,loyalty:-6,unrest:6}},
};

function changePolicy(world,city,input,now) {
  const state = kingdom(world,city.id,now);
  requireRule(has(taxes,input.tax) && has(stances,input.stance),'government_policy','Choose a taxation rate and government stance.',400);
  requireRule(state.policyAt <= now,'government_cooldown','Wait for the prior government policy cooldown.');
  requireRule(state.tax !== input.tax || state.stance !== input.stance,'government_policy','That policy is already active.');
  const higherTax = taxes[input.tax] - taxes[state.tax];
  state.tax = input.tax;
  state.stance = input.stance;
  state.policyAt = now+limits.policyCooldown;
  adjust(state,{loyalty: higherTax > 0 ? -Math.ceil(higherTax/2) : higherTax < 0 ? 3 : 0, unrest:higherTax > 0 ? Math.ceil(higherTax/1.5) : higherTax < 0 ? -3 : 0,
    legitimacy:input.stance === 'mobilization' ? -1 : 0},now);
  history(world,'policy',{actor:city.id,tax:state.tax,stance:state.stance},now);
  return state;
}

function civicDecision(world,city,input,now) {
  const book = ensureGovernment(world,now);
  const state = book.kingdoms[city.id];
  const choice = input.decision;
  requireRule(has(decisions,choice),'government_decision','Choose a valid civic decision.',400);
  const cooldown = dayBucket(book,city.id);
  requireRule(fresh(cooldown.decision,now),'government_cooldown','The government is recovering from its latest decision.');
  const plan = decisions[choice];
  if (choice === 'levy') {
    requireRule(Object.values(state.civic).reduce((sum,value)=>sum+value,0) >= 35,'government_civic','Collect tax before distributing a civic levy.');
  }
  spendCivic(city,state,plan.cost);
  adjust(state,plan.delta,now);
  if (choice === 'levy') {
    const payable = Object.fromEntries(resources.map(key => [key,Math.min(state.civic[key],80)]));
    const credited = credit(city,payable);
    for (const key of resources) state.civic[key] -= credited[key];
  }
  if (choice === 'relief' || choice === 'public-works') state.reliefUntil = now+4*HOUR;
  cooldown.decision = now+limits.decisionCooldown;
  history(world,'decision',{actor:city.id,decision:choice},now);
  return state;
}

export function manageNpcCourt(world,city,preferredStance,now) {
  requireRule(city.npc,'political_npc','A player controls this government.',403);
  const book = ensureGovernment(world,now);
  const state = book.kingdoms[city.id];
  const availableRelief = resources.every(resource => city.resources[resource] >= (decisions.relief.cost[resource] ?? 0) * 2);
  if (state.unrest >= 34 && availableRelief && fresh(book.cooldowns[city.id]?.decision,now)) {
    civicDecision(world,city,{decision:'relief'},now);
    return;
  }
  const stance = state.unrest >= 38 ? 'civic' : preferredStance;
  const tax = stance === 'commerce' && city.resources.food > 360 ? 'balanced' : 'exempt';
  if (state.policyAt <= now && (state.stance !== stance || state.tax !== tax)) changePolicy(world,city,{stance,tax},now);
}

function quota(troops,max) {
  const total = troopTotal(troops);
  if (total <= max) return Object.fromEntries(unitIds.map(unit=>[unit,troops[unit] ?? 0]));
  const selected = unitIds.map(unit=>[unit,Math.floor((troops[unit] ?? 0)*max / total)]);
  let remaining = max-selected.reduce((sum,item)=>sum+item[1],0);
  const order = selected.toSorted((a,b)=> (troops[b[0]]*max % total) - (troops[a[0]]*max % total));
  for (const item of order) {
    if (remaining === 0) break;
    item[1]++;
    remaining--;
  }
  return Object.fromEntries(selected);
}

function takeTroops(city,troops) {
  requireRule(unitIds.every(unit=>(city.troops[unit] ?? 0) >= (troops[unit] ?? 0)),
    'political_army','The city lacks available soldiers for this commitment.');
  for (const unit of unitIds) city.troops[unit] -= troops[unit] ?? 0;
}

function wing(captain,city,troops,now) {
  return {captain, tactic:city.tactic, formation:city.formation, troops:[{player:city.id,troops,losses:zeros(unitIds),at:now,role:'local'}],
    packages:[], morale:0, intel:0, equipment:0, logistics:0};
}

function isAlly(world,actor,rival,now) {
  const relationship = diplomacyRelationship(world,actor.id,rival.id,now);
  return actor.id === rival.id || Boolean(actor.alliance && actor.alliance === rival.alliance) ||
    Boolean(activeTreaty(world,actor,rival,['defense'])) || relationship.assistance || relationship.defense;
}

function assertEnrolled(city,now) {
  requireRule(!city.npc && city.tutorial && city.optIn && city.shieldUntil <= now,'political_enrollment',
    'Complete the tutorial, leave starter protection, and enroll in seasonal politics.');
}

function findConflict(world,id,now) {
  const book = ensureGovernment(world,now);
  requireRule(has(book.conflicts,id),'political_conflict','That political conflict is unavailable.',404);
  return book.conflicts[id];
}

function rulingConflict(book,cityId) {
  return Object.values(book.conflicts).some(conflict => !terminal(conflict.status) && [conflict.initiator,conflict.target].includes(cityId));
}

function openConflict(world,actor,input,now,openedBy=null) {
  const book = ensureGovernment(world,now);
  const state = book.kingdoms[actor.id];
  const kind = input.kind;
  requireRule(has(conflictKinds,kind),'political_conflict','Choose a valid kind of conflict.',400);
  assertEnrolled(actor,now);
  const cooldown = dayBucket(book,actor.id);
  requireRule(!rulingConflict(book,actor.id) && fresh(cooldown.conflict,now) && state.recoveryUntil <= now,
    'political_active','Finish the current conflict or recovery before opening a new one.');
  const site = siteFor(world,input.territory);
  let defender = actor;
  let protectorate = null;
  if (kind === 'coalition') {
    defender = getCity(world,input.target);
    const eligibility = attackEligibility(world,actor,defender,now);
    requireRule(eligibility.ok,eligibility.code,eligibility.reason);
    requireRule(!rulingConflict(book,defender.id) && book.kingdoms[defender.id].recoveryUntil <= now,
      'political_active','The defender is already in political conflict or recovery.');
    if (site) requireRule(site.owner === defender.id && !site.protected,'political_site','Choose a frontier location held by the rival.');
  }
  if (kind === 'independence') {
    protectorate = activeProtectorate(world,actor.id);
    const previouslyOwned = site && !site.protected && site.owner && site.owner !== actor.id &&
      site.history.some(record=>record.previousOwner===actor.id && record.kind==='conquered');
    requireRule(protectorate || previouslyOwned,'political_independence','Independence requires an active protectorate or a previously occupied holding.');
    defender = getCity(world,protectorate?.overlord ?? site.owner);
    requireRule(!rulingConflict(book,defender.id) && book.kingdoms[defender.id].recoveryUntil <= now,
      'political_active','The opposing kingdom is already in political conflict or recovery.');
    requireRule(!['preparing','mustering'].includes(protectorate?.rebellion?.status),'political_active',
      'Resolve the protectorate’s active rebellion before restarting the campaign.');
  }
  if (kind === 'civil-war') {
    requireRule(state.unrest >= 35,'political_unrest','Public unrest must reach 35 to muster a civil war.');
    requireRule(site && !site.protected && site.owner === actor.id,'political_site','A civil war needs an owned frontier holding to contest.');
  }
  if (kind === 'coup') {
    requireRule(state.unrest >= 28 || state.loyalty <= 49,'political_unrest','A coup needs 28 unrest or divided loyalty below 50.');
    if (site) requireRule(site.owner === actor.id && !site.protected,'political_site','Choose a frontier holding of your own city.');
  }
  const requiredInfluence = kind === 'coalition' ? 18 : kind === 'civil-war' ? 15 : 10;
  requireRule(state.influence >= requiredInfluence && troopTotal(actor.troops) >= 24,'political_muster',
    'This conflict needs at least 24 available troops and enough diplomatic influence.');
  const local = defender.id === actor.id;
  const attackerRoster = quota(actor.troops, local ? Math.floor(troopTotal(actor.troops)*.47) : 48);
  const defenderAvailable = local ? Object.fromEntries(unitIds.map(unit=>[unit,actor.troops[unit]-attackerRoster[unit]])) : defender.troops;
  const defenderRoster = quota(defenderAvailable,local ? 52 : kind === 'independence' ? Math.max(16,Math.floor(troopTotal(attackerRoster)*1.05)) : 48);
  requireRule(troopTotal(defenderRoster) >= 10,'political_muster','The opposing side lacks a defending roster.');
  spendCivic(actor,state,{food:100,wood:50,iron:24,crystal:9});
  adjust(state,{influence:-requiredInfluence,unrest:kind === 'coalition' ? 2 : 5},now);
  takeTroops(actor,attackerRoster);
  takeTroops(defender,defenderRoster);
  const id = 'pc' + (++world.seq);
  const secret = digest([world.secret,id,'political']);
  const conflict = {id,kind,initiator:actor.id,target:defender.id,territory:site?.id ?? null,protectorate:protectorate?.id ?? null,
    status:'organizing',createdAt:now,nextAt:now+limits.preparation,stage:0,score:{challenger:0,government:0},winner:null,
    seedCommitment:digest(secret),seedScheme:'political-front-v2',fieldRules:fieldDoctrine.version,
    sides:{challenger:wing(actor.id,actor,attackerRoster,now), government:wing(defender.id,defender,defenderRoster,now)},
    rounds:[],receipts:[],casualties:{},openedBy};
  book.conflicts[id] = conflict;
  cooldown.conflict = now+limits.conflictCooldown;
  if (kind === 'coalition') {
    world.marches.unshift({id,kind:'raid',attacker:actor.id,defender:defender.id,alliance:actor.alliance,at:now,endsAt:now+limits.preparation});
    recordGovernmentEvent(world,'war',{actor:actor.id,target:defender.id,id},now);
  }
  history(world,'conflict-opened',{actor:actor.id,target:defender.id,conflict:id,category:kind},now);
  notify(world,actor.id,conflictKinds[kind] + ' mobilization entered its first stage.',now,'politics');
  if (!local) notify(world,defender.id,actor.name + ' opened ' + conflictKinds[kind].toLowerCase() + ' preparations.',now,'politics');
  return conflict;
}

function resourceEffect(side,mode) {
  if (mode === 'resources') side.morale += .013;
  if (mode === 'intel') side.intel += .16;
  if (mode === 'equipment') side.equipment += .02;
  if (mode === 'logistics' || mode === 'paid') side.logistics += .025;
}

function supportEligibility(world,actor,conflict,side,mode,now) {
  assertEnrolled(actor,now);
  requireRule(conflict.status === 'organizing' && conflict.nextAt > now,'political_support_closed','This conflict has locked its support roster.');
  requireRule(sides.has(side),'political_side','Choose the challenger or government side.',400);
  const wing = conflict.sides[side];
  const captain = getCity(world,wing.captain);
  const adverse = getCity(world,conflict.sides[side === 'challenger' ? 'government' : 'challenger'].captain);
  const local = actor.id === captain.id;
  const external = actor.id !== adverse.id && isAlly(world,actor,captain,now);
  const covert = mode === 'intel' && actor.intel?.[adverse.id]?.expiresAt > now && actor.intel[adverse.id].confidence >= .55;
  requireRule(local || external || side === 'challenger' && conflict.kind !== 'coalition' && actor.id !== adverse.id && covert,
    'political_support_access','Intervention requires a commander, allied relationship or fresh covert intelligence.',403);
  requireRule(!wing.packages.some(item=>item.player === actor.id),'political_support_limit','This kingdom already contributed to this side.');
  const other = conflict.sides[side === 'challenger' ? 'government' : 'challenger'];
  requireRule(!other.packages.some(item=>item.player === actor.id),'political_support_conflict','A kingdom cannot contribute on both sides of a conflict.');
  requireRule(wing.packages.length < (limits.maxInterveners+1),'political_support_limit','This wing reached its reinforcement limit.');
  if (!local) {
    const ledger = ensureGovernment(world,now);
    requireRule(fresh(ledger.cooldowns[actor.id]?.proxy,now),'political_proxy_limit','An external intervention is allowed once per rolling day.');
    const combatant = Object.values(ledger.conflicts).find(item=>!terminal(item.status) && item.id!==conflict.id &&
      (item.initiator===actor.id || item.target===actor.id || Object.values(item.sides).some(group=>group.packages.some(pkg=>pkg.player===actor.id))));
    requireRule(!combatant,'political_proxy_limit','Finish your existing campaign before intervening in another.');
    if (side === 'challenger' && conflict.kind === 'coalition') {
      requireRule(!friendly(world,actor,adverse),'friendly','An alliance or treaty protects the opposing kingdom.');
      if (mode === 'troops') {
        const troops={...adverse.troops};
        for (const row of other.troops.filter(item=>item.player===adverse.id && !item.returned)) {
          for (const unit of unitIds) troops[unit]+=row.troops[unit]-row.losses[unit];
        }
        const eligibility=attackEligibility(world,actor,{...adverse,troops},now,{omitMarch:conflict.id});
        requireRule(eligibility.ok,eligibility.code,eligibility.reason);
      }
    }
  }
  return {wing,local};
}

function eligibleRequest(world,conflict,side,from,target,now) {
  if (!sides.has(side) || conflict.status!=='organizing' || conflict.nextAt<=now || conflict.sides[side].captain!==from.id ||
      from.id===target.id || !isAlly(world,from,target,now)) return false;
  const requests=ensureGovernment(world,now).requests;
  if (requests.some(item=>item.conflict===conflict.id && item.to===target.id) ||
      requests.filter(item=>item.conflict===conflict.id && item.side===side).length>=limits.maxInterveners) return false;
  try {
    supportEligibility(world,target,conflict,side,'logistics',now);
    return true;
  } catch (error) {
    if (!error.code) throw error;
    return false;
  }
}

function requestIntervention(world,actor,input,now) {
  const book=ensureGovernment(world,now);
  const conflict=findConflict(world,input.conflict,now);
  const target=getCity(world,input.target);
  const cooldown=dayBucket(book,actor.id);
  requireRule(fresh(cooldown.interventionRequest,now),'political_request_cooldown','Wait two minutes before sending another request.');
  requireRule(eligibleRequest(world,conflict,input.side,actor,target,now),'political_request_access',
    'Only a wing captain can request intervention from an eligible ally during preparation.',403);
  spendCivic(actor,kingdom(world,actor.id,now),limits.interventionRequestCost);
  cooldown.interventionRequest=now+limits.interventionRequestCooldown;
  const row={id:'pr'+(++world.seq),conflict:conflict.id,side:input.side,from:actor.id,to:target.id,
    status:'open',createdAt:now,expiresAt:conflict.nextAt};
  book.requests.push(row);
  notify(world,target.id,actor.name+' requests intervention for the '+input.side+' wing in '+conflictKinds[conflict.kind]+'.',now,'politics');
  notify(world,actor.id,'Intervention requested from '+target.name+'.',now,'politics');
  return row;
}

function attachSupport(world,actor,conflict,side,mode,now,payment,input={}) {
  const {wing,local} = supportEligibility(world,actor,conflict,side,mode,now);
  const influence = kingdom(world,actor.id,now);
  const data = {player:actor.id,mode,at:now,role:local ? 'local' : 'external'};
  if (mode === 'troops') {
    const {unit,count} = input;
    requireRule(has(units,unit) && Number.isSafeInteger(count) && count>=1 && count<=(local?limits.maxLocalReinforcement:limits.maxProxyTroops),
      'political_troops','Choose a valid unit and up to 12 troops.',400);
    const troops = {...zeros(unitIds),[unit]:count};
    takeTroops(actor,troops);
    wing.troops.push({player:actor.id,troops,losses:zeros(unitIds),at:now,role:data.role});
    data.unit = unit;
    data.count = count;
  } else if (mode === 'paid') {
    const paid = {id:payment.id,txid:payment.txid,satoshis:payment.satoshis,player:actor.id,side,at:now};
    conflict.receipts.push(paid);
    data.payment = paid;
  } else {
    if (mode === 'intel') {
      requireRule(!local || influence.influence >= 3,'political_intel','Coordinated intelligence requires three political influence.');
    }
    const cost = modeCosts[mode];
    spendCivic(actor,influence,cost);
    if (mode === 'intel' && local) adjust(influence,{influence:-3},now);
    data.cost = cost;
  }
  if (!local) {
    dayBucket(ensureGovernment(world,now),actor.id).proxy = now+limits.proxyCooldown;
    const march = world.marches.find(item => item.id === conflict.id);
    if (march && mode === 'troops' && side === 'challenger') {
      (march.contributors ??= []).push(actor.id);
      if (actor.alliance && actor.alliance!==march.alliance && !(march.contributorAlliances??[]).includes(actor.alliance)) {
        (march.contributorAlliances ??= []).push(actor.alliance);
      }
    }
  }
  resourceEffect(wing,mode);
  wing.packages.push(data);
  const request=ensureGovernment(world,now).requests.find(item=>item.conflict===conflict.id && item.side===side && item.to===actor.id && item.status==='open');
  if (request) {
    request.status='fulfilled';
    request.fulfilledAt=now;
  }
  notify(world,wing.captain,'Confirmed ' + (mode==='paid'?'' + NETWORK_LABEL + ' logistics':mode) + ' support for the ' + conflictKinds[conflict.kind].toLowerCase() + '.',now,'politics');
  return {conflict:conflict.id, side, contribution:data};
}

function support(world,actor,input,now) {
  requireRule(modes.has(input.mode),'political_support','Choose troops, resources, intelligence, equipment or logistics.',400);
  return attachSupport(world,actor,findConflict(world,input.conflict,now),input.side,input.mode,now,null,input);
}

export function quotePoliticalSupport(world,player,input,now=world.now) {
  const actor = getCity(world,player);
  requireRule(input.operation === 'support','political_support','Choose a valid paid political operation.',400);
  const conflict = findConflict(world,input.conflict,now);
  supportEligibility(world,actor,conflict,input.side,'paid',now);
  return { action:{type:'political-operation',operation:'support',conflict:conflict.id,side:input.side}, title:'Fund political logistics',
    description:'A confirmed payment supplies one bounded logistics package. No player wallet is otherwise debited.',satoshis:limits.politicalSupportFee };
}

export function applyPoliticalSupport(world,player,action,receipt,now=world.now) {
  const book = ensureGovernment(world,now);
  requireRule(receipt && typeof receipt.id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(receipt.id) &&
    /^[a-fA-F0-9]{64}$/.test(receipt.txid ?? '') && receipt.satoshis === (receipt.price ?? limits.politicalSupportFee),
    'political_payment','A confirmed exact ' + NETWORK_LABEL + ' receipt is required.',402);
  const txid = receipt.txid.toLowerCase();
  const old = has(book.payments,receipt.id) ? book.payments[receipt.id] : null;
  if (old) {
    requireRule(old.txid===txid && old.player===player && old.result.conflict===action.conflict && old.result.side===action.side,
      'political_payment_duplicate','The receipt already belongs to another operation.');
    return old.result;
  }
  requireRule(!Object.values(book.payments).some(item=>item.txid===txid),'political_payment_duplicate','That transaction funded another operation.');
  const quote = quotePoliticalSupport(world,player,action,now);
  const result = attachSupport(world,getCity(world,player),book.conflicts[quote.action.conflict],quote.action.side,'paid',now,{...receipt,txid});
  book.payments[receipt.id] = {txid,player,result};
  return result;
}

function orders(world,actor,input,now) {
  const conflict = findConflict(world,input.conflict,now);
  requireRule(!terminal(conflict.status) && conflict.nextAt > now,'political_order_closed','The active front has already closed.');
  requireRule(sides.has(input.side) && has(tactics,input.tactic) && has(formations,input.formation),'political_order','Choose a wing and valid battle orders.',400);
  const wing = conflict.sides[input.side];
  requireRule(wing.captain===actor.id,'political_order','Only this wing’s commander can change its orders.',403);
  wing.tactic = input.tactic;
  wing.formation = input.formation;
  return {conflict:conflict.id,side:input.side,tactic:wing.tactic,formation:wing.formation};
}

const fronts = [
  {name:'Outer Approaches',terrain:'plains',points:1},
  {name:'Supply Crossing',terrain:'river',points:1},
  {name:'Seat of Authority',terrain:'hills',points:2},
];

function availableUnit(wing,unit) {
  return wing.troops.reduce((sum,item)=>sum+item.troops[unit]-item.losses[unit],0);
}
function wingInput(world,conflict,wing,now,wall=0,multiplier=1) {
  const city = getCity(world,wing.captain);
  const {hero,commanderTraits,...side}=currentTactic(city,world,now,city.hero,conflict.fieldRules??1);
  if (conflict.fieldRules===fieldDoctrine.version && conflict.stage===0) wing.lockedCommander={hero,commanderTraits:commanderTraits??null};
  const commander=wing.lockedCommander&&governmentCommander(world,city.id,wing.lockedCommander.hero,now) ? wing.lockedCommander :
    wing.lockedCommander ? {hero:null} : {hero,commanderTraits};
  return {...side,hero:commander.hero,...(commander.commanderTraits && {commanderTraits:commander.commanderTraits}),
    troops:Object.fromEntries(unitIds.map(unit=>[unit,availableUnit(wing,unit)])),
    tactic:wing.tactic,formation:wing.formation,wall,
    intel:Math.min(.7,wing.intel),politicalMorale:clamp(governmentMorale(world,city.id,now)*multiplier + wing.morale+wing.equipment+wing.logistics,.86,1.16)};
}

function distributeLoss(wing,desired,roundIndex) {
  const byPlayer = {};
  for (const unit of unitIds) {
    const row = wing.troops.map((item,index)=>({
      item,index,available:item.troops[unit]-item.losses[unit],
    })).filter(item=>item.available>0);
    const total = row.reduce((sum,item)=>sum+item.available,0);
    if (!total || !desired[unit]) continue;
    const count = Math.min(total,desired[unit]);
    for (const item of row) item.share = Math.floor(count*item.available/total);
    const remaining = count-row.reduce((sum,item)=>sum+item.share,0);
    row.sort((left,right)=>(right.available*count % total)-(left.available*count % total) ||
      digest([roundIndex,unit,left.item.player,left.index]).localeCompare(digest([roundIndex,unit,right.item.player,right.index])));
    for (const item of row.slice(0,remaining)) item.share++;
    for (const {item,share} of row) if (share) {
      item.losses[unit] += share;
      const player = byPlayer[item.player] ??= zeros(unitIds);
      player[unit] += share;
    }
  }
  return byPlayer;
}

function militaryStrain(world,conflict,side) {
  if (side === 'government' && ['coup','civil-war'].includes(conflict.kind)) {
    const city = world.government.kingdoms[conflict.target];
    return clamp(1+(city.legitimacy-50)*.002 - city.unrest*.002,.82,1.04);
  }
  if (side === 'challenger' && ['coup','civil-war'].includes(conflict.kind)) {
    const city = world.government.kingdoms[conflict.target];
    return clamp(1+(city.unrest-25)*.003 - (city.loyalty-40)*.001,.95,1.12);
  }
  return 1;
}

function politicalReport(world,conflict,now) {
  const front = fronts[conflict.stage];
  const defender = getCity(world,conflict.target);
  const site = siteFor(world,conflict.territory);
  const wall = conflict.stage===2 ? Math.max(1,site?.defenses.level ?? defender.buildings.walls-1) : 0;
  const input = {attacker:wingInput(world,conflict,conflict.sides.challenger,now,0,militaryStrain(world,conflict,'challenger')),
    defender:wingInput(world,conflict,conflict.sides.government,now,wall,militaryStrain(world,conflict,'government')),terrain:front.terrain};
  const seed = conflict.seedScheme==='political-front-v2' ? digest([digest([world.secret,conflict.id,'political']),conflict.stage]) :
    digest([world.secret,conflict.id,'political',conflict.stage]);
  const result = simulateBattle(input,seed);
  const id = 'b' + (++world.seq);
  const report = {id,kind:'political-front',politicalConflict:conflict.id,attacker:conflict.initiator,defender:conflict.target,
    attackerName:getCity(world,conflict.initiator).name,defenderName:defender.name,at:now,commitment:digest({input,seed}),
    input,seed,paid:false,loot:zeros(resources),...result};
  world.battles.unshift(report);
  const challenger = distributeLoss(conflict.sides.challenger,result.losses.attacker,conflict.stage);
  const government = distributeLoss(conflict.sides.government,result.losses.defender,conflict.stage);
  const winner = result.winner==='attacker' ? 'challenger' : 'government';
  conflict.score[winner] += front.points;
  const round = {stage:conflict.stage+1,name:front.name,battleId:id,winner,losses:{challenger,government},at:now,
    ...(conflict.seedScheme==='political-front-v2' && {seed,battleCommitment:report.commitment})};
  conflict.rounds.push(round);
  for (const bySide of [challenger,government]) for (const [player,losses] of Object.entries(bySide)) {
    const total = conflict.casualties[player] ??= zeros(unitIds);
    for (const unit of unitIds) total[unit] += losses[unit];
  }
  if (site && conflict.stage===1 && (conflict.kind==='civil-war' || conflict.kind==='independence') && winner==='challenger') {
    site.politicalControl = {conflict:conflict.id,side:winner,until:now+limits.frontDuration};
    site.history.push({kind:'political-contest',playerId:conflict.initiator,at:now,conflict:conflict.id});
  }
  for (const player of new Set([conflict.initiator,conflict.target])) {
    notify(world,player,front.name + ' resolved for the ' + winner + ' faction.',now,'politics');
  }
}

function restoreSurvivors(world,conflict) {
  for (const side of Object.values(conflict.sides)) for (const row of side.troops) {
    const city = getCity(world,row.player);
    for (const unit of unitIds) city.troops[unit] += row.troops[unit]-row.losses[unit];
    row.returned = true;
  }
}

function closeConflict(world,conflict,now) {
  const book = ensureGovernment(world,now);
  const challenger = getCity(world,conflict.initiator);
  const defender = getCity(world,conflict.target);
  const site = siteFor(world,conflict.territory);
  const won = conflict.score.challenger > conflict.score.government ||
    conflict.score.challenger===conflict.score.government && conflict.rounds.at(-1)?.winner==='challenger';
  const winner = won ? 'challenger' : 'government';
  conflict.winner = winner;
  conflict.status = 'resolved';
  conflict.resolvedAt = now;
  conflict.seed = digest([world.secret,conflict.id,'political']);
  conflict.nextAt = null;
  const lastFront=world.battles.find(row=>row.id===conflict.rounds.at(-1)?.battleId);
  if (lastFront?.input) {
    awardCommanderMastery(challenger,lastFront.input.attacker.hero,'political',now);
    if (defender.id!==challenger.id && !defender.npc) awardCommanderMastery(defender,lastFront.input.defender.hero,'political',now);
  }
  restoreSurvivors(world,conflict);
  if (site?.politicalControl?.conflict===conflict.id) delete site.politicalControl;
  const local = challenger.id===defender.id;
  const primary = book.kingdoms[challenger.id];
  const opposition = book.kingdoms[defender.id];
  primary.recoveryUntil = now+limits.recovery;
  opposition.recoveryUntil = now+limits.recovery;
  if (local) {
    const changed = won ? {legitimacy:8,loyalty:6,influence:4,unrest:-15} : {legitimacy:2,loyalty:-4,influence:-2,unrest:-8};
    adjust(primary,changed,now);
    if (won) {
      primary.governmentEra = (primary.governmentEra ?? 0)+1;
      primary.tax = 'exempt';
      primary.stance = 'civic';
      primary.commanderUntil = now+2*HOUR;
      if (conflict.kind === 'civil-war' && site?.owner===challenger.id) {
        site.politicalControl = {conflict:conflict.id,side:winner,until:now+2*HOUR};
        site.history.push({kind:'civil-realignment',playerId:challenger.id,at:now,conflict:conflict.id});
      }
    }
  } else {
    adjust(primary,won ? {legitimacy:5,loyalty:3,influence:5,unrest:-8} : {legitimacy:-2,loyalty:-4,influence:-2,unrest:4},now);
    adjust(opposition,won ? {legitimacy:-3,loyalty:-2,influence:-1,unrest:4} : {legitimacy:3,loyalty:2,unrest:-4},now);
    const victor = won ? challenger : defender;
    points(victor,won ? 14 : 9,'politics',{kind:'politics',ref:'conflict:'+conflict.id});
    if (conflict.kind==='independence' && won) {
      const pact = world.governance.find(item=>item.id===conflict.protectorate && item.status==='active');
      if (pact) {
        pact.status = 'liberated';
        pact.endedAt = now;
        if (pact.rebellion) pact.rebellion.status = 'liberated';
        challenger.immunityUntil = Math.max(challenger.immunityUntil,now+limits.recovery);
        notify(world,challenger.id,'Independence declared. Protectorate tribute has ended.',now,'politics');
      } else if (site?.owner===defender.id) {
        const restored = restorePoliticalTerritory(world,site.id,defender.id,challenger.id,conflict.id,now);
        conflict.result = restored ? {kind:'independence-restoration',territory:site.id,restoration:restored} :
          {kind:'independence-constrained',territory:site.id};
      }
      recordGovernmentEvent(world,'liberation',{actor:challenger.id,target:defender.id,id:conflict.id},now);
    }
  }
  conflict.result ??= {kind:conflict.kind==='coup' && won ? 'coup-successful' :
    conflict.kind==='independence' && won ? 'independence-declared' : 'conflict-ended'};
  history(world,'conflict-resolved',{actor:challenger.id,target:defender.id,conflict:conflict.id,
    category:conflict.kind,winner,result:conflict.result.kind},now);
  activity(world,'politics',conflictKinds[conflict.kind] + (won?' resolved in favor of the challenger.':' was contained by the government.'),now);
  for (const player of new Set([challenger.id,defender.id])) {
    notify(world,player,conflictKinds[conflict.kind] + ' resolved for the ' + winner + ' faction.',now,'politics');
  }
}

function nextConflict(world,conflict,at) {
  if (conflict.stage===0) {
    for (const request of ensureGovernment(world,at).requests) if (request.conflict===conflict.id && request.status==='open') {
      request.status='expired';
    }
  }
  const relationship = diplomacyRelationship(world,conflict.initiator,conflict.target,at);
  const pact = conflict.protectorate && world.governance.find(item=>item.id===conflict.protectorate);
  if (conflict.kind==='coalition' && relationship.blocksAttack || pact && pact.status!=='active') {
    restoreSurvivors(world,conflict);
    conflict.status = 'cancelled';
    conflict.nextAt = null;
    conflict.resolvedAt = at;
    conflict.seed = digest([world.secret,conflict.id,'political']);
    conflict.result = {kind:'withdrawal-agreed'};
    history(world,'conflict-cancelled',{actor:conflict.initiator,target:conflict.target,conflict:conflict.id,category:conflict.kind},at);
    for (const id of new Set([conflict.initiator,conflict.target])) notify(world,id,'Political terms ended the conflict and surviving troops returned.',at,'politics');
    return;
  }
  if (conflict.stage===0) conflict.status = 'fighting';
  politicalReport(world,conflict,at);
  conflict.stage++;
  if (conflict.stage===fronts.length) closeConflict(world,conflict,at);
  else conflict.nextAt = at+limits.frontDuration;
}

export function reservedPoliticalTroops(world,playerId) {
  return Object.values(world.government?.conflicts ?? {}).filter(conflict=>!terminal(conflict.status)).reduce((count,conflict)=>
    count+Object.values(conflict.sides).reduce((sum,wing)=>sum+wing.troops.filter(row=>row.player===playerId && !row.returned)
      .reduce((total,item)=>total+troopTotal(item.troops)-troopTotal(item.losses),0),0),0);
}

const eventRules = {
  crisis:{name:'Political Crisis',duration:20*MINUTE,cooldown:8*HOUR,choices:[
    {id:'relief',label:'Open public granaries',cost:{food:95,wood:25}},
    {id:'assembly',label:'Hear the public assembly',cost:{wood:30,crystal:10}}]},
  assassination:{name:'Assassination Attempt',duration:12*MINUTE,cooldown:2*DAY,secret:true,choices:[
    {id:'protect',label:'Place the commander in protective custody',cost:{food:60,iron:28}},
    {id:'decoy',label:'Commit to a decoy operation',cost:{food:32,crystal:12}}]},
  corruption:{name:'Corruption Scandal',duration:25*MINUTE,cooldown:DAY,choices:[
    {id:'audit',label:'Open an independent audit',cost:{iron:25,crystal:14}},
    {id:'restitution',label:'Repay local households',cost:{wood:55,food:65}}]},
  succession:{name:'Succession Dispute',duration:20*MINUTE,cooldown:DAY,choices:[
    {id:'regency',label:'Appoint a temporary regency',cost:{food:48,stone:35}},
    {id:'council',label:'Call a succession council',cost:{food:42,crystal:15}}]},
  incident:{name:'Diplomatic Incident',duration:25*MINUTE,cooldown:12*HOUR,choices:[
    {id:'apology',label:'Offer a public apology',cost:{food:30}},
    {id:'arbitrate',label:'Pay for independent arbitration',cost:{wood:35,crystal:9}}]},
  uprising:{name:'Uprising',duration:25*MINUTE,cooldown:DAY,choices:[
    {id:'concede',label:'Accept local reforms',cost:{food:70,wood:40}},
    {id:'mobilize',label:'Let the factions muster',cost:{}}]},
  'independence-declaration':{name:'Independence Declaration',duration:25*MINUTE,cooldown:DAY,choices:[
    {id:'negotiate',label:'Seek a negotiated withdrawal',cost:{food:45,crystal:10}},
    {id:'mobilize',label:'Begin an independence campaign',cost:{}}]},
  'territorial-dispute':{name:'Territorial Dispute',duration:25*MINUTE,cooldown:DAY,choices:[
    {id:'arbitrate',label:'Submit the frontier to arbitration',cost:{food:25,crystal:12}},
    {id:'stand',label:'Contest the claim publicly',cost:{wood:40,iron:18}}]},
  negotiation:{name:'Political Negotiation',duration:30*MINUTE,cooldown:12*HOUR,choices:[
    {id:'conference',label:'Attend the diplomatic conference',cost:{food:40,crystal:8}},
    {id:'decline',label:'Decline the invitation',cost:{}}]},
  'war-declaration':{name:'Public War Declaration',duration:25*MINUTE,cooldown:DAY,choices:[
    {id:'conference',label:'Request a cooling-off conference',cost:{food:42,crystal:10}},
    {id:'mobilize',label:'Accept the coalition challenge',cost:{}}]},
  'council-vote':{name:'International Council Vote',duration:30*MINUTE,cooldown:DAY,choices:[
    {id:'approve',label:'Approve civic protection terms',cost:{}},
    {id:'reject',label:'Reject the proposed terms',cost:{}}]},
};

function politicalEvent(world,id,now) {
  const book = ensureGovernment(world,now);
  requireRule(has(book.crises,id),'political_event','That political event is unavailable.',404);
  return book.crises[id];
}

function placeEvent(world,actor,input,now) {
  const book = ensureGovernment(world,now);
  const kind = input.kind;
  requireRule(has(eventRules,kind),'political_event','Choose a valid political event.',400);
  const rule = eventRules[kind];
  const actorState = book.kingdoms[actor.id];
  const cooldown = dayBucket(book,actor.id);
  const key = 'event:'+kind;
  requireRule(fresh(cooldown[key],now),'political_event_cooldown','This event is still on cooldown.');
  requireRule(!Object.values(book.crises).some(event=>event.actor===actor.id && event.status==='open' && event.kind===kind),
    'political_event_open','Resolve the existing event of this kind first.');
  let target = actor;
  let eligible = [actor.id];
  const site = siteFor(world,input.territory);
  if (['assassination','incident','negotiation','war-declaration','territorial-dispute'].includes(kind)) {
    assertEnrolled(actor,now);
    target = getCity(world,input.target ?? site?.owner);
    requireRule(target.id!==actor.id && target.optIn && target.shieldUntil<=now,'political_event_target',
      'The target must be an opposing kingdom participating in seasonal politics.');
    eligible = [target.id];
    requireRule(!Object.values(book.crises).some(event=>event.kind===kind && event.target===target.id && event.status==='open'),
      'political_event_open','The target already has an unresolved event of this kind.');
  }
  const actorCosts = {food:24,wood:15};
  if (kind==='crisis') requireRule(actorState.unrest>=28,'political_event_state','A political crisis needs at least 28 unrest.');
  if (kind==='corruption') requireRule(actorState.tax!=='exempt' || actorState.legitimacy<=50,
    'political_event_state','A corruption inquiry requires taxation or legitimacy of 50 or less.');
  if (kind==='succession') requireRule(actorState.legitimacy<=55 || actorState.commanderUntil>now,
    'political_event_state','A succession dispute needs absent leadership or legitimacy of 55 or less.');
  if (kind==='uprising') requireRule(actorState.unrest>=35 && site?.owner===actor.id && !site.protected,
    'political_event_state','An uprising needs an owned frontier territory and at least 35 unrest.');
  let protectorate = null;
  if (kind==='independence-declaration') {
    protectorate = activeProtectorate(world,actor.id);
    const occupied = site?.owner && site.owner!==actor.id && !site.protected && site.history.some(item=>item.previousOwner===actor.id && item.kind==='conquered');
    requireRule(protectorate || occupied,'political_event_state','You need active protectorate terms or an occupied former territory.');
    target = getCity(world,protectorate?.overlord ?? site.owner);
  }
  if (kind==='territorial-dispute') requireRule(site?.owner===target.id && !site.protected &&
    site.history.some(item=>item.previousOwner===actor.id || item.playerId===actor.id),
    'political_event_state','Choose a neighboring holding with a recorded prior claim by your kingdom.');
  if (kind==='war-declaration') {
    const eligibility = attackEligibility(world,actor,target,now);
    requireRule(eligibility.ok,eligibility.code,eligibility.reason);
  }
  if (kind==='assassination') {
    const intel = actor.intel?.[target.id];
    requireRule(!isAlly(world,actor,target,now) && intel?.expiresAt>now && intel.confidence>=.55 &&
      actor.scoutPoints>=2 && actor.spies>=1,'political_intel','This fictional operation needs a fresh hostile intelligence report, an operative and two scout points.');
    Object.assign(actorCosts,{food:58,crystal:14});
  }
  if (kind==='council-vote') {
    requireRule(actor.alliance && world.alliances[actor.alliance]?.leader===actor.id,'political_council','Only an alliance leader may call this forum.',403);
    eligible = Object.values(world.cities).filter(city=>city.alliance===actor.alliance && !city.npc && city.tutorial).map(city=>city.id).sort();
    requireRule(eligible.length>=2,'political_council','At least two enrolled council participants are required.');
  }
  spendCivic(actor,actorState,actorCosts);
  cooldown[key] = now+rule.cooldown;
  if (kind==='assassination') actor.scoutPoints -= 2;
  const id = 'pe' + (++world.seq);
  const event = {id,kind,actor:actor.id,target:target.id,territory:site?.id??null,protectorate:protectorate?.id??null,
    status:'open',createdAt:now,deadline:now+rule.duration,choices:rule.choices,eligible,votes:{},result:null};
  book.crises[id] = event;
  if (!rule.secret) history(world,'event-opened',{actor:actor.id,target:target.id,event:id,category:kind},now);
  notify(world,target.id,rule.secret ? 'An intelligence warning requires a protective decision.' : rule.name + ' awaits a political decision.',now,'politics');
  for (const player of eligible) if (player!==target.id) notify(world,player,rule.name + ' is open for your vote.',now,'politics');
  return event;
}

function settleAssassination(world,event,response,now) {
  const city = getCity(world,event.target);
  const attacker = getCity(world,event.actor);
  const victim = kingdom(world,city.id,now);
  const quality = attacker.intel?.[city.id]?.confidence ?? 0;
  const preparation = response==='protect' ? .28 : response==='decoy' ? .21 : 0;
  const probability = clamp(.44 + quality*.18 + (attacker.buildings.scout-city.buildings.scout)*.025 -
    (city.counterspyUntil > now ? .17 : 0) - preparation,.08,.77);
  const seed = digest([world.secret,event.id,'incident']);
  const success = seeded(seed)()<probability;
  if (success) {
    victim.commanderUntil = Math.max(victim.commanderUntil,now+45*MINUTE);
    adjust(victim,{unrest:7,loyalty:-3},now);
  } else {
    adjust(victim,{legitimacy:2,loyalty:2},now);
    adjust(kingdom(world,attacker.id,now),{influence:-3},now);
  }
  return {outcome:success?'commander-unavailable':'attempt-thwarted',until:success?victim.commanderUntil:null,probability,commitment:digest(seed),seed};
}

function enactResponse(world,event,choice,now) {
  const actor = getCity(world,event.actor);
  const target = getCity(world,event.target);
  const source = kingdom(world,actor.id,now);
  const destination = kingdom(world,target.id,now);
  const kind = event.kind;
  let effect = 'resolved';
  if (kind==='assassination') return settleAssassination(world,event,choice,now);
  if (kind==='council-vote') {
    const votes = Object.values(event.votes);
    const yes = votes.filter(value=>value==='approve').length;
    const quorum = Math.ceil(event.eligible.length*.6);
    const passed = votes.length>=quorum && yes>votes.length/2;
    if (passed) for (const id of event.eligible) adjust(kingdom(world,id,now),{loyalty:3,influence:2,unrest:-2},now);
    return {outcome:passed?'approved':'not-passed',votes:votes.length,yes,quorum};
  }
  if (choice==='mobilize') {
    const conflictKind = kind==='war-declaration'?'coalition':kind==='independence-declaration'?'independence':'civil-war';
    const conflict = openConflict(world,actor,{kind:conflictKind,target:event.target,territory:event.territory},now,event.id);
    return {outcome:'conflict-opened',conflict:conflict.id};
  }
  if (choice==='deadline') {
    const crowded = ['crisis','corruption','succession','uprising'].includes(kind);
    adjust(destination,crowded?{legitimacy:-3,loyalty:-3,unrest:4}:{influence:-2},now);
    return {outcome:'expired'};
  }
  if (kind==='crisis' || kind==='corruption' || kind==='succession' || kind==='uprising') {
    adjust(destination,{legitimacy:kind==='corruption'?8:5,loyalty:kind==='uprising'?8:4,unrest:-7},now);
    if (kind==='succession') {
      destination.commanderUntil = choice==='regency' ? now+30*MINUTE : now;
      effect = 'succession-settled';
    } else effect = kind==='uprising'?'reforms-adopted':kind==='corruption'?'accounts-cleared':'crisis-eased';
  }
  if (kind==='negotiation' || kind==='incident' || kind==='war-declaration') {
    if (choice==='decline') adjust(source,{influence:-1},now);
    else {
      adjust(source,{influence:3,unrest:-2},now);
      adjust(destination,{influence:3,loyalty:2,unrest:-3},now);
      effect = 'conference-concluded';
    }
  }
  if (kind==='territorial-dispute') {
    const site = siteFor(world,event.territory);
    if (choice==='arbitrate') {
      adjust(source,{influence:3,unrest:-2},now);
      adjust(destination,{legitimacy:2,unrest:-2},now);
      effect = 'claims-reconciled';
    } else {
      if (site?.owner===target.id) site.politicalControl = {conflict:event.id,side:'disputed',until:now+2*HOUR};
      adjust(destination,{influence:2,unrest:4},now);
      adjust(source,{unrest:3},now);
      effect = 'disputed-production';
    }
  }
  if (kind==='independence-declaration' && choice==='negotiate') {
    adjust(source,{influence:4,loyalty:4,unrest:-3},now);
    effect = 'terms-requested';
  }
  return {outcome:effect};
}

function settleEvent(world,event,choice,now) {
  const result = enactResponse(world,event,choice,now);
  event.status = 'resolved';
  event.resolvedAt = now;
  event.result = {...result,choice};
  history(world,'event-resolved',{actor:event.actor,target:event.target,event:event.id,category:event.kind,result:result.outcome},now);
  for (const id of new Set([event.actor,event.target])) notify(world,id,eventRules[event.kind].name + ' resolved.',now,'politics');
  return event;
}

function answerEvent(world,city,input,now) {
  const event = politicalEvent(world,input.event,now);
  requireRule(event.status==='open' && event.deadline>now,'political_event_closed','This political response window closed.');
  requireRule(event.eligible.includes(city.id),'political_event_access','This response belongs to the affected kingdom or eligible council.',403);
  const choice = event.choices.find(value=>value.id===input.choice);
  requireRule(choice,'political_event_choice','Choose an available political response.',400);
  if (event.kind==='council-vote') {
    requireRule(!has(event.votes,city.id),'political_event_vote','Each eligible council participant votes once.');
    event.votes[city.id] = choice.id;
    if (Object.keys(event.votes).length===event.eligible.length) settleEvent(world,event,'closed',now);
    return {event:event.id,choice:choice.id,status:event.status};
  }
  spendCivic(city,kingdom(world,city.id,now),choice.cost);
  return settleEvent(world,event,choice.id,now);
}

function drift(world,at) {
  const book = ensureGovernment(world,at);
  for (const state of Object.values(book.kingdoms)) {
    const lighter = state.tax === 'exempt';
    const unrest = state.tax==='heavy' && state.unrest<52 ? 1 : state.unrest>20 ? -1 : 0;
    const loyalty = lighter && state.loyalty<58 ? 1 : state.tax==='heavy' && state.loyalty>48 ? -1 : 0;
    const legitimacy = lighter && state.legitimacy<49 ? 1 : 0;
    if (unrest || loyalty || legitimacy) adjust(state,{unrest,loyalty,legitimacy},at);
  }
  book.reviewAt = at+6*HOUR;
  for (const [id,at] of Object.entries(book.seenEvents)) if (at+7*DAY<book.reviewAt) delete book.seenEvents[id];
}

export function nextGovernmentEvent(world,now = world.now) {
  const book = world.government;
  if (!book) return undefined;
  const queue = [];
  for (const conflict of Object.values(book.conflicts)) {
    const at = conflict.nextAt;
    if (!terminal(conflict.status) && Number.isSafeInteger(at) && at<=now) queue.push({at,apply:()=>nextConflict(world,conflict,at)});
  }
  for (const event of Object.values(book.crises)) if (event.status==='open' && event.deadline<=now) {
    queue.push({at:event.deadline,apply:()=>settleEvent(world,event,event.kind==='council-vote'?'closed':'deadline',event.deadline)});
  }
  if (book.reviewAt<=now) {
    const at = book.reviewAt;
    queue.push({at,apply:()=>drift(world,at)});
  }
  for (const state of Object.values(book.kingdoms)) if (state.reliefUntil > world.now && state.reliefUntil <= now) {
    queue.push({at:state.reliefUntil,apply:()=>{}});
  }
  for (const site of world.territories ?? []) if (site.politicalControl?.until > world.now && site.politicalControl.until<=now) {
    queue.push({at:site.politicalControl.until,apply:()=>{delete site.politicalControl;}});
  }
  return queue.sort((a,b)=>a.at-b.at)[0];
}

const commandTypes = new Set(['government-policy','government-decision','political-conflict-open','political-conflict-support',
  'political-conflict-order','political-conflict-request','political-event-open','political-event-respond']);

export const isGovernmentAction = type => commandTypes.has(type);

export function governmentCommand(world,player,input,now = world.now) {
  const actor = getCity(world,player);
  requireRule(!actor.npc,'political_npc','Only an active player can send government orders.',403);
  switch (input.type) {
    case 'government-policy':return changePolicy(world,actor,input,now);
    case 'government-decision':return civicDecision(world,actor,input,now);
    case 'political-conflict-open':return openConflict(world,actor,input,now);
    case 'political-conflict-support':return support(world,actor,input,now);
    case 'political-conflict-request':return requestIntervention(world,actor,input,now);
    case 'political-conflict-order':return orders(world,actor,input,now);
    case 'political-event-open':return placeEvent(world,actor,input,now);
    case 'political-event-respond':return answerEvent(world,actor,input,now);
    default:requireRule(false,'political_action','Choose a valid government action.',400);
  }
}

function conflictView(world,record,viewer,now) {
  const done = terminal(record.status);
  const actor = has(world.cities,viewer)?world.cities[viewer]:null;
  const out = {...record,sides:{},receipts:done?record.receipts:[],casualties:done?record.casualties:{}};
  for (const [key,wing] of Object.entries(record.sides)) {
    let canSupport = false;
    if (!done && actor) {
      try { supportEligibility(world,actor,record,key,'logistics',now); canSupport=true; }
      catch (error) { if (!error.code) throw error; }
    }
    const own = viewer === wing.captain;
    out.sides[key] = {captain:wing.captain, canSupport, canOrder:own&&!done, contributionCount:wing.packages.length,
      ...(own && !done && actor && {requestTargets:Object.values(world.cities).filter(target=>eligibleRequest(world,record,key,actor,target,now)).map(target=>target.id)}),
      ...(done && {troops:wing.troops,tactic:wing.tactic,formation:wing.formation,packages:wing.packages}),
      ...(!done && (own || wing.packages.some(item=>item.player===viewer)) && {
        ...(own && {tactic:wing.tactic,formation:wing.formation}),
        packages:wing.packages.filter(item=>item.player===viewer),
        ownTroops:wing.troops.filter(item=>item.player===viewer),
      })};
  }
  if (!done) out.rounds = record.rounds.map(({losses,seed,...round})=>round);
  return out;
}

function crisisView(event,viewer) {
  const open = event.status === 'open';
  const secret = eventRules[event.kind].secret;
  if (open && secret && ![event.actor,event.target].includes(viewer)) return null;
  const canRespond = open && event.eligible.includes(viewer) && !(event.kind==='council-vote' && has(event.votes,viewer));
  return {...event,actor:open && secret && viewer!==event.actor?null:event.actor, choices:event.choices,
    canRespond, eligible:open?undefined:event.eligible,votes:open?undefined:event.votes,ownVote:event.votes[viewer]??null};
}

export function governmentState(world,viewer,now = world.now) {
  const book = ensureGovernment(world,now);
  const state = has(book.kingdoms,viewer)?book.kingdoms[viewer]:null;
  const project = ({taxRemainder,civic,...kingdom})=>kingdom;
  const conflicts = Object.values(book.conflicts).sort((left,right)=>right.createdAt-left.createdAt).slice(0,45)
    .map(record=>conflictView(world,record,viewer,now));
  const crises = Object.values(book.crises).sort((left,right)=>right.createdAt-left.createdAt)
    .map(event=>crisisView(event,viewer)).filter(Boolean).slice(0,45);
  return {kingdom:state ? {...project(state),civic:state.civic,production:governmentProductionMultiplier(world,viewer,now),
    morale:governmentMorale(world,viewer,now),cooldowns:book.cooldowns[viewer]??{}}:null,
    kingdoms:Object.values(book.kingdoms).map(project),conflicts,crises,history:book.history,
    requests:viewer ? book.requests.filter(item=>[item.from,item.to].includes(viewer)).slice(-24).reverse():[],
    rules:{...limits,taxes,stances,conflictKinds,events:eventRules,modeCosts,decisionCosts:decisions}};
}

export function readSettledPoliticalConflict(world,id,now=world.now) {
  const conflicts=world.government?.conflicts;
  return conflicts && has(conflicts,id) && terminal(conflicts[id].status) ? conflictView(world,conflicts[id],null,now):null;
}

export function publicGovernmentRecord(world,now = world.now) {
  const state = governmentState(world,null,now);
  return {...state,conflicts:state.conflicts.filter(record=>terminal(record.status)),crises:state.crises.filter(event=>event.status==='resolved')};
}
