import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hdTestWallet, pairingEntry } from '../tests/support/paired-wallet.mjs';

const output = resolve(process.env.DOMINION_BROWSER_OUTPUT ?? 'output/playwright');
await mkdir(output, { recursive:true });
await mkdir('var', { recursive:true });
const scratch = await mkdtemp(resolve('var/browser-'));
Object.assign(process.env,{TEMP:scratch,TMP:scratch,TMPDIR:scratch});
const browserEnv = { ...process.env, TEMP:scratch, TMP:scratch, TMPDIR:scratch };
const installedEdge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const executablePath = process.env.DOMINION_BROWSER_PATH ?? (existsSync(installedEdge) ? installedEdge : undefined);

let now = Date.now();
// The final financial configuration: one developer address and an independent attestor. Both keys exist only in this run.
const developer = walletFromPrivateKey(randomBytes(32).toString('hex'));
const attestor = walletFromPrivateKey(randomBytes(32).toString('hex'));
// The seat's wallet is an HD wallet, so the browser can hold a WizardConnect pairing for it (its relay never answers).
const seatWallet = hdTestWallet();
const testRelay = 'ws://127.0.0.1:64262';
const chain = createChain({ treasuryPrivateKey:randomBytes(32).toString('hex'), developmentAddress:developer.address, prizeAttestors:[attestor.publicKey], transport:{
  withClient: work => work({tip:36008, block:async () => '01'+'00'.repeat(79), history:async () => [], listUnspent:async()=>[]}),
} });
const assets={enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
const { server, close, store } = createApp({ database:':memory:', localDemo:true, chain, clock:() => now,
  territoryAssets:assets,politicalAssets:assets,testWizardRelay:testRelay });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath,env:browserEnv,args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking'] });
const errors = [];

async function loopbackOnly(page) {
  await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await page.routeWebSocket('**/*',socket=>{socket.close();});
}
async function open(viewport, route = '', mobile = false) {
  const page = await browser.newPage({viewport, isMobile:mobile, hasTouch:mobile, ...(process.env.DOMINION_BROWSER_REDUCED_MOTION==='true' && {reducedMotion:'reduce'})});
  await loopbackOnly(page);
  // A checkout that was left unpaid announces its expiry in a dialog whenever the simulated clock passes it, which can be in the
  // middle of any later step. The notice is logged and closed, as a player would close it, before the step's own click.
  await page.addLocatorHandler(page.locator('dialog[open]').filter({hasText:/expired\s+chipnet/i}), async notice => {
    console.log('Expired checkout notice closed: '+(await notice.innerText()).replace(/\s+/g,' ').slice(0,80));
    await notice.getByRole('button',{name:'Close dialog',exact:true}).click();
  });
  page.on('pageerror',error => errors.push(error.stack??error.message));
  page.on('response',response => {
    if (response.status() >= 400) errors.push(response.status() + ' ' + response.url());
  });
  await page.goto(origin + (route ? '/' + route : '/play'));
  await page.locator('#inspector h2').waitFor();
  return page;
}
const shot = (page,file) => page.screenshot({path:resolve(output,file)});
async function mapHasNoEdgeGap(page) {
  await page.waitForFunction(()=>{
    const viewport=document.querySelector('#world').getBoundingClientRect();
    const fringe=[...document.querySelectorAll('.atlas-fringe i')].map(item=>item.getBoundingClientRect());
    return Math.min(...fringe.map(r=>r.left))<=viewport.left+.75&&Math.max(...fringe.map(r=>r.right))>=viewport.right-.75&&
      Math.min(...fringe.map(r=>r.top))<=viewport.top+.75&&Math.max(...fringe.map(r=>r.bottom))>=viewport.bottom-.75;
  });
}
const dialog = page => page.locator('dialog');
const clickButton = (container,name) => container.getByRole('button',{name,exact:true}).click();
async function clickAndWait(page, container, name, route = '/api/command') {
  // A click that lands while the panel is being redrawn sends nothing. It is repeated once the panel is still; a click that did send is never repeated.
  for (let attempt = 0; ; attempt += 1) {
    const pending = page.waitForResponse(response => response.url().endsWith(route) && response.request().method() === 'POST', {timeout:attempt < 2 ? 8_000 : 30_000})
      .catch(error => { if (attempt < 2) return null; throw error; });
    // An expired checkout announces itself in a dialog with the next state the page receives; a click outside it would wait behind it.
    if (!(await container.evaluate(node => Boolean(node.closest('dialog'))).catch(() => true))) await closeRaised(page, 0);
    await container.getByRole('button',{name,exact:true}).click({timeout:attempt < 2 ? 8_000 : 30_000}).catch(error => { if (attempt >= 2) throw error; });
    const response = await pending;
    if (!response) continue;
    assert.equal(response.ok(),true,await response.text());
    return;
  }
}
const closeDialog = (page) => clickButton(dialog(page),'Close dialog');
// Advancing the clock can raise a dialog over the page (an expired checkout, a report). It is noted and closed before the next click.
async function closeRaised(page, wait = 400) {
  if (wait) await page.waitForTimeout(wait);
  if (!(await dialog(page).evaluate(node=>node.open))) return;
  console.log('Dialog raised over the page, closed: '+(await dialog(page).innerText()).replace(/\s+/g,' ').slice(0,160));
  await closeDialog(page);
}
// The main navigation is never used from inside a dialog: one that is still open, or opens while the click waits, is logged and closed first.
const openNav = async (page,name) => {
  const item = page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name,exact:true});
  for (let attempt = 0; ; attempt += 1) {
    await closeRaised(page, attempt ? 300 : 0);
    try { await item.click({timeout:attempt < 3 ? 6_000 : 30_000}); return; } catch (error) { if (attempt >= 3) throw error; }
  }
};
// A tab inside a panel that is still animating is clicked as soon as it exists, and a click that landed on a tab bar being redrawn is repeated until the tab is the selected one.
const openTab = async (page,name) => {
  const tab = page.getByRole('tab',{name,exact:true});
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await tab.waitFor();
    await tab.click({timeout:8_000}).catch(() => tab.click({force:true,timeout:8_000}).catch(() => {}));
    if (await tab.getAttribute('aria-selected',{timeout:2_000}).catch(() => null) === 'true') return;
    await page.waitForTimeout(300);
  }
  throw new Error('The '+name+' tab did not open');
};
const fetchState = async page => page.evaluate(async () => (await fetch('/api/state')).json());
async function progress(page,ms) {
  now += ms;
  await page.evaluate(async () => {
    const response = await fetch('/api/command', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'configure',requestId:crypto.randomUUID()}),
    });
    if (!response.ok) throw new Error('Clock synchronization failed');
  });
}
async function quoteState(page, amount, heading) {
  const box = dialog(page);
  await box.getByRole('heading',{name:heading,exact:true}).waitFor();
  assert.match(await box.innerText(), new RegExp(amount + ' sat'));
  // The outputs are one click away, in the payment details.
  await box.getByText('Payment details',{exact:true}).click();
  await box.getByRole('heading',{name:'Outputs',exact:true}).waitFor();
  await box.getByRole('heading',{name:'WizardConnect',exact:true}).waitFor();
  assert.equal(await box.getByLabel('Broadcast transaction ID').count(),0);
  assert.match(await box.innerText(), /Awaiting wallet payment/i);
  console.log('Chipnet intent prepared:',heading,'(' + amount + ' sat)');
}
try {
  const page = await open({width:1440,height:900},'?seat=p1');
  const front = await fetchState(page);
  assert.equal(front.player.name,'Riverhold');
  assert.equal(front.cities.length,9); // 4 seats and 5 NPC kingdoms
  assert.equal(await page.locator('#inspector h2').innerText(),'Ironhaven');
  await shot(page,'world-1440x900.png');
  await page.setViewportSize({width:1920,height:1080});
  await shot(page,'world-1920x1080.png');
  await page.setViewportSize({width:1440,height:900});
  await clickButton(page,'Zoom in');
  assert.ok(JSON.parse(await page.evaluate(() => window.render_game_to_text())).map.zoom > 1);
  await clickButton(page,'Reset view');
  for(let i=0;i<4;i++) await clickButton(page,'Zoom out');
  await page.locator('#world').focus();
  for(let i=0;i<14;i++) {await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowDown');}
  await mapHasNoEdgeGap(page);
  assert.equal(await page.evaluate(async()=>{await document.fonts.ready; return document.fonts.check('700 24px "Vault Cinzel"')&&document.fonts.check('400 16px "Vault Alegreya"');}),true);
  await shot(page,'atlas-fringe.png');
  await clickButton(page,'Reset view');
  await page.getByRole('button',{name:/^Ironhaven level/}).click({button:'right'});
  await page.getByRole('menu',{name:'City orders'}).getByRole('menuitem',{name:'Inspect city'}).click();

  await clickButton(page.locator('#inspector'),'Scout');
  await dialog(page).getByText('Basic Reconnaissance').waitFor();
  await dialog(page).locator('.mission-row').first().getByRole('button',{name:'Dispatch'}).click();
  await dialog(page).getByRole('heading',{name:'Scout mission dispatched',exact:true}).waitFor();
  assert.match(await dialog(page).innerText(),/scout points spent/);
  await clickButton(dialog(page),'Continue');
  await dialog(page).getByRole('heading',{name:'Underway'}).waitFor();
  await closeDialog(page);
  await progress(page,16_000);
  assert.notEqual((await fetchState(page)).missions[0].status,'pending');
  console.log('World selection, zoom, scout dispatch and mission resolution passed');

  await openNav(page,'My City');
  await clickButton(page.locator('#campaign'),'Daily supplies');
  await clickButton(dialog(page),'Claim daily supplies');
  await dialog(page).getByRole('heading',{name:'Reward claimed',exact:true}).waitFor();
  assert.equal(await dialog(page).locator('.supply-card').count(),5);
  await shot(page,'daily-reward.png');
  await clickButton(dialog(page),'Continue');
  await clickButton(page.locator('#campaign'),'Daily supplies');
  await dialog(page).getByText(/Already claimed/).waitFor();
  assert.equal(await dialog(page).getByRole('button',{name:'Claim daily supplies'}).count(),0);
  await closeDialog(page);
  await page.getByRole('button',{name:/City Hall Level/}).click();
  await clickButton(dialog(page),'Start standard upgrade');
  await dialog(page).getByRole('heading',{name:'Works commissioned'}).waitFor();
  await clickButton(dialog(page),'Continue');
  await dialog(page).getByText('Construction finishes').waitFor();
  // Paid services are locked to the payer's own wallet: without a verified wallet no payment is prepared.
  const unverified = await page.request.post(origin + '/api/payments',{data:{type:'rush',building:'hall'}});
  assert.equal(unverified.status(),403);
  assert.match((await unverified.json()).error,/Connect your wallet first/);
  store.bindWallet('p1',seatWallet.address,seatWallet.publicKey,now);
  // Linked to the kingdom, but not connected in this browser: a pay button opens the wallet dialog, never a checkout.
  await clickButton(dialog(page),'Rush upgrade · 0.00020000 BCH');
  await dialog(page).getByRole('heading',{name:'Chipnet wallet',exact:true}).waitFor();
  assert.match(await dialog(page).innerText(),/Connect your wallet first/);
  assert.equal(((await fetchState(page)).payments ?? []).length,0,'no checkout is prepared without a connected wallet');
  await clickButton(dialog(page),'Other WizardConnect wallet');
  await dialog(page).getByRole('img',{name:'WizardConnect pairing QR code'}).waitFor();
  assert.match(await dialog(page).getByRole('link',{name:'Open in wallet'}).getAttribute('href'),/^wiz:\/\//);
  await shot(page,'wallet-required.png');
  await clickButton(dialog(page),'Cancel pairing');
  await closeDialog(page);
  // The player pairs the wallet (here: the pairing as the browser keeps it). Connected, the same buttons go straight to checkout.
  const pairing = pairingEntry('p1',testRelay,seatWallet);
  await page.evaluate(([key,value]) => localStorage.setItem(key,value),[pairing.key,pairing.value]);
  await page.reload();
  await page.locator('#inspector h2').waitFor();
  await openNav(page,'My City');
  await page.getByRole('button',{name:/City Hall Level/}).click();
  await clickButton(dialog(page),'Rush upgrade · 0.00020000 BCH');
  await quoteState(page,'20,000','Rush City Hall');
  // The payer's own transaction makes four exact outputs; the one network reserve is shown on top of the price.
  assert.match((await dialog(page).innerText()).replace(/\s+/g,' '),/Your War Chest · always at risk 10,000 sat Development 4,000 sat Season reward share 4000 \+ network reserve 300 4,300 sat Burn 2,000 sat/);
  assert.match((await dialog(page).innerText()).replace(/\s+/g,' '),/Your wallet sends 20,300 sats \(incl\. 300 sat network reserve\)/);
  await closeDialog(page);
  await page.getByRole('button',{name:/City Hall Level/}).click();
  await clickButton(dialog(page),'Upgrade with BCH · 0.00022000 BCH');
  await quoteState(page,'22,000','City Hall premium upgrade');
  await dialog(page).getByRole('button',{name:'Approve with wallet',exact:true}).waitFor();
  await shot(page,'payment-intent.png');
  await closeDialog(page);
  // Construction takes real time from level 2 on: wait until this one is done.
  const building = (await fetchState(page)).player.queue.find(job => job.kind === 'building');
  await progress(page,building.completesAt - now + 1_000);
  assert.equal((await fetchState(page)).player.buildings.hall,front.player.buildings.hall+1);

  await openTab(page,'Army');
  await page.locator('.troop-tile').first().getByRole('button',{name:'Train',exact:true}).click();
  await dialog(page).getByRole('heading',{name:'Base combat attributes'}).waitFor();
  await dialog(page).getByLabel('Recruits',{exact:true}).fill('1');
  await clickButton(dialog(page),'Queue recruits');
  await dialog(page).getByRole('heading',{name:'Training ordered'}).waitFor();
  await clickButton(dialog(page),'Continue');
  await dialog(page).waitFor({ state:'hidden' });
  await progress(page,3_000);
  assert.equal((await fetchState(page)).player.troops.infantry,front.player.troops.infantry+1);
  for (const tab of ['Commanders','Defense','Research','Marketplace','Inventory']) {
    await openTab(page,tab);
    assert.ok((await page.locator('#campaign').innerText()).length > 200);
  }
  await openTab(page,'Commanders');
  await page.locator('.hero-card').first().getByRole('button',{name:'Review commander'}).click();
  await dialog(page).getByRole('heading',{name:'Active traits'}).waitFor();
  await dialog(page).getByRole('heading',{name:'Equipment fittings'}).waitFor();
  await shot(page,'commander-progression.png');
  await closeDialog(page);
  await openTab(page,'Marketplace');
  await page.getByText('You receive',{exact:true}).waitFor();
  await shot(page,'marketplace.png');
  const beforeTrade = (await fetchState(page)).player.resources.stone;
  await clickAndWait(page,page.locator('#campaign'),'Exchange');
  await dialog(page).getByRole('heading',{name:'Trade completed'}).waitFor();
  await shot(page,'trade-completed.png');
  await clickButton(dialog(page),'Continue');
  assert.ok((await fetchState(page)).player.resources.stone > beforeTrade);
  await openTab(page,'Research');
  await clickAndWait(page,page.locator('#campaign .tiles .tile').first(),'Research');
  await dialog(page).getByRole('heading',{name:'Research under way'}).waitFor();
  await clickButton(dialog(page),'Continue');
  await progress(page,46_000);
  assert.equal((await fetchState(page)).player.tech.logistics,1);
  console.log('Standard construction completion, paid upgrade/rush checkout, recruitment and city tabs passed');

  const defender = await open({width:1220,height:860},'?seat=p2');
  assert.equal((await fetchState(defender)).player.name,'Ironhaven');
  await openNav(page,'Map');
  await page.getByRole('button',{name:/Stonevale level/}).click();
  await clickButton(page.locator('#inspector'),'Attack');
  await dialog(page).getByRole('heading',{name:'Unknown defenses'}).waitFor();
  await closeDialog(page);
  await clickButton(page.locator('#inspector'),'Protectorate');
  await dialog(page).getByText('0.00024000 BCH',{exact:true}).waitFor();
  await clickButton(dialog(page),'Prepare Chipnet proposal');
  await quoteState(page,'24,000','Protectorate offer to Stonevale');
  await closeDialog(page);

  await page.getByRole('button',{name:/Ironhaven level/}).click();
  await clickButton(page.locator('#inspector'),'Attack');
  await dialog(page).getByRole('heading',{name:'Ready army'}).waitFor();
  await dialog(page).getByRole('heading',{name:(await fetchState(page)).intel.p2?'Scouting estimate':'Unknown defenses'}).waitFor();
  const previews=new Set();
  page.on('request',request=>{if(request.url().includes('/api/attack-preview?')) previews.add(request.url());});
  await dialog(page).getByRole('button',{name:/Tactic/}).click();
  await page.getByRole('option',{name:'Siege',exact:false}).click();
  await dialog(page).getByText(/Siege stance reduces fortification pressure/).waitFor();
  assert.ok([...previews].some(url=>new URL(url).searchParams.get('tactic')==='siege'));
  await shot(page,'raid-dossier.png');
  await page.setViewportSize({width:1280,height:720});
  await page.waitForFunction(()=>{
    const box=document.querySelector('#dialog').getBoundingClientRect();
    const launch=document.querySelector('#dialog .raid-launch').getBoundingClientRect();
    return launch.height>0&&launch.top>=box.top&&launch.bottom<=box.bottom;
  });
  await shot(page,'raid-dossier-short.png');
  await page.setViewportSize({width:1440,height:900});
  // Ironhaven holds no War Chest. Under matched stakes a paid raid needs a defender with the same amount at risk, so it
  // is not offered here, and nothing can be ticked to force it. The free raid stays available.
  const stakes=(await dialog(page).locator('[data-raid-stakes]').innerText()).replace(/\s+/g,' ');
  assert.match(stakes,/Paid raid: matched stakes/);
  assert.match(stakes,/has not connected a wallet, so there is no War Chest to match your stake|cannot cover the smallest stake/);
  assert.equal(await dialog(page).getByRole('button',{name:'Prepare paid raid · stake from 0.00010000 BCH'}).isDisabled(),true);
  assert.equal(await dialog(page).locator('[name=acceptNoReward]').count(),0);
  assert.equal(await dialog(page).getByRole('button',{name:'Launch free raid'}).isDisabled(),false);
  await closeDialog(page);
  const audioSettings=await page.request.post(origin+'/api/command',{
    data:{type:'settings',muted:false,musicVolume:24,sfxVolume:18,requestId:'browser-battle-audio-settings'},
  });
  assert.equal(audioSettings.ok(),true,await audioSettings.text());
  await page.evaluate(()=>{
    const created=new Set();
    const mediaPlay=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(...args){
      created.add(this);
      return mediaPlay.apply(this,args);
    };
    window.battleMusicAudit=()=>[...created].filter(track=>!track.paused).map(track=>new URL(track.src).pathname);
  });
  await clickButton(page.locator('#inspector'),'Attack');
  const battlesBeforeReview=(await fetchState(page)).battles.length;
  await clickButton(dialog(page),'Launch free raid');
  await clickButton(dialog(page),'Keep planning');
  assert.equal((await fetchState(page)).battles.length,battlesBeforeReview);
  await clickButton(dialog(page),'Launch free raid');
  await clickButton(dialog(page),'Confirm attack');
  await dialog(page).getByRole('button',{name:'Play battle replay'}).waitFor();
  await dialog(page).locator('.replay-scene[data-replay-trace=verified]').waitFor();
  assert.equal(await dialog(page).locator('[data-battle-result]').isVisible(),false);
  await clickButton(dialog(page),'Play battle replay');
  await dialog(page).locator('#replay-status').getByText(/Round/).waitFor();
  await dialog(page).locator('.battle-canvas').waitFor();
  await page.waitForFunction(()=>window.battleMusicAudit().includes('/art/battle-score.mp3'));
  assert.deepEqual(await page.evaluate(()=>window.battleMusicAudit()),['/art/battle-score.mp3']);
  await dialog(page).locator('#replay-seek').fill('54');
  await dialog(page).locator('#replay-status').getByText('Engagement · Round 5',{exact:true}).waitFor();
  await shot(page,'battle-report.png');
  await clickButton(dialog(page),'Show result');
  await dialog(page).getByRole('heading',{name:/^(VICTORY|DEFEAT)$/}).waitFor();
  const playedBattle=(await fetchState(page)).battles[0];
  const lastExchange=playedBattle.events.at(-1);
  assert.equal((await dialog(page).locator('[data-battle-survivors=attacker]').innerText()).replace(/,/g,''),String(lastExchange.attackerRemaining));
  assert.equal((await dialog(page).locator('[data-battle-survivors=defender]').innerText()).replace(/,/g,''),String(lastExchange.defenderRemaining));
  await shot(page,'battle-result.png');
  assert.equal((await fetchState(page)).player.attacksLeft, front.player.attacksLeft-1);
  assert.equal((await fetchState(defender)).battles.length,1);
  await closeDialog(page);
  await page.waitForFunction(()=>window.battleMusicAudit().includes('/art/frontier-score.mp3'));
  assert.deepEqual(await page.evaluate(()=>window.battleMusicAudit()),['/art/frontier-score.mp3']);
  console.log('Protectorate/paid attack quote, free raid, replay and two-session combat synchronization passed');

  await openNav(page,'Alliance');
  for (const tab of ['Diplomacy','War council','Chat']) await openTab(page,tab);
  await page.locator('#campaign form').first().getByLabel('Message',{exact:true}).fill('Frontier dispatch verified');
  await clickButton(page.locator('#campaign form').first(),'Send');
  await page.locator('#campaign').getByText('Frontier dispatch verified').waitFor();
  assert.ok((await fetchState(defender)).messages.some(item => item.text === 'Frontier dispatch verified'));
  await openTab(page,'Diplomacy');
  await clickButton(page.locator('#campaign'),'Issue diplomatic order');
  await dialog(page).getByRole('button',{name:/^Order /}).press('ArrowDown');
  await dialog(page).getByRole('option',{name:'Trade accord'}).press('Enter');
  await clickButton(dialog(page),'Issue order');
  await page.locator('#campaign').getByText('Trade Accord',{exact:true}).waitFor();
  await openNav(defender,'Alliance');
  await openTab(defender,'Diplomacy');
  await clickAndWait(defender,defender.locator('#campaign'),'Accept');
  assert.equal((await fetchState(defender)).treaties.find(item => item.kind === 'trade').status,'active');

  await openNav(page,'Politics');
  const politics = page.locator('#campaign');
  await politics.getByRole('heading',{name:'Politics & Diplomacy',exact:true}).waitFor();
  await politics.getByRole('button',{name:'Ironhaven',exact:true}).click();
  await politics.getByRole('complementary',{name:'Selected kingdom'}).getByRole('heading',{name:'Ironhaven',exact:true}).waitFor();
  await clickButton(politics,'View on world map');
  assert.equal(await page.getByRole('button',{name:'Toggle political overlay'}).getAttribute('aria-pressed'),'true');
  await openNav(page,'Politics');
  await page.getByRole('button',{name:/^Resource taxation /}).click();
  await page.getByRole('option',{name:'Balanced · 8%'}).click();
  await clickAndWait(page,politics,'Adopt policy');
  assert.equal((await fetchState(page)).government.kingdom.tax,'balanced');
  await politics.getByText('Policy review in').waitFor();
  await openTab(page,'Treaties');
  await clickButton(politics,'Propose treaty');
  const offer = dialog(page);
  await offer.getByLabel('Written terms',{exact:true}).fill('Safe passage for both kingdoms');
  await clickAndWait(page,offer,'Send proposal');
  await offer.waitFor({state:'hidden'});
  await openNav(defender,'Politics');
  await openTab(defender,'Treaties');
  await clickButton(defender.locator('#campaign'),'Review terms');
  await dialog(defender).getByText('Safe passage for both kingdoms',{exact:true}).waitFor();
  await clickAndWait(defender,dialog(defender),'Accept terms');
  assert.equal((await fetchState(defender)).diplomacy.treaties.find(item=>item.kind==='peace').status,'active');
  await defender.locator('#political-outcome').getByText('PEACE SIGNED',{exact:true}).waitFor();
  await shot(defender,'politics-peace-signed.png');
  await clickButton(defender.locator('#political-outcome'),'Review dispatch');
  await defender.getByRole('tabpanel',{name:'Treaties',exact:true}).waitFor();
  for (const tab of ['Conflicts','Trade & Sanctions','Council & Federations','Chronicle']) await openTab(defender,tab);
  await openTab(page,'Treaties');
  await clickButton(politics,'Propose treaty');
  await offer.getByRole('button',{name:/^Agreement /}).click();
  await offer.getByRole('option',{name:'Trade agreement',exact:true}).click();
  await clickAndWait(page,offer,'Send proposal');
  await openTab(defender,'Treaties');
  await clickButton(defender.locator('#campaign'),'Review terms');
  await clickAndWait(defender,dialog(defender),'Accept terms');
  await openTab(page,'Trade & Sanctions');
  await clickButton(politics,'Establish trade route');
  await clickAndWait(page,offer,'Register route');
  await clickButton(politics,'Ship resources');
  await clickAndWait(page,offer,'Dispatch shipment');
  assert.equal((await fetchState(page)).diplomacy.shipments[0].status,'in-transit');
  await progress(page,241_000);
  assert.equal((await fetchState(page)).diplomacy.shipments[0].status,'delivered');
  await openTab(page,'Council & Federations');
  await clickButton(politics,'Contribute resources');
  await clickAndWait(page,offer,'Contribute resources');
  assert.equal((await fetchState(page)).diplomacy.council.treasury.wood,50);
  await clickButton(politics,'Submit motion');
  await offer.getByRole('button',{name:/^Motion /}).click();
  await offer.getByRole('option',{name:'Treasury policy',exact:true}).click();
  await offer.getByRole('button',{name:/^Treasury policy /}).click();
  await offer.getByRole('option',{name:/^Reserve /}).click();
  await clickAndWait(page,offer,'Call vote');
  await clickButton(politics,'Cast vote');
  await clickAndWait(page,offer,'Record ballot');
  assert.equal((await fetchState(page)).diplomacy.council.proposals[0].votes.p1,'yes');
  const pageDispatch = page.locator('#political-outcome').getByRole('button',{name:'Dismiss',exact:true});
  if (await pageDispatch.isVisible()) await pageDispatch.click();
  await openTab(page,'Government');
  await openNav(page,'Politics');
  await shot(page,'politics-government.png');
  console.log('Political atlas, policy change, two-seat treaties, cinematic dispatch, cargo delivery and council ballots passed');

  await openNav(page,'War');
  for (const tab of ['Intelligence','Protectorates','Territories']) await openTab(page,tab);
  assert.equal(await page.locator('.territory-atlas .territory-section').count(),7);
  await page.locator('.territory-atlas').getByRole('heading',{name:'Frontier camps',exact:true}).waitFor();
  await page.locator('.territory-row').filter({hasText:'Silver Mine'}).getByRole('button',{name:'Inspect',exact:true}).click();
  await dialog(page).getByRole('heading',{name:'Silver Mine'}).waitFor();
  await dialog(page).getByRole('link',{name:'Verify territory activity'}).waitFor();
  await closeDialog(page);
  await shot(page,'vaultborn-territory-atlas.png');

  await openNav(page,'Vault');
  // One treasury: no separate protected deposit is offered. A direct deposit goes into the War Chest, unsplit.
  assert.equal(await page.locator('#campaign').getByRole('button',{name:'Deposit BCH',exact:true}).count(),0);
  await clickButton(page.locator('#campaign'),'Fund War Chest');
  await dialog(page).getByRole('checkbox').check();
  await clickButton(dialog(page),'Create payment intent');
  await quoteState(page,'10,000','War chest funding');
  await closeDialog(page);
  await openNav(page,'Rankings');
  for (const tab of ['Alliances','Archive','Cities']) await openTab(page,tab);
  await shot(page,'season-rankings.png');

  const otherKey = randomBytes(32).toString('hex');
  const otherWallet = walletFromPrivateKey(otherKey);
  const otherChallenge = await defender.request.post(origin + '/api/wallet/challenge',{data:{address:otherWallet.address}});
  assert.equal(otherChallenge.ok(),true,await otherChallenge.text());
  const otherProof = signWalletChallenge(otherKey,(await otherChallenge.json()).result.challenge);
  const linked = await defender.request.post(origin + '/api/wallet/verify',{data:{
    address:otherWallet.address,publicKey:otherProof.publicKey,signature:otherProof.signature,
  }});
  assert.equal(linked.ok(),true,await linked.text());
  await openNav(page,'Politics');
  await openTab(page,'Treaties');
  await clickButton(politics,'Propose treaty');
  await offer.getByRole('button',{name:/^Agreement /}).click();
  await offer.getByRole('option',{name:'Reparations & compensation',exact:true}).click();
  await offer.getByRole('button',{name:/^Compensation /}).click();
  await offer.getByRole('option',{name:'BCH escrow',exact:true}).click();
  await offer.getByLabel('BCH compensation in sats').fill('2000');
  await clickAndWait(page,offer,'Send proposal');
  await openTab(defender,'Treaties');
  await clickButton(defender.locator('#campaign'),'Review terms');
  await dialog(defender).getByText('0.00002000 BCH in escrow',{exact:true}).waitFor();
  await clickAndWait(defender,dialog(defender),'Accept terms');
  assert.equal((await fetchState(defender)).diplomacy.treaties.find(item=>item.kind==='reparations').status,'awaiting-funding');
  await clickButton(politics,'Fund compensation');
  assert.equal(await offer.getByRole('checkbox').isChecked(),false);
  await offer.getByRole('checkbox').check();
  await clickButton(offer,'Review escrow payment');
  await quoteState(page,'2,650','Treaty compensation escrow');
  await closeDialog(page);

  const campaignPlayer = (await fetchState(page)).player;
  if (!campaignPlayer.tutorial) {
    await clickButton(page,'Profile and settings');
    await clickButton(dialog(page),'Play tutorial');
    await clickAndWait(page,dialog(page),'Complete tutorial');
    await dialog(page).waitFor({state:'hidden'});
  }
  if (campaignPlayer.shieldUntil >= now) await progress(page,campaignPlayer.shieldUntil-now+1);
  await openNav(page,'War');
  await openTab(page,'Territories');
  await page.locator('.territory-row').filter({hasText:'East Meadow'}).getByRole('button',{name:'Inspect',exact:true}).click();
  await dialog(page).getByRole('heading',{name:'East Meadow',exact:true}).waitFor();
  await shot(page,'vaultborn-territory-claim.png');
  assert.match(await dialog(page).innerText(),/Open claim/);
  await clickButton(dialog(page),'Open claim · 6,600 sats');
  await quoteState(page,'6,600','Enter claim for East Meadow');
  await closeDialog(page);

  // A wallet that cannot pair: the player disconnects the paired one and verifies another receiving address with a signed message.
  await page.locator('button.wallet-shortcut').click();
  await clickButton(dialog(page),'Disconnect wallet');
  await dialog(page).getByRole('button',{name:'Other WizardConnect wallet',exact:true}).waitFor();
  await dialog(page).getByText('Other way: verify an address with a signed message',{exact:true}).click();
  const fixtureSecret = randomBytes(32).toString('hex');
  const localWallet = walletFromPrivateKey(fixtureSecret);
  await dialog(page).getByLabel('Chipnet CashAddr',{exact:true}).fill(localWallet.address);
  await clickButton(dialog(page),'Create ownership challenge');
  const challenge = await dialog(page).locator('.wallet-challenge').textContent();
  const walletProof = signWalletChallenge(fixtureSecret,challenge);
  await dialog(page).getByLabel('Compressed public key (legacy proof only)',{exact:true}).fill(walletProof.publicKey);
  await dialog(page).getByLabel('Ownership signature',{exact:true}).fill(walletProof.signature);
  await clickButton(dialog(page),'Verify ownership');
  await dialog(page).getByText('Wallet verified',{exact:true}).waitFor();
  assert.equal((await fetchState(page)).wallet.address,localWallet.address);
  await dialog(page).getByRole('button',{name:'Refresh balance'}).waitFor();
  await shot(page,'wallet-linked.png');
  await closeDialog(page);

  await clickButton(page,'Profile and settings');
  await dialog(page).getByRole('slider',{name:'Music volume'}).press('Home');
  await dialog(page).getByRole('slider',{name:'Effects volume'}).press('End');
  await clickAndWait(page,dialog(page),'Save settings');
  const audio = (await fetchState(page)).player.settings;
  assert.equal(audio.musicVolume,0);
  assert.equal(audio.sfxVolume,100);
  const music = await page.request.get(origin + '/art/frontier-score.mp3');
  assert.equal(music.headers()['content-type'],'audio/mpeg');
  assert.ok((await music.body()).length > 100_000);
  await closeDialog(page);

  const mobile = await open({width:390,height:844},'?seat=p3',true);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth),390);
  await shot(mobile,'world-390x844.png');
  const touch=await mobile.context().newCDPSession(mobile);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:135,y:370,id:1},{x:245,y:370,id:2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:66,y:325,id:1},{x:308,y:417,id:2}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.waitForFunction(()=>JSON.parse(window.render_game_to_text()).map.zoom>1.25);
  await mapHasNoEdgeGap(mobile);
  await clickButton(mobile,'Reset view');
  await openNav(mobile,'My City');
  await mobile.getByRole('button',{name:/City Hall Level/}).click();
  await dialog(mobile).getByRole('heading',{name:'City Hall',exact:true}).waitFor();
  await shot(mobile,'city-390x844.png');
  await closeDialog(mobile);
  await openTab(mobile,'Commanders');
  await mobile.locator('.hero-card').first().getByRole('button',{name:'Review commander'}).tap();
  await dialog(mobile).getByRole('heading',{name:'Active traits'}).waitFor();
  assert.equal(await dialog(mobile).evaluate(box=>box.scrollWidth<=box.clientWidth),true);
  await shot(mobile,'commander-390x844.png');
  await closeDialog(mobile);
  await openTab(mobile,'Marketplace');
  await mobile.getByRole('button',{name:/^Give /}).tap();
  await mobile.getByRole('option',{name:'Stone',exact:true}).tap();
  assert.equal(await mobile.locator('input[name=give]').inputValue(),'stone');
  await openNav(mobile,'War');
  await openTab(mobile,'Territories');
  await mobile.locator('.territory-row').filter({hasText:'Oracle Ruins'}).getByRole('button',{name:'Inspect',exact:true}).tap();
  await dialog(mobile).getByRole('heading',{name:'Rare site raffle'}).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth),390);
  await shot(mobile,'vaultborn-territory-rare-mobile.png');
  const newcomer = await open({width:1440,height:900});
  const founding = dialog(newcomer);
  await founding.getByRole('heading',{name:'Found a city',exact:true}).waitFor();
  await founding.getByLabel('Commander name',{exact:true}).fill('Warden Elara');
  await founding.getByLabel('Settlement name',{exact:true}).fill('Cedarwatch');
  await founding.getByRole('button',{name:/^Faction /}).click();
  await founding.locator('[data-select-option="violet"]').click();
  await clickAndWait(newcomer,founding,'Found city');
  // Greeted once: the tutorial, the instructions, or Skip; the greeting is not offered again.
  await founding.getByRole('heading',{name:'Welcome to VaultBorn'}).waitFor();
  assert.equal((await fetchState(newcomer)).player.welcome,false);
  await clickButton(founding,'Start the tutorial');
  // Without a wallet the kingdom is asked to connect one; the tutorial follows either way.
  await founding.getByRole('heading',{name:'Connect your wallet'}).waitFor();
  await clickButton(founding,'Not now');
  await founding.waitFor({ state:'hidden' });
  assert.equal((await fetchState(newcomer)).player.name,'Cedarwatch');
  const guide = newcomer.locator('#campaign-guide');
  await clickButton(guide,'Skip');
  await clickAndWait(newcomer,guide,'Skip tutorial');
  await dialog(newcomer).getByRole('heading',{name:'First banner raised'}).waitFor();
  await clickButton(founding,'Continue');
  await founding.waitFor({ state:'hidden' });
  await openNav(newcomer,'My City');
  await clickButton(newcomer.locator('#campaign'),'Daily supplies');
  await clickAndWait(newcomer,founding,'Claim daily supplies');
  await clickButton(founding,'Continue');
  const founded = (await fetchState(newcomer)).player;
  assert.equal(founded.faction,'violet');
  assert.equal(founded.tutorial,true);
  assert.ok(founded.shieldUntil === 0 && founded.optIn, 'a new kingdom is open and in the season from its first day');
  assert.equal(await newcomer.locator('select').count(),0);
  assert.equal(await newcomer.locator('html').getAttribute('lang'),'en-US');

  await openNav(page,'Politics');
  await openTab(page,'Government');
  const policyAt = (await fetchState(page)).government.kingdom.policyAt;
  if (policyAt >= now) await progress(page,policyAt-now+1);
  await closeRaised(page);
  await page.getByRole('button',{name:/^Resource taxation /}).click();
  await page.getByRole('option',{name:'Heavy · 15%'}).click();
  await clickAndWait(page,politics,'Adopt policy');
  const levy = politics.locator('.politics-row').filter({hasText:'Requisition civic reserves'});
  await clickAndWait(page,levy,'Enact');
  const beforeCoup = await fetchState(page);
  assert.ok(beforeCoup.government.kingdom.unrest >= 28 || beforeCoup.government.kingdom.loyalty < 50);
  await openTab(page,'Conflicts');
  const coup = politics.locator('.politics-row').filter({hasText:/Coup d’État/});
  await clickButton(coup,'Plan');
  await clickAndWait(page,offer,'Order mobilization');
  await offer.waitFor({state:'hidden'});
  const campaign = (await fetchState(page)).government.conflicts[0];
  assert.equal(campaign.status,'organizing');
  assert.match(campaign.seedCommitment,/^[a-f0-9]{64}$/);
  assert.equal(campaign.seed,undefined);
  const totalTroops = state => Object.values(state.player.troops).reduce((total,item)=>total+item,0);
  assert.ok(totalTroops(await fetchState(page)) < totalTroops(beforeCoup));
  await clickButton(politics,'Request government aid');
  await offer.getByRole('button',{name:/^Allied kingdom Northcrest$/}).waitFor();
  await clickAndWait(page,offer,'Send aid request');
  const request = (await fetchState(page)).government.requests.find(item=>item.conflict===campaign.id);
  assert.equal(request.status,'open');
  assert.equal(request.to,'p3');
  assert.ok(!(await fetchState(defender)).government.requests.some(item=>item.id===request.id));
  await closeDialog(mobile);
  await openNav(mobile,'Politics');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth),390);
  await shot(mobile,'politics-mobile.png');
  await openTab(mobile,'Conflicts');
  await clickButton(mobile.locator('#campaign'),'Answer request');
  const allyBefore = totalTroops(await fetchState(mobile));
  await clickAndWait(mobile,dialog(mobile),'Commit support');
  const allyAfter = await fetchState(mobile);
  assert.equal(allyAfter.government.requests.find(item=>item.id===request.id).status,'fulfilled');
  assert.equal(totalTroops(allyAfter),allyBefore-1);
  const archive = await browser.newPage({viewport:{width:1440,height:900}});
  await loopbackOnly(archive);
  archive.on('pageerror',error => errors.push(error.message));
  await archive.goto(origin+'/verify/politics');
  await archive.getByRole('heading',{name:'Political Archive',exact:true}).waitFor();
  await archive.getByRole('heading',{name:'CashTokens charters',exact:true}).waitFor();
  const publicBook = async () => (await (await archive.request.get(origin+'/api/public/politics')).json()).government;
  assert.equal((await publicBook()).conflicts.some(item=>item.id===campaign.id),false);
  await progress(page,campaign.nextAt-now);
  await openTab(page,'Conflicts');
  await closeRaised(page);
  await clickButton(politics,'Campaign record');
  await offer.getByText('Front replays are sealed until this conflict ends.').waitFor();
  assert.equal(await offer.getByRole('button',{name:'View battle'}).count(),0);
  await closeDialog(page);
  const {frontDuration} = (await fetchState(page)).government.rules;
  await progress(page,2*frontDuration);
  const concluded = (await publicBook()).conflicts.find(item=>item.id===campaign.id);
  assert.equal(concluded.status,'resolved');
  assert.equal(concluded.rounds.length,3);
  assert.match(concluded.seed,/^[a-f0-9]{64}$/);
  const outcome = page.locator('#political-outcome');
  if (await outcome.getByText('COUP SUCCESSFUL',{exact:true}).isVisible()) await clickButton(outcome,'Review dispatch');
  await openTab(page,'Conflicts');
  await clickButton(politics,'Campaign record');
  assert.equal(await offer.getByRole('button',{name:'View battle'}).count(),3);
  await shot(page,'politics-conflict.png');
  await offer.getByRole('button',{name:'View battle',exact:true}).first().click();
  await clickButton(offer,'Play battle replay');
  await offer.locator('.battle-canvas').waitFor();
  await clickButton(offer,'Show result');
  await offer.getByText(/^(CHALLENGER|GOVERNMENT) VICTORY$/).waitFor();
  await archive.reload();
  await archive.getByRole('heading',{name:'Coup',exact:true}).waitFor();
  console.log('Coup mobilization, private allied intervention, sealed front replays and public three-front resolution passed');
  const returning=await open({width:1100,height:810},'?seat=p4');
  const arriving=await fetchState(returning);
  assert.equal(arriving.player.name,'Stonevale');
  await clickButton(returning.getByRole('navigation',{name:'Main navigation'}),'My City');
  await openTab(returning,'Army');
  await returning.locator('.troop-tile').first().getByRole('button',{name:'Train',exact:true}).click();
  await dialog(returning).getByLabel('Recruits',{exact:true}).fill('1');
  await clickButton(dialog(returning),'Queue recruits');
  await dialog(returning).getByRole('heading',{name:'Training ordered'}).waitFor();
  await clickButton(dialog(returning),'Continue');
  await fetchState(returning);
  now+=11*60_000;
  await returning.goto(origin+'/');
  await dialog(returning).getByRole('heading',{name:'While you were away',exact:true}).waitFor();
  await dialog(returning).getByText('Training complete',{exact:true}).waitFor();
  await shot(returning,'offline-kingdom.png');
  await clickAndWait(returning,dialog(returning),'Continue to kingdom','/api/offline-report/dismiss');
  await dialog(returning).waitFor({state:'hidden'});
  await clickButton(returning,'Notifications');
  await clickButton(dialog(returning),'While you were away');
  await dialog(returning).getByRole('heading',{name:'While you were away',exact:true}).waitFor();
  assert.equal((await fetchState(returning)).offlineReport.unread,false);
  console.log('Offline report presents recorded training once and remains reviewable in dispatches');
  assert.deepEqual(errors,[]);
  console.log('Alliance, treaties, vault, rankings, wallet proof, audio preferences, mobile controls and onboarding passed');
  console.log('Browser checkout creates intents only. No blockchain transfer is asserted by this suite.');
} finally {
  await browser.close();
  close();
  if (dirname(scratch) === resolve('var')) await rm(scratch,{recursive:true,force:true});
}
