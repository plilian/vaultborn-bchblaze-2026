// The BCH shown in the game is the whole wallet, not only its first receiving address: change and later payments of an HD
// wallet sit on other addresses. Offline fixture: an invented indexer answers for invented keys; nothing touches a chain.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';

const key = n => n.toString(16).padStart(64, '0');

test('the whole-wallet balance adds the funded receiving and change addresses the wallet shared', async t => {
  const receive = walletFromPrivateKey(key(701));
  const change = walletFromPrivateKey(key(702));
  const empty = walletFromPrivateKey(key(703));
  const funds = new Map([[receive.script, [{ satoshis: 1_000 }]], [change.script, [{ satoshis: 142_171 }, { satoshis: 29 }]]]);
  let lookups = 0;
  const reader = { tip: 900_000, lookup: async () => undefined, raw: async () => undefined, history: async () => [],
    listUnspent: async script => { lookups++; return funds.get(script) ?? []; }, broadcast: async () => { throw new Error('no broadcast in this test'); } };
  const chain = createChain({ treasuryPrivateKey: key(700), transport: { withClient: work => work(reader) } });
  const disabledAssets = { enabled:false, list:() => [], close:() => {} };
  const app = createApp({ database: ':memory:', clock: () => Date.UTC(2026, 10, 19), chain, localDemo: true, territoryAssets: disabledAssets, politicalAssets: disabledAssets });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  let cookie = '';
  const request = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('session', { demo: 'p1' })).status, 200);
  const keys = [{ path:'receive', index:0, publicKey:receive.publicKey }, { path:'receive', index:1, publicKey:empty.publicKey }, { path:'change', index:3, publicKey:change.publicKey }];
  const answer = await request('wallet/balance', { keys });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.totalSatoshis, 143_200);
  assert.equal(answer.body.checked, 3);
  assert.deepEqual(answer.body.funded.map(item => [item.path, item.index, item.address, item.satoshis]),
    [['receive', 0, receive.address, 1_000], ['change', 3, change.address, 142_200]]);
  // Asked again at once, the answer comes from the short cache, not from the indexer.
  const before = lookups;
  assert.deepEqual((await request('wallet/balance', { keys })).body, answer.body);
  assert.equal(lookups, before);
  // Only public keys on the receiving or change branch are accepted, and not too many.
  assert.equal((await request('wallet/balance', { keys: [{ path:'other', index:0, publicKey:receive.publicKey }] })).status, 400);
  assert.equal((await request('wallet/balance', { keys: [{ path:'receive', index:0, publicKey:'02' + '00'.repeat(32) }] })).status, 400);
  assert.equal((await request('wallet/balance', { keys: Array.from({ length: 49 }, (_, index) => ({ path:'receive', index, publicKey:receive.publicKey })) })).status, 400);
});
