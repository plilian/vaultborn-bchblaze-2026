import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const storage = resolve('var');
await mkdir(storage, { recursive:true });
const scratch = await mkdtemp(resolve(storage,'frontier-browser-'));
const captures = resolve(process.env.DOMINION_BROWSER_OUTPUT ?? 'output/frontier-browser');
await mkdir(captures,{recursive:true});
const blocked = () => { throw new Error('The atlas fixture has no chain access.'); };
const assets = {enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
const app = createApp({database:':memory:',localDemo:false,clock:()=>Date.UTC(2026,10,18),
  chain:createChain({enabled:false,transport:{withClient:blocked}}),territoryAssets:assets,politicalAssets:assets});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const origin = `http://127.0.0.1:${app.server.address().port}`;
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const errors = [];
const external = [];
const finance = [];
let browser;

const button = (container,name) => container.getByRole('button',{name,exact:true});
const heading = (container,name) => container.getByRole('heading',{name,exact:true});
const game = page => page.evaluate(()=>JSON.parse(window.render_game_to_text()));
const state = async page => (await page.request.get(origin+'/api/state')).json();
const screenshot = (page,name) => page.screenshot({path:resolve(captures,name)});

async function fillCore() {
  for (let index=0;index<34;index++) {
    const response = await fetch(origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({entry:'new',includeState:false})});
    const result = await response.json();
    assert.equal(response.status,200,JSON.stringify(result));
    assert.equal(result.result.created,true);
    assert.equal(result.state,undefined);
  }
}

async function found(page,name) {
  await page.route('**/*',route=>{
    const request = route.request();
    if (new URL(request.url()).origin!==origin) {
      external.push(request.url());
      return route.abort();
    }
    if (request.method()==='POST' && /\/api\/(payments|vault|wallet)/.test(request.url())) finance.push(request.url());
    return route.continue();
  });
  await page.routeWebSocket('**/*',socket=>{external.push(socket.url());socket.close();});
  page.on('pageerror',error=>errors.push(error.stack ?? error.message));
  page.on('response',response=>{if(response.status()>=400) errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(origin+'/');
  await page.getByRole('link',{name:'Play now',exact:true}).first().click();
  const dialog = page.getByRole('dialog');
  await heading(dialog,'Found a city').waitFor();
  await dialog.getByLabel('Commander name',{exact:true}).fill('Warden Arden');
  await dialog.getByLabel('Settlement name',{exact:true}).fill(name);
  await button(dialog,'Found city').click();
  // A new kingdom is greeted once: this test takes the tutorial.
  await button(dialog,'Start the tutorial').click();
  await heading(dialog,'Connect your wallet').waitFor();
  await button(dialog,'Not now').click();
  const guide = page.locator('#campaign-guide');
  await heading(guide,'Your banner rises').waitFor();
  const fresh = await state(page);
  const home = fresh.atlas.regions.find(region=>region.id===fresh.atlas.homeRegion);
  assert.notEqual(home.id,'core');
  assert.ok(home.x>0||home.y>0);
  assert.equal(fresh.player.region,home.id);
  assert.equal((await game(page)).map.region,home.id);
  const starter = fresh.territories.filter(site=>site.protected&&site.owner===fresh.player.id);
  assert.equal(starter.length,1);
  assert.deepEqual([starter[0].x,starter[0].y],[fresh.player.x,fresh.player.y]);
  await button(guide,'Skip').click();
  await button(guide,'Skip tutorial').click();
  await heading(dialog,'First banner raised').waitFor();
  await button(dialog,'Continue').click();
  return {home,player:fresh.player,starter:starter[0]};
}

async function chooseRegion(page,id) {
  const regions = page.getByRole('navigation',{name:'World regions'});
  await regions.locator('summary').click();
  await regions.locator(`[data-region-pick="${id}"]`).click();
  await page.waitForFunction(region=>JSON.parse(window.render_game_to_text()).map.region===region,id);
  assert.equal(await page.locator('#world-stage').getAttribute('data-region'),id);
}

async function verifyMarkers(page,region) {
  const snapshot = await state(page);
  const expected = new Map(snapshot.cities.filter(city=>(city.region??'core')===region.id).map(city=>[city.id,city]));
  const expectedSites = new Map(snapshot.territories.filter(site=>(site.region??'core')===region.id).map(site=>[site.id,site]));
  const found = await page.locator('#world-cities').evaluate(root=>{
    const entries = selector=>[...root.querySelectorAll(selector)].map(item=>({
      id:item.dataset.target ?? item.dataset.id,x:parseFloat(item.style.left)/100,y:parseFloat(item.style.top)/100,
    }));
    return {cities:entries('.world-city'),sites:entries('.territory-marker')};
  });
  for (const [records,list] of [[expected,found.cities],[expectedSites,found.sites]]) {
    assert.equal(list.length,records.size);
    for (const marker of list) {
      const original=records.get(marker.id);
      assert.ok(original,`Found ${marker.id} outside the selected region.`);
      assert.ok(marker.x>=0&&marker.x<=1&&marker.y>=0&&marker.y<=1);
      assert.ok(Math.abs(marker.x-(original.x-region.x))<1e-5);
      assert.ok(Math.abs(marker.y-(original.y-region.y))<1e-5);
    }
  }
}

async function verifyBounds(page) {
  await page.waitForFunction(()=>{
    const viewport = document.querySelector('#world').getBoundingClientRect();
    const fringe = [...document.querySelectorAll('.atlas-fringe i')].map(item=>item.getBoundingClientRect());
    return fringe.length===8 && Math.min(...fringe.map(item=>item.left))<=viewport.left+1 &&
      Math.max(...fringe.map(item=>item.right))>=viewport.right-1 &&
      Math.min(...fringe.map(item=>item.top))<=viewport.top+1 &&
      Math.max(...fringe.map(item=>item.bottom))>=viewport.bottom-1;
  });
}

async function limitPan(page,key) {
  await page.locator('#world').focus();
  await page.locator('#world').evaluate((world,direction)=>{
    for (let index=0;index<100;index++) world.dispatchEvent(new KeyboardEvent('keydown',{key:direction,bubbles:true,cancelable:true}));
  },key);
  await verifyBounds(page);
}

try {
  await fillCore();
  browser = await chromium.launch({executablePath:process.env.DOMINION_BROWSER_PATH ?? (existsSync(edge)?edge:undefined),
    env:{...process.env,TEMP:scratch,TMP:scratch,TMPDIR:scratch},
    args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking']});
  const desktop = await browser.newPage({viewport:{width:1440,height:900}});
  const claimed = await found(desktop,'Meadowgate');
  const core = (await state(desktop)).atlas.regions.find(region=>region.id==='core');
  await verifyMarkers(desktop,claimed.home);
  await verifyBounds(desktop);
  await screenshot(desktop,'expanded-home-desktop.png');
  await chooseRegion(desktop,core.id);
  await verifyMarkers(desktop,core);
  await screenshot(desktop,'core-desktop.png');
  await chooseRegion(desktop,claimed.home.id);
  await verifyMarkers(desktop,claimed.home);
  for (let click=0;click<12;click++) await button(desktop,'Zoom in').click();
  assert.equal((await game(desktop)).map.zoom,2.75);
  for (const direction of ['ArrowLeft','ArrowUp','ArrowRight','ArrowDown']) await limitPan(desktop,direction);
  assert.ok((await game(desktop)).map.pan.every(value=>Math.abs(value)>1));
  await screenshot(desktop,'expanded-bounded-pan.png');
  for (let click=0;click<20;click++) await button(desktop,'Zoom out').click();
  const zoom = (await game(desktop)).map.zoom;
  assert.ok(zoom>=.82&&zoom<1.15);
  await verifyBounds(desktop);

  const mobile = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const mobileClaim = await found(mobile,'Larkford');
  await verifyMarkers(mobile,mobileClaim.home);
  assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await screenshot(mobile,'expanded-home-mobile.png');
  await chooseRegion(mobile,core.id);
  await verifyMarkers(mobile,core);
  await chooseRegion(mobile,mobileClaim.home.id);
  const touch = await mobile.context().newCDPSession(mobile);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:135,y:370,id:1},{x:245,y:370,id:2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:65,y:325,id:1},{x:310,y:416,id:2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.waitForFunction(()=>JSON.parse(window.render_game_to_text()).map.zoom>1.25);
  await verifyBounds(mobile);
  await screenshot(mobile,'expanded-pinch-mobile.png');
  const beforeDrag = (await game(mobile)).map.pan;
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:175,y:400,id:3}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:359,y:570,id:3}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.notDeepEqual((await game(mobile)).map.pan,beforeDrag);
  await verifyBounds(mobile);
  await mobile.reload();
  await mobile.waitForFunction(home=>window.render_game_to_text&&JSON.parse(window.render_game_to_text()).map.region===home,mobileClaim.home.id);
  await verifyMarkers(mobile,mobileClaim.home);
  assert.deepEqual(finance,[]);
  assert.deepEqual(external,[]);
  assert.deepEqual(errors,[]);
  console.log(`Expanded-region atlas passed on desktop and mobile. ${claimed.home.name} and ${mobileClaim.home.name} home plots survived navigation and reload, marker coordinates matched, and bounded pan and pinch stayed inside terrain.`);
} finally {
  await browser?.close();
  app.close();
  if (dirname(scratch)===storage) await rm(scratch,{recursive:true,force:true});
}
