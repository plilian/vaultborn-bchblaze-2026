import './support/chipnet-only.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain,signWalletChallenge,walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { rafflePolicy } from '../apps/game-server/territory-raffles.mjs';

const fixture = process.env.CHIPNET_FIXTURE_FILE;
if (!fixture || process.env.CHIPNET_TEST_APPROVE !== 'true') throw new Error('A disposable funded Chipnet fixture and explicit test approval are required.');
const {player,treasury} = JSON.parse(await readFile(fixture,'utf8'));
const signer = keys => walletFromPrivateKey(keys);
const keys = [player.priv,randomBytes(32).toString('hex')];
const wallets = keys.map(signer);
const operator = createChain({treasuryPrivateKey:treasury.priv});
const head = await operator.blockAt();
assert.equal(head.network,'chipnet');
assert.ok(await operator.localWalletBalance(wallets[0].address) >= 40_000,'The primary disposable fixture needs 40,000 Chipnet sats.');
await mkdir('var',{recursive:true});
const scratch = await mkdtemp(resolve('var','territory-chipnet-'));
await writeFile(resolve(scratch,'secondary.key'),keys[1],{mode:0o600});
const evidence = {network:'chipnet',startedAt:new Date().toISOString(),payments:[],proofs:[],preflight:{tip:head.height}};
const save = () => writeFile(resolve(scratch,'receipts.json'),JSON.stringify(evidence,null,2)+'\n');
const shortened = {...rafflePolicy,roundBlocks:12,lastEntryOffset:5,drawOffset:7,drawConfirmations:2,offset:head.height%12};
evidence.raffleRules = shortened;
let offset = 0;
const app = createApp({database:resolve(scratch,'world.sqlite'),chain:operator,clock:() => Date.now()+offset,raffleRules:shortened});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const url='http://127.0.0.1:'+app.server.address().port;
function client() {
  let cookie='';
  return async (path,body) => {
    const reply = await fetch(url+'/api/'+path,{headers:{Cookie:cookie,...(body && {'Content-Type':'application/json'})},
      ...(body && {method:'POST',body:JSON.stringify(body)})});
    cookie=reply.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const json=await reply.json();
    if (!reply.ok) throw Object.assign(new Error(path + ' · ' + json.error),{status:reply.status});
    return json;
  };
}
const clients=[client(),client()];
const any=clients[0];
const state = () => any('state');
const advance = ms => {
  offset += ms;
  app.store.transaction(() => {
    const {world}=app.store.read();
    app.territory.tick(world,Date.now()+offset);
    app.store.write(world);
  });
};
async function till(description,work,minutes=18) {
  const limit=Date.now()+minutes*60_000;
  while (Date.now()<limit) {
    const result = await work();
    if (result) return result;
    await delay(6_000);
  }
  throw new Error('Timed out waiting for '+description);
}
async function pay(seat,payload,reuse) {
  const {result:intent}=reuse ?? await clients[seat]('payments',payload);
  const transaction = await operator.sendOutputsWithLocalKey(keys[seat],intent.outputs);
  const entry={id:intent.id,action:intent.action,txid:transaction.txid,satoshis:intent.satoshis,
    feeSatoshis:transaction.feeSatoshis,entry:payload.territory};
  evidence.payments.push(entry);
  await save();
  console.log('Broadcast',payload.type,transaction.txid);
  return {intent,entry};
}
async function credit(stage) {
  const found = await till(stage.entry.action,async () => {
    await app.ledger.reconcile();
    const row=app.store.payment(stage.intent.id);
    if (row?.state==='credited') return row;
    assert.ok(!['expired','rejected','reorg'].includes(row?.state),row?.lastError);
  });
  assert.equal(found.txid,stage.entry.txid);
  assert.equal(found.fulfillment.status,'applied',found.fulfillment.reason);
  const {height,blockHash,confirmations,event,eventVout}=found.receipt;
  Object.assign(stage.entry,{height,blockHash,confirmations,event,eventVout,outcome:found.fulfillment.result});
  await save();
  console.log('Confirmed',found.action,found.txid,confirmations);
  return found.fulfillment.result;
}
async function archive(site,kind) {
  const result=await till(kind+' settlement',async () => {
    await app.ledger.reconcile();
    const report=await any('public/territories/'+site);
    return report.records.find(item => item.record.kind===kind && item.anchorStatus==='credited') && report;
  });
  const record=result.records.find(item => item.record.kind===kind && item.anchorStatus==='credited');
  evidence.proofs.push({site,kind,record:record.record.id,txid:record.settlement.txid,hash:record.recordHash,
    feeSatoshis:record.settlement.feeSatoshis,blockHash:record.settlement.blockHash});
  await writeFile(resolve(scratch,site+'.json'),JSON.stringify(result,null,2)+'\n');
  await save();
  console.log('Anchored',kind,record.settlement.txid);
  return record.record;
}

try {
  console.log('Territory evidence will be stored at',scratch);
  await clients[0]('session',{demo:'p1'});
  await clients[1]('session',{demo:'p2'});
  for (const [seat,wallet] of wallets.entries()) {
    const owner=clients[seat];
    const {result:challenge}=await owner('wallet/challenge',{address:wallet.address});
    const proof=signWalletChallenge(keys[seat],challenge.challenge);
    await owner('wallet/verify',{address:proof.address,publicKey:proof.publicKey,signature:proof.signature});
  }
  const first=await state();
  if (!first.player.tutorial) await any('command',{type:'tutorial'});
  const secondaryFunding=await operator.sendWithLocalKey(keys[0],wallets[1].address,15_000);
  evidence.secondaryFunding=secondaryFunding.txid;
  const snapshot=await state();
  const land=snapshot.territories.find(item=>item.id==='east-meadow');
  const rare=snapshot.territories.find(item=>item.category==='rare');
  assert.ok(land?.claimEligibility?.ok,land?.claimEligibility?.reason);
  assert.ok(rare);
  const solo=await pay(0,{type:'territory-claim',territory:land.id});
  const raffle=await pay(0,{type:'territory-raffle',territory:rare.id});
  const opened=await credit(solo);
  const contender=await pay(1,{type:'territory-claim',territory:land.id});
  await credit(contender);
  await credit(raffle);
  const openedSite=(await state()).territories.find(item => item.id===land.id);
  assert.equal(opened.endsAt-openedSite.claim.startedAt,3_600_000);
  advance(Math.max(0,opened.endsAt-(Date.now()+offset))+1);
  const contested=await archive(land.id,'territory-claim');
  assert.equal(contested.entries.length,2);
  assert.ok(contested.battles.length);
  assert.ok(['p1','p2'].includes(contested.winner));
  const defender=contested.winner==='p1' ? 0 : 1;
  const attacker=1-defender;
  await clients[defender]('kingdom/risk',{satoshis:2000,consent:true});
  const captured=(await state()).territories.find(item=>item.id===land.id);
  if (captured.cooldownUntil>Date.now()+offset) advance(captured.cooldownUntil-(Date.now()+offset)+1);
  const attack=await pay(attacker,{type:'territory-attack',territory:land.id});
  await credit(attack);
  await archive(land.id,'territory-attack');
  const lease=await archive(rare.id,'raffle');
  assert.equal(lease.lease.expiresAt-lease.lease.startsAt,72*3_600_000);
  advance(Math.max(0,lease.lease.expiresAt-(Date.now()+offset))+1);
  await archive(rare.id,'lease-expired');
  evidence.finishedAt=new Date().toISOString();
  await save();
} finally {
  const closing=once(app.server,'close');
  app.close();
  await closing;
}
