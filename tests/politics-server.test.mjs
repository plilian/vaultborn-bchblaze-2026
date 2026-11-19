import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { eventOutput, protocolHash } from '../packages/chain-observer/vaultborn.mjs';
import { signPoliticalEscrow } from '../packages/chain-observer/political-escrow.mjs';

// Paid political operations need an operator-held reserve for their proof transaction. They are covered here on the previous custody path.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

const key=i=>i.toString(16).padStart(64,'0');
const HOUR=3600000;

async function instance(t) {
  const transactions=new Map();
  let tip=390001;
  let now=Date.now();
  const transport={withClient:fn=>fn({get tip(){return tip;},
    lookup:async id=>{
      const item=transactions.get(id);
      return item && {...item,confirmations:item.height ? tip-item.height+1 : 0};
    },
    raw:async id=>transactions.get(id)?.rawHex ?? null,
    history:async script=>[...transactions.values()].filter(item=>item.transaction.outputs.some(output=>hex(output.lockingBytecode)===script) ||
      item.transaction.inputs.some(input=>{
        const output=transactions.get(hex(input.outpointTransactionHash))?.transaction.outputs[input.outpointIndex];
        return output && hex(output.lockingBytecode)===script;
      }))
      .map(item=>({txid:item.txid,height:item.height??0})),
    broadcast:async raw=>{
      const item=readTransaction(raw);
      if (!transactions.has(item.txid)) transactions.set(item.txid,{...item,rawHex:raw});
      return item.txid;
    },
  })};
  // A plain copy lets a test take the signer away while the observer keeps working.
  const chain={...createChain({treasuryPrivateKey:key(901),transport})};
  const app=createApp({database:':memory:',chain,clock:()=>now});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async()=>{const stopped=once(app.server,'close');app.close();await stopped;});
  const origin='http://127.0.0.1:'+app.server.address().port;
  const client=()=>{
    let cookie='';
    return async (path,body,status=200)=>{
      const response=await fetch(origin+'/api/'+path,{headers:{Cookie:cookie,...(body && {'Content-Type':'application/json'})},
        ...(body && {method:'POST',body:JSON.stringify(body)})});
      cookie=response.headers.get('set-cookie')?.split(';')[0]??cookie;
      const asJson=await response.json();
      assert.equal(response.status,status,path+' '+asJson.error);
      return asJson;
    };
  };
  const clients=[client(),client()];
  await clients[0]('session',{demo:'p1'});
  await clients[1]('session',{demo:'p2'});
  for (const [i,seat] of clients.entries()) {
    const secret=key(300+i);
    const wallet=walletFromPrivateKey(secret);
    const challenge=(await seat('wallet/challenge',{address:wallet.address})).result;
    const signed=signWalletChallenge(secret,challenge.challenge??challenge.message);
    await seat('wallet/verify',{address:signed.address,publicKey:signed.publicKey,signature:signed.signature});
  }
  const command=(seat,payload,status)=>clients[seat]('command',payload,status);
  const mine=(only)=>{
    tip++;
    for (const tx of transactions.values()) if (!tx.height && (!only || tx.txid===only)) {
      tx.height=tip;
      tx.blockTime=now;
    }
    tip++;
  };
  async function charge(intent,seat) {
    const privateKey=key(300+seat);
    const wallet=walletFromPrivateKey(privateKey);
    const spend=signSpend({privateKey,sources:[{txid:intent.id.padStart(64,'c'),vout:0,script:wallet.script,satoshis:80000}],
      outputs:[...intent.outputs,{script:wallet.script,satoshis:79500-intent.satoshis}]});
    await chain.broadcast(spend.rawHex);
    return spend.txid;
  }
  async function ratify(kind,terms={}) {
    const offer=(await command(0,{type:'diplomacy-treaty-propose',target:'p2',kind,durationHours:48,terms})).result;
    assert.equal((await clients[1]('state')).diplomacy.treaties[0].id,offer.id);
    const {termsHash,version}=offer.proposal;
    return (await command(1,{type:'diplomacy-treaty-respond',id:offer.id,accept:true,termsHash,version})).result;
  }
  return {app,chain,clients,command,ratify,charge,mine,transactions,clock:()=>now,elapse:ms=>{now+=ms;}};
}

test('treaty terms stay inactive until the exact funded contract pays its principal on chain',async t=>{
  const {app,clients,ratify,charge,mine,transactions}=await instance(t);
  const [payer,recipient]=clients;
  const treaty=await ratify('reparations',{compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:8300}});
  assert.equal(treaty.status,'awaiting-funding');
  const terms={type:'political-escrow',treaty:treaty.id,consent:true};
  await recipient('payments',terms,403);
  await payer('payments',{...terms,consent:false},400);
  const {result:quote}=await payer('payments',terms,201);
  assert.equal(quote.satoshis,8950);
  assert.deepEqual(quote.outputs.map(output=>[output.role,output.satoshis]),[['treaty-escrow',8950],['event',0]]);
  const txid=await charge(quote,0);
  mine();
  await app.ledger.reconcile();
  assert.equal((await payer('state')).diplomacy.treaties[0].status,'awaiting-settlement');
  assert.equal((await payer('public/ledger')).buckets.politicalEscrow,8300);
  mine();
  await app.ledger.reconcile();
  const proof=await payer('public/politics');
  const saved=proof.records[0].record;
  assert.equal(saved.kind,'treaty-compensation');
  assert.equal(saved.funding.txid,txid);
  assert.equal(saved.principal,8300);
  assert.equal(proof.treaties[0].status,'active');
  assert.equal((await payer('public/ledger')).buckets.politicalEscrow,0);
  const mined=transactions.get(saved.settlement.txid).transaction;
  assert.equal(Number(mined.outputs[0].valueSatoshis),8300);
  assert.equal(hex(mined.outputs[1].lockingBytecode),eventOutput(saved.settlement.event).script);
  assert.equal(await payer('vault').then(data=>data.kingdomSatoshis),0);
  await app.ledger.reconcile();
  assert.equal((await payer('public/politics')).records.length,1);
});

test('an independently signed confirmed refund closes the treaty and retires a conflicting operator payout',async t=>{
  const {app,chain,clients,ratify,charge,mine,elapse}=await instance(t);
  const [payer]=clients;
  const accord=await ratify('reparations',{compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:4100}});
  const {result:quote}=await payer('payments',{type:'political-escrow',treaty:accord.id,consent:true},201);
  const funding=await charge(quote,0);
  mine();
  await app.ledger.reconcile();
  const first=app.store.payments().find(row=>row.politicalFunding===quote.id);
  assert.equal(first.action,'political-release');
  elapse(7*HOUR);
  const refund=signPoliticalEscrow({contract:quote.contract,source:{txid:funding,vout:0,satoshis:quote.satoshis,script:quote.contract.script},
    privateKey:key(300),lane:'payer-refund',eventScript:'6a045642524e'});
  await chain.broadcast(refund.rawHex);
  mine(refund.txid);
  await app.ledger.reconcile();
  const saved=(await payer('public/politics')).records[0].record;
  assert.equal(saved.kind,'treaty-refund');
  assert.equal(saved.settlement.txid,refund.txid);
  assert.equal(app.store.payment(first.id).state,'rejected');
  assert.equal(app.store.payment(quote.id).politicalStatus,'refunded');
  assert.equal((await payer('public/ledger')).buckets.politicalEscrow,0);
  await app.ledger.reconcile();
  assert.equal((await payer('public/politics')).records.length,1);
});

test('a cancelled checkout routes late principal to the payer and paid charters reveal a salted operation only after acceptance',async t=>{
  const {app,clients,command,ratify,charge,mine,transactions,elapse}=await instance(t);
  const [payer]=clients;
  const accord=await ratify('reparations',{compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:9300}});
  const {result:quote}=await payer('payments',{type:'political-escrow',treaty:accord.id,consent:true},201);
  await command(0,{type:'diplomacy-treaty-cancel',id:accord.id});
  const funding=await charge(quote,0);
  mine(); await app.ledger.reconcile();
  mine(); await app.ledger.reconcile();
  const record=(await payer('public/politics')).records[0].record;
  assert.equal(record.kind,'treaty-refund');
  assert.equal(record.funding.txid,funding);
  assert.equal(hex(transactions.get(record.settlement.txid).transaction.outputs[0].lockingBytecode),walletFromPrivateKey(key(300)).script);
  elapse(HOUR);
  const trade=await ratify('trade');
  const {result:charter}=await payer('payments',{type:'political-operation',operation:'attest',treaty:trade.id,consent:true},201);
  assert.equal(charter.satoshis,4000);
  assert.deepEqual(charter.event.data.allocation,{development:800,burn:200,prize:400,kingdom:2600});
  assert.deepEqual((await payer('public/politics')).records.filter(row=>row.opening),[]);
  await charge(charter,0);
  mine(); await app.ledger.reconcile();
  mine(); await app.ledger.reconcile();
  const confirmed=(await payer('public/politics')).records.find(row=>row.record.kind==='treaty-charter');
  assert.ok(confirmed?.anchored?.txid);
  assert.equal(confirmed.payment.event.data.actionHash,protocolHash(confirmed.opening));
  assert.equal(confirmed.anchored.event.data.recordHash,confirmed.recordHash);
  assert.equal((await payer('vault')).kingdomSatoshis,2600);
});

test('a payer refund is recognized after the operator signer is removed',async t=>{
  const {app,chain,clients,ratify,charge,mine,elapse}=await instance(t);
  const [payer]=clients;
  const accord=await ratify('reparations',{compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:5200}});
  const {result:quote}=await payer('payments',{type:'political-escrow',treaty:accord.id,consent:true},201);
  assert.equal(quote.contract.version,2);
  const funding=await charge(quote,0);
  mine();
  // The signer disappears before any settlement is signed. Only chain observation remains.
  chain.payoutsEnabled=false;
  await app.ledger.reconcile();
  assert.equal(app.store.payment(quote.id).politicalStatus,'funded');
  assert.equal(app.store.payments().some(row=>row.politicalFunding===quote.id),false);
  elapse(7*HOUR);
  const refund=signPoliticalEscrow({contract:quote.contract,source:{txid:funding,vout:0,satoshis:quote.satoshis,script:quote.contract.script},
    privateKey:key(300),lane:'payer-refund',eventScript:'6a045642524e'});
  await chain.broadcast(refund.rawHex);
  mine(refund.txid);
  await app.ledger.reconcile();
  assert.equal(app.store.payment(quote.id).politicalStatus,'refunded');
  assert.equal((await payer('public/ledger')).buckets.politicalEscrow,0);
  const saved=(await payer('public/politics')).records[0].record;
  assert.equal(saved.kind,'treaty-refund');
  assert.equal(saved.settlement.txid,refund.txid);
});
