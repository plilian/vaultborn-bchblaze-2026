import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';
import { battleTimeline } from '../apps/web/battle-motion.js';
import { raidSpoils } from '../apps/web/battle-report.js';

const output = resolve(process.env.DOMINION_BROWSER_OUTPUT ?? 'output/playwright/battle');
await mkdir(output, { recursive: true });
await mkdir('var', { recursive: true });
const scratch = await mkdtemp(resolve('var/battle-browser-'));
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const assets = { enabled: false, list: () => [], authority: () => null, close: () => {} };
const blocked = () => { throw new Error('This replay fixture cannot access the chain.'); };
const app = createApp({
  database: ':memory:', localDemo: true,
  chain: createChain({ enabled: false, transport: { withClient: blocked } }),
  territoryAssets: assets, politicalAssets: assets,
});
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const origin = 'http://127.0.0.1:' + app.server.address().port;
let browser;
const errors = [];
const sides = ['attacker', 'defender'];
const dialog = page => page.locator('#dialog');
const click = (container, label) => container.getByRole('button', { name: label, exact: true }).click();
const take = (page, name) => page.screenshot({ path: resolve(output, name + '.png') });
const troops = (page, side) => dialog(page).locator('[data-battle-survivors=' + side + ']');

async function open({ route = '?seat=p1', mobile = false, reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: mobile, hasTouch: mobile, reducedMotion,
  });
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push('Unexpected outbound request: ' + route.request().url());
    return route.abort();
  });
  await page.routeWebSocket('**/*', socket => {
    errors.push('Unexpected WebSocket: ' + socket.url());
    socket.close();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
  await page.addInitScript(() => {
    const audio = window.Audio;
    window.replayTracks = [];
    window.Audio = new Proxy(audio, {
      construct(target, args) {
        const track = Reflect.construct(target, args);
        window.replayTracks.push(track);
        return track;
      },
    });
    window.replaySounds = 0;
    const context = window.AudioContext;
    if (context) {
      const create = context.prototype.createBufferSource;
      context.prototype.createBufferSource = function (...args) {
        window.replaySounds += 1;
        return create.apply(this, args);
      };
    }
  });
  await page.goto(origin + '/' + route);
  await page.locator('#inspector h2').waitFor();
  return page;
}

const activeSong = (page, name) => page.waitForFunction(trackName => {
  const active = window.replayTracks.filter(track => !track.paused && track.volume > .01);
  return active.length === 1 && active[0].src.endsWith('/' + trackName);
}, { frontier:'frontier-saga.mp3', battle:'battle-score.mp3' }[name]);
const seek = (page, scene, position, hit) => Promise.all([
  dialog(page).locator('#replay-seek').fill(String(Math.round(position * 20) / 20)),
  scene.locator('xpath=self::*[@data-replay-impact="' + hit + '"]').waitFor(),
]);

try {
  browser = await chromium.launch({
    executablePath: process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined),
    env: { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
    args: ['--disable-crash-reporter', '--disable-breakpad', '--disable-background-networking'],
  });
  const attacker = await open();
  const defender = await open({ route: '?seat=p2', mobile: true, reducedMotion: 'reduce' });
  await click(attacker.locator('#inspector'), 'Attack');
  await click(dialog(attacker), 'Launch free raid');
  const raid = attacker.waitForResponse(response => response.url() === origin + '/api/command');
  await click(dialog(attacker), 'Confirm attack');
  const order = await raid;
  assert.equal(order.status(), 200);
  const { result } = await order.json();
  const { trace, verified } = await attacker.evaluate(async id => (await fetch('/api/public/battle/' + id + '?cinematic=1')).json(), result.id);
  assert.equal(verified, true);
  const timeline = battleTimeline(result, trace);
  assert.equal(timeline.traced, true);
  const scene = dialog(attacker).locator('.replay-scene[data-replay-trace=verified]');
  await scene.waitFor();
  assert.equal(await dialog(attacker).locator('[data-battle-result]').isVisible(), false);
  // The battle just fought plays by itself; the result, the reward popup of a won attack and the replay follow.
  await activeSong(attacker, 'battle');
  await attacker.waitForFunction(() => window.replaySounds > 0);
  await click(dialog(attacker), 'Show result');
  await dialog(attacker).getByRole('heading', { name: result.winner === 'attacker' ? 'VICTORY' : 'DEFEAT', exact: true }).waitFor();
  if (raidSpoils(result, result.attacker)) {
    await dialog(attacker).getByRole('heading', { name: 'Your rewards' }).waitFor();
    await click(dialog(attacker), 'Continue');
  }
  await click(dialog(attacker), 'Replay battle');
  await activeSong(attacker, 'battle');
  await click(dialog(attacker), 'Pause replay');
  const pausedAt = await dialog(attacker).locator('#replay-meter').getAttribute('style');
  await attacker.waitForFunction(() => window.replayTracks.every(track => track.paused));
  assert.equal(await dialog(attacker).locator('#replay-meter').getAttribute('style'), pausedAt);

  const exchange = timeline.rounds.find(round => round.event.attackerLoss || round.event.defenderLoss);
  assert.ok(exchange, 'At least one observed exchange must produce a casualty.');
  const before = (exchange.impact - 60) * 100 / timeline.duration;
  const after = (exchange.impact + 430) * 100 / timeline.duration;
  await seek(attacker, scene, before, false);
  for (const side of sides) assert.equal(Number(await troops(attacker, side).innerText()), exchange.before[side]);
  await seek(attacker, scene, after, true);
  for (const side of sides) assert.equal(Number(await troops(attacker, side).innerText()), exchange.event[side + 'Remaining']);
  await take(attacker, 'battle-impact');

  await click(dialog(attacker), 'Show result');
  const won = result.winner === 'attacker';
  await dialog(attacker).getByRole('heading', { name: won ? 'VICTORY' : 'DEFEAT', exact: true }).waitFor();
  await attacker.waitForFunction(() => window.replayTracks.every(track => track.paused));
  await take(attacker, 'battle-result-desktop');
  const final = result.events.at(-1);
  for (const side of sides) assert.equal(Number(await troops(attacker, side).innerText()), final[side + 'Remaining']);
  await click(dialog(attacker), 'Close dialog');
  await activeSong(attacker, 'frontier');

  // The defender is told at once, in a popup with the result, and opens the report from there.
  await dialog(defender).getByRole('heading', { name: won ? 'Your city was raided' : 'Attack repelled', exact: true }).waitFor();
  await click(dialog(defender), 'Battle report');
  await dialog(defender).locator('.replay-scene[data-replay-trace=verified]').waitFor();
  await click(dialog(defender), 'Show result');
  await dialog(defender).getByRole('heading', { name: won ? 'DEFEAT' : 'VICTORY', exact: true }).waitFor();
  assert.equal(await dialog(defender).evaluate(box => box.scrollWidth <= box.clientWidth), true);
  await take(defender, 'battle-result-mobile');
  await click(dialog(defender), 'Replay battle');
  await dialog(defender).getByRole('button', { name: 'Pause replay', exact: true }).waitFor();
  assert.equal(await dialog(defender).locator('[data-battle-result]').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Two-seat battle replay passed: exact casualty timing, solo battle music, pause and scrub, desktop/mobile victory and defeat, campaign score restored.');
} finally {
  await browser?.close();
  app.close();
  if (dirname(scratch) === resolve('var')) await rm(scratch, { recursive: true, force: true });
}
