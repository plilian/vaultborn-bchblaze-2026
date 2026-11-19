// Takes the pictures shown in README.md from a local, isolated game (in-memory save, no blockchain connection).
//   node scripts/capture-readme-images.mjs            writes docs/images/*.jpg
// Set DOMINION_BROWSER_PATH to use a particular Chromium or Edge.
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';
import { WebSocketServer } from 'ws';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const out = new URL('../docs/images/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(out, { recursive: true });
// A relay inside this script, so that the wallet pairing code can be drawn. No wallet connects.
const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(relay, 'listening');
relay.on('connection', socket => socket.on('message', raw => { const [type, id] = JSON.parse(String(raw)); if (type === 'REQ') socket.send(JSON.stringify(['EOSE', id])); }));
const app = createApp({ database: ':memory:', chain: createChain({ enabled: false }), localDemo: true, testWizardRelay: 'ws://127.0.0.1:' + relay.address().port });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const origin = 'http://127.0.0.1:' + app.server.address().port;
const browser = await chromium.launch({ ...(process.env.DOMINION_BROWSER_PATH && { executablePath: process.env.DOMINION_BROWSER_PATH }) });
const shot = (page, name) => page.screenshot({ path: out + name + '.jpg', type: 'jpeg', quality: 84 });
const pause = ms => new Promise(done => setTimeout(done, ms));
const closeDialogs = page => page.evaluate(() => { document.querySelector('#dialog')?.close(); const guide = document.querySelector('#campaign-guide'); if (guide) guide.hidden = true; });

// The start page and the wallet connection
const visitor = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await visitor.goto(origin + '/');
await visitor.getByRole('button', { name: /^Connect wallet/ }).waitFor();
await pause(1500);
await shot(visitor, 'landing');
await visitor.getByRole('button', { name: /^Connect wallet/ }).click();
await visitor.getByRole('button', { name: 'Selene Wallet', exact: true }).click();
await visitor.getByRole('img', { name: 'WizardConnect pairing code' }).waitFor({ timeout: 20_000 });
await pause(500);
await shot(visitor, 'connect-wallet');
await visitor.close();

// A kingdom that has been played: Riverhold, the first demo seat
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(origin + '/?seat=p1');
await page.locator('.wallet-shortcut').first().waitFor({ timeout: 30_000 });
await pause(1200); await closeDialogs(page); await pause(300);
await page.locator('.world-city').filter({ hasText: 'Ironhaven' }).first().click().catch(() => {});
await pause(600);
await shot(page, 'world-map');
const go = async (pageName, tab) => { await closeDialogs(page); await page.locator(`[data-page="${pageName}"]`).first().dispatchEvent('click'); await pause(500);
  if (tab) { await page.locator(`#campaign [data-tab="${tab}"]`).first().dispatchEvent('click'); await pause(500); } };
await go('city', 'heroes');
await shot(page, 'commanders');
await go('war');
await shot(page, 'war-room');
await page.locator('#campaign').getByRole('button', { name: 'Plan raid' }).first().dispatchEvent('click'); await pause(900);
await page.locator('#dialog').getByRole('button', { name: 'Launch free raid' }).click(); await pause(300);
await page.locator('#dialog').getByRole('button', { name: 'Confirm attack' }).click(); await pause(2500);
await shot(page, 'battle-report');
await go('politics');
await shot(page, 'politics');
await go('rankings');
await shot(page, 'season');
await page.close();

// The map on a phone
const phone = await browser.newContext({ ...devices['iPhone 13'] });
const mobile = await phone.newPage();
await mobile.goto(origin + '/?seat=p2');
await mobile.locator('.wallet-shortcut').first().waitFor({ timeout: 30_000 }).catch(() => {});
await pause(1500); await closeDialogs(mobile); await pause(300);
await mobile.screenshot({ path: out + 'mobile.jpg', type: 'jpeg', quality: 84 });
await browser.close(); app.close(); relay.close();
console.log('Pictures written to docs/images.');
process.exit(0);
