// Link previews: the start page and the game page carry Open Graph and Twitter tags whose addresses are the address the
// page was requested at, and the preview picture is served.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const get = (port, path, host) => new Promise((done, failed) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { Host: host } }, res => {
    const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  });
  req.on('error', failed); req.end();
});
const tag = (html, attribute, name) => (html.match(new RegExp(`<meta ${attribute}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)">`)) ?? [])[1];

test('the start page and the game page carry link-preview tags for the address they were reached at', async t => {
  const app = createApp({ database: ':memory:', chain: createChain({ enabled: false }), localDemo: false });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { const closed = once(app.server, 'close'); app.close(); await closed; });
  const port = app.server.address().port;
  for (const path of ['/', '/play']) {
    const page = await get(port, path, 'vaultborn.example.org');
    assert.equal(page.status, 200);
    const html = page.body.toString('utf8');
    assert.equal(Number(page.headers['content-length']), page.body.length, 'the length matches the filled-in page');
    assert.ok(!html.includes('__SITE__'));
    assert.equal(tag(html, 'property', 'og:image'), 'http://vaultborn.example.org/og-image.jpg');
    assert.equal(tag(html, 'property', 'og:url'), 'http://vaultborn.example.org/');
    assert.equal(tag(html, 'name', 'twitter:card'), 'summary_large_image');
    assert.equal(tag(html, 'property', 'og:image:width'), '1200');
    assert.match(tag(html, 'property', 'og:title'), /VaultBorn/);
  }
  // A Host header that is not a plain host name never reaches the page; the addresses stay relative.
  const odd = (await get(port, '/', 'a_b.example')).body.toString('utf8');
  assert.equal(tag(odd, 'property', 'og:image'), '/og-image.jpg');
  const picture = await get(port, '/og-image.jpg', 'vaultborn.example.org');
  assert.equal(picture.status, 200);
  assert.equal(picture.headers['content-type'], 'image/jpeg');
  assert.ok(picture.body.length > 20_000);
  assert.deepEqual([...picture.body.subarray(0, 2)], [0xff, 0xd8], 'a JPEG file');
});
