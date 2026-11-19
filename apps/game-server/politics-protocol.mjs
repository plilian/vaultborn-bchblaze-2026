import { gameEvent, protocolHash } from '../../packages/chain-observer/vaultborn.mjs';
import { servicePrice } from '../../config/pricing.mjs';
import { applyPoliticalSupport, quotePoliticalSupport } from '../../packages/game-engine/government.mjs';
import * as diplomacy from '../../packages/game-engine/diplomacy.mjs';
import * as government from '../../packages/game-engine/government.mjs';
import { politicalTradeSnapshot } from '../../packages/game-engine/political-trade.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { ADDRESS_PATTERN, NETWORK_ID } from '../../config/network.mjs';

const HOUR = 3_600_000;
const proofRows = world => world.politicalEvidence ??= [];
const accepted = new Set(['awaiting-funding','awaiting-settlement','active','expired','cancelled','terminated','breached']);
const receipt = ({txid,confirmations,height,blockHash,event,eventVout,explorerUrl,feeSatoshis} = {}) =>
  ({txid,confirmations,height,blockHash,event,eventVout,explorerUrl,feeSatoshis});

export function createPoliticsProtocol({ store, chain, clock, notify, fail, assets }) {
  const treaty = (world,id,now) => typeof id==='string' ? diplomacy.diplomacyTreatyRecord(world,id,now) : null;

  function attestable(world,party,id,now) {
    const row=treaty(world,id,now);
    if (!row || row.status!=='active') fail(409,'Choose an active treaty to record on ' + NETWORK_LABEL + '.');
    const participants=row.participants ?? [row.from,row.to];
    if (!participants.includes(party)) fail(403,'Only a kingdom party to this treaty can attest it.');
    const termsHash=row.termsHash ?? row.acceptance?.termsHash ?? protocolHash({kind:row.kind,participants,terms:row.terms,version:row.version});
    if (proofRows(world).some(record=>record.treaty===id && record.termsHash===termsHash && ['treaty-charter','treaty-compensation'].includes(record.kind))) {
      fail(409,'This version of the treaty already has a recorded charter.');
    }
    return {termsHash,version:row.version ?? 1,record:row};
  }

  function quote(world,player,body,now) {
    if (body.consent!==true) fail(400,'Approve this specific ' + NETWORK_LABEL + ' political action first.');
    const payer=store.walletKey(player);
    if (!payer?.publicKey) fail(403,'Connect your wallet first. This political action is paid and signed by your ' + NETWORK_LABEL + ' wallet.');
    if (body.type==='political-escrow') {
      const terms=diplomacy.quoteDiplomaticEscrow(world,player,{treatyId:body.treaty ?? body.treatyId},now);
      const payee=store.walletKey(terms.payeeId);
      if (!payee?.publicKey || payee.address===payer.address) fail(409,'The compensation recipient needs a different verified ' + NETWORK_LABEL + ' wallet.');
      const action={type:body.type,treaty:terms.treatyId,termsHash:terms.termsHash,payerId:terms.payerId,payeeId:terms.payeeId,satoshis:terms.satoshis};
      return {title:'Treaty compensation escrow',description:'Funds the exact principal plus 650 sats for settlement. Your wallet can independently refund the principal after the on-chain timelock.',
        satoshis:terms.satoshis+650,principal:terms.satoshis,payerKey:payer.publicKey,payeeKey:payee.publicKey,
        refundAt:Math.floor((now+6*HOUR)/1000),event:{treaty:action.treaty,termsHash:action.termsHash},action};
    }
    if (body.operation==='support') return quotePoliticalSupport(world,player,body,now);
    if (body.operation!=='attest') fail(400,'Choose political support or a treaty charter.');
    const record=attestable(world,player,body.treaty,now);
    return {title:'Attest treaty charter',description:'Records the ratified terms and authorizes an immutable ' + NETWORK_LABEL + ' charter. The gameplay fee uses the published four-way split.',
      satoshis:4000,action:{type:body.type,operation:'attest',treaty:body.treaty,termsHash:record.termsHash,version:record.version}};
  }

  function fundingFields(row) {
    const {treaty: treatyId,termsHash,payerId,payeeId,satoshis}=row.payload;
    return {treatyId,termsHash,payerId,payeeId,satoshis,txid:row.txid};
  }

  function fund(world,row,now) {
    const fields=fundingFields(row);
    if (row.late || now >= row.contract.refundAt*1000) return {lane:'operator-refund'};
    try {
      const fresh=diplomacy.quoteDiplomaticEscrow(world,row.playerId,{treatyId:fields.treatyId},now);
      if (fresh.termsHash!==fields.termsHash || fresh.satoshis!==fields.satoshis ||
          fresh.payerId!==fields.payerId || fresh.payeeId!==fields.payeeId) return {lane:'operator-refund'};
      diplomacy.recordTreatyFunding(world,fields,now);
      return {lane:'release'};
    } catch (error) {
      if (!error.code && !error.status) throw error;
      return {lane:'operator-refund'};
    }
  }

  function finish(world,funding,settlement,lane,now) {
    const original=fundingFields(funding);
    const result={...original,fundingTxid:original.txid,txid:settlement.txid};
    if (lane==='release') diplomacy.confirmTreatyCompensation(world,result,now);
    else if (funding.politicalLane==='release') diplomacy.refundTreatyFunding(world,result,now);
    const snapshot=treaty(world,original.treatyId,now);
    const record={id:'pe-'+funding.id,kind:lane==='release'?'treaty-compensation':'treaty-refund',treaty:original.treatyId,
      termsHash:original.termsHash,version:snapshot?.version ?? 1,payer:original.payerId,payee:original.payeeId,
      principal:original.satoshis,contract:funding.contract,funding:receipt(funding.receipt),settlement:receipt(settlement),at:now};
    proofRows(world).push(record);
    store.savePayment({...funding,politicalStatus:lane==='release'?'paid':'refunded',politicalSettlement:settlement.txid});
    return {treaty:original.treatyId,record:record.id,txid:settlement.txid};
  }

  function credit(world,row,now) {
    const funding=store.payment(row.politicalFunding);
    if (!funding || funding.politicalStatus!=='funded') return null;
    return finish(world,funding,row.receipt,row.action==='political-release'?'release':'operator-refund',now);
  }

  function acceptOperation(world,row,now) {
    const action=row.payload;
    if (action.operation==='support') {
      // A payment quoted under a price book was already verified against that book's price, output by output.
      return applyPoliticalSupport(world,row.playerId,action,{id:row.id,txid:row.txid,satoshis:row.satoshis,
        ...(row.event?.data.pricing && {price:servicePrice('political-operation',row.event.data.pricing)})},now);
    }
    const charter=attestable(world,row.playerId,action.treaty,now);
    if (charter.termsHash!==action.termsHash) fail(409,'The charter terms changed while this payment was confirming.');
    proofRows(world).push({id:'po-'+row.id,kind:'treaty-charter',treaty:action.treaty,termsHash:charter.termsHash,
      version:charter.version,holder:row.playerId,terms:charter.record,operation:row.id,at:now});
    return {treaty:action.treaty,record:'po-'+row.id,txid:row.txid};
  }

  function discloseSupport(world,rows,now) {
    const records=proofRows(world);
    const disclosed=new Set(records.map(item=>item.operation));
    for (const row of rows) {
      if (row.action!=='political-operation' || row.payload?.operation!=='support' || row.state!=='credited' || row.fulfillment?.status!=='applied' ||
          disclosed.has(row.id)) continue;
      const conflict=government.readSettledPoliticalConflict(world,row.payload.conflict,now);
      if (!conflict) continue;
      records.push({id:'po-'+row.id,kind:'conflict-support',conflict:conflict.id,result:conflict,operation:row.id,at:now});
    }
  }

  let maturedCursor=0;
  async function reconcile({settle=true}={}) {
    const now=clock();
    // Reading a payer's own confirmed refund needs no signer. It runs before the signing guard and rotates through every matured escrow.
    const waiting=store.payments().filter(row=>row.action==='political-escrow' && row.state==='credited' &&
      row.politicalStatus==='funded' && now>=row.contract.refundAt*1000).reverse();
    const first=waiting.length ? maturedCursor%waiting.length : 0;
    const matured=Array.from({length:Math.min(8,waiting.length)},(_,offset)=>waiting[(first+offset)%waiting.length]);
    maturedCursor=waiting.length ? (first+matured.length)%waiting.length : 0;
    for (const pending of matured) {
      const external=await chain.politicalSpend(pending).catch(()=>null);
      if (external && !store.byTxid(external.txid)) {
        store.transaction(()=>{
          const current=store.payment(pending.id);
          if (current?.politicalStatus!=='funded') return;
          const {world}=store.read();
          finish(world,current,external,external.lane,now);
          for (const outgoing of store.payments().filter(row=>row.politicalFunding===current.id && row.state!=='credited')) {
            store.savePayment({...outgoing,state:'rejected',lastError:'A different settlement already spent this escrow on ' + NETWORK_LABEL + '.'});
          }
          store.write(world);
        });
        notify();
      }
    }
    if (!chain.payoutsEnabled || !settle) return;
    const payment=store.transaction(()=>{
      const rows=store.payments();
      const {world}=store.read();
      const before=proofRows(world).length;
      discloseSupport(world,rows,now);
      if (proofRows(world).length!==before) store.write(world);
      const funding=rows.find(row=>row.action==='political-escrow' && row.state==='credited' && row.politicalStatus==='funded' &&
        !rows.some(candidate=>candidate.politicalFunding===row.id));
      if (funding) {
        const lane=funding.politicalLane;
        const event=gameEvent(lane==='release'?'political-release':'political-refund','pe-'+funding.id,
          {treaty:funding.payload.treaty,termsHash:funding.payload.termsHash,entryTxid:funding.txid,principal:funding.contract.principal});
        const plan={...chain.signPoliticalSettlement({row:funding,lane,event,now}),politicalFunding:funding.id,
          title:lane==='release'?'Treaty compensation release':'Treaty principal refund'};
        store.savePayment(plan);
        return plan;
      }
      const record=proofRows(world).find(item=>item.operation && !rows.some(row=>row.politicalAnchor===item.id));
      if (!record) return null;
      const incoming=store.payment(record.operation);
      if (incoming?.state!=='credited') return null;
      const event=gameEvent('political-outcome',record.id,{recordHash:protocolHash(record),entryTxid:incoming.txid});
      // The payer locked the fee of this record in an output that can be spent as that fee and nothing else. Payments from
      // before that output existed funded the record from an operator-held development output.
      const reserve=incoming.receipt.allocations.find(output=>output.role==='record');
      let signed;
      if (reserve && chain.signPoliticalRecord) {
        signed={...chain.signPoliticalRecord({source:reserve,event,payload:{record:record.id},now}),title:'Political outcome commitment',
          description:'The public proof record of this operation. Its network fee is the reserve the payer locked for it; no other money moved.',politicalAnchor:record.id};
      } else {
        const source=incoming.receipt.allocations.find(output=>output.role==='development' && output.custody!=='external');
        if (!source) return null;
        const plan=chain.preparePayout({playerId:'council',action:'political-outcome',payload:{record:record.id},sources:[source],event,retain:true,now});
        signed={...plan,...chain.signPayout(plan),state:'submitted',title:'Political outcome commitment',
          retainedPool:'development',politicalAnchor:record.id};
      }
      store.savePayment(signed);
      return signed;
    });
    if (payment) {
      await chain.broadcast(payment.rawHex).catch(()=>undefined);
      notify();
    }
    await reconcileAssets();
  }

  async function reconcileAssets() {
    if (!assets?.signingEnabled) return;
    const {world}=store.read();
    const rows=store.payments();
    const before=assets.list().map(item=>item.id+':'+item.state).join('|');
    for (const record of proofRows(world)) {
      if (!['treaty-compensation','treaty-charter'].includes(record.kind) || store.portal('political-asset-queue',record.id)) continue;
      const settled=record.operation ? rows.find(row=>row.politicalAnchor===record.id && row.state==='credited')?.receipt : record.settlement;
      if (!settled?.txid || rows.some(row=>row.txid===settled.txid && row.state==='reorg')) continue;
      const controller=record.holder ?? record.payee;
      const holder=store.wallet(controller)?.address;
      if (!holder) continue;
      await assets.enqueue({eventId:record.id,territoryId:record.treaty,kind:'political-treaty',version:record.version,
        holderAddress:holder,controllerId:controller,controlHash:record.termsHash,relatedTxid:settled.txid});
      store.savePortal('political-asset-queue',record.id,{txid:settled.txid,at:clock()});
    }
    await assets.reconcile();
    if (before!==assets.list().map(item=>item.id+':'+item.state).join('|')) notify();
  }

  function publicProof() {
    const {world}=store.read();
    const now=clock();
    const rows=store.payments();
    const indexed=new Map(rows.map(row=>[row.id,row]));
    const byTxid=new Map(rows.filter(row=>row.txid).map(row=>[row.txid,row]));
    const byAnchor=new Map(rows.filter(row=>row.politicalAnchor).map(row=>[row.politicalAnchor,row]));
    const records=proofRows(world).slice().reverse().map(record=>{
      const started=indexed.get(record.operation);
      const anchor=byAnchor.get(record.id);
      const chainReview=[started,anchor,byTxid.get(record.funding?.txid),byTxid.get(record.settlement?.txid)].some(row=>row?.state==='reorg');
      return {record,recordHash:protocolHash(record),anchored:anchor?.state==='credited'?receipt(anchor.receipt):null,
        ...(chainReview && {chainReview:true}),
        ...(started && {payment:receipt(started.receipt),opening:{player:started.playerId,action:started.payload,nonce:started.politicalNonce}})};
    });
    return {network:NETWORK_ID,treasuryPublicKey:chain.treasuryPublicKey ?? null,records,government:government.publicGovernmentRecord(world,now),trade:politicalTradeSnapshot(world,null,now),
      treaties:(diplomacy.diplomacySnapshot(world,null,now)?.treaties ?? []).filter(item=>accepted.has(item.status)),
      assets:assets?.list() ?? [],authority:assets?.authority() ?? null};
  }

  return {quote,fund,credit,acceptOperation,reconcile,publicProof};
}
