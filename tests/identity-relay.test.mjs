// Publication and discovery of the BCH and Nostr binding over the Nostr relay protocol, against two relays started in
// this process. No public relay is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex, hex, walletFromPrivateKey } from '../packages/chain-observer/primitives.mjs';
import { bindingBchMessage, bindingEventTemplate, createBindingChallenge, publishIdentityToRelay, readIdentityFromRelay, signLocalBchProof,
  signNostrEvent, verifyIdentityHistory, verifyNostrEvent } from '../packages/decentralized-identity/index.mjs';

const run = promisify(execFile);
// The smallest relay that follows NIP-01 for this purpose: it keeps valid events and answers a "#d" filter.
function relay({ withhold = false } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const stored = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const [type, a, b] = JSON.parse(raw);
    if (type === 'EVENT') {
      const valid = verifyNostrEvent(a);
      if (valid && !stored.some((event) => event.id === a.id)) stored.push(a);
      socket.send(JSON.stringify(['OK', a.id, valid, valid ? '' : 'invalid: signature']));
    } else if (type === 'REQ') {
      const wanted = stored.filter((event) => b.kinds.includes(event.kind) && event.tags.some((tag) => tag[0] === 'd' && b['#d'].includes(tag[1])));
      for (const event of withhold ? wanted.slice(0, 1) : wanted) socket.send(JSON.stringify(['EVENT', a, event]));
      socket.send(JSON.stringify(['EOSE', a]));
    }
  }));
  return new Promise((resolve) => server.on('listening', () => resolve({ url: 'ws://127.0.0.1:' + server.address().port, stored, close: () => server.close() })));
}
const connect = (url) => new Promise((resolve, reject) => { const socket = new WebSocket(url); socket.addEventListener('open', () => resolve(socket)); socket.addEventListener('error', reject); });
function linked() {
  const bch = hex(randomBytes(32)), nostr = hex(randomBytes(32));
  const wallet = walletFromPrivateKey(bch);
  const payload = createBindingChallenge({ operation: 'link', realm: 'vaultborn:test', account: 'relay', wallet: wallet.address, bchKey: wallet.publicKey,
    nostrKey: hex(schnorr.getPublicKey(fromHex(nostr))) });
  const event = signNostrEvent(bindingEventTemplate(payload, signLocalBchProof(bch, bindingBchMessage(payload))), nostr);
  return { event, binding: verifyIdentityHistory([event]) };
}

test('a signed binding is published to a relay and verified from what the relay returns', async () => {
  const hub = await relay();
  const { event, binding } = linked();
  const writer = await connect(hub.url);
  assert.deepEqual(await publishIdentityToRelay(writer, [event]), [{ id: event.id, accepted: true, message: '' }]);
  writer.close();
  const reader = await connect(hub.url);
  const found = await readIdentityFromRelay(reader, binding.identity);
  reader.close();
  assert.equal(found.identity.head, event.id);
  assert.equal(found.identity.wallet, binding.wallet);
  assert.equal(found.identity.nostrKey, binding.nostrKey);
  hub.close();
});

test('a history that does not verify is never sent', async () => {
  const hub = await relay();
  const { event } = linked();
  const socket = await connect(hub.url);
  await assert.rejects(publishIdentityToRelay(socket, [{ ...event, content: event.content.replace('link', 'lynk') }]));
  socket.close();
  assert.equal(hub.stored.length, 0);
  hub.close();
});

test('the command-line tool publishes, discovers from each relay on its own, and authenticates both keys', async () => {
  const first = await relay(), second = await relay();
  const demo = JSON.parse((await run(process.execPath, ['scripts/identity-proof.mjs', 'demo', first.url, second.url])).stdout);
  assert.equal(demo.agreed, true);
  assert.equal(demo.authenticated, true);
  assert.deepEqual(demo.published.map((item) => item.published[0].accepted), [true, true]);
  assert.deepEqual(demo.discovered.map((item) => item.binding.head), [demo.event, demo.event]);
  assert.equal(first.stored[0].id, demo.event);

  // A second, unrelated process finds and verifies the identity knowing only its name and the relays.
  const found = JSON.parse((await run(process.execPath, ['scripts/identity-proof.mjs', 'discover', demo.identity, second.url])).stdout);
  assert.equal(found.agreed, true);
  assert.equal(found.views[0].binding.wallet, demo.wallet);

  // Publishing an exported archive, and a relay that has nothing, which must not count as agreement.
  const { event, binding } = linked();
  const archive = join(mkdtempSync(join(tmpdir(), 'identity-')), 'archive.json');
  writeFileSync(archive, JSON.stringify({ events: [event] }));
  const sent = JSON.parse((await run(process.execPath, ['scripts/identity-proof.mjs', 'publish', archive, first.url])).stdout);
  assert.equal(sent.relays[0].published[0].accepted, true);
  await assert.rejects(run(process.execPath, ['scripts/identity-proof.mjs', 'discover', binding.identity, first.url, second.url]), (error) => {
    const output = JSON.parse(error.stdout);
    return output.agreed === false && output.views[0].binding.head === event.id && Boolean(output.views[1].error);
  });
  first.close(); second.close();
});
