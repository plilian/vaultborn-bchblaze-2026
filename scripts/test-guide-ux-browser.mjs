import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const storage = resolve('var');
const captures = resolve(process.env.DOMINION_BROWSER_OUTPUT ?? 'output/guide-ux');
await mkdir(storage, {recursive:true});
await mkdir(captures, {recursive:true});
const scratch = await mkdtemp(resolve(storage, 'guide-ux-'));
Object.assign(process.env,{TEMP:scratch,TMP:scratch,TMPDIR:scratch});
const offlineAssets = {enabled:false, list:()=>[], authority:()=>null, close(){}};
const chain = createChain({enabled:false, transport:{withClient(){throw new Error('The guide fixture cannot reach a chain provider.');}}});
const app = createApp({database:':memory:', localDemo:true, chain, territoryAssets:offlineAssets,
  politicalAssets:offlineAssets, clock:()=>Date.UTC(2026,10,18)});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const origin = 'http://127.0.0.1:' + app.server.address().port;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const executablePath = process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge) ? edge : undefined);
const external = [], unexpectedHttp = [], pageErrors = [], financial = [];
const button = (root,name) => root.getByRole('button',{name,exact:true});
const heading = (root,name) => root.getByRole('heading',{name,exact:true});
const shot = (page,name) => page.screenshot({path:resolve(captures,name),animations:'disabled'});
const read = async (page,name='state') => (await page.request.get(`${origin}/api/${name}`)).json();
const chapter = (dialog,id) => dialog.locator(`[data-codex-section="${id}"]`);
let browser;

async function open(viewport, mobile = false) {
  const page = await browser.newPage({viewport,isMobile:mobile,hasTouch:mobile,reducedMotion:'reduce'});
  await page.route('**/*',route=>{
    const request=route.request();
    if (!request.url().startsWith(origin+'/')) {external.push(request.url());return route.abort();}
    if (request.method()==='POST' && /\/api\/(payments|vault|wallet)/.test(request.url())) financial.push(request.url());
    return route.continue();
  });
  await page.routeWebSocket('**/*',socket=>{external.push(socket.url());socket.close();});
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('response',response=>{
    if (response.status() >= 400 && !(mobile && response.url().endsWith('/api/command') && response.status()===409))
      unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(origin+'/');
  return page;
}

async function landing(page,label) {
  const howTo = page.getByRole('navigation',{name:'Landing navigation'}).getByRole('link',{name:'How to Play',exact:true});
  await howTo.waitFor();
  const rect=await howTo.boundingBox();
  assert.ok(rect.y < 100 && rect.x + rect.width <= page.viewportSize().width);
  const play=page.getByRole('link',{name:'Play now',exact:true});
  await play.waitFor();
  assert.ok((await play.boundingBox()).y < page.viewportSize().height);
  await howTo.click();
  await page.waitForURL(origin+'/#how-to-play');
  await heading(page,'How to Play').waitFor();
  await heading(page,'Raise a kingdom').waitFor();
  await heading(page,'Earn your victories').waitFor();
  await heading(page,'Choose your allies').waitFor();
  await shot(page,`how-to-play-${label}.png`);
  const brand=page.getByText('Powered by Bitcoin Cash',{exact:true});
  await brand.scrollIntoViewIfNeeded();
  await heading(page,'Play Free. Build Your Kingdom. Discover Bitcoin Cash.').waitFor();
  for (const technology of ['Bitcoin Cash','CashTokens','Nostr']) await page.locator('.gate-technologies').getByText(technology,{exact:true}).waitFor();
  assert.equal(await page.getByText(/optional transactions/i).count(),0);
  assert.equal((await read(page,'session')).authenticated,false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('.gate-finale').screenshot({path:resolve(captures,`bitcoin-cash-${label}.png`),animations:'disabled'});
}

async function castle(page,seat) {
  await page.goto(`${origin}/?seat=${seat}`);
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  await button(nav,'My City').click();
  await button(page.locator('#campaign'),'Learn these rules').waitFor();
  return read(page);
}

async function center(dialog,page) {
  const rect=await dialog.boundingBox(),{width,height}=page.viewportSize();
  assert.ok(Math.abs(rect.x+rect.width/2-width/2)<4);
  assert.ok(Math.abs(rect.y+rect.height/2-height/2)<4);
}

try {
  browser=await chromium.launch({executablePath,env:{...process.env,TEMP:scratch,TMP:scratch,TMPDIR:scratch},
    args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking']});
  const desktop=await open({width:1440,height:900});
  await landing(desktop,'desktop');
  const before=await castle(desktop,'p1');
  const dialog=desktop.getByRole('dialog');
  await button(desktop.locator('#masthead'),'Game guide').click();
  await heading(dialog,'Game guide').waitFor();
  assert.equal(await dialog.locator('[data-codex-section]:not([hidden])').count(),11);
  const search=dialog.getByRole('searchbox',{name:'Search the guide'});
  await search.fill('shared rest window');
  await chapter(dialog,'raids').locator('.codex-entry').waitFor();
  const supply=before.config.expeditionRules.cost;
  assert.match(await chapter(dialog,'raids').innerText(),new RegExp(`${supply.wood} wood and ${supply.food} food`));
  assert.equal(await dialog.locator('[data-codex-section]:not([hidden])').count(),1);
  await shot(desktop,'codex-search-desktop.png');
  await search.fill('not-an-actual-codex-topic');
  await dialog.getByText('No chapters matched. Try a different word.',{exact:true}).waitFor();
  const chapters=dialog.getByRole('navigation',{name:'Guide chapters'});
  const seasons=button(chapters,'Seasons, rankings & rewards');
  await seasons.click();
  assert.equal(await search.inputValue(),'');
  assert.equal(await seasons.getAttribute('aria-pressed'),'true');
  await chapter(dialog,'seasons').locator('.codex-entry').waitFor();
  assert.equal(await dialog.locator('[data-codex-section]:not([hidden])').count(),1);
  await button(chapters,'All').click();
  assert.equal(await dialog.locator('[data-codex-section]:not([hidden])').count(),11);
  await button(dialog,'Close dialog').click();
  const city=desktop.locator('#campaign');
  await button(city,'Learn these rules').click();
  await chapter(dialog,'city').locator('.codex-entry').waitFor();
  assert.equal(await button(dialog,'Back to previous screen').count(),0);
  await button(dialog,'Close dialog').click();
  await city.getByRole('button',{name:/City Hall Level/}).click();
  await heading(dialog,'City Hall').waitFor();
  await button(dialog,'Learn about construction').click();
  await chapter(dialog,'city').locator('.codex-entry').waitFor();
  await button(dialog,'Back to previous screen').click();
  await heading(dialog,'City Hall').waitFor();
  await button(dialog,'Start standard upgrade').click();
  await heading(dialog,'Works commissioned').waitFor();
  await center(dialog,desktop);
  const cost=before.player.upgrades.hall.cost;
  for (const [name,spent] of Object.entries(cost)) {
    if (spent) assert.equal(await dialog.locator(`.supply-card.r-${name} b`).innerText(),`-${spent}`);
  }
  const after=await read(desktop);
  for (const [name,spent] of Object.entries(cost)) assert.equal(before.player.resources[name]-after.player.resources[name],spent);
  assert.equal(after.player.queue.filter(job=>job.kind==='building'&&job.key==='hall').length,1);
  await shot(desktop,'construction-success-desktop.png');
  await button(dialog,'Continue').click();
  await heading(dialog,'City Hall').waitFor();
  await button(dialog,'Learn about construction').click();
  await button(dialog,'Open the First Campaign').click();
  const guide=desktop.locator('#campaign-guide');
  await heading(guide,'Your banner rises').waitFor();
  await button(guide,'Close guide').click();
  assert.deepEqual((await read(desktop)).player.resources,after.player.resources);

  const mobile=await open({width:390,height:844},true);
  await landing(mobile,'mobile');
  await castle(mobile,'p2');
  const mobileDialog=mobile.getByRole('dialog');
  await button(mobile.locator('#masthead'),'Game guide').click();
  await mobileDialog.getByRole('searchbox',{name:'Search the guide'}).fill('CashTokens');
  await chapter(mobileDialog,'identity').locator('.codex-entry').waitFor();
  assert.match(await chapter(mobileDialog,'identity').innerText(),/does not move command of a city/);
  const mobileFit=await mobileDialog.boundingBox();
  assert.ok(mobileFit.x>=0 && mobileFit.x+mobileFit.width<=390);
  await shot(mobile,'codex-mobile.png');
  await button(mobileDialog,'Close dialog').click();
  await mobile.locator('#campaign').getByRole('button',{name:/City Hall Level/}).click();
  let committed;
  await mobile.route('**/api/command',async route=>{
    const order=route.request().postDataJSON();
    if (order.type!=='upgrade') return route.continue();
    const occupied=await mobile.request.post(`${origin}/api/command`,{data:{...order,requestId:randomUUID()}});
    assert.equal(occupied.status(),200,await occupied.text());
    committed=(await occupied.json()).state;
    return route.continue();
  },{times:1});
  const rejection=mobile.waitForResponse(response=>response.url().endsWith('/api/command')&&response.status()===409);
  await button(mobileDialog,'Start standard upgrade').click();
  assert.match(await (await rejection).text(),/construction slot is already in use/i);
  await heading(mobileDialog,'City Hall').waitFor();
  const error=mobileDialog.getByRole('alert');
  await error.getByText('Order could not be completed',{exact:true}).waitFor();
  await error.getByText('A construction slot is already in use.',{exact:true}).waitFor();
  await center(mobileDialog,mobile);
  const afterRejection=await read(mobile);
  assert.deepEqual(afterRejection.player.resources,committed.player.resources);
  assert.deepEqual(afterRejection.player.queue,committed.player.queue);
  assert.equal(afterRejection.player.queue.filter(job=>job.kind==='building'&&job.key==='hall').length,1);
  await shot(mobile,'construction-failure-mobile.png');
  await button(error,'Dismiss message').click();
  assert.equal(await mobileDialog.getByRole('alert').count(),0);
  await heading(mobileDialog,'City Hall').waitFor();
  await button(mobileDialog,'Start standard upgrade').waitFor({state:'visible'});
  await mobile.waitForFunction(()=>document.querySelector('#dialog button[data-command]')?.disabled===true);
  assert.equal(await button(mobileDialog,'Start standard upgrade').isDisabled(),true);
  await button(mobileDialog,'Close dialog').click();
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(unexpectedHttp,[]);
  assert.deepEqual(external,[]);
  assert.deepEqual(financial,[]);
  console.log('Desktop/mobile How to Play and BCH branding, Codex search/filter and contextual return, guide replay, centered construction success and real conflict rejection passed.');
} finally {
  await browser?.close();
  app.close();
  if (dirname(scratch)===storage) await rm(scratch,{recursive:true,force:true});
}
