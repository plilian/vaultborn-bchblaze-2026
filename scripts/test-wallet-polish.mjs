// NOT YET UPDATED for verification at connect time (19 November 2026): as soon as a wallet pairs, the game now asks it to
// approve the proof transaction (apps/game-server/wallet-proof.mjs). This script still expects the earlier flow, in which
// the player signed a message by hand. scripts/test-wallet-connect-browser.mjs covers the new flow with the wallet SDK.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveHdPath, deriveHdPathRelative, deriveHdPrivateNodeFromSeed, deriveHdPublicNode,
  encodeHdPublicKey } from '@bitauth/libauth';
import { WalletConnectionManager } from '@wizardconnect/wallet';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { hex } from '../packages/chain-observer/primitives.mjs';

const relay = new WebSocketServer({host:'127.0.0.1',port:0});
await once(relay,'listening');
const subscriptions=new Map();
const events=new Map();
const relayUrl='ws://127.0.0.1:'+relay.address().port;
const matches=(event,filter)=>(!filter.kinds||filter.kinds.includes(event.kind))&&
  (!filter.since||event.created_at>=filter.since)&&
  (!filter['#p']||event.tags.some(tag=>tag[0]==='p'&&filter['#p'].includes(tag[1])));
const send=(socket,message)=>{if(socket.readyState===1)socket.send(JSON.stringify(message));};
relay.on('connection',socket=>{
  const scopes=new Map();
  subscriptions.set(socket,scopes);
  socket.on('close',()=>subscriptions.delete(socket));
  socket.on('message',body=>{
    const [type,value,...filters]=JSON.parse(String(body));
    if(type==='EVENT'&&value?.id&&Array.isArray(value.tags)){
      if(!events.has(value.id)){
        events.set(value.id,value);
        for(const [listener,registered] of subscriptions)
          for(const [id,active] of registered)
            if(active.some(filter=>matches(value,filter)))send(listener,['EVENT',id,value]);
      }
      send(socket,['OK',value.id,true,'']);
    }else if(type==='REQ'){
      scopes.set(value,filters);
      for(const event of events.values())
        if(filters.some(filter=>matches(event,filter)))send(socket,['EVENT',value,event]);
      send(socket,['EOSE',value]);
    }else if(type==='CLOSE')scopes.delete(value);
  });
});

const account=deriveHdPath(deriveHdPrivateNodeFromSeed(randomBytes(32)),"m/44'/145'/0'");
const branch=path=>deriveHdPathRelative(account,String(path));
const child=(path,index)=>deriveHdPathRelative(branch(path),String(index));
const secret=hex(child(0,0).privateKey);
const wallet=walletFromPrivateKey(secret);
let attemptedBroadcasts=0;
let attemptedSignatures=0;
let fixtureBalance=4321;
const transport={
  withClient:work=>work({tip:36008,block:async()=>'01'+'00'.repeat(79),history:async()=>[],
    listUnspent:async (script,mode)=>script===wallet.script&&mode!=='tokens_only'?[{satoshis:fixtureBalance}]:[],
    broadcast:()=>{attemptedBroadcasts++;throw new Error('Offline fixture cannot broadcast');}}),
};
const chain=createChain({treasuryPrivateKey:hex(randomBytes(32)),transport});
const issuers={enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
let now=Date.now();
const app=createApp({database:':memory:',chain,simulatedChain:true,testWizardRelay:relayUrl,clock:()=>now,
  territoryAssets:issuers,politicalAssets:issuers});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const origin='http://127.0.0.1:'+app.server.address().port;
const readOnlyApp=createApp({database:':memory:',chain:createChain({transport}),testWizardRelay:relayUrl,
  sessionCookieName:'dominion_wallet_read',territoryAssets:issuers,politicalAssets:issuers});
readOnlyApp.server.listen(0,'127.0.0.1');
await once(readOnlyApp.server,'listening');
const readOnlyOrigin='http://127.0.0.1:'+readOnlyApp.server.address().port;
const manager=new WalletConnectionManager({
  walletName:'VaultBorn local SDK wallet',walletIcon:'',
  getRelayPrivateKey:()=>randomBytes(32),
  getXpub:path=>encodeHdPublicKey({network:'mainnet',node:deriveHdPublicNode(branch(path))}).hdPublicKey,
  getPublicKey:(path,index)=>deriveHdPublicNode(child(path,index)).publicKey,
  signTransaction:async()=>{attemptedSignatures++;throw new Error('Offline fixture does not sign transactions');},
});
manager.on('pendingSignRequest',()=>{attemptedSignatures++;});
// Selene's current approval flow first sends an empty-path protocol greeting.
// Reproduce it with the pinned SDK before releasing the user's consent.
const pushApprovedWalletReady=manager.pushWalletReady.bind(manager);
let consent=false,provisionalConnection;
manager.pushWalletReady=async connection=>{
  if(consent)return pushApprovedWalletReady(connection);
  if(connection.walletReadySentThisCycle)return;
  connection.walletReadySentThisCycle=true;
  provisionalConnection=connection;
  connection.notificationQueue.push({action:'wallet_ready',supported_protocols:['hdwalletv1'],
    wallet_name:'VaultBorn local SDK wallet',wallet_icon:'',time:Math.floor(Date.now()/1000),
    dapp_discovered:connection.dappDiscovered,session:{hdwalletv1:{paths:[]}},
    public_key:connection.walletPublicKeyHex,secret:connection.keyExchangeSecret});
  manager.flushNotificationQueue(connection);
};
let seleneNetwork='mainnet';
const seleneProtocolFixture=new WalletConnectionManager({
  walletName:'Selene protocol fixture',walletIcon:'',
  getRelayPrivateKey:()=>randomBytes(32),
  getXpub:path=>encodeHdPublicKey({network:seleneNetwork,node:deriveHdPublicNode(branch(path))}).hdPublicKey,
  getPublicKey:(path,index)=>deriveHdPublicNode(child(path,index)).publicKey,
  signTransaction:async()=>{attemptedSignatures++;throw new Error('Offline fixture does not sign transactions');},
});
seleneProtocolFixture.on('pendingSignRequest',()=>{attemptedSignatures++;});

await mkdir('var',{recursive:true});
const scratch=await mkdtemp(resolve('var','wallet-polish-'));
process.env.TEMP=scratch;
process.env.TMP=scratch;
process.env.TMPDIR=scratch;
const output=resolve(process.env.DOMINION_BROWSER_OUTPUT??'output/wallet-polish');
await mkdir(output,{recursive:true});
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let browser,page;
try{
  browser=await chromium.launch({executablePath:process.env.DOMINION_BROWSER_PATH??(existsSync(edge)?edge:undefined),
    env:{...process.env,TEMP:scratch,TMP:scratch,TMPDIR:scratch},
    args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking']});
  page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  const pageErrors=[], external=[];
  let stage='territory';
  page.on('pageerror',error=>pageErrors.push({stage,message:error.stack||error.message}));
  await page.route('**/*',route=>{
    if(route.request().url().startsWith(origin+'/'))return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket(new RegExp('^wss?://(?!127\\.0\\.0\\.1:'+relay.address().port+'(?:/|$))'),socket=>{
    external.push(socket.url());
    socket.close();
  });
  await page.addInitScript(()=>{
    const AudioElement=window.Audio;
    window.frontierTracks=[];
    window.Audio=new Proxy(AudioElement,{construct(target,args){
      const track=Reflect.construct(target,args);
      if(args[0]==='/art/frontier-saga.mp3')window.frontierTracks.push(track);
      return track;
    }});
  });
  const dialog=page.locator('#dialog');
  const click=(container,name)=>container.getByRole('button',{name,exact:true}).click();
  const state=async()=>page.evaluate(async()=>await (await fetch('/api/state')).json());
  await page.goto(origin+'/?seat=p1');
  const nav=page.getByRole('navigation',{name:'Main navigation'});
  await nav.getByRole('button',{name:'Map',exact:true}).waitFor();
  const initial=await state();
  const command=async data=>{
    const response=await page.request.post(origin+'/api/command',{data});
    assert.ok(response.ok(),await response.text());
  };
  if(!initial.player.tutorial)await command({type:'tutorial'});
  if(!(await state()).player.optIn)await command({type:'opt-in',enabled:true});
  now=Math.max(now,(await state()).player.shieldUntil+1);
  const campaign=await state();
  assert.equal(campaign.territories.find(site=>site.id==='east-meadow').claimEligibility.ok,true,
    JSON.stringify({claim:campaign.territories.find(site=>site.id==='east-meadow').claimEligibility,player:campaign.player.id}));
  await page.reload();
  await click(nav,'War');
  await page.getByRole('tab',{name:'Territories',exact:true}).click();
  await click(page.locator('.territory-row').filter({hasText:'East Meadow'}),'Inspect');
  await dialog.getByRole('heading',{name:'East Meadow',exact:true}).waitFor();
  const linkButton=dialog.getByRole('button',{name:'Connect wallet',exact:true});
  assert.equal(await linkButton.count(),1,await dialog.innerText());
  await linkButton.click();
  await dialog.getByRole('button',{name:'Return to territory'}).waitFor();
  await click(dialog,'Other WizardConnect wallet');
  const addressLink=dialog.getByRole('link',{name:'Open in wallet'});
  await addressLink.waitFor();
  const uri=await addressLink.getAttribute('href');
  manager.connect(uri);
  await dialog.getByText('Confirm the connection in your wallet. Pairing is waiting for your consent.',{exact:true}).waitFor({timeout:20000});
  assert.equal(await dialog.getByRole('img',{name:'WizardConnect pairing QR code'}).count(),1);
  assert.equal(await dialog.getByText('Address needs proof',{exact:true}).count(),0);
  assert.equal((await state()).wallet,null);
  await page.screenshot({path:resolve(output,'wallet-awaiting-consent.png')});
  await click(dialog,'Cancel pairing');
  await dialog.getByRole('button',{name:'Other WizardConnect wallet',exact:true}).waitFor();
  assert.equal((await state()).wallet,null);
  await click(dialog,'Other WizardConnect wallet');
  await addressLink.waitFor();
  manager.connect(await addressLink.getAttribute('href'));
  await dialog.getByText('Confirm the connection in your wallet. Pairing is waiting for your consent.',{exact:true}).waitFor({timeout:20000});
  consent=true;
  provisionalConnection.walletReadySentThisCycle=false;
  await pushApprovedWalletReady(provisionalConnection);
  await dialog.getByText('VaultBorn local SDK wallet',{exact:true}).waitFor({timeout:20000});
  await dialog.getByText(/Wallet BCH · 0\.00004321 BCH/).waitFor();
  await click(dialog,'Copy address');
  await page.waitForFunction(async address=>await navigator.clipboard.readText()===address,wallet.address,{timeout:5000});
  fixtureBalance=5432;
  await click(dialog,'Refresh balance');
  await dialog.getByText(/Wallet BCH · 0\.00005432 BCH/).waitFor();
  assert.equal((await state()).wallet,null);
  const shortened=wallet.address.slice(0,15)+'…'+wallet.address.slice(-5);
  await page.getByRole('button',{name:'Wallet '+shortened,exact:true}).waitFor();
  assert.equal(await dialog.getByLabel('Chipnet CashAddr',{exact:true}).inputValue(),wallet.address);
  await click(dialog,'Create ownership challenge');
  await dialog.locator('.wallet-challenge').waitFor();
  const proof=signWalletChallenge(secret,await dialog.locator('.wallet-challenge').textContent());
  assert.equal(await dialog.getByLabel('Compressed public key (legacy proof only)',{exact:true}).inputValue(),proof.publicKey);
  await dialog.getByLabel('Ownership signature',{exact:true}).fill(proof.signature);
  await click(dialog,'Verify ownership');
  await dialog.getByText('Address verified',{exact:true}).waitFor();
  await page.screenshot({path:resolve(output,'wallet-connected.png')});
  await click(dialog,'Return to territory');
  await dialog.getByRole('heading',{name:'East Meadow',exact:true}).waitFor();
  await click(dialog,'Open claim · 2,600 sats');
  await dialog.getByRole('heading',{name:'Enter claim for East Meadow',exact:true}).waitFor();
  await dialog.getByText('Local simulation',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Approve with wallet',exact:true}).waitFor();
  await click(dialog,'Close dialog');
  await click(nav,'Vault');
  await page.waitForFunction(()=>window.frontierTracks.length===1);
  await page.evaluate(()=>{window.beforeLedger=window.frontierTracks[0];});
  await page.getByRole('link',{name:'Chain explorer',exact:true}).click();
  await page.getByRole('heading',{name:'Chain Explorer',exact:true}).waitFor();
  await page.getByLabel('Citadel archives').getByText('Local simulation',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'Your open checkouts',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>window.frontierTracks.length===1&&window.beforeLedger===window.frontierTracks[0]));
  assert.equal(await page.getByRole('button',{name:'Wallet '+shortened,exact:true}).count(),1);
  await page.screenshot({path:resolve(output,'chain-explorer-in-game.png')});
  stage='return';
  await click(page,'Return to campaign');
  await page.getByRole('heading',{name:'War Chest',exact:true}).waitFor();
  stage='reload';
  await page.reload();
  await click(page,'Wallet '+shortened);
  await dialog.getByText('VaultBorn local SDK wallet',{exact:true}).waitFor({timeout:20000});
  stage='disconnect';
  await click(dialog,'Disconnect wallet');
  await dialog.getByRole('button',{name:'Other WizardConnect wallet'}).waitFor();
  assert.equal((await state()).wallet.address,wallet.address);
  stage='read-only';
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  mobile.on('pageerror',error=>pageErrors.push({stage,message:error.stack||error.message}));
  await mobile.route('**/*',route=>{
    if(route.request().url().startsWith(readOnlyOrigin+'/'))return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await mobile.routeWebSocket(new RegExp('^wss?://(?!127\\.0\\.0\\.1:'+relay.address().port+'(?:/|$))'),socket=>{
    external.push(socket.url());
    socket.close();
  });
  await mobile.goto(readOnlyOrigin+'/?seat=p1');
  await click(mobile,'Connect wallet');
  const walletDialog=mobile.locator('#dialog');
  await walletDialog.getByText(/Chipnet checkout is currently offline/).waitFor();
  const readOnlyState=await (await mobile.request.get(readOnlyOrigin+'/api/state')).json();
  assert.equal(readOnlyState.chain.enabled,false);
  assert.equal(readOnlyState.chain.walletConnect,true);
  assert.equal(readOnlyState.chain.walletRead,true);
  await click(walletDialog,'Selene Wallet');
  seleneProtocolFixture.connect(await walletDialog.getByRole('link',{name:'Open in wallet'}).getAttribute('href'));
  await walletDialog.getByText(/Selene is on Mainnet/).waitFor({timeout:20000});
  assert.equal((await (await mobile.request.get(readOnlyOrigin+'/api/state')).json()).wallet,null);
  seleneNetwork='testnet';
  await click(walletDialog,'Selene Wallet');
  seleneProtocolFixture.connect(await walletDialog.getByRole('link',{name:'Open in wallet'}).getAttribute('href'));
  await walletDialog.getByText('Selene protocol fixture',{exact:true}).waitFor({timeout:20000});
  await walletDialog.getByText(/Wallet BCH · 0\.00005432 BCH/).waitFor();
  await mobile.screenshot({path:resolve(output,'wallet-read-only-mobile.png')});
  assert.equal(await walletDialog.getByRole('button',{name:'Approve with wallet',exact:true}).count(),0);
  assert.deepEqual((await (await mobile.request.get(readOnlyOrigin+'/api/state')).json()).payments,[]);
  await mobile.reload();
  await click(mobile,'Wallet '+shortened);
  await walletDialog.getByText('Selene protocol fixture',{exact:true}).waitFor({timeout:20000});
  await click(walletDialog,'Disconnect wallet');
  await walletDialog.getByRole('button',{name:'Selene Wallet',exact:true}).waitFor();
  await mobile.close();
  assert.equal(attemptedSignatures,0);
  assert.equal(attemptedBroadcasts,0);
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(external,[]);
  console.log('Wallet SDK pairing, verified territory return and checkout, Explorer audio continuity, reload, disconnect, wrong-network rejection and mobile read-only pairing without a treasury passed offline.');
}catch(error){
  console.error(error);
  process.exitCode=1;
}finally{
  if(page&&!page.isClosed()) await page.evaluate(async()=>{
    await (await import('/ritual-wallet.js')).closeWizard();
  }).catch(()=>{});
  manager.disconnectAll();
  seleneProtocolFixture.disconnectAll();
  await delay(200);
  for(const socket of relay.clients)socket.terminate();
  relay.close();
  await browser?.close();
  app.close();
  readOnlyApp.close();
  if(dirname(scratch)===resolve('var'))await rm(scratch,{recursive:true,force:true});
}
