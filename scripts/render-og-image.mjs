// Draws the link preview picture (Open Graph image, 1200 × 630) that chat apps and social sites show when someone shares
// the game's address. It is made from the game's own art and fonts.
//   node scripts/render-og-image.mjs [--domain vaultborn.parhamlilian.com]
// Writes apps/web/og-image.jpg. Set DOMINION_BROWSER_PATH to use a particular Chromium or Edge.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Every picture and font is embedded, so that the page needs nothing from outside.
const kinds = { webp: 'image/webp', woff2: 'font/woff2' };
const at = path => `data:${kinds[path.split('.').pop()]};base64,${readFileSync(root + path).toString('base64')}`;
const domainArg = process.argv.indexOf('--domain');
const domain = domainArg > 0 ? process.argv[domainArg + 1] : 'vaultborn.parhamlilian.com';
const escape = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Cinzel; src: url('${at('apps/web/fonts/cinzel-latin.woff2')}') format('woff2'); font-weight: 400 900; }
@font-face { font-family: Alegreya; src: url('${at('apps/web/fonts/alegreya-sans-400-latin.woff2')}') format('woff2'); font-weight: 400; }
@font-face { font-family: Alegreya; src: url('${at('apps/web/fonts/alegreya-sans-500-latin.woff2')}') format('woff2'); font-weight: 500; }
@font-face { font-family: Alegreya; src: url('${at('apps/web/fonts/alegreya-sans-700-latin.woff2')}') format('woff2'); font-weight: 700; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; background: #0b151b; color: #f6ead0; font-family: Alegreya, sans-serif; }
.stage { position: relative; width: 1200px; height: 630px; }
.art { position: absolute; inset: 0; background: url('${at('packages/assets/battlefield.webp')}') center 40% / cover no-repeat; }
.shade { position: absolute; inset: 0; background: linear-gradient(90deg, #08111add 0%, #0a141cd0 42%, #0a141c66 66%, #0a141c10 100%),
  linear-gradient(0deg, #070e14ee 0%, #070e1400 34%); }
.army { position: absolute; right: 22px; bottom: 34px; display: flex; align-items: flex-end; filter: drop-shadow(0 18px 24px #000a); }
.army img { height: 225px; margin-left: -40px; }
.army img.lead { height: 275px; }
.frame { position: absolute; inset: 18px; border: 2px solid #d9b56a99; outline: 1px solid #d9b56a44; outline-offset: 6px; }
.copy { position: absolute; left: 70px; top: 58px; width: 690px; }
.brand { display: flex; align-items: center; gap: 22px; }
.brand img { width: 92px; filter: drop-shadow(0 6px 10px #000c); }
.eyebrow { color: #e9ce99; font: 700 20px/1 Cinzel, serif; letter-spacing: .22em; margin-bottom: 10px; }
h1 { font: 800 86px/0.95 Cinzel, serif; letter-spacing: .01em; color: #f4dfae; text-shadow: 0 4px 18px #000c; }
.tagline { margin-top: 26px; font: 500 34px/1.2 Alegreya, sans-serif; color: #fff4dc; text-shadow: 0 2px 10px #000; }
ul { list-style: none; padding: 0; margin-top: 26px; display: grid; gap: 13px; }
li { position: relative; padding-left: 36px; font: 500 26px/1.2 Alegreya, sans-serif; color: #f1e5cb; text-shadow: 0 2px 8px #000; }
li::before { content: ''; position: absolute; left: 4px; top: 9px; width: 13px; height: 13px; background: #0ac18e; transform: rotate(45deg); box-shadow: 0 0 0 3px #0ac18e44; }
.foot { position: absolute; left: 70px; right: 70px; bottom: 50px; display: flex; align-items: center; gap: 18px; }
.domain { font: 700 25px/1 Alegreya, sans-serif; color: #fff; padding: 12px 20px; background: #0c1b22e6; border: 1.5px solid #d9b56a; }
.badge { font: 700 18px/1 Cinzel, serif; letter-spacing: .12em; padding: 12px 16px; color: #0b151b; background: #e8a33d; }
.badge.bch { background: #0ac18e; color: #04221a; }
</style></head><body><div class="stage">
<div class="art"></div><div class="shade"></div>
<div class="army"><img src="${at('packages/assets/unit-archer.webp')}"><img class="lead" src="${at('packages/assets/unit-cavalry.webp')}"><img src="${at('packages/assets/unit-shield.webp')}"></div>
<div class="frame"></div>
<div class="copy">
  <div class="brand"><img src="${at('apps/web/logo.webp')}"><div><div class="eyebrow">BUILD · DEFEND · CONQUER</div><h1>VaultBorn</h1></div></div>
  <p class="tagline">A kingdom strategy game on Bitcoin Cash</p>
  <ul>
    <li>Free to play in your browser, on computer or phone</li>
    <li>Raid rivals for free, or put real BCH at stake</li>
    <li>Seasons with a prize pool paid in BCH</li>
    <li>Your own wallet signs every payment</li>
  </ul>
</div>
<div class="foot"><span class="domain">${escape(domain)}</span><span class="badge bch">BITCOIN CASH</span><span class="badge">BCH BLAZE 2026</span></div>
</div></body></html>`;

const browser = await chromium.launch({ ...(process.env.DOMINION_BROWSER_PATH && { executablePath: process.env.DOMINION_BROWSER_PATH }) });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); });
await page.screenshot({ path: root + 'apps/web/og-image.jpg', type: 'jpeg', quality: 86 });
await browser.close();
console.log('apps/web/og-image.jpg written (1200 × 630) for ' + domain);
