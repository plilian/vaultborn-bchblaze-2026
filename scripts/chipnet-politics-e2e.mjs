import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const primary=process.env.CHIPNET_FIXTURE_FILE;
const recipient=process.env.CHIPNET_RECIPIENT_KEY_FILE;
if (process.env.CHIPNET_TEST_APPROVE!=='true' || !primary || !recipient) {
  throw new Error('Supply test approval and two disposable Chipnet fixture wallets.');
}
const fixture=JSON.parse(await readFile(primary,'utf8'));
const privateKeys=[fixture.player.priv,(await readFile(recipient,'utf8')).trim()];
const wallets=privateKeys.map(walletFromPrivateKey);
const chain=createChain({treasuryPrivateKey:fixture.treasury.priv});
const head=await chain.blockAt();
assert.equal(head.network,'chipnet');
assert.notEqual(wallets[0].address,wallets[1].address);
const resume=process.argv[2]==='--resume' ? process.argv[3] : undefined;
if (process.argv[2]==='--resume' && !resume) throw new Error('Supply the isolated Chipnet fixture directory to resume.');
if (!resume) assert.ok(await chain.localWalletBalance(wallets[0].address)>15000,'The isolated payer needs at least 15,000 Chipnet sats.');
await mkdir('var',{recursive:true});
const directory=resume ? resolve(resume) : await mkdtemp(resolve('var','politics-chipnet-'));
const app=createApp({database:resolve(directory,'world.sqlite'),chain});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const base='http://127.0.0.1:'+app.server.address().port;
const client=()=>{
  let cookie='';
  return async (route,data)=>{
    const response=await fetch(base+'/api/'+route,{headers:{Cookie:cookie,...(data && {'Content-Type':'application/json'})},
      ...(data && {method:'POST',body:JSON.stringify(data)})});
    cookie=response.headers.get('set-cookie')?.split(';')[0]??cookie;
    const body=await response.json();
    assert.ok(response.ok,route+' '+body.error);
    return body.result??body;
  };
};
const clients=[client(),client()];
const [payeeOne,payeeTwo]=clients;
const evidence=resume ? JSON.parse(await readFile(resolve(directory,'evidence.json'),'utf8')) :
  {network:'chipnet',startedAt:new Date().toISOString(),records:[],transactions:[]};
const save=()=>writeFile(resolve(directory,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
const awaitCondition=async(label,check)=>{
  const until=Date.now()+15*60_000;
  while (Date.now()<until) {
    const result=await check();
    if (result) return result;
    await delay(7000);
  }
  throw new Error('No confirmed evidence for '+label);
};

async function ratify(kind,terms={}) {
  const proposal=await payeeOne('command',{type:'diplomacy-treaty-propose',target:'p2',kind,durationHours:48,terms});
  const {termsHash,version}=proposal.proposal;
  return payeeTwo('command',{type:'diplomacy-treaty-respond',id:proposal.id,termsHash,version,accept:true});
}

async function pay(intent) {
  const broadcast=await chain.sendOutputsWithLocalKey(privateKeys[0],intent.outputs);
  evidence.transactions.push({kind:intent.action,txid:broadcast.txid,satoshis:intent.satoshis});
  console.log(intent.action,broadcast.txid);
  await save();
  if (resume) await app.ledger.submit('p1',intent.id,broadcast.txid);
  else await payeeOne('payments/'+intent.id+'/submit',{txid:broadcast.txid});
  return broadcast.txid;
}

try {
  let covenant,intent;
  if (resume) {
    const rows=app.store.payments();
    covenant=chain.publicIntent(rows.find(row=>row.action==='political-escrow'));
    intent=chain.publicIntent(rows.find(row=>row.action==='political-operation' && row.payload.operation==='attest'));
    for (const row of [covenant,intent]) {
      const funded=evidence.transactions.find(item=>item.kind===row.action);
      if (funded && !row.txid) await app.ledger.submit('p1',row.id,funded.txid);
    }
  } else {
    await payeeOne('session',{demo:'p1'});
    await payeeTwo('session',{demo:'p2'});
    for (const [i,seat] of clients.entries()) {
      const challenge=await seat('wallet/challenge',{address:wallets[i].address});
      const proof=signWalletChallenge(privateKeys[i],challenge.challenge);
      await seat('wallet/verify',{address:proof.address,signature:proof.signature,publicKey:proof.publicKey});
    }
    const accord=await ratify('reparations',{compensation:{kind:'bch',payerId:'p1',payeeId:'p2',satoshis:3100}});
    const charter=await ratify('trade');
    covenant=await payeeOne('payments',{type:'political-escrow',treaty:accord.id,consent:true});
    intent=await payeeOne('payments',{type:'political-operation',operation:'attest',treaty:charter.id,consent:true});
  }
  const accordId=app.store.payment(covenant.id).payload.treaty;
  const charterId=app.store.payment(intent.id).payload.treaty;
  if (!evidence.transactions.some(row=>row.kind===covenant.action)) await pay(covenant);
  const released=await awaitCondition('treaty release',async()=>{
    await app.ledger.reconcile();
    const data=await payeeOne('public/politics');
    return data.records.find(row=>row.record.treaty===accordId && row.record.kind==='treaty-compensation');
  });
  if (!evidence.records.some(row=>row.record.id===released.record.id)) evidence.records.push(released);
  console.log('treaty compensation',released.record.settlement.txid);
  await save();
  const exact=await chain.verifyPublishedTransaction(released.record.settlement.txid);
  assert.equal(exact.outputs[0].satoshis,3100);
  assert.equal(exact.outputs[0].script,wallets[1].script);
  if (!evidence.transactions.some(row=>row.kind===intent.action)) {
    if (Date.now()>=intent.expiresAt) intent=app.ledger.create('p1',{
      type:'political-operation',operation:'attest',treaty:charterId,consent:true,
    });
    await pay(intent);
  }
  const attested=await awaitCondition('charter anchor',async()=>{
    await app.ledger.reconcile();
    const data=await payeeOne('public/politics');
    return data.records.find(row=>row.record.treaty===charterId && row.record.kind==='treaty-charter' && row.anchored?.txid);
  });
  if (!evidence.records.some(row=>row.record.id===attested.record.id)) evidence.records.push(attested);
  evidence.treasuryPublicKey=chain.treasuryPublicKey;
  console.log('charter anchor',attested.anchored.txid);
  evidence.finishedAt=new Date().toISOString();
  console.log('Confirmed Chipnet political treaty lifecycle',directory);
  await save();
} finally {
  const end=once(app.server,'close');
  app.close();
  await end;
}
