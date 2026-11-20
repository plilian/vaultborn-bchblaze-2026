import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const storage = resolve('var');
await mkdir(storage,{recursive:true});
const scratch = await mkdtemp(resolve(storage,'npc-browser-'));
const captures = resolve(process.env.DOMINION_BROWSER_OUTPUT ?? 'output/dynamic-npc-browser');
await mkdir(captures,{recursive:true});
const blocked = () => { throw new Error('NPC browser fixtures cannot access a blockchain.'); };
const assets = {enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
const start = Date.UTC(2026,10,18);
const app = createApp({database:':memory:',localDemo:false,clock:()=>start,
  chain:createChain({enabled:false,transport:{withClient:blocked}}),territoryAssets:assets,politicalAssets:assets});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const origin = `http://127.0.0.1:${app.server.address().port}`;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const errors = [];
const finance = [];
const outbound = [];
let browser;

const button = (scope,name) => scope.getByRole('button',{name,exact:true});
const heading = (scope,name) => scope.getByRole('heading',{name,exact:true});
const dialog = page => page.getByRole('dialog');
const shot = (page,name) => page.screenshot({path:resolve(captures,name)});
const state = async page => (await page.request.get(origin+'/api/state')).json();
const go = (page,name) => page.getByRole('tab',{name,exact:true}).click();
const war = page => button(page.getByRole('navigation',{name:'Main navigation'}),'War').click();
const close = page => button(dialog(page),'Close dialog').click();

async function newKingdom(name,mobile=false) {
  const page = await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900},
    isMobile:mobile,hasTouch:mobile,reducedMotion:mobile?'reduce':'no-preference'});
  await page.route('**/*',route=>{
    const request = route.request();
    if (new URL(request.url()).origin!==origin) {
      outbound.push(request.url());
      return route.abort();
    }
    if (request.method()==='POST' && /\/api\/(payments|vault|wallet)/.test(request.url())) finance.push(request.url());
    return route.continue();
  });
  await page.routeWebSocket('**/*',socket=>{outbound.push(socket.url());socket.close();});
  page.on('pageerror',error=>errors.push(error.stack ?? error.message));
  page.on('response',response=>{if(response.status()>=400) errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(origin+'/');
  await page.getByRole('link',{name:'Play now',exact:true}).first().click();
  await heading(dialog(page),'Found a city').waitFor();
  await dialog(page).getByLabel('Commander name',{exact:true}).fill('Warden Arden');
  await dialog(page).getByLabel('Settlement name',{exact:true}).fill(name);
  await button(dialog(page),'Found city').click();
  // A new kingdom is greeted once: the tutorial, the instructions, or skip. This test takes the tutorial and skips it.
  await button(dialog(page),'Start the tutorial').click();
  await heading(dialog(page),'Connect your wallet').waitFor();
  await button(dialog(page),'Not now').click();
  const guide = page.locator('#campaign-guide');
  await button(guide,'Skip').click();
  await button(guide,'Skip tutorial').click();
  await heading(dialog(page),'First banner raised').waitFor();
  await button(dialog(page),'Continue').click();
  assert.equal((await state(page)).player.optIn,true);   // in the season from day one
  return page;
}

try {
  browser = await chromium.launch({executablePath:process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge)?edge:undefined),
    env:{...process.env,TEMP:scratch,TMP:scratch,TMPDIR:scratch},
    args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking']});
  const desktop = await newKingdom('Brightshore');
  await war(desktop);
  await go(desktop,'Expeditions');
  const npcList = desktop.getByRole('heading',{name:'NPC kingdoms',exact:true}).locator('..');
  const town = npcList.locator('.row').filter({hasText:'Millbrook'});
  await button(town,'Plan expedition').click();
  await heading(dialog(desktop),'Expedition to Millbrook').waitFor();
  await dialog(desktop).getByRole('button',{name:/^Formation /}).click();
  await dialog(desktop).getByRole('option',{name:'Spearhead',exact:true}).click();
  await shot(desktop,'expedition-orders.png');
  await button(dialog(desktop),'Lead expedition').click();
  await dialog(desktop).locator('[data-replay-trace="verified"]').waitFor();
  await button(dialog(desktop),'Show result').click();
  await heading(dialog(desktop),'Expedition supplies spent').waitFor();
  const report = (await state(desktop)).battles.find(item=>item.kind==='expedition');
  assert.equal(report.input.attacker.formation,'wedge');
  assert.equal(report.paid,false);
  assert.equal((await state(desktop)).player.attacksLeft,3);
  await shot(desktop,'expedition-result.png');

  const mobile = await newKingdom('Brookwatch',true);
  await war(mobile);
  await go(mobile,'Territories');
  const eligible = (await state(mobile)).territories.find(site=>site.frontierEligibility?.ok);
  assert.ok(eligible);
  await button(mobile.locator('.territory-row').filter({hasText:eligible.name}),'Inspect').click();
  await heading(dialog(mobile),eligible.name).waitFor();
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await shot(mobile,'camp-orders-mobile.png');
  await button(dialog(mobile),'Lead camp expedition').click();
  await dialog(mobile).locator('[data-replay-trace="verified"]').waitFor();
  await button(dialog(mobile),'Show result').click();
  await dialog(mobile).locator('.conquest-banner').getByText(/Occupation ends/).waitFor();
  const changed = await state(mobile);
  assert.equal(changed.battles[0].kind,'frontier-conquest');
  assert.equal(changed.battles[0].winner,'attacker');
  const captured = changed.territories.find(site=>site.id===eligible.id);
  assert.equal(captured.owner,changed.player.id);
  assert.equal(captured.frontierOccupationUntil,start+48*60*60_000);
  assert.equal(changed.payments.length,0);
  await shot(mobile,'camp-conquered-mobile.png');

  await close(desktop);
  const freehold = npcList.locator('.row').filter({hasText:'Frostwatch'});
  await button(freehold,'Visit court').click();
  await heading(dialog(desktop),'Court of Frostwatch').waitFor();
  await button(dialog(desktop),'Send envoy').click();
  await heading(dialog(desktop),'Ceasefire signed').waitFor();
  await shot(desktop,'npc-ceasefire.png');
  assert.ok((await state(desktop)).diplomacy.treaties.some(treaty=>treaty.kind==='ceasefire'&&treaty.status==='active'));
  assert.deepEqual(outbound,[]);
  assert.deepEqual(finance,[]);
  assert.deepEqual(errors,[]);
  console.log('NPC ceasefire, saved expedition orders, verified battle, and mobile camp occupation passed without payment or network access.');
} finally {
  await browser?.close();
  app.close();
  if (dirname(scratch)===storage) await rm(scratch,{recursive:true,force:true});
}
