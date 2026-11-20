import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';
import { rafflePolicy } from '../apps/game-server/territory-raffles.mjs';


const hour = 3_600_000;
const deterministicKey = numeric => numeric.toString(16).padStart(64,'0');
const judgeKey = deterministicKey(778);

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
  const chain = createChain({treasuryPrivateKey:deterministicKey(777),prizeAttestors:[walletFromPrivateKey(judgeKey).publicKey],transport:{withClient:fn => fn(client)}});
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
import { compileTreasuryCovenant } from '../packages/chain-observer/treasury-covenants.mjs';
import { completeStakeSpend, planStakeSpend, signStakeDigest, stakeEscrow } from '../packages/chain-observer/stake-escrow.mjs';

const walletOf = key => walletFromPrivateKey(key);
// The independent outcome attestor of this fixture. It signs each proposed stake settlement, as its tool would after checking the contest.
const attest = async app => {
  let signed = 0;
  for (const item of app.ledger.pendingAwards().filter(entry => entry.kind === 'stake')) {
    const plan = planStakeSpend(item.sources[0], { lane:item.lane, payee:item.payeeScript ?? undefined, eventScript:item.eventScript ?? undefined });
    await app.ledger.attestAward(item.id, { publicKey:walletFromPrivateKey(judgeKey).publicKey, signatures:[signStakeDigest(plan, judgeKey)] });
    signed += 1;
  }
  return signed;
};
const paidTo = (app, txid, script) => readTransaction(app.store.payments().find(item => item.txid === txid).rawHex).transaction.outputs
  .filter(output => hex(output.lockingBytecode) === script).reduce((sum, output) => sum + Number(output.valueSatoshis), 0);

test('contested claims sit in escrows that keep at least half for each claimant and settle to wallets on their own', async t => {
  const {app,players,keys,network,advance} = await apiFixture(t);
  const site='east-meadow';
  const pay = async seat => {
    const {result} = await players[seat]('payments',{type:'territory-claim',territory:site},201);
    assert.deepEqual(result.outputs.map(output => output.role),['escrow','event']);
    await network.pay(result,keys[seat]);
    network.mine();
    await app.ledger.reconcile();
    const row=app.store.payment(result.id);
    assert.equal(row.fulfillment.status,'applied',row.fulfillment.reason);
    return row;
  };
  const rows=[await pay(0),await pay(1)];
  for (const [seat,row] of rows.entries()) {
    const contract=stakeEscrow(row.escrow);
    assert.equal(row.receipt.allocations[0].script,contract.script);
    assert.deepEqual([contract.kind,contract.ownerAddress,contract.lanes],['territory-claim',walletOf(keys[seat]).address,['return','forfeit']]);
    assert.ok(contract.keep*2 >= contract.principal,'the claimant always keeps at least half');
    // The game key cannot open a lane alone: the panel is the game key and the independent attestor together.
    assert.equal(contract.panel.threshold,2);
    const alone=planStakeSpend(row.receipt.allocations[0],{lane:'forfeit',payee:walletOf(deterministicKey(777)).script});
    assert.throws(() => completeStakeSpend(alone,{[walletOf(deterministicKey(777)).publicKey]:signStakeDigest(alone,deterministicKey(777))}),/attestor signature is missing/);
  }
  assert.equal(app.ledger.explorer().buckets.kingdomReserve,0,'no claim stake is pooled under the game key');
  advance(rows[0].fulfillment.result.endsAt-network.clock()+1);
  for (let round=0; round<4; round+=1) { await app.ledger.reconcile(); await attest(app); network.mine(); }
  await app.ledger.reconcile();
  while (await attest(app)) { network.mine(); await app.ledger.reconcile(); }
  const record=app.store.read().world.territorySettlements.find(item => item.entries.some(entry => entry.id === rows[0].id));
  const winner=record.winner === 'p1' ? 0 : 1;
  const settlements=rows.map(row => app.store.payments().find(item => item.settles === row.id));
  assert.deepEqual(settlements.map(item => item?.state),['credited','credited']);
  assert.deepEqual(settlements.map(item => item.lane),winner === 0 ? ['return','forfeit'] : ['forfeit','return']);
  const principal=stakeEscrow(rows[0].escrow).principal;
  const half=Math.floor(principal/2);
  const scripts=keys.map(key => walletOf(key).script);
  assert.equal(paidTo(app,settlements[winner].txid,scripts[winner]),principal);
  assert.equal(paidTo(app,settlements[1-winner].txid,scripts[1-winner]),principal-half);
  assert.equal(paidTo(app,settlements[1-winner].txid,scripts[winner]),half);
  for (const item of settlements) assert.equal(item.territoryAnchor,record.id);
  assert.equal((await players[0]('public/territories/'+site)).records[0].anchorStatus,'credited');
  for (const seat of [0,1]) assert.equal((await players[seat]('vault')).kingdomSatoshis,0,'stakes return to wallets, not to pooled balances');

  // The loser attacks the new owner: that stake can only pay the attacker or the owner named when it was funded.
  const challenger=1-winner;
  const {territory}=await players[0]('public/territories/'+site);
  if (territory.cooldownUntil>network.clock()) await advance(territory.cooldownUntil-network.clock()+1);
  const {result:attack}=await players[challenger]('payments',{type:'territory-attack',territory:site},201);
  await network.pay(attack,keys[challenger]);
  await app.ledger.reconcile();
  network.mine();
  for (let round=0; round<4; round+=1) { await app.ledger.reconcile(); await attest(app); network.mine(); }
  while (await attest(app)) { network.mine(); await app.ledger.reconcile(); }
  const raid=app.store.payment(attack.id);
  const duel=stakeEscrow(raid.escrow);
  assert.equal(duel.kind,'territory-escrow');
  assert.deepEqual([duel.ownerAddress,duel.opponent],[walletOf(keys[challenger]).address,walletOf(keys[winner]).script]);
  assert.equal(raid.fulfillment.status,'applied',raid.fulfillment.reason);
  const closed=app.store.payments().find(item => item.settles === raid.id);
  assert.equal(closed?.state,'credited');
  assert.ok(['return','opponent-wins'].includes(closed.lane));
  assert.equal(paidTo(app,closed.txid,scripts[challenger])+paidTo(app,closed.txid,scripts[winner]),duel.principal);
});

test('a raffle entry can only return to its entrant, with the unused reserve, and needs no key', async t => {
  const issuer = {enabled:true,list:() => [],authority:() => ({network:'chipnet'}),enqueue:() => undefined,reconcile:async () => undefined, close:async () => undefined};
  const {app,players,keys,network,advance} = await apiFixture(t,{territoryAssets:issuer});
  const [player]=players;
  const rare=(await player('state')).territories.find(site => site.category==='rare');
  const {result:intent}=await player('payments',{type:'territory-raffle',territory:rare.id},201);
  await network.pay(intent,keys[0]);
  network.mine();
  await app.ledger.reconcile();
  const entry=app.store.payment(intent.id);
  assert.equal(entry.fulfillment.status,'applied',entry.fulfillment.reason);
  const contract=compileTreasuryCovenant(entry.escrow);
  assert.deepEqual([contract.kind,contract.keys,contract.outcomes.length],['territory-uncontested',[],1]);
  assert.deepEqual(contract.outcomes[0].outputs.map(output => [output.address,output.satoshis]),[[walletOf(keys[0]).address,intent.satoshis-600]]);
  advance(60_000);
  network.mine(intent.payload.round.drawHeight+rafflePolicy.drawConfirmations);
  await app.ledger.reconcile();
  assert.equal((await player('public/territories/'+rare.id)).territory.raffle.lease.playerId,'p1');
  assert.equal(app.store.payments().some(item => item.settles === entry.id),false,'the return lane is closed until its time');
  advance(10*hour+1);
  for (let round=0; round<3; round+=1) { await app.ledger.reconcile(); network.mine(); }
  await app.ledger.reconcile();
  const back=app.store.payments().find(item => item.settles === entry.id);
  assert.equal(back?.state,'credited');
  assert.equal(paidTo(app,back.txid,walletOf(keys[0]).script),intent.satoshis-600);
  assert.equal(readTransaction(back.rawHex).transaction.inputs[0].unlockingBytecode[0],0x00,'no signature opens the return lane');
});

test('a claim the game could not enter when its payment became final returns whole to the claimant, and its attestors are told why', async t => {
  const {app,players,keys,network} = await apiFixture(t);
  const {result} = await players[0]('payments',{type:'territory-claim',territory:'east-meadow'},201);
  // Between checkout and confirmation the army left: the claim can no longer be entered.
  app.store.transaction(() => { const {world}=app.store.read(); for (const unit of Object.keys(world.cities.p1.troops)) world.cities.p1.troops[unit]=0; app.store.write(world); });
  await network.pay(result,keys[0]);
  network.mine();
  await app.ledger.reconcile();
  const row=app.store.payment(result.id);
  assert.equal(row.state,'credited');
  assert.equal(row.fulfillment.status,'review');
  assert.equal(app.store.read().world.territories.find(site => site.id==='east-meadow').claim,null,'no contest was opened');
  assert.ok((app.store.read().world.notifications.p1 ?? []).some(entry => /Field at least 12 available troops.*your stake is returned to your wallet/.test(entry.text ?? entry.message ?? '')),
    'the claimant is told at once why, and that the stake comes back');
  for (let round=0; round<3; round+=1) { await app.ledger.reconcile(); await attest(app); network.mine(); }
  await app.ledger.reconcile();
  const back=app.store.payments().find(item => item.settles === row.id);
  assert.equal(back?.lane,'return');
  assert.equal(back.state,'credited');
  const principal=stakeEscrow(row.escrow).principal;
  assert.ok(paidTo(app,back.txid,walletOf(keys[0]).script) >= principal,'the whole stake and the unused reserve go back to the claimant');
  assert.ok((app.store.read().world.notifications.p1 ?? []).some(entry => entry.title === 'Stake returned to its owner'),'the claimant is told');
  // The evidence an attestor receives says the claim was never entered, and why.
  const { signAttestorRequest } = await import('../packages/chain-observer/index.mjs');
  const evidence=app.ledger.evidence(back.id,{publicKey:walletOf(judgeKey).publicKey,signature:signAttestorRequest(back.id,judgeKey)});
  assert.equal(evidence.contest,null);
  assert.match(evidence.notEntered.reason,/Field at least 12 available troops/);
});
