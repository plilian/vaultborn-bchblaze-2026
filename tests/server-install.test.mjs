// The installation behind an existing nginx, exercised against a make-believe server (tests/support/server-install.mjs).
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeServer } from './support/server-install.mjs';

const DOMAIN = 'vaultborn.203-0-113-10.sslip.io';
const skip = process.platform === 'win32' ? 'needs bash' : false;
const untouched = (server, before) => { for (const name of server.others) assert.equal(readFileSync(join(server.paths.nginx, 'sites-enabled', name), 'utf8'), before[name], name + ' was changed'); };
const snapshot = server => Object.fromEntries(server.others.map(name => [name, readFileSync(join(server.paths.nginx, 'sites-enabled', name), 'utf8')]));

test('installs the game beside the existing sites and changes none of them', { skip }, () => {
  const server = makeServer();
  const before = snapshot(server);
  const result = server.run(DOMAIN);
  assert.equal(result.code, 0, result.err + result.out);
  assert.match(result.out, /INSTALLED: https:\/\/vaultborn\.203-0-113-10\.sslip\.io \(game on 127\.0\.0\.1:4274/);   // 4273 is taken on the make-believe server
  assert.equal(readFileSync(join(server.paths.app, 'port'), 'utf8').trim(), '4274');
  assert.deepEqual(server.enabled(), [...server.others, 'vaultborn-' + DOMAIN + '.conf'].sort());
  untouched(server, before);
  const site = server.site(DOMAIN);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:4274;/);
  assert.match(site, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  // Reachable exactly like the other sites: IPv4 and, because they use it, IPv6.
  for (const line of ['listen 80;', 'listen [::]:80;', 'listen 443 ssl;', 'listen [::]:443 ssl;']) assert.ok(site.includes('    ' + line), line);
  assert.equal((site.match(/server_name /g) ?? []).length, 2);
  const calls = server.calls();
  // nginx is only ever tested and reloaded, never restarted or stopped; every reload follows a passed test.
  assert.ok(calls.every(call => !/systemctl (restart|stop)/.test(call)));
  assert.ok(calls.filter(call => call.startsWith('systemctl')).every(call => call === 'systemctl reload nginx'));
  const certbot = calls.find(call => call.startsWith('certbot'));
  assert.match(certbot, /^certbot certonly --webroot -w .*acme -d vaultborn\.203-0-113-10\.sslip\.io /);
  assert.ok(!certbot.includes('--register-unsafely-without-email'));   // the server's existing certificate account is used
  // Docker is only used inside the project "vaultborn".
  assert.ok(calls.filter(call => call.startsWith('docker compose') && !call.includes('version')).every(call => call.startsWith('docker compose -p vaultborn -f ')));
  assert.ok(calls.includes('port=4274'));
});

test('a second run updates the game and requests no second certificate', { skip }, () => {
  const server = makeServer();
  assert.equal(server.run(DOMAIN).code, 0);
  const result = server.run(DOMAIN);
  assert.equal(result.code, 0, result.err);
  assert.equal(server.calls().filter(call => call.startsWith('certbot')).length, 1);
  assert.equal(readFileSync(join(server.paths.app, 'port'), 'utf8').trim(), '4274');
});

test('stops before any change when the existing nginx configuration already has a problem', { skip }, () => {
  const server = makeServer();
  server.flag('nginx-broken');
  const result = server.run(DOMAIN);
  assert.equal(result.code, 1);
  assert.match(result.err, /nginx reports a problem in its present configuration.*Nothing was changed/);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
  assert.ok(!server.calls().some(call => /compose .* (build|up)/.test(call)));
});

test('refuses a host name that another site on the server already answers for', { skip }, () => {
  const server = makeServer();
  const result = server.run('www.other.example.org');
  assert.equal(result.code, 1);
  assert.match(result.err, /another site on this server already answers for www\.other\.example\.org/);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
});

test('a game that does not start leaves the web server untouched', { skip }, () => {
  const server = makeServer();
  server.flag('game-down');
  // The script waits 40 × 5 seconds for the game; a stand-in "sleep" returns at once.
  writeFileSync(join(server.paths.bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n'); chmodSync(join(server.paths.bin, 'sleep'), 0o755);
  const result = server.run(DOMAIN);
  assert.equal(result.code, 1);
  assert.match(result.err, /the game did not start\. The web server was not touched\. The game's containers were stopped again/);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
  assert.ok(!server.calls().some(call => call.startsWith('systemctl') || call.startsWith('certbot')));
  // Not left restarting over and over.
  assert.ok(server.calls().some(call => /^docker compose .* down$/.test(call)));
});

test('the check of the site is repeated while nginx starts its new workers, and a silent site is reported with its last answer', { skip }, () => {
  const slow = makeServer();
  slow.flag('site-slow');
  const ok = slow.run(DOMAIN);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(ok.out.includes('INSTALLED: https://' + DOMAIN));
  const silent = makeServer();
  silent.flag('site-silent');
  const failed = silent.run(DOMAIN);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /The last answer was: curl: \(60\) SSL: no alternative certificate subject name matches/);
  assert.ok(failed.err.includes('STOPPED: the site is installed, but https://' + DOMAIN + '/api/health did not answer as expected.'));
  assert.equal(silent.calls().filter(call => call.startsWith('curl ')).length, 24);
});

test('no certificate: the site is taken out of nginx again and the other sites are as before', { skip }, () => {
  const server = makeServer();
  const before = snapshot(server);
  server.flag('certbot-fails');
  const result = server.run(DOMAIN);
  assert.equal(result.code, 1);
  assert.match(result.err, /no certificate could be obtained.*The site was removed from nginx again/);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
  assert.equal(server.site(DOMAIN), null);
  untouched(server, before);
});

test('nginx refusing the new site: it is removed and nginx is not reloaded', { skip }, () => {
  const server = makeServer();
  server.flag('nginx-rejects-site');
  const result = server.run(DOMAIN);
  assert.equal(result.code, 1);
  assert.match(result.err, /nginx did not accept the new site, so it was removed again and nginx was not reloaded/);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
  assert.ok(!server.calls().includes('systemctl reload nginx'));
});

test('nginx refusing the HTTPS site: the certificate-only site is put back', { skip }, () => {
  const server = makeServer();
  server.flag('nginx-rejects-https');
  const result = server.run(DOMAIN);
  assert.equal(result.code, 1);
  assert.match(result.err, /nginx did not accept the HTTPS site, so the previous state was restored/);
  assert.ok(!server.site(DOMAIN).includes('listen 443'));
});

test('an nginx that does not read the sites folder gets nothing added', { skip }, () => {
  const server = makeServer();
  server.flag('nginx-ignores-folder');
  const result = server.run(DOMAIN);
  assert.equal(result.code, 1);
  assert.match(result.err, /does not load site files/);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
});

test('remove takes the game and its site away and leaves the rest', { skip }, () => {
  const server = makeServer();
  const before = snapshot(server);
  assert.equal(server.run(DOMAIN).code, 0);
  const result = server.run(DOMAIN, 'remove');
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(server.enabled(), server.others.slice().sort());
  untouched(server, before);
  assert.ok(server.calls().some(call => /^docker compose -p vaultborn -f .* down$/.test(call)));
});

test('refuses anything that is not a host name', { skip }, () => {
  const server = makeServer();
  for (const bad of ['a b.example.org', 'x.example.org; rm -rf /', '../etc', 'UPPER.example.org', 'nodot']) {
    const result = server.run(bad);
    assert.equal(result.code, 1, bad);
    assert.match(result.err, /is not a host name\. Nothing was changed/);
  }
  assert.equal(server.calls().length, 0);
});
