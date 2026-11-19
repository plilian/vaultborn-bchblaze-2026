// The BCH BLAZE home page banner: only real, well-formed values are shown, and the page renders them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blazeBanner } from '../config/blaze.mjs';
import { covenantNode } from './support/covenant-node.mjs';

const none = new URL('./no-such-file.json', import.meta.url);
// A valid Mainnet address made of a zero key hash; it is a well-known burn address and belongs to nobody here.
const PLAIN = 'bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603';

test('the committed banner file names the repository and leaves the two owner values open', () => {
  const saved = JSON.parse(readFileSync(new URL('../config/blaze.json', import.meta.url), 'utf8'));
  assert.equal(saved.repository, 'https://github.com/plilian/vaultborn-bchblaze-2026');
  const banner = blazeBanner({ environment: {} });
  assert.equal(banner.repository, saved.repository);
  if (!saved.presentation) assert.ok(banner.missing.includes('presentation link'));
  if (!saved.emberAddress) assert.ok(banner.missing.includes('EMBER2026 CashTokens address'));
});

test('values are taken only when they are real links and Mainnet addresses, and the address is shown token-aware', () => {
  const banner = blazeBanner({ file: none, environment: { BLAZE_PRESENTATION_URL: 'https://docs.google.com/presentation/d/example', BLAZE_REPOSITORY_URL: 'javascript:alert(1)',
    BLAZE_EMBER_ADDRESS: PLAIN } });
  assert.equal(banner.presentation, 'https://docs.google.com/presentation/d/example');
  assert.equal(banner.repository, '');
  assert.match(banner.emberAddress, /^bitcoincash:z/);
  assert.equal(banner.emberFromDeveloperAddress, false);
  assert.deepEqual(banner.missing, ['repository link']);
  assert.equal(blazeBanner({ file: none, environment: { BLAZE_EMBER_ADDRESS: 'bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603' } }).emberAddress, '');
  assert.equal(blazeBanner({ file: none, environment: { BLAZE_EMBER_ADDRESS: PLAIN.slice(0, -1) + 'x' } }).emberAddress, '');
});

test('without an address of its own the banner uses the token-aware form of the developer address, and it can be switched off', () => {
  const banner = blazeBanner({ file: none, environment: {}, developmentAddress: PLAIN });
  assert.match(banner.emberAddress, /^bitcoincash:z/);
  assert.equal(banner.emberFromDeveloperAddress, true);
  assert.equal(blazeBanner({ file: none, environment: {}, developmentAddress: 'bchtest:qq' }).emberAddress, '');
  assert.deepEqual(blazeBanner({ file: none, environment: { BLAZE_BANNER: 'off' } }), { enabled: false });
});

test('the server gives the home page its banner data and the page has the banner as its first element', async () => {
  const node = await covenantNode();
  try {
    const origin = 'http://127.0.0.1:' + node.app.server.address().port;
    const script = await (await fetch(origin + '/blaze.js')).text();
    assert.match(script, /^export const BLAZE = Object\.freeze\(\{"enabled":true,"event":"BCH BLAZE 2026"/);
    assert.ok(!script.includes('missing'));
    const page = await (await fetch(origin + '/')).text();
    assert.ok(page.indexOf('id="blaze-banner"') > 0 && page.indexOf('id="blaze-banner"') < page.indexOf('class="gate-header"'));
  } finally { await node.close(); }
});
