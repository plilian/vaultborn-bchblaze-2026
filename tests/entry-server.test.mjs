import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

async function serve(t, options = {}) {
  const disabledAssets = { enabled: false, list: () => [], authority: () => null, close: () => {} };
  const chain = createChain({ enabled: false, transport: { withClient: async () => {
    throw new Error('Entry fixtures do not access a blockchain transport.');
  } } });
  const app = createApp({ database: ':memory:', localDemo: true, chain,
    territoryAssets: disabledAssets, politicalAssets: disabledAssets, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { const closed = once(app.server, 'close'); app.close(); await closed; });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const request = (path, options) => fetch(origin + path, { redirect: 'manual', ...options });
  const post = (path, data, headers) => request(path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return { app, request, post };
}

test('anonymous landing, campaign shell and public records never allocate a city or cookie', async t => {
  const { app, request, post } = await serve(t);
  const initial = app.store.read();
  for (const path of ['/', '/play', '/ledger.html', '/council.html', '/api/public/ledger', '/api/council']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.has('set-cookie'), false, path);
    const body = await response.text();
    if (path === '/council.html') assert.match(body, /<body class="citadel">/);
    if (path === '/play') assert.match(body, /id="campaign"/);
  }
  const probe = await request('/api/session', { headers: { Cookie: 'dominion=' + '0'.repeat(64) } });
  assert.deepEqual(await probe.json(), { authenticated: false, demo: true, walletConnect: false });
  assert.equal(probe.headers.has('set-cookie'), false);
  for (const path of ['/api/state', '/api/events', '/api/vault']) {
    assert.equal((await request(path)).status, 401, path);
  }
  assert.equal((await post('/api/session', { entry: 'new' }, { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/command', { type: 'collect' })).status, 401);
  assert.deepEqual(app.store.read(), initial);
  assert.equal(app.store.hasSeat('p1'), false);
});

test('Play opens one protected city; cookie visits recover it and keep existing links', async t => {
  const { app, request, post } = await serve(t);
  const enter = await post('/api/session', { entry: 'new' });
  assert.equal(enter.status, 200);
  const cookie = enter.headers.get('set-cookie');
  assert.match(cookie, /^dominion=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict;/);
  const headers = { Cookie: cookie.split(';')[0] };
  const { state, result } = await enter.json();
  const player = state.player;
  assert.deepEqual(result, { player: player.id, created: true });
  assert.notEqual(player.id, 'p1');
  assert.equal(player.founding, true);
  assert.equal(player.optIn, true);
  const homeland = app.store.read().world.territories.find(site => site.id === 'starter-' + player.id);
  assert.equal(homeland.owner, player.id);
  assert.equal(homeland.protected, true);
  assert.equal(homeland.nextUpkeep, null);
  assert.equal(state.payments.length, 0);

  const returning = await request('/?payment=payment-test', { headers });
  assert.equal(returning.status, 302);
  assert.equal(returning.headers.get('location'), '/play?payment=payment-test');
  const probe = await request('/api/session', { headers });
  assert.deepEqual(await probe.json(), { authenticated: true, demo: true, walletConnect: false });
  const reopen = await post('/api/session', { entry: 'new' }, headers);
  assert.equal(reopen.headers.has('set-cookie'), false);
  assert.deepEqual((await reopen.json()).result, { player: player.id, created: false });

  const archive = await request('/council.html', { headers });
  assert.match(await archive.text(), /id="campaign-citadel"/);
  const demoEntry = await request('/?seat=p2');
  assert.match(await demoEntry.text(), /id="campaign"/);
  assert.equal(demoEntry.headers.has('set-cookie'), false);
  const demo = await post('/api/session', { demo: 'p2' });
  assert.deepEqual((await demo.json()).result, { player: 'p2', created: false });
  assert.equal(Object.keys(app.store.read().world.cities).length, 10); // 4 seats, 5 NPC kingdoms and the new city
});

test('large atlas snapshots preserve identical data while negotiating gzip with clients', async t => {
  const { request, post } = await serve(t, { clock:() => 1_800_000_000_000 });
  const enter = await post('/api/session', { entry:'new', includeState:false });
  const cookie = enter.headers.get('set-cookie').split(';')[0];
  assert.equal((await enter.json()).state, undefined);
  for (let seat = 0; seat < 20; seat++) assert.ok((await post('/api/session', { entry:'new', includeState:false })).ok);
  const plain = await request('/api/state?background=1', { headers:{ Cookie:cookie, 'Accept-Encoding':'gzip;q=0, *;q=1' } });
  const packed = await request('/api/state?background=1', { headers:{ Cookie:cookie, 'Accept-Encoding':'gzip' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal(packed.headers.get('content-encoding'), 'gzip');
  assert.equal(packed.headers.get('vary'), 'Accept-Encoding');
  assert.ok(Number(packed.headers.get('content-length')) < Number(plain.headers.get('content-length'))/2);
  assert.deepEqual(await packed.json(), await plain.json());
});
