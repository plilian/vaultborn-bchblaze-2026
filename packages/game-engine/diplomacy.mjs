import {DAY,HOUR,economy,resources} from '../../config/economy.mjs';
import {protocolHash} from '../chain-observer/vaultborn.mjs';
import {activeProtectorate,activeTreaty,activity,GameError,getCity,has,notify,requireRule,stockCapacity,subtract} from './world.mjs';
import {recordGovernmentEvent} from './government.mjs';

const rules = {
  peace:['protection'], ceasefire:['protection'], 'non-aggression':['protection'],
  'defensive-alliance':['protection','defense','assistance'], 'military-assistance':['assistance'],
  trade:['trade'], 'territory-sharing':['territory-sharing'], reparations:[],
  protectorate:['protection','defense','assistance','tribute'],
  federation:['protection','defense','assistance','trade','federated'],
};
const ratified = new Set(['awaiting-funding','awaiting-settlement','active']);
const drafts = new Set(['proposed','negotiating']);
const treatyCost = {food:16,wood:12};
const historyCap = 240;
const maximumPrincipal = 250_000;
const compensationMinimum = 1_000;
const paymentDeadline = DAY;
const warTerm = 7*DAY;
const councilTime = 12*HOUR;
const txid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const note = value => typeof value === 'string' ? value.trim().slice(0,180) : '';
const rows = world => Object.values(world.diplomacy?.treaties ?? {});
const isActive = (row,now) => row.status === 'active' && Math.min(row.expiresAt,row.cancellationAt ?? Infinity) > now;
const sameParties = (row,a,b) => row.from === a && row.to === b || row.from === b && row.to === a;
const peer = (row,id) => row.from === id ? row.to : row.from;
const holds = (world,id) => (world.territories ?? world.nodes ?? []).find(site => site.id === id);
const state = world => world.diplomacy ??= {version:1,treaties:{},wars:{},councils:{},history:[],cooldowns:{},transactions:{}};

function history(world,kind,details,now) {
  const book = state(world);
  const event = {id:'dh'+(++world.seq),kind,at:now,...details};
  event.eventHash = protocolHash(event);
  book.history.unshift(event);
  book.history.length = Math.min(book.history.length,historyCap);
  return event;
}

function participant(world,id) {
  const city = getCity(world,id);
  requireRule(!city.npc,'diplomacy_npc','Political agreements require player kingdoms.',403);
  return city;
}

function parties(world,a,b) {
  const actor = participant(world,a);
  const target = participant(world,b);
  requireRule(a !== b,'self_target','Choose another kingdom.',400);
  return [actor,target];
}

function treaty(world,id) {
  const records = world.diplomacy?.treaties ?? {};
  requireRule(has(records,id),'treaty_missing','That treaty could not be found.',404);
  return records[id];
}

function partyTo(row,id) {
  requireRule([row.from,row.to].includes(id),'treaty_participant','Only treaty participants can act on this agreement.',403);
}

function cleanCompensation(value,from,to) {
  if (value == null) return null;
  requireRule(isObject(value) && [from,to].includes(value.payerId) && [from,to].includes(value.payeeId) && value.payerId !== value.payeeId,
    'treaty_compensation','Choose different treaty parties as payer and recipient.',400);
  const {payerId,payeeId} = value;
  if (value.kind === 'bch') {
    requireRule(Number.isSafeInteger(value.satoshis) && value.satoshis >= compensationMinimum && value.satoshis <= maximumPrincipal,
      'treaty_compensation','Choose compensation between 1,000 and 250,000 sats.',400);
    return {kind:'bch',payerId,payeeId,satoshis:value.satoshis};
  }
  requireRule(value.kind === 'resources' && isObject(value.resources) && Object.keys(value.resources).length > 0 &&
    Object.entries(value.resources).every(([key,quantity]) => resources.includes(key) && Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 500),
    'treaty_compensation','Choose between 1 and 500 earned units for each compensation resource.',400);
  return {kind:'resources',payerId,payeeId,resources:Object.fromEntries(resources.filter(key=>has(value.resources,key)).map(key=>[key,value.resources[key]]))};
}

function cleanTerms(world,kind,from,to,value,previous = {}) {
  requireRule(has(rules,kind) && isObject(value),'invalid_treaty','Choose a treaty type and valid terms.',400);
  const hours = value.hours ?? previous.hours ?? 48;
  requireRule(Number.isSafeInteger(hours) && hours >= 1 && hours <= 720,'treaty_duration','Choose a term from 1 to 720 hours.',400);
  requireRule(kind !== 'protectorate' || hours*HOUR <= economy.protectorateTerm,'treaty_duration',
    `A protectorate can last at most ${economy.protectorateTerm/HOUR} hours.`,400);
  const territories = value.territoryIds ?? previous.territoryIds ?? [];
  requireRule(Array.isArray(territories) && territories.length <= 5 && new Set(territories).size === territories.length &&
    territories.every(id => typeof id === 'string' && [from,to].includes(holds(world,id)?.owner)),
    'treaty_territories','Choose up to five distinct holdings controlled by the signatories.',400);
  requireRule(kind === 'territory-sharing' ? territories.length > 0 : territories.length === 0,
    'treaty_territories','A territory-sharing agreement requires named holdings.',400);
  const compensation = cleanCompensation(has(value,'compensation') ? value.compensation : previous.compensation,from,to);
  requireRule(kind !== 'reparations' || compensation,'treaty_compensation','Reparations require compensation terms.',400);
  return {hours,note:note(value.note ?? previous.note),territoryIds:[...territories].sort(),permissions:[...rules[kind]],
    cancellation:'mutual-or-six-hour-notice',breach:'termination-and-political-penalty',
    ...(kind === 'protectorate' && {tribute:economy.protectorateTribute}),...(compensation && {compensation})};
}

function termsHash(row,terms,version) {
  return protocolHash({kind:row.kind,participants:[row.from,row.to],terms,version});
}

function offer(row,actor,kind,terms,now) {
  const version = Math.max(row.version ?? 0,row.proposal?.version ?? 0,row.lastVersion ?? 0)+1;
  row.lastVersion = version;
  row.proposal = {by:actor,kind,terms,termsHash:termsHash(row,terms,version),version,respondBy:now+DAY};
}

function relationStatus(world,row,now) {
  if (row.terms.territoryIds.some(id=>![row.from,row.to].includes(holds(world,id)?.owner))) return false;
  if (row.governanceId) return world.governance.some(pact=>pact.id === row.governanceId && pact.status === 'active' && pact.endsAt > now);
  return true;
}

function failureOfAgreement(world,row,now) {
  if (row.governanceId) {
    const pact = world.governance.find(item=>item.id === row.governanceId);
    if (pact?.status !== 'active') return {at:pact?.endedAt ?? now,status:'cancelled',actor:row.from};
  }
  const failures = row.terms.territoryIds.flatMap(id=>{
    const site = holds(world,id);
    if ([row.from,row.to].includes(site?.owner)) return [];
    const change = site?.history?.findLast(item=>item.previousOwner && item.at >= row.startedAt);
    const actor = [row.from,row.to].includes(change?.previousOwner) ? change.previousOwner : row.territorySponsors[id];
    return [{at:change?.at ?? now,status:'breached',actor:actor ?? row.from}];
  });
  return failures.sort((a,b)=>a.at-b.at)[0];
}

export function diplomacyRelationship(world,a,b,now = world.now) {
  const answer = {blocksAttack:false,defense:false,assistance:false,trade:false,territorySharing:false,federated:false,war:false,territoryIds:[]};
  for (const row of rows(world)) {
    if (!sameParties(row,a,b) || !isActive(row,now) || !relationStatus(world,row,now)) continue;
    const {permissions,territoryIds} = row.terms;
    answer.blocksAttack ||= permissions.includes('protection');
    answer.defense ||= permissions.includes('defense');
    answer.assistance ||= permissions.includes('assistance');
    answer.trade ||= permissions.includes('trade');
    answer.territorySharing ||= permissions.includes('territory-sharing');
    answer.federated ||= permissions.includes('federated');
    answer.territoryIds = [...new Set([...answer.territoryIds,...territoryIds])];
  }
  answer.war = !answer.blocksAttack && Object.values(world.diplomacy?.wars ?? {}).some(row=>sameParties(row,a,b) && row.status === 'active' && row.expiresAt > now);
  return answer;
}

export function diplomacyTreatyRecord(world,id,now = world.now) {
  const row = has(world.diplomacy?.treaties ?? {},id) ? world.diplomacy.treaties[id] : null;
  if (!row || !row.acceptance) return null;
  let status = row.status;
  if (status === 'active') {
    if (row.cancellationAt <= now && row.cancellationAt <= row.expiresAt) status = 'cancelled';
    else if (row.expiresAt <= now) status = 'expired';
    else if (!relationStatus(world,row,now)) status = row.governanceId ? 'cancelled' : 'breached';
  } else if (status === 'awaiting-funding' && row.acceptance.fundingDueAt <= now) status = 'expired';
  const {from,to,terms,version,termsHash:hash,kind,acceptedAt,expiresAt,escrow,endedAt} = row;
  return structuredClone({id,from,to,participants:[from,to],terms,version,termsHash:hash,kind,status,acceptedAt,expiresAt,endsAt:expiresAt,escrow,endedAt});
}

function assertTerritories(world,row,terms) {
  requireRule(terms.territoryIds.every(id=>[row.from,row.to].includes(holds(world,id)?.owner)),
    'treaty_territories','The signatories must still control each named holding.');
}

function protectoratePlan(world,row,now) {
  if (row.kind !== 'protectorate') return null;
  const [sponsor,defender] = parties(world,row.from,row.to);
  const mine = world.alliances[sponsor.alliance];
  const openPacts = world.governance.filter(pact=>['active','pending'].includes(pact.status) && pact.id !== row.governanceId);
  requireRule(mine?.leader === sponsor.id, 'alliance_leader','An alliance leader must sponsor a protectorate.',403);
  requireRule(sponsor.optIn && defender.optIn && sponsor.shieldUntil <= now && defender.shieldUntil <= now && defender.immunityUntil <= now && sponsor.alliance !== defender.alliance,
    'protectorate_enrollment','Each kingdom must be eligible for protectorate politics.');
  requireRule(!openPacts.some(pact=>pact.defender === defender.id || pact.defender === sponsor.id || pact.overlord === defender.id),
    'protectorate_conflict','Resolve existing protectorate obligations before establishing a new protectorate.');
  requireRule(openPacts.filter(pact=>pact.alliance === sponsor.alliance).length < economy.protectorateSlots,
    'political_slot','The sponsor alliance has used its protectorate slots.');
  return mine.id;
}

function closeWar(world,row,now) {
  for (const war of Object.values(state(world).wars)) {
    if (war.status !== 'active' || !sameParties(war,row.from,row.to)) continue;
    war.status = 'ended';
    war.endedAt = now;
    war.treaty = row.id;
    history(world,'war-ended',{actor:row.from,target:row.to,war:war.id,treaty:row.id},now);
  }
}

function endTreaty(world,row,status,actor,now) {
  if (row.status === status) return row;
  delete row.proposal;
  row.status = status;
  row.endedAt = now;
  const pact = row.governanceId && world.governance.find(item=>item.id === row.governanceId);
  if (pact?.status === 'active') {
    pact.status = status === 'cancelled' ? 'released' : status;
    pact.endedAt = now;
    if (pact.rebellion?.status === 'mustering') pact.rebellion.status = 'cancelled';
    const defender = getCity(world,pact.defender);
    defender.immunityUntil = Math.max(defender.immunityUntil,now+economy.rebellionImmunity);
  }
  const target = peer(row,actor);
  if (status === 'breached') recordGovernmentEvent(world,'treaty-breach',{actor,target,id:row.id},now);
  notify(world,row.from,`The ${row.kind} agreement is ${status}.`,now,'diplomacy');
  notify(world,row.to,`The ${row.kind} agreement is ${status}.`,now,'diplomacy');
  history(world,'treaty-'+status,{actor,target,treaty:row.id,category:row.kind,termsHash:row.termsHash},now);
  return row;
}

function activate(world,row,now,{alliance,amendment = false} = {}) {
  row.status = 'active';
  row.startedAt = now;
  row.expiresAt = now+row.terms.hours*HOUR;
  if (row.kind === 'protectorate') {
    const current = world.governance.find(pact=>pact.id === row.governanceId);
    if (current) current.endsAt = row.expiresAt;
    else {
      row.governanceId = 'pact'+(++world.seq);
      world.governance.unshift({id:row.governanceId,defender:row.to,overlord:row.from,alliance,status:'active',createdAt:row.createdAt,
        startedAt:now,endsAt:row.expiresAt,tribute:row.terms.tribute,rebellion:null,upkeepAt:now+6*HOUR,diplomaticTreaty:row.id});
    }
  }
  if (row.kind === 'peace') closeWar(world,row,now);
  if (!amendment) {
    const book = state(world);
    const pair = [row.from,row.to].sort().join(':');
    const badge = 'relations:'+pair;
    if ((book.cooldowns[badge] ?? 0) <= now) {
      recordGovernmentEvent(world,'treaty',{actor:row.from,target:row.to,id:row.id},now);
      book.cooldowns[badge] = now+DAY;
    }
  }
  const message = `The ${row.kind} agreement ${amendment ? 'has been amended' : 'is active'}.`;
  notify(world,row.from,message,now,'diplomacy');
  notify(world,row.to,message,now,'diplomacy');
  activity(world,'diplomacy',`${getCity(world,row.from).name} and ${getCity(world,row.to).name}: ${message}`,now,{treaty:row.id,kind:row.kind});
  history(world,amendment ? 'treaty-amended' : 'treaty-active',{actor:row.from,target:row.to,treaty:row.id,category:row.kind,termsHash:row.termsHash},now);
  return row;
}

function proposeTreaty(world,actorId,input,now,budget,autonomousNpc = false) {
  const [actor,target] = autonomousNpc ? [getCity(world,actorId),getCity(world,input.target)] : parties(world,actorId,input.target);
  const terms = cleanTerms(world,input.kind,actor.id,target.id,input.terms ?? {});
  const book = state(world);
  const known = rows(world).filter(row=>sameParties(row,actor.id,target.id));
  requireRule(!known.some(row=>row.kind === input.kind && (isActive(row,now) || ratified.has(row.status) || drafts.has(row.status))),
    'treaty_duplicate','You already have an open agreement of this kind with that kingdom.');
  requireRule(rows(world).filter(row=>row.proposal?.by === actor.id && row.proposal.respondBy > now).length < 6,
    'treaty_limit','Resolve an open proposal first.');
  const cooldown = ['proposal',actor.id,target.id,input.kind].join(':');
  requireRule((book.cooldowns[cooldown] ?? 0) <= now,'treaty_cooldown','Wait before making another offer of this kind to this kingdom.');
  const row = {from:actor.id,to:target.id,kind:input.kind,createdAt:now,status:'proposed'};
  protectoratePlan(world,row,now);
  subtract(budget ?? actor,treatyCost);
  row.id = 'dt'+(++world.seq);
  offer(row,actor.id,'offer',terms,now);
  book.treaties[row.id] = row;
  const influence = world.government?.kingdoms[actor.id]?.influence ?? 30;
  const cooldownHours = influence >= 60 ? 5 : influence <= 20 ? 7 : 6;
  book.cooldowns[cooldown] = now+cooldownHours*HOUR;
  notify(world,target.id,`${actor.name} proposed a ${row.kind} agreement.`,now,'diplomacy');
  return row;
}

export function reconcileNpcBorder(world,actor,target,now) {
  requireRule(actor.npc && target.npc && actor.id!==target.id,'diplomacy_npc','Only NPC kingdoms may agree to an autonomous armistice.',403);
  return npcCeasefire(world,actor,target,true,now);
}

export function npcCeasefire(world,actor,target,accept,now) {
  requireRule(target.npc && actor.id!==target.id,'diplomacy_npc','Only an NPC kingdom may receive this envoy.',403);
  const row = proposeTreaty(world,actor.id,{ target:target.id, kind:'ceasefire',
    terms:{ hours:12, note:'Both frontier hosts agreed to withdraw and recover their forces.' } },now,undefined,true);
  const {termsHash,version} = row.proposal;
  return respondTreaty(world,target.id,{ id:row.id,accept,termsHash,version },now);
}

export const npcEnvoyCost = Object.freeze({...treatyCost});

function amendTreaty(world,actorId,input,now) {
  const row = treaty(world,input.id);
  partyTo(row,actorId);
  const active = isActive(row,now);
  requireRule((active && !row.cancellationAt || drafts.has(row.status)) && (!row.proposal || row.proposal.respondBy > now),
    'treaty_closed','This agreement cannot be amended.');
  requireRule(!row.proposal || row.proposal.kind !== 'cancel' && row.proposal.by !== actorId,
    'treaty_turn','The other kingdom must respond to the current offer.');
  const previous = row.proposal?.terms ?? row.terms;
  const terms = cleanTerms(world,row.kind,row.from,row.to,input.terms,previous);
  requireRule(JSON.stringify(terms) !== JSON.stringify(previous),'treaty_unchanged','Change a term before offering an amendment.');
  requireRule(!active || JSON.stringify(terms.compensation) === JSON.stringify(row.terms.compensation),
    'treaty_compensation','A ratified compensation obligation requires a new agreement to change.');
  subtract(participant(world,actorId),treatyCost);
  offer(row,actorId,'amend',terms,now);
  if (!active) row.status = 'negotiating';
  notify(world,peer(row,actorId),'Your treaty counterparty proposed revised terms.',now,'diplomacy');
  return row;
}

function compensateResources(world,compensation) {
  const {payerId,payeeId,resources:goods} = compensation;
  const payer = participant(world,payerId);
  const payee = participant(world,payeeId);
  const capacity = stockCapacity(payee);
  requireRule(Object.entries(goods).every(([resource,value])=>capacity[resource]-payee.resources[resource] >= value),
    'treaty_warehouse','The recipient needs warehouse space for the full compensation.');
  subtract(payer,goods);
  for (const [resource,value] of Object.entries(goods)) payee.resources[resource] += value;
}

function respondTreaty(world,actorId,input,now) {
  const row = treaty(world,input.id);
  partyTo(row,actorId);
  const proposal = row.proposal;
  requireRule(proposal?.respondBy > now && (drafts.has(row.status) || isActive(row,now)),'treaty_closed','This treaty offer is closed.');
  requireRule(proposal.by !== actorId,'treaty_turn','Only the other party may accept or reject these terms.',403);
  requireRule(typeof input.accept === 'boolean','treaty_response','Choose to accept or reject the offer.',400);
  requireRule(input.termsHash === proposal.termsHash && input.version === proposal.version,'treaty_stale','Review and respond to the latest treaty terms.');
  if (proposal.kind === 'cancel') {
    if (input.accept) return endTreaty(world,row,'cancelled',actorId,now);
    delete row.proposal;
    return row;
  }
  const amendment = isActive(row,now);
  if (!input.accept) {
    if (!amendment) return endTreaty(world,row,'rejected',actorId,now);
    delete row.proposal;
    return row;
  }
  const {terms,termsHash:hash,version} = proposal;
  assertTerritories(world,row,terms);
  const alliance = protectoratePlan(world,row,now);
  const compensation = amendment ? null : terms.compensation;
  if (compensation?.kind === 'bch') {
    requireRule(row.kind !== 'protectorate' && row.kind !== 'territory-sharing','treaty_compensation',
      'Use a separate BCH reparations agreement when permissions depend on changing holdings or alliance membership.');
  }
  if (compensation?.kind === 'resources') compensateResources(world,compensation);
  Object.assign(row,{terms,termsHash:hash,version,acceptedAt:now,acceptance:{termsHash:hash,version,actor:actorId,at:now}});
  row.territorySponsors = Object.fromEntries(terms.territoryIds.map(id=>[id,holds(world,id).owner]));
  delete row.proposal;
  if (compensation?.kind === 'bch') {
    const {payerId,payeeId,satoshis} = compensation;
    const fundingDueAt = now+paymentDeadline;
    Object.assign(row.acceptance,{payerId,payeeId,satoshis,fundingDueAt});
    row.status = 'awaiting-funding';
    history(world,'treaty-awaiting-funding',{actor:actorId,target:peer(row,actorId),treaty:row.id,category:row.kind,termsHash:hash},now);
    notify(world,payerId,'Ratified treaty compensation is ready for your wallet authorization.',now,'diplomacy');
    return row;
  }
  if (compensation?.kind === 'resources') recordGovernmentEvent(world,'reparations',{actor:compensation.payerId,target:compensation.payeeId,id:row.id},now);
  return activate(world,row,now,{alliance,amendment});
}

function cancelTreaty(world,actorId,input,now) {
  const row = treaty(world,input.id);
  partyTo(row,actorId);
  if (drafts.has(row.status)) {
    requireRule(row.proposal.by === actorId,'treaty_turn','Only the proposer can withdraw this offer.',403);
    return endTreaty(world,row,'cancelled',actorId,now);
  }
  if (row.status === 'awaiting-funding') return endTreaty(world,row,'cancelled',actorId,now);
  requireRule(isActive(row,now) && !row.cancellationAt,'treaty_closed','This agreement cannot receive a cancellation notice.');
  row.cancelledBy = actorId;
  row.cancellationAt = now+6*HOUR;
  offer(row,actorId,'cancel',row.terms,now);
  notify(world,peer(row,actorId),'Your agreement will end after the six-hour notice unless you approve an earlier cancellation.',now,'diplomacy');
  return row;
}

export function quoteDiplomaticEscrow(world,actorId,{treatyId},now = world.now) {
  const row = treaty(world,treatyId);
  const terms = row.acceptance;
  requireRule(row.status === 'awaiting-funding' && terms?.fundingDueAt > now,'treaty_funding_closed','This treaty cannot receive new escrow funding.');
  requireRule(terms.payerId === actorId,'treaty_payer','Only the agreed payer can authorize this compensation.',403);
  const {termsHash,payerId,payeeId,satoshis} = terms;
  return {treatyId,termsHash,payerId,payeeId,satoshis};
}

function matchPayment(row,fields) {
  const acceptance = row.acceptance;
  requireRule(acceptance && ['termsHash','payerId','payeeId','satoshis'].every(key=>acceptance[key] === fields[key]) && txid(fields.txid),
    'treaty_payment','The confirmed payment differs from the accepted compensation.',400);
}

export function recordTreatyFunding(world,fields,now = world.now) {
  const row = treaty(world,fields.treatyId);
  if (row.escrow?.fundingTxid === fields.txid && ['termsHash','payerId','payeeId','satoshis'].every(key=>row.escrow[key] === fields[key])) return row;
  matchPayment(row,fields);
  quoteDiplomaticEscrow(world,fields.payerId,fields,now);
  const book = state(world);
  requireRule(!has(book.transactions,fields.txid),'treaty_payment_replay','This transaction already belongs to a treaty.');
  book.transactions[fields.txid] = row.id;
  const {payerId,payeeId,satoshis,termsHash} = row.acceptance;
  row.escrow = {status:'funded',payerId,payeeId,satoshis,termsHash,fundingTxid:fields.txid,fundedAt:now};
  row.status = 'awaiting-settlement';
  history(world,'treaty-funded',{actor:payerId,target:payeeId,treaty:row.id,category:row.kind,termsHash,txid:fields.txid},now);
  return row;
}

function settleTreaty(world,fields,status,now) {
  const row = treaty(world,fields.treatyId);
  const escrow = row.escrow;
  requireRule(escrow && fields.fundingTxid === escrow.fundingTxid && txid(fields.txid) &&
    ['termsHash','payerId','payeeId','satoshis'].every(key=>escrow[key] === fields[key]),
    'treaty_payment','The settlement must spend the agreed treaty escrow.',400);
  if (escrow?.settlementTxid === fields.txid && escrow.status === status) return row;
  matchPayment(row,fields);
  const book = state(world);
  requireRule(row.status === 'awaiting-settlement' && !has(book.transactions,fields.txid),
    'treaty_payment_replay','This settlement is closed or its transaction has already been recorded.');
  const {payerId,payeeId,termsHash} = escrow;
  book.transactions[fields.txid] = row.id;
  Object.assign(escrow,{status,settlementTxid:fields.txid,settledAt:now});
  history(world,'treaty-'+status,{actor:payerId,target:payeeId,treaty:row.id,category:row.kind,termsHash,txid:fields.txid},now);
  if (status === 'refunded') return endTreaty(world,row,'cancelled',payerId,now);
  recordGovernmentEvent(world,'reparations',{actor:payerId,target:payeeId,id:row.id},now);
  return activate(world,row,now);
}

export const confirmTreatyCompensation = (world,fields,now = world.now) => settleTreaty(world,fields,'settled',now);
export const refundTreatyFunding = (world,fields,now = world.now) => settleTreaty(world,fields,'refunded',now);

const warCost = {food:65,iron:40};

function declareWar(world,actorId,input,now,budget) {
  const [actor,target] = parties(world,actorId,input.target);
  requireRule(actor.optIn && target.optIn && actor.shieldUntil <= now && target.shieldUntil <= now,
    'diplomacy_enrollment','Both kingdoms must be enrolled and outside starter protection.');
  requireRule(!(actor.alliance && actor.alliance === target.alliance) &&
    !activeProtectorate(world,actorId) && !activeProtectorate(world,target.id),
    'diplomacy_protection','Alliance and protectorate obligations prevent this war.');
  const relationship = diplomacyRelationship(world,actorId,target.id,now);
  requireRule(!relationship.blocksAttack && !relationship.war && !activeTreaty(world,actor,target,['nonaggression','defense','ceasefire']),
    'diplomacy_protection','An active treaty or war prevents this declaration.');
  const book = state(world);
  const cooldown = 'war:'+actorId;
  requireRule((book.cooldowns[cooldown] ?? 0) <= now,'diplomacy_cooldown','Wait before issuing another war declaration.');
  subtract(budget ?? actor,warCost);
  const row = {id:'war'+(++world.seq),from:actorId,to:target.id,status:'active',declaredAt:now,expiresAt:now+warTerm,note:note(input.note)};
  book.wars[row.id] = row;
  book.cooldowns[cooldown] = now+DAY;
  recordGovernmentEvent(world,'war',{actor:actorId,target:target.id,id:row.id},now);
  activity(world,'war',`${actor.name} declared war on ${target.name}.`,now,{war:row.id});
  history(world,'war-declared',{actor:actorId,target:target.id,war:row.id},now);
  return row;
}

const councilKinds = new Set(['election','war','alliance','peace','sanction','spend','policy','appoint']);
const councilPolicies = {balanced:{maximum:300},reserve:{maximum:100},investment:{maximum:500}};
const councilRoles = new Set(['diplomat','quartermaster','member']);

function councilContext(world,actorId,councilId,now) {
  const actor = participant(world,actorId);
  const id = councilId ?? actor.alliance;
  if (typeof id !== 'string' || !/^[a-z0-9_-]+$/i.test(id)) return null;
  const alliance = has(world.alliances,id) && world.alliances[id];
  if (alliance && actor.alliance === id) {
    const members = Object.values(world.cities).filter(city=>!city.npc && city.alliance === id).map(city=>city.id).sort();
    return {id,name:alliance.name,alliance,leader:alliance.leader,members};
  }
  const charter = has(world.diplomacy?.treaties ?? {},id) && world.diplomacy.treaties[id];
  if (charter?.kind === 'federation' && isActive(charter,now) && [charter.from,charter.to].includes(actorId)) {
    return {id,name:`${getCity(world,charter.from).name}–${getCity(world,charter.to).name} Federation`,
      charter,leader:world.diplomacy.councils[id]?.leader ?? charter.from,members:[charter.from,charter.to].sort()};
  }
  return null;
}

function councilBook(world,id) {
  const book = state(world);
  return book.councils[id] ??= {id,leader:null,roles:{},proposals:{},treasury:Object.fromEntries(resources.map(key=>[key,0])),policy:'balanced',nextElectionAt:0};
}

function requireCouncil(world,actorId,id,now) {
  const context = councilContext(world,actorId,id,now);
  requireRule(context,'council_membership','Join the alliance or federation to use its council.',403);
  return context;
}

function councilMotion(world,context,book,input,now) {
  const payload = {target:input.target,note:note(input.note)};
  if (['election','appoint','spend'].includes(input.kind)) {
    requireRule(context.members.includes(input.target),'council_candidate','Choose an eligible council member.',400);
  } else if (input.kind !== 'policy') {
    participant(world,input.target);
    requireRule(!context.members.includes(input.target),'council_external','Choose a kingdom outside this council.',400);
  }
  if (input.kind === 'election') requireRule(book.nextElectionAt <= now,'council_election_cooldown','Wait until the current leadership election cooldown ends.');
  if (input.kind === 'spend') {
    requireRule(resources.includes(input.resource) && Number.isSafeInteger(input.amount) && input.amount > 0 && input.amount <= councilPolicies[book.policy].maximum,
      'council_spending','Choose an earned resource and a quantity within the current spending policy.',400);
    requireRule(book.treasury[input.resource] >= input.amount,'council_treasury','The shared treasury lacks these contributions.');
    Object.assign(payload,{resource:input.resource,amount:input.amount});
  }
  if (input.kind === 'sanction') Object.assign(payload,{kind:input.measure ?? 'embargo',hours:input.hours ?? 24,resource:input.resource ?? 'food',territory:input.territory});
  if (input.kind === 'policy') {
    requireRule(has(councilPolicies,input.policy) && input.policy !== book.policy,'council_policy','Choose a different treasury policy.',400);
    payload.policy = input.policy;
  }
  if (input.kind === 'appoint') {
    requireRule(councilRoles.has(input.role) && input.target !== context.leader,'council_role','Choose a non-leader and an eligible council role.',400);
    payload.role = input.role;
  }
  return payload;
}

function proposeMotion(world,actorId,input,now) {
  const context = requireCouncil(world,actorId,input.councilId,now);
  const book = councilBook(world,context.id);
  requireRule(councilKinds.has(input.kind),'council_motion','Choose an available council motion.',400);
  const open = Object.values(book.proposals).filter(row=>row.status === 'open' && row.deadline > now);
  const mine = open.filter(row=>row.proposerId === actorId);
  const role = book.roles[actorId];
  const extra = role === 'diplomat' && ['alliance','peace','sanction'].includes(input.kind) || role === 'quartermaster' && ['spend','policy'].includes(input.kind);
  requireRule(open.length < 6 && mine.length < (extra ? 2 : 1) && !open.some(row=>input.kind === 'election' && row.kind === 'election'),
    'council_motion_limit','Resolve the current proposal or election first.');
  const payload = councilMotion(world,context,book,input,now);
  const cost = input.kind === 'war' ? warCost : ['peace','alliance'].includes(input.kind) ? treatyCost : null;
  requireRule(!cost || Object.entries(cost).every(([key,amount])=>book.treasury[key] >= amount),
    'council_treasury','Contribute the earned resources that this foreign motion requires.');
  const eligible = [...context.members];
  const quorum = Math.max(1,Math.ceil(eligible.length*2/3));
  const threshold = Math.max(1,Math.floor(eligible.length/2)+1);
  subtract(participant(world,actorId),{food:12,wood:8});
  const row = {id:'motion'+(++world.seq),councilId:context.id,kind:input.kind,proposerId:actorId,eligible,quorum,threshold,
    votes:{},payload,status:'open',createdAt:now,deadline:now+councilTime,note:payload.note};
  book.proposals[row.id] = row;
  return row;
}

function findMotion(world,id) {
  return Object.values(world.diplomacy?.councils ?? {}).find(book=>has(book.proposals,id))?.proposals[id];
}

function castVote(world,actorId,input,now) {
  const row = findMotion(world,input.id);
  requireRule(row && row.status === 'open' && row.deadline > now,'council_closed','That vote is closed.',404);
  requireCouncil(world,actorId,row.councilId,now);
  requireRule(row.eligible.includes(actorId) && !has(row.votes,actorId),'council_ballot','This member cannot cast another ballot on that motion.',403);
  requireRule(['yes','no','abstain'].includes(input.vote),'council_vote','Choose approve, oppose or abstain.',400);
  row.votes[actorId] = input.vote;
  return row;
}

function contribute(world,actorId,input,now) {
  const context = requireCouncil(world,actorId,input.councilId,now);
  const book = councilBook(world,context.id);
  const {resource,amount} = input;
  requireRule(resources.includes(resource) && Number.isSafeInteger(amount) && amount > 0 && amount <= 500,
    'council_contribution','Contribute between 1 and 500 earned resource units.',400);
  requireRule(book.treasury[resource]+amount <= 5_000,'council_treasury','This shared resource reserve is full.');
  subtract(participant(world,actorId),{[resource]:amount});
  book.treasury[resource] += amount;
  history(world,'council-contribution',{actor:actorId,council:context.id,resource,amount},now);
  return {resource,amount,balance:book.treasury[resource]};
}

function executeMotion(world,context,book,row,now,politicalTradeCommand) {
  const {kind,payload} = row;
  const leader = context.leader;
  const budget = {resources:book.treasury};
  switch (kind) {
    case 'election': {
      requireRule(context.members.includes(payload.target),'council_candidate','The candidate left the council.');
      if (context.alliance) context.alliance.leader = payload.target;
      else book.leader = payload.target;
      if (has(book.roles,payload.target)) delete book.roles[payload.target];
      book.nextElectionAt = now+7*DAY;
      return payload.target;
    }
    case 'appoint': {
      requireRule(context.members.includes(payload.target) && payload.target !== leader,'council_role','The appointee is unavailable.');
      book.roles[payload.target] = payload.role;
      return payload.role;
    }
    case 'war':
      return declareWar(world,leader,payload,now,budget).id;
    case 'alliance':
    case 'peace':
      return proposeTreaty(world,leader,{target:payload.target,kind:kind === 'alliance' ? 'defensive-alliance' : 'peace',terms:{note:payload.note}},now,budget).id;
    case 'sanction': {
      const result = politicalTradeCommand?.(world,leader,{type:'diplomacy-sanction-impose',...payload},now,{budget});
      requireRule(result,'council_sanction','The economic authority could not issue this measure.');
      return result.id;
    }
    case 'policy':
      book.policy = payload.policy;
      return book.policy;
    case 'spend': {
      const {target,resource,amount} = payload;
      requireRule(context.members.includes(target),'council_treasury','The recipient left the council.');
      const city = participant(world,target);
      requireRule(book.treasury[resource] >= amount && amount <= councilPolicies[book.policy].maximum && stockCapacity(city)[resource]-city.resources[resource] >= amount,
        'council_treasury','The council reserve, spending policy, or recipient warehouse cannot cover this transfer.');
      book.treasury[resource] -= amount;
      city.resources[resource] += amount;
      return amount;
    }
    default:
      return null;
  }
}

function resolveMotion(world,book,row,now,politicalTradeCommand) {
  if (row.status !== 'open') return;
  const context = row.eligible.filter(id=>has(world.cities,id)).map(id=>councilContext(world,id,book.id,now)).find(Boolean);
  const validVotes = Object.entries(row.votes).filter(([id])=>context?.members.includes(id) && row.eligible.includes(id));
  const yes = validVotes.filter(([,vote])=>vote === 'yes').length;
  row.closedAt = now;
  row.result = {yes,turnout:validVotes.length};
  row.status = 'rejected';
  if (context && validVotes.length >= row.quorum && yes >= row.threshold) {
    try {
      row.result.effect = executeMotion(world,context,book,row,now,politicalTradeCommand);
      row.status = 'passed';
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
      row.status = 'failed';
      row.result.reason = error.message;
    }
  }
  history(world,'council-'+row.kind,{actor:row.proposerId,target:row.payload.target,council:book.id,proposal:row.id,outcome:row.status,
    turnout:row.result.turnout,yes:row.result.yes,quorum:row.quorum,threshold:row.threshold},now);
}

const commands = {
  'diplomacy-treaty-propose':proposeTreaty,'diplomacy-treaty-amend':amendTreaty,'diplomacy-treaty-respond':respondTreaty,
  'diplomacy-treaty-cancel':cancelTreaty,'diplomacy-war-declare':declareWar,
  'diplomacy-council-propose':proposeMotion,'diplomacy-council-vote':castVote,'diplomacy-council-contribute':contribute,
};

export function diplomacyCommand(world,actorId,input,now = world.now) {
  if (!has(commands,input?.type)) return undefined;
  return structuredClone(commands[input.type](world,actorId,input,now));
}

function viewTreaty(world,row,actorId,now) {
  const record = diplomacyTreatyRecord(world,row.id,now);
  if (!actorId || ![row.from,row.to].includes(actorId)) return record;
  if (!record) {
    const proposal = row.proposal;
    return {id:row.id,from:row.from,to:row.to,participants:[row.from,row.to],kind:row.kind,status:row.status,
      terms:proposal?.terms,respondBy:proposal?.respondBy,proposerId:proposal?.by,proposal};
  }
  return {...record,proposal:row.proposal,acceptance:row.acceptance,cancellationAt:row.cancellationAt,cancelledBy:row.cancelledBy};
}

function viewCouncil(world,context) {
  if (!context) return null;
  const book = world.diplomacy?.councils[context.id];
  return {id:context.id,name:context.name,leader:context.leader,policy:book?.policy ?? 'balanced',nextElectionAt:book?.nextElectionAt ?? 0,
    treasury:book?.treasury ?? Object.fromEntries(resources.map(key=>[key,0])),
    members:context.members.map(id=>({id,role:id === context.leader ? 'leader' : book?.roles[id] ?? 'member'})),
    proposals:Object.values(book?.proposals ?? {}).sort((a,b)=>b.createdAt-a.createdAt).slice(0,50)};
}

export function diplomacySnapshot(world,actorId,now = world.now) {
  const actor = has(world.cities,actorId) && !world.cities[actorId].npc ? actorId : null;
  const treaties = rows(world).map(row=>viewTreaty(world,row,actor,now)).filter(Boolean);
  const persistentHistory = world.diplomacy?.history ?? [];
  const wars = Object.values(world.diplomacy?.wars ?? {}).map(row=>{
    if (row.status !== 'active') return row;
    if (row.expiresAt <= now) return {...row,status:'expired'};
    return diplomacyRelationship(world,row.from,row.to,now).blocksAttack ? {...row,status:'suspended'} : row;
  });
  const federations = treaties.filter(row=>row.kind === 'federation' && row.status === 'active').map(row=>({id:row.id,councilId:row.id,
    name:`${getCity(world,row.from).name}–${getCity(world,row.to).name} Federation`,members:row.participants,status:row.status,
    council: actor ? viewCouncil(world,councilContext(world,actor,row.id,now)) : null}));
  const council = actor ? viewCouncil(world,councilContext(world,actor,undefined,now)) : null;
  return structuredClone({treaties:treaties.sort((a,b)=>(b.acceptedAt ?? b.respondBy ?? 0)-(a.acceptedAt ?? a.respondBy ?? 0)),wars,federations,council,history:persistentHistory});
}

function addTreatyEvents(world,row,now,events) {
  const offer = row.proposal;
  if (offer?.respondBy <= now && (!row.acceptance || isActive(row,offer.respondBy))) {
    events.push({at:offer.respondBy,apply:()=>{
      if (row.proposal !== offer) return;
      if (drafts.has(row.status)) endTreaty(world,row,'expired',offer.by,offer.respondBy);
      else delete row.proposal;
    }});
  }
  const fundingDueAt = row.acceptance?.fundingDueAt;
  if (row.status === 'awaiting-funding' && fundingDueAt <= now) events.push({at:fundingDueAt,apply:()=>{
    if (row.status === 'awaiting-funding') endTreaty(world,row,'expired',row.acceptance.payerId,fundingDueAt);
  }});
  if (row.status !== 'active') return;
  const end = Math.min(row.expiresAt,row.cancellationAt ?? Infinity);
  if (end <= now) events.push({at:end,apply:()=>{
    if (row.status === 'active') endTreaty(world,row,end === row.cancellationAt ? 'cancelled' : 'expired',row.cancelledBy ?? row.from,end);
  }});
  const failure = failureOfAgreement(world,row,now);
  if (failure && failure.at < end) events.push({at:failure.at,apply:()=>{
    if (row.status === 'active' && !relationStatus(world,row,failure.at)) endTreaty(world,row,failure.status,failure.actor,failure.at);
  }});
}

export function nextDiplomacyEvents(world,now,politicalTradeCommand) {
  const book = world.diplomacy;
  if (!book) return [];
  const events = [];
  for (const row of rows(world)) addTreatyEvents(world,row,now,events);
  for (const war of Object.values(book.wars)) {
    if (war.status !== 'active' || war.expiresAt > now) continue;
    events.push({at:war.expiresAt,apply:()=>{
      if (war.status !== 'active') return;
      war.status = 'expired';
      war.endedAt = war.expiresAt;
      history(world,'war-expired',{actor:war.from,target:war.to,war:war.id},war.expiresAt);
    }});
  }
  for (const council of Object.values(book.councils)) {
    for (const row of Object.values(council.proposals)) {
      if (row.status === 'open' && row.deadline <= now) {
        events.push({at:row.deadline,apply:()=>resolveMotion(world,council,row,row.deadline,politicalTradeCommand)});
      }
    }
  }
  return events;
}
