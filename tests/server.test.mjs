import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex, readTransaction, signSpend } from '../packages/chain-observer/primitives.mjs';

// These tests cover outputs and balances created before covenant custody of kingdom funds. Those must stay verifiable and spendable.
process.env.VAULTBORN_KINGDOM_CUSTODY = 'operator';

function observerFixture() {
  let index = 0;
  const verified = new Map();
  return { verified, enabled: true, payoutsEnabled: false, minConfirmations: 2,
    createIntent(args) { return { ...args, id: `payment-${++index}`, state: 'awaiting_signature', expiresAt: args.now + 60_000 }; },
    publicIntent(intent) { return intent; },
    submit(intent, txid) { return { ...intent, txid, state: 'submitted' }; },
    async observe(intent) {
      const observation = verified.get(intent.txid);
      if (!observation) return intent;
      if (observation.id !== intent.id) return { ...intent, state: 'rejected' };
      return { ...intent, state: observation.state, receipt: { confirmations: observation.state === 'confirmed' ? 2 : 0 } };
    },
  };
}

async function serve(options, t) {
  const app = createApp(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const stop = async () => { if (app.server.listening) { const done = once(app.server, 'close'); app.close(); await done; } };
  t.after(stop);
  const client = () => {
    let cookie = '';
    return {
      async request(path, body, headers = {}) {
        const response = await fetch(origin + '/api/' + path, { headers: { Cookie: cookie, ...headers, ...(body && { 'Content-Type': 'application/json' }) },
          ...(body && { method: 'POST', body: JSON.stringify(body) }) });
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return { status: response.status, body: await response.json() };
      },
      cookie: () => cookie,
      use(value) { cookie = value; },
    };
  };
  return { client, stop, app, origin };
}

test('isolates sessions, protects command origin, and debits a retry once', async (t) => {
  const { client } = await serve({ database: ':memory:', chain: observerFixture() }, t);
  const first = client();
  const second = client();
  const initial = (await first.request('session', { demo:'p1' })).body.state;
  assert.equal(initial.player.id, 'p1');
  assert.equal((await second.request('session', { demo:'p2' })).body.state.player.id, 'p2');
  const unique = client();
  assert.equal((await unique.request('session', { demo:'p1' })).status, 409);
  const action = { type:'upgrade', building:'hall', requestId:'repeat-upgrade-id' };
  assert.equal((await first.request('command', action, { Origin:'https://other.example' })).status, 403);
  const [committed, retried] = await Promise.all([first.request('command', action), first.request('command', action)]);
  assert.equal(committed.status, 200);
  assert.deepEqual(committed.body.result, retried.body.result);
  assert.equal(retried.body.state.player.queue.length, 1);
  assert.equal((await first.request('command', { ...action, building:'vault' })).status, 409);
  assert.equal((await second.request('state')).body.player.queue.length, 0);
  assert.equal((await first.request('command', { type:'attack-paid', target:'p2' })).status, 402);
});

test('new battle archives become public after the intelligence delay and reproduce the recorded result', async (t) => {
  let now = Date.now();
  const { client, origin } = await serve({ database: ':memory:', clock: () => now, chain: observerFixture() }, t);
  const player = client();
  await player.request('session', { demo:'p1' });
  const attack = await player.request('command', { type:'attack', target:'p2', requestId:'record-check' });
  assert.equal(attack.status, 200, JSON.stringify(attack.body));
  const id = attack.body.result.id;
  const visible = await player.request('public/battle/' + id);
  assert.equal(visible.body.verified, true);
  assert.equal(visible.body.record.battle.hash, attack.body.result.hash);
  assert.equal((await client().request('public/battle/' + id)).status, 404);
  const cinematic=await player.request('public/battle/' + id + '?cinematic=1');
  assert.equal(cinematic.body.recordHash,visible.body.recordHash);
  assert.equal(cinematic.body.trace.length,attack.body.result.events.length);
  for (const side of ['attacker','defender']) {
    for (const [unit,losses] of Object.entries(attack.body.result.losses[side])) {
      assert.equal(cinematic.body.trace.reduce((sum,row)=>sum+row[side].losses[unit],0),losses);
    }
    for (const [index,row] of cinematic.body.trace.entries()) {
      assert.equal(Object.values(row[side].losses).reduce((sum,loss)=>sum+loss,0),attack.body.result.events[index][side+'Loss']);
    }
  }
  assert.equal((await client().request('public/battle/' + id + '?cinematic=1')).status,404);
  now += 25 * 3_600_000;
  const archive = await fetch(origin + '/verify/battle/' + id + '?format=json');
  assert.equal(archive.status, 200);
  assert.equal((await archive.json()).recordHash, visible.body.recordHash);
  assert.match(await (await fetch(origin + '/verify/battle/' + id)).text(), /citadel-main/);
});

test('sponsor funding requires approval and publication waits for confirmed funding and schedule', async (t) => {
  const adminToken = 'fixture-admin-token-'.padEnd(40, 'x');
  let now = Date.now();
  let observed;
  const localSigner = '05'.padStart(64, '0');
  const signer = walletFromPrivateKey(localSigner);
  const developer = walletFromPrivateKey('07'.padStart(64, '0'));
  const attestor = walletFromPrivateKey('08'.padStart(64, '0'));
  const chain = createChain({ treasuryPrivateKey:'06'.padStart(64, '0'), developmentAddress:developer.address, prizeAttestors:[attestor.publicKey],
    transport:{ withClient:run => run({ history:async () => [], lookup:async txid => txid === observed?.txid ? observed : null }) } });
  const { client, app } = await serve({ database: ':memory:', clock: () => now, chain, adminToken }, t);
  const player = client();
  await player.request('session', { demo:'p1' });
  const start = now + 120_000;
  const proposed = await player.request('sponsors', { package:'standard', title:'Alden Tournament',
    sponsor:'Alden', start, end:start + 3_600_000, link:'https://example.com' });
  assert.equal(proposed.status, 201);
  const { id } = proposed.body;
  const fund = { type:'sponsor-fund', campaignId:id, consent:true };
  assert.equal((await player.request('payments', fund)).status, 409);
  const review = { id, decision:'approved' };
  assert.equal((await player.request('admin/sponsors/review', review)).status, 403);
  assert.equal((await player.request('admin/sponsors/review', review, { Authorization:'Bearer ' + adminToken })).status, 200);
  // The sponsor's verified wallet is the only place an unawarded prize contribution can return to.
  assert.equal((await player.request('payments', fund)).status, 403);
  app.store.bindWallet('p1', signer.address, signer.publicKey, now);
  const intent = (await player.request('payments', fund)).body.result;
  assert.equal(intent.satoshis, 50_000_000);
  assert.deepEqual(intent.outputs.map(output=>[output.role,output.satoshis]), [['prize',35_000_000],['development',15_000_000],['event',0]]);
  assert.equal(intent.outputs[1].address, developer.address);
  assert.equal(intent.fund.sponsorKey, signer.publicKey);
  const fixture = signSpend({ privateKey:localSigner, sources:[{ txid:'a'.repeat(64), vout:0, satoshis:50_000_500, script:signer.script }], outputs:intent.outputs });
  observed = { ...readTransaction(fixture.rawHex), confirmations:2, height:390_001, blockTime:now };
  assert.equal((await player.request('payments/' + intent.id + '/submit', { txid:observed.txid })).body.result.state, 'credited');
  assert.equal((await player.request('public/sponsors')).body.publicCampaigns.length, 0);
  now = start + 1;
  assert.equal((await player.request('public/sponsors')).body.publicCampaigns[0].id, id);
  for (let i = 0; i < 2; i++) await player.request('sponsors/' + id + '/impression', {});
  assert.equal((await player.request('public/sponsors')).body.own[0].analytics.impression, 1);
});

test('council snapshots eligible accounts, counts abstentions for quorum, and blocks unapproved spending', async (t) => {
  const adminToken = 'fixture-admin-token-'.padEnd(40, 'y');
  let now = Date.now();
  const { client, app } = await serve({ database: ':memory:', clock: () => now, chain: observerFixture(), adminToken }, t);
  const players = [client(), client(), client()];
  for (const [i, player] of players.entries()) await player.request('session', { demo:'p' + (i + 1) });
  app.store.transaction(() => {
    const { world } = app.store.read();
    for (let i = 1; i <= 3; i++) {
      const who = 'p' + i;
      world.cities[who].score = 20;
      world.cities[who].tutorial = true;
      const key = walletFromPrivateKey(String(i).padStart(64, '0'));
      app.store.bindWallet(who, key.address, key.publicKey, now);
    }
    app.store.write(world);
  });
  const address = walletFromPrivateKey('04'.padStart(64,'0')).address;
  const opened = await players[0].request('council/proposals', { title:'Archive maintenance',
    reason:'Sponsor a public verification archive.', address, satoshis:1000 });
  assert.equal(opened.status, 201);
  const { id } = opened.body;
  assert.equal(opened.body.quorum, 3);
  const ineligible = client();
  await ineligible.request('session', { demo:'p4' });
  assert.equal((await ineligible.request('council/vote', { id, vote:'yes' })).status, 403);
  for (const [i, vote] of ['yes','yes','abstain'].entries()) {
    assert.equal((await players[i].request('council/vote', { id, vote })).status, 200);
  }
  assert.equal((await players[0].request('council')).body.proposals[0].status, 'open');
  now += 4 * 86_400_000;
  assert.equal((await players[0].request('council')).body.proposals[0].status, 'passed');
  assert.equal((await players[0].request('admin/council/spend', { id, consent:true })).status, 403);
  assert.equal((await players[0].request('admin/council/spend', { id, consent:true },
    { Authorization:'Bearer ' + adminToken })).status, 409);
});

test('wallet-approved raw checkout rejects altered outputs, captures TXID, and deduplicates a signed retry', async (t) => {
  const key = '02'.padStart(64,'0');
  const wallet = walletFromPrivateKey(key);
  let observed;
  const transport = { withClient: run => run({
    history:async () => observed ? [{txid:observed.txid,height:334369}] : [],
    lookup:async txid => txid === observed?.txid ? observed : null,
    raw:async () => null,
  }) };
  const chain = createChain({treasuryPrivateKey:'01'.padStart(64,'0'),transport});
  let broadcasts = 0;
  chain.walletCoins = async ([candidate]) => [{...candidate, txid:'b'.repeat(64), vout:0, satoshis:9000}];
  chain.broadcast = async raw => {
    broadcasts++;
    observed = { ...readTransaction(raw), confirmations:2, height:334369 };
    return observed.txid;
  };
  const { client, app } = await serve({ database:':memory:', chain }, t);
  const actor = client();
  await actor.request('session', { demo:'p1' });
  const intent = (await actor.request('payments',{ type:'premium',building:'hall' })).body.result;
  const route = 'payments/' + intent.id + '/wallet/';
  const keys = { keys:[{ publicKey:wallet.publicKey,path:'receive',index:0 }] };
  const rival = client();
  await rival.request('session', { demo:'p2' });
  assert.equal((await rival.request(route + 'prepare',keys)).status,404);
  const { result: review } = (await actor.request(route + 'prepare',keys)).body;
  assert.deepEqual(review.inputPaths, [[0,'receive',0]]);
  assert.equal(review.sourceOutputs[0].valueSatoshis,'<bigint: 9000n>');
  const unsigned = readTransaction(review.transaction).transaction;
  const sources = [{ script:wallet.script, satoshis:9000, txid:'b'.repeat(64), vout:0 }];
  const outputs = unsigned.outputs.map(output => ({script:hex(output.lockingBytecode),satoshis:Number(output.valueSatoshis)}));
  const sign = (outputs, requireUtxos) => signSpend({ sources, outputs, privateKey:key, requireUtxos });
  const moved = sign(outputs.map((output, i) => i === 0 ? {...output,satoshis:output.satoshis - 1} : output),true);
  assert.equal((await actor.request(route + 'broadcast',{signedTransaction:moved.rawHex})).status,409);
  const weak = sign(outputs,false);
  assert.equal((await actor.request(route + 'broadcast',{signedTransaction:weak.rawHex})).status,400);
  assert.equal(broadcasts,0);
  const signed = sign(outputs,true);
  const response = await actor.request(route + 'broadcast',{signedTransaction:signed.rawHex});
  assert.equal(response.status,202,JSON.stringify(response.body));
  assert.equal(response.body.result.txid,signed.txid);
  assert.equal(response.body.state.wallet.address,wallet.address);
  assert.equal((await actor.request(route + 'broadcast',{signedTransaction:signed.rawHex})).status,202);
  assert.equal((await actor.request('payments')).body.length,1);
  await app.ledger.reconcile();
  const confirmed = (await actor.request('state')).body;
  assert.equal(confirmed.payments[0].state,'credited');
  assert.equal(confirmed.payments[0].fulfillment.status,'applied');
  assert.equal(confirmed.vault.kingdomSatoshis,2925);
});

test('confirmed payment changes game state once across restart and a reorg quarantines the account', async (t) => {
  await mkdir('var', { recursive:true });
  await mkdir('var', { recursive: true });   // a fresh copy of the repository has no var/ folder yet
  const dir = await mkdtemp(resolve('var', 'server-test-'));
  const config = { database:resolve(dir,'world.sqlite'), chain:observerFixture() };
  const a = await serve(config, t);
  const first = a.client();
  await first.request('session', { demo:'p1' });
  const prepared = await first.request('payments', { type:'premium', building:'hall' });
  assert.equal(prepared.status, 201);
  assert.equal(prepared.body.result.satoshis, 22_000);
  const paymentId = prepared.body.result.id;
  const txid = 'e'.repeat(64);
  const wrongPlayer = a.client();
  await wrongPlayer.request('session', { demo:'p2' });
  const route = `payments/${paymentId}/submit`;
  assert.equal((await wrongPlayer.request(route,{txid})).status, 404);
  config.chain.verified.set(txid, { id:paymentId, state:'seen_in_mempool' });
  const mempool = await first.request(route, {txid});
  assert.equal(mempool.body.result.state, 'seen_in_mempool');
  assert.equal(Object.hasOwn(mempool.body.state.player.perks, 'hall'), false);
  await a.stop();
  const b = await serve(config, t);
  const returning = b.client(); returning.use(first.cookie());
  config.chain.verified.set(txid, { id:paymentId, state:'confirmed' });
  const [receipt, retry] = await Promise.all([returning.request(route,{txid}), returning.request(route,{txid})]);
  assert.equal(receipt.body.result.fulfillment.status,'applied');
  assert.equal(retry.body.result.state,'credited');
  assert.ok(retry.body.state.player.perks.hall);
  assert.equal(retry.body.state.payments.length, 1);
  config.chain.verified.set(txid, { id:paymentId, state:'reorg' });
  await b.app.ledger.reconcile();
  assert.equal((await returning.request('state')).body.vault.quarantined, true);
  await b.stop();
  await rm(dir,{recursive:true,force:true});
});
