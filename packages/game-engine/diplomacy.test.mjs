import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DAY,HOUR} from '../../config/economy.mjs';
import {protocolHash} from '../chain-observer/vaultborn.mjs';
import {addPlayer,advance,attackEligibility,command,createWorld} from './index.mjs';
import {confirmTreatyCompensation,diplomacyRelationship,diplomacySnapshot,diplomacyTreatyRecord,nextDiplomacyEvents,quoteDiplomaticEscrow,recordTreatyFunding,refundTreatyFunding} from './diplomacy.mjs';

const start = DAY;
const call = (world,actor,action,fields = {}) => command(world,actor,{type:'diplomacy-'+action,...fields});
const offer = (world,actor,target,kind,terms = {hours:24}) => call(world,actor,'treaty-propose',{target,kind,terms});
const answer = (world,actor,{id,proposal},accept = true) => call(world,actor,'treaty-respond',{
  id,accept,termsHash:proposal.termsHash,version:proposal.version,
});

test('private counteroffers reject stale consent, then activate genuine combat protection', () => {
  const world = createWorld(start);
  assert.equal(attackEligibility(world,world.cities.p1,world.cities.p2).ok,true);
  const opening = offer(world,'p1','p2','non-aggression',{hours:2,note:'First terms'});
  assert.equal(diplomacySnapshot(world,null).treaties.length,0);
  assert.equal(diplomacySnapshot(world,'p4').treaties.length,0);
  assert.equal(diplomacySnapshot(world,'p2').treaties[0].proposal.by,'p1');
  assert.throws(()=>answer(world,'p4',opening),{code:'treaty_participant'});
  assert.throws(()=>offer(world,'p2','p1','non-aggression'),{code:'treaty_duplicate'});
  const changed = call(world,'p2','treaty-amend',{id:opening.id,terms:{hours:3,note:'Counteroffer'}});
  assert.throws(()=>answer(world,'p1',{...opening,proposal:{...opening.proposal,by:'p2'}}),{code:'treaty_stale'});
  assert.throws(()=>answer(world,'p2',changed),{code:'treaty_turn'});
  const treaty = answer(world,'p1',changed);
  assert.equal(treaty.status,'active');
  assert.equal(treaty.version,2);
  const row = diplomacyTreatyRecord(world,treaty.id);
  assert.equal(row.termsHash,protocolHash({kind:row.kind,participants:row.participants,terms:row.terms,version:row.version}));
  assert.equal(diplomacyRelationship(world,'p2','p1').blocksAttack,true);
  assert.equal(attackEligibility(world,world.cities.p1,world.cities.p2).code,'friendly');
  assert.throws(()=>call(world,'p2','war-declare',{target:'p1'}),{code:'diplomacy_protection'});
  advance(world,treaty.expiresAt);
  assert.equal(diplomacyRelationship(world,'p1','p2').blocksAttack,false);
  assert.equal(diplomacyTreatyRecord(world,treaty.id).status,'expired');
});

test('peace ends a declared war and independent overlapping protection survives treaty cancellation', () => {
  const world = createWorld(start);
  assert.equal(call(world,'p1','war-declare',{target:'p2'}).status,'active');
  const peace = answer(world,'p2',offer(world,'p1','p2','peace'));
  assert.equal(diplomacySnapshot(world,null).wars[0].status,'ended');
  assert.equal(diplomacyRelationship(world,'p1','p2').war,false);
  const defense = answer(world,'p2',offer(world,'p1','p2','defensive-alliance'));
  const notice = call(world,'p1','treaty-cancel',{id:peace.id});
  assert.equal(notice.status,'active');
  assert.equal(notice.cancellationAt,start+6*HOUR);
  assert.equal(answer(world,'p2',notice).status,'cancelled');
  assert.equal(diplomacyRelationship(world,'p1','p2').defense,true);
  call(world,'p2','treaty-cancel',{id:defense.id});
  advance(world,start+6*HOUR);
  assert.equal(diplomacyTreatyRecord(world,defense.id).status,'cancelled');
  assert.equal(diplomacyRelationship(world,'p1','p2').blocksAttack,false);
});

test('a ceasefire suspends an existing declaration for the exact agreed term', () => {
  const world = createWorld(start);
  call(world,'p1','war-declare',{target:'p2'});
  const truce = answer(world,'p2',offer(world,'p1','p2','ceasefire',{hours:2}));
  assert.equal(diplomacySnapshot(world,'p2').wars[0].status,'suspended');
  assert.equal(diplomacyRelationship(world,'p2','p1').war,false);
  advance(world,truce.expiresAt);
  assert.equal(diplomacySnapshot(world,'p2').wars[0].status,'active');
  assert.equal(diplomacyRelationship(world,'p2','p1').war,true);
});

test('earned compensation conserves resources with ratification, including amendments', () => {
  const world = createWorld(start);
  const proposal = offer(world,'p1','p2','reparations',{hours:24,compensation:{kind:'resources',payerId:'p1',payeeId:'p2',resources:{iron:70}}});
  const payer = world.cities.p1.resources.iron;
  const payee = world.cities.p2.resources.iron;
  const active = answer(world,'p2',proposal);
  assert.equal(world.cities.p1.resources.iron,payer-70);
  assert.equal(world.cities.p2.resources.iron,payee+70);
  assert.throws(()=>answer(world,'p2',proposal),{code:'treaty_closed'});
  const revision = call(world,'p2','treaty-amend',{id:active.id,terms:{hours:48}});
  assert.equal(diplomacyTreatyRecord(world,active.id).terms.hours,24);
  answer(world,'p1',revision);
  assert.equal(diplomacyTreatyRecord(world,active.id).terms.hours,48);
  assert.equal(world.cities.p1.resources.iron,payer-70);
});

test('BCH compensation requires payer consent and matched funding and settlement receipts', () => {
  const world = createWorld(start);
  const terms = {hours:24,compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:2000}};
  const active = answer(world,'p2',offer(world,'p1','p2','peace',terms));
  assert.equal(active.status,'awaiting-funding');
  assert.equal(diplomacyRelationship(world,'p1','p2').blocksAttack,false);
  assert.throws(()=>quoteDiplomaticEscrow(world,'p2',{treatyId:active.id}),{code:'treaty_payer'});
  const quote = quoteDiplomaticEscrow(world,'p1',{treatyId:active.id});
  const funding = {...quote,txid:'a'.repeat(64)};
  const settled = {...quote,fundingTxid:funding.txid,txid:'b'.repeat(64)};
  assert.throws(()=>recordTreatyFunding(world,{...funding,satoshis:2100}),{code:'treaty_payment'});
  assert.equal(recordTreatyFunding(world,funding).status,'awaiting-settlement');
  assert.throws(()=>call(world,'p2','treaty-cancel',{id:active.id}),{code:'treaty_closed'});
  assert.throws(()=>confirmTreatyCompensation(world,{...settled,fundingTxid:'c'.repeat(64)}),{code:'treaty_payment'});
  assert.equal(confirmTreatyCompensation(world,settled).status,'active');
  assert.equal(diplomacyRelationship(world,'p1','p2').blocksAttack,true);
  assert.equal(recordTreatyFunding(world,funding).status,'active');
  assert.equal(confirmTreatyCompensation(world,settled).status,'active');
  assert.throws(()=>refundTreatyFunding(world,settled),{code:'treaty_payment_replay'});
  assert.equal(diplomacyTreatyRecord(world,active.id).escrow.settlementTxid,settled.txid);
  assert.equal(world.bchTreasury,undefined);
});

test('unfunded terms expire while marked escrow can be refunded exactly once', () => {
  const world = createWorld(start);
  const terms = {hours:24,compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:2000}};
  const funded = answer(world,'p2',offer(world,'p1','p2','peace',terms));
  const expires = answer(world,'p2',offer(world,'p1','p2','reparations',terms));
  const quote = quoteDiplomaticEscrow(world,'p1',{treatyId:funded.id});
  recordTreatyFunding(world,{...quote,txid:'a'.repeat(64)});
  advance(world,start+DAY);
  assert.equal(diplomacyTreatyRecord(world,expires.id).status,'expired');
  assert.equal(diplomacyTreatyRecord(world,funded.id).status,'awaiting-settlement');
  const settlement = {...quote,fundingTxid:'a'.repeat(64),txid:'b'.repeat(64)};
  assert.equal(refundTreatyFunding(world,settlement).status,'cancelled');
  assert.equal(refundTreatyFunding(world,settlement).status,'cancelled');
  assert.equal(diplomacyTreatyRecord(world,funded.id).escrow.status,'refunded');
});

test('territory permissions are specific and a failed territorial obligation records breach once', () => {
  const world = createWorld(start);
  advance(world,start);
  assert.throws(()=>offer(world,'p1','p2','territory-sharing',{hours:24,territoryIds:['mine']}),{code:'treaty_territories'});
  const site = world.territories.find(item=>item.id === 'mine');
  site.owner = 'p2';
  const treaty = answer(world,'p2',offer(world,'p1','p2','territory-sharing',{hours:24,territoryIds:[site.id]}));
  assert.deepEqual(diplomacyRelationship(world,'p1','p2').territoryIds,[site.id]);
  site.owner = 'p3';
  assert.deepEqual(diplomacyRelationship(world,'p1','p2').territoryIds,[]);
  advance(world,start+1);
  assert.equal(diplomacyTreatyRecord(world,treaty.id).status,'breached');
  const events = diplomacySnapshot(world,null).history.filter(event=>event.kind === 'treaty-breached');
  assert.equal(events.length,1);
  assert.equal(events[0].actor,'p2');
});

test('abandoning a shared holding before expiry cannot evade breach accounting by waiting', () => {
  const world = createWorld(start);
  advance(world,start);
  const site = world.territories.find(item=>item.id === 'mine');
  site.owner = 'p2';
  const treaty = answer(world,'p2',offer(world,'p1','p2','territory-sharing',{hours:1,territoryIds:[site.id]}));
  command(world,'p2',{type:'territory-abandon',territory:site.id});
  advance(world,treaty.expiresAt+HOUR);
  assert.equal(diplomacyTreatyRecord(world,treaty.id).status,'breached');
  assert.equal(diplomacyTreatyRecord(world,treaty.id).endedAt,start);
});

test('a voluntary protectorate shares legacy tribute, expiration and rebellion eligibility', () => {
  const world = createWorld(start);
  const offerRow = offer(world,'p1','p2','protectorate',{hours:13});
  const treaty = answer(world,'p2',offerRow);
  const pact = world.governance.find(item=>item.id === treaty.governanceId);
  assert.equal(pact.diplomaticTreaty,treaty.id);
  assert.equal(pact.status,'active');
  assert.equal(pact.tribute,treaty.terms.tribute);
  assert.equal(diplomacyRelationship(world,'p1','p2').defense,true);
  assert.throws(()=>command(world,'p2',{type:'opt-in',enabled:false}),{code:'pact_blocks_opt_out'});
  advance(world,treaty.expiresAt);
  assert.equal(pact.status,'expired');
  assert.equal(diplomacyRelationship(world,'p1','p2').defense,false);
});

test('alliance elections and treasury appropriations enforce current membership, quorum and separate funds', () => {
  const world = createWorld(start);
  const election = call(world,'p1','council-propose',{kind:'election',target:'p3'});
  assert.equal(election.threshold,2);
  call(world,'p1','council-vote',{id:election.id,vote:'yes'});
  assert.throws(()=>call(world,'p1','council-vote',{id:election.id,vote:'yes'}),{code:'council_ballot'});
  assert.throws(()=>call(world,'p2','council-vote',{id:election.id,vote:'yes'}),{code:'council_membership'});
  call(world,'p3','council-vote',{id:election.id,vote:'yes'});
  advance(world,election.deadline);
  assert.equal(world.alliances['emerald-watch'].leader,'p3');
  assert.equal(diplomacySnapshot(world,'p1').council.proposals[0].status,'passed');
  call(world,'p1','council-contribute',{resource:'iron',amount:60});
  const spending = call(world,'p3','council-propose',{kind:'spend',target:'p1',resource:'iron',amount:40});
  call(world,'p3','council-vote',{id:spending.id,vote:'yes'});
  addPlayer(world,{id:'newmember',name:'New Member'},world.now);
  command(world,'newmember',{type:'alliance-join',id:'emerald-watch'});
  assert.throws(()=>call(world,'newmember','council-vote',{id:spending.id,vote:'yes'}),{code:'council_ballot'});
  advance(world,spending.deadline);
  assert.equal(diplomacySnapshot(world,'p3').council.treasury.iron,60);
  assert.equal(diplomacySnapshot(world,'p3').council.proposals[0].status,'rejected');
  assert.equal(diplomacySnapshot(world,null).council,null);
  assert.equal(world.bchTreasury,undefined);
});

test('federation ratification creates a shared council without merging private alliance membership', () => {
  const world = createWorld(start);
  const treaty = answer(world,'p4',offer(world,'p1','p4','federation'));
  const federation = diplomacySnapshot(world,'p4').federations[0];
  assert.deepEqual(federation.members,['p1','p4']);
  assert.equal(federation.councilId,treaty.id);
  assert.equal(world.cities.p4.alliance,null);
  assert.equal(diplomacySnapshot(world,'p1').council.id,'emerald-watch');
  assert.equal(diplomacySnapshot(world,'p2').federations[0].council,null);
  assert.equal(diplomacyRelationship(world,'p4','p1').federated,true);
  const motion = call(world,'p4','council-propose',{councilId:treaty.id,kind:'policy',policy:'investment'});
  call(world,'p4','council-vote',{id:motion.id,vote:'yes'});
  call(world,'p1','council-vote',{id:motion.id,vote:'yes'});
  advance(world,motion.deadline);
  assert.equal(diplomacySnapshot(world,'p4').federations[0].council.policy,'investment');
  assert.equal(diplomacySnapshot(world,'p1').council.policy,'balanced');
});

test('an approved foreign council motion spends the shared border budget', () => {
  const world = createWorld(start);
  const request = {kind:'peace',target:'p2'};
  assert.throws(()=>call(world,'p3','council-propose',request),{code:'council_treasury'});
  call(world,'p3','council-contribute',{resource:'food',amount:16});
  call(world,'p3','council-contribute',{resource:'wood',amount:12});
  const motion = call(world,'p3','council-propose',request);
  call(world,'p1','council-vote',{id:motion.id,vote:'yes'});
  call(world,'p3','council-vote',{id:motion.id,vote:'yes'});
  advance(world,motion.deadline);
  assert.equal(diplomacySnapshot(world,'p1').council.treasury.food,0);
  assert.equal(diplomacySnapshot(world,'p2').treaties[0].proposal.by,'p1');
  assert.equal(diplomacySnapshot(world,'p2').treaties[0].status,'proposed');
});

test('an adopted sanction carries current council authority and the contributed budget', () => {
  const world = createWorld(start);
  call(world,'p3','council-contribute',{resource:'food',amount:80});
  const motion = call(world,'p3','council-propose',{kind:'sanction',target:'p2',measure:'embargo',resource:'wood',hours:8});
  call(world,'p1','council-vote',{id:motion.id,vote:'yes'});
  call(world,'p3','council-vote',{id:motion.id,vote:'yes'});
  const applications = [];
  const sanction = (current,leader,input,at,{budget})=>{
    assert.equal(current,world);
    assert.equal(leader,'p1');
    assert.equal(at,motion.deadline);
    assert.equal(budget.resources.food,80);
    applications.push(input);
    budget.resources.food -= 20;
    return {id:'agreed-embargo'};
  };
  for (const event of nextDiplomacyEvents(world,motion.deadline,sanction)) {
    event.apply();
    event.apply();
  }
  assert.deepEqual(applications,[{type:'diplomacy-sanction-impose',target:'p2',kind:'embargo',resource:'wood',hours:8,note:'',territory:undefined}]);
  const council = diplomacySnapshot(world,'p3').council;
  assert.equal(council.treasury.food,60);
  assert.equal(council.proposals[0].result.effect,'agreed-embargo');
});
