import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { rafflePolicy } from '../apps/game-server/territory-raffles.mjs';

// Territory stakes created before their covenant custody must stay verifiable and spendable.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

const hour = 3_600_000;
const deterministicKey = numeric => numeric.toString(16).padStart(64,'0');

function chips() {
  const pending = new Map();
  let height = 36008;
  let now = Date.now();
  const block = h => (h >>> 0).toString(16).padStart(8,'0') + '0'.repeat(152);
  const client = {
    get tip() { return height; },
    block:async h => block(h),
    raw:async txid => pending.get(txid)?.rawHex ?? null,
    history:async script => [...pending.values()].filter(row => row.transaction.outputs.some(output => hex(output.lockingBytecode) === script))
      .map(row => ({txid:row.txid,height:row.height ?? 0})),
    lookup:async txid => {
      const row = pending.get(txid);
      return row && {...row,confirmations:row.height ? height-row.height+1 : 0,blockTime:row.includedTime};
    },
    broadcast:async rawHex => {
      const entry = {...readTransaction(rawHex),rawHex};
      if (!pending.has(entry.txid)) pending.set(entry.txid,entry);
      return entry.txid;
    },
  };
  const chain = createChain({treasuryPrivateKey:deterministicKey(777),transport:{withClient:fn => fn(client)}});
  return { chain, mine(nextHeight=height+2) {
    const slot = height + 1;
    for (const row of pending.values()) if (!row.height) { row.height=slot; row.includedTime=now; }
    height = nextHeight;
  }, clock:() => now, tick(ms) { now+=ms; },
  async pay(intent, key) {
    const wallet = walletFromPrivateKey(key);
    const tx = signSpend({ sources:[{txid:intent.id.padStart(64,'f'),vout:0,satoshis:100_000,script:wallet.script}],
      privateKey:key,outputs:[...intent.outputs,{script:wallet.script,satoshis:99_500-intent.satoshis}] });
    await client.broadcast(tx.rawHex);
    return tx.txid;
  } };
}

async function apiFixture(t, options = {}) {
  const network = chips();
  const app = createApp({database:':memory:',chain:network.chain,clock:network.clock,...options});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async () => { const closed=once(app.server,'close'); app.close(); await closed; });
  const origin='http://127.0.0.1:' + app.server.address().port;
  const client = key => {
    let cookie = '';
    return async (route,body,status=200) => {
      const response = await fetch(origin+'/api/'+route,{headers:{Cookie:cookie,...(body && {'Content-Type':'application/json'})},
        ...(body && {method:'POST',body:JSON.stringify(body)})});
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      const data = await response.json();
      assert.equal(response.status,status,route + ' ' + JSON.stringify(data?.error));
      return data;
    };
  };
  const players = [client(),client()];
  await players[0]('session',{demo:'p1'});
  await players[1]('session',{demo:'p2'});
  const keys = [deterministicKey(201),deterministicKey(202)];
  app.store.transaction(() => {
    const {world}=app.store.read();
    for (const [i,player] of ['p1','p2'].entries()) {
      world.cities[player].tutorial=true;
      world.cities[player].optIn=true;
      const wallet=walletFromPrivateKey(keys[i]);
      app.store.bindWallet(player,wallet.address,wallet.publicKey,network.clock());
    }
    app.store.write(world);
  });
  const advance = ms => {
    network.tick(ms);
    app.store.transaction(() => {
      const {world}=app.store.read();
      app.territory.tick(world,network.clock());
      app.store.write(world);
    });
  };
  return {app,network,players,keys,advance};
}

test('a real-output fixture confirms a territory stake, queues a draw, returns the stake after settlement, and expires the lease', async t => {
  const assetEvents=[];
  const issuer = {enabled:true,list:() => [],authority:() => ({network:'chipnet'}),
    enqueue:event => { assetEvents.push(event); },reconcile:async () => undefined, close:async () => undefined};
  const {app,players,keys,network,advance} = await apiFixture(t,{territoryAssets:issuer});
  const [player]=players;
  const {territories} = await player('state');
  const rare=territories.find(site => site.category==='rare');
  assert.ok(rare,'The world has no rare territories.');
  const {result:intent}=await player('payments',{type:'territory-raffle',territory:rare.id},201);
  const paid=await network.pay(intent,keys[0]);
  network.mine();
  await app.ledger.reconcile();
  const accepted=app.store.payment(intent.id);
  assert.equal(accepted.txid,paid);
  assert.equal(accepted.state,'credited');
  assert.equal(accepted.fulfillment.status,'applied',accepted.fulfillment.reason);
  assert.equal((await player('vault')).lockedSatoshis,rafflePolicy.fee/2);
  advance(60_000);
  const drawHeight=intent.payload.round.drawHeight;
  network.mine(drawHeight+rafflePolicy.drawConfirmations);
  await app.ledger.reconcile();
  const occupied=(await player('public/territories/'+rare.id)).territory;
  assert.equal(occupied.raffle.lease.playerId,'p1');
  assert.equal(occupied.raffle.lease.expiresAt-occupied.raffle.lease.startsAt,72*hour);
  assert.equal((await player('vault')).kingdomSatoshis,0);
  await app.territory.reconcileAssets();
  assert.equal(assetEvents.length,0);
  network.mine();
  await app.ledger.reconcile();
  assert.equal((await player('vault')).lockedSatoshis,0);
  assert.equal((await player('vault')).kingdomSatoshis,rafflePolicy.fee/2);
  const verified=(await player('public/territories/'+rare.id)).records[0];
  assert.equal(verified.anchorStatus,'credited');
  assert.equal(verified.settlement.event.data.recordHash,verified.recordHash);
  await app.territory.reconcileAssets();
  await app.territory.reconcileAssets();
  assert.deepEqual(assetEvents.map(event => event.kind),['lease']);
  assert.equal(assetEvents[0].relatedTxid,verified.settlement.txid);
  advance(72*hour);
  await app.ledger.reconcile();
  network.mine();
  await app.ledger.reconcile();
  const expired=await player('public/territories/'+rare.id);
  assert.equal(expired.territory.raffle.lease,null);
  assert.equal(expired.records[0].record.kind,'lease-expired');
  assert.equal(expired.records[0].anchorStatus,'credited');
  assert.equal((await player('vault')).kingdomSatoshis,rafflePolicy.fee/2);
  await app.territory.reconcileAssets();
  assert.deepEqual(assetEvents.map(event => event.kind),['lease','lease-expired']);
});

test('two claims settle distinct real-output stakes and a later conquest can release committed treasury', async t => {
  const {app,players,keys,network,advance} = await apiFixture(t);
  const site='east-meadow';
  const [primary,other]=players;
  await primary('command',{type:'claim-node',id:site},402);
  const pay = async (seat,type) => {
    const {result} = await players[seat]('payments',{type,territory:site},201);
    await network.pay(result,keys[seat]);
    if (type === 'territory-attack') {
      await app.ledger.reconcile();
      assert.ok((await players[1-seat]('state')).notifications.some(item => /^Incoming attack at East Meadow/.test(item.text)));
      assert.equal(app.store.payment(result.id).fulfillment,undefined);
    }
    network.mine();
    await app.ledger.reconcile();
    const item=app.store.payment(result.id);
    assert.equal(item.fulfillment.status,'applied',item.fulfillment.reason);
    return item.fulfillment.result;
  };
  const first=await pay(0,'territory-claim');
  await pay(1,'territory-claim');
  await primary('payments',{type:'territory-claim',territory:site},409);
  await advance(first.endsAt-network.clock()+1);
  await app.ledger.reconcile();
  network.mine();
  await app.ledger.reconcile();
  const settled=(await primary('public/territories/'+site)).records[0];
  assert.equal(settled.anchorStatus,'credited');
  assert.equal(settled.record.entries.length,2);
  assert.ok(settled.record.battles.length);
  const owner=settled.record.winner==='p1' ? 0 : 1;
  const foe=1-owner;
  assert.equal((await players[owner]('vault')).kingdomSatoshis,4000);
  assert.equal((await players[foe]('vault')).kingdomSatoshis,0);
  await players[owner]('kingdom/risk',{satoshis:2000,consent:true});
  const {territory}=await other('public/territories/'+site);
  if (territory.cooldownUntil>network.clock()) await advance(territory.cooldownUntil-network.clock()+1);
  const conquest=await pay(foe,'territory-attack');
  network.mine();
  await app.ledger.reconcile();
  const later=(await primary('public/territories/'+site)).records[0];
  assert.equal(later.record.kind,'territory-attack');
  assert.equal(later.anchorStatus,'credited');
  assert.equal(later.record.battles[0].hash,conquest.battle.hash);
  if (conquest.battle.winner==='attacker') {
    assert.equal(later.record.controller,foe===0 ? 'p1' : 'p2');
    assert.equal(later.record.treasury.capturedSatoshis,400);
  } else {
    assert.equal(later.record.controller,owner===0 ? 'p1' : 'p2');
    assert.equal(later.record.treasury.recipient,owner===0 ? 'p1' : 'p2');
  }
});
