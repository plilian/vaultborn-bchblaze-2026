import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const adminToken = 'local-citadel-fixture-'.padEnd(40,'v');
const app = createApp({ database: ':memory:', chain: createChain({ enabled: false }), adminToken });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const base = 'http://127.0.0.1:' + app.server.address().port;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await mkdir('var', { recursive: true });
const scratch = await mkdtemp(resolve('var','citadel-browser-'));
const browserEnv = { ...process.env, TEMP:scratch, TMP:scratch, TMPDIR:scratch };
const browser = await chromium.launch({ executablePath: process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined),
  env: browserEnv, args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking'] });
try {
  const output = resolve('output/playwright');
  await mkdir(output,{recursive:true});
  const desktop = await browser.newPage({ viewport:{width:1440,height:900} });
  const mobile = await browser.newPage({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  const errors = [];
  for (const page of [desktop, mobile]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/ledger.html');
    await page.getByRole('heading',{ name:'Chain Explorer', exact:true }).waitFor();
    await page.getByRole('link',{ name:'Council & sponsors', exact:true }).click();
    await page.getByRole('heading',{ name:'The Council', exact:true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'),'en-US');
    assert.equal(await page.locator('select').count(),0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  }
  const login = await desktop.request.post(base+'/api/session',{data:{},headers:{origin:base}});
  assert.ok(login.ok(),await login.text());
  await desktop.reload();
  await desktop.getByText('Request a sponsorship slot',{ exact:true }).click();
  await desktop.getByLabel('Sponsor name').fill('Alden Smiths');
  await desktop.getByLabel('Campaign title').fill('Foundry Cup');
  await desktop.getByLabel('Sponsor website').fill('https://example.com');
  const localInput = minutes => {
    const time = new Date(Date.now() + minutes * 60000);
    return new Date(+time - time.getTimezoneOffset()*60000).toISOString().slice(0,16);
  };
  await desktop.getByLabel('Starts (your local time)').fill(localInput(12));
  await desktop.getByLabel('Ends (your local time)').fill(localInput(90));
  await desktop.getByRole('button',{name:'Request campaign approval'}).click();
  await desktop.getByRole('heading',{name:'Foundry Cup'}).waitFor();
  await desktop.getByText('Campaign approval and council transfers',{exact:true}).click();
  await desktop.getByLabel('Administrator token').fill(adminToken);
  await desktop.getByRole('button',{name:'Unlock'}).click();
  await desktop.getByRole('button',{name:'Approve', exact:true}).click();
  await desktop.getByRole('button',{name:'Pay 5,000 sat',exact:true}).waitFor();
  await desktop.screenshot({path:resolve(output,'vaultborn-council-desktop.png'), fullPage:true});
  await mobile.screenshot({path:resolve(output,'vaultborn-council-mobile.png'),fullPage:true});
  const battle = await desktop.evaluate(async () => {
    const response = await fetch('/api/command', { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ type:'attack', target:'p2' }) });
    return (await response.json()).result;
  });
  await desktop.goto(base + '/verify/battle/' + battle.id);
  await desktop.getByText('Matches archived result',{exact:true}).waitFor();
  await desktop.screenshot({path:resolve(output,'vaultborn-battle-verification.png'),fullPage:true});
  for (const page of [desktop,mobile]) {
    await page.goto(base + '/verify/territory/east-meadow');
    await page.getByRole('heading',{name:'East Meadow',exact:true}).waitFor();
    await page.getByRole('link',{name:'Open complete record (JSON)'}).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  }
  await desktop.screenshot({path:resolve(output,'vaultborn-territory-verification.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('Desktop and mobile explorer, campaign submission, admin approval, and independent battle report passed.');
} finally {
  await browser.close();
  const closed = once(app.server,'close');
  app.close();
  await closed;
}
