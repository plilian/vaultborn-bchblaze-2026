// NOT YET UPDATED for verification at connect time (19 November 2026): as soon as a wallet pairs, the game now asks it to
// approve the proof transaction (apps/game-server/wallet-proof.mjs). This script still expects the earlier flow, in which
// the player signed a message by hand. scripts/test-wallet-connect-browser.mjs covers the new flow with the wallet SDK.
// Optional interoperability check against the cached, unmodified Selene release.
// Release files are deliberately kept under ignored var/ rather than vendored.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { createApp } from '../apps/game-server/index.mjs';
import { createChain } from '../packages/chain-observer/index.mjs';

const cache=resolve('var/selene-app');
const output=resolve('output/selene-release');
await mkdir(output,{recursive:true});
const assets=new Map();
const types={js:'text/javascript',css:'text/css',woff2:'font/woff2',wasm:'application/wasm',png:'image/png',svg:'image/svg+xml'};
const releaseOrigin='https://app.selene.cash';
const manifest=JSON.parse(await readFile(resolve('docs/selene-release-fixture.json'),'utf8'));
for(const [name,expected] of Object.entries(manifest.files)) {
  const bytes=await readFile(resolve(cache,name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'Changed cached Selene release asset: '+name);
  assets.set(name,bytes);
}
const relay=new WebSocketServer({host:'127.0.0.1',port:0});
await once(relay,'listening');
const relayUrl='ws://127.0.0.1:'+relay.address().port;
const subscriptions=new Map(),events=new Map();
const send=(socket,message)=>{if(socket.readyState===1)socket.send(JSON.stringify(message));};
const matches=(event,filter)=>(!filter.kinds||filter.kinds.includes(event.kind))&&(!filter.since||event.created_at>=filter.since)&&
  (!filter['#p']||event.tags.some(tag=>tag[0]==='p'&&filter['#p'].includes(tag[1])));
relay.on('connection',socket=>{
  const scopes=new Map();subscriptions.set(socket,scopes);
  socket.on('close',()=>subscriptions.delete(socket));
  socket.on('message',body=>{
    const [type,value,...filters]=JSON.parse(String(body));
    if(type==='EVENT'&&value?.id&&Array.isArray(value.tags)){
      if(!events.has(value.id)){
        events.set(value.id,value);
        for(const [listener,registered] of subscriptions)for(const [id,active]of registered)
          if(active.some(filter=>matches(value,filter)))send(listener,['EVENT',id,value]);
      }send(socket,['OK',value.id,true,'']);
    }else if(type==='REQ'){
      scopes.set(value,filters);
      for(const event of events.values())if(filters.some(filter=>matches(event,filter)))send(socket,['EVENT',value,event]);
      send(socket,['EOSE',value]);
    }else if(type==='CLOSE')scopes.delete(value);
  });
});
let broadcasts=0;
const chain=createChain({transport:{withClient:work=>work({tip:36008,block:async()=>'01'+'00'.repeat(79),
  history:async()=>[],listUnspent:async()=>[],broadcast:()=>{broadcasts++;throw Error('No broadcast allowed');}})}});
const issuers={enabled:false,list:()=>[],authority:()=>null,close:()=>{}};
const app=createApp({database:':memory:',chain,testWizardRelay:relayUrl,territoryAssets:issuers,politicalAssets:issuers});
app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
const origin='http://127.0.0.1:'+app.server.address().port;
const scratch=await mkdtemp(resolve('var/selene-release-'));
process.env.TEMP=scratch;
process.env.TMP=scratch;
process.env.TMPDIR=scratch;
const browser=await chromium.launch({executablePath:process.env.DOMINION_BROWSER_PATH??(existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')?
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe':undefined),
  env:{...process.env,TEMP:scratch,TMP:scratch,TMPDIR:scratch},
  args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking']});
const game=await browser.newPage({viewport:{width:1440,height:900}});
const selene=await browser.newPage({viewport:{width:430,height:900},ignoreHTTPSErrors:true,serviceWorkers:'block'});
const gameErrors=[],blockedSockets=[],missingAssets=[],financialPosts=[];
game.on('pageerror',error=>gameErrors.push(error.message));
for(const page of [game,selene]){
  await page.routeWebSocket(new RegExp('^wss?://(?!127\\.0\\.0\\.1:'+relay.address().port+'(?:/|$))'),socket=>{
    blockedSockets.push(socket.url());socket.close();
  });
}
// The unmodified Selene CSP requires wss. Bridge its secure-origin route to
// our local no-TLS fixture; the signed/encrypted Nostr frames stay unchanged.
await selene.routeWebSocket('wss://127.0.0.1:'+relay.address().port+'/',browserSocket=>{
  const upstream=new WebSocket(relayUrl),queued=[];
  browserSocket.onMessage(message=>upstream.readyState===1?upstream.send(message):queued.push(message));
  browserSocket.onClose(()=>upstream.close());
  upstream.on('open',()=>{for(const message of queued)upstream.send(message);});
  upstream.on('message',(message,isBinary)=>browserSocket.send(isBinary?message:String(message)));
  upstream.on('close',()=>browserSocket.close());
  upstream.on('error',()=>browserSocket.close());
});
await game.route('**/*',route=>{
  const request=route.request();
  if(request.method()==='POST'&&/\/api\/(payments|vault)/.test(request.url()))financialPosts.push(request.url());
  return request.url().startsWith(origin+'/')?route.continue():route.abort();
});
await selene.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==releaseOrigin||request.method()!=='GET')return route.abort();
  const leaf=url.pathname.split('/').at(-1),name=leaf?.includes('.')?leaf:'index.html';
  if(!assets.has(name)){missingAssets.push(name);return route.abort();}
  await route.fulfill({status:200,body:assets.get(name),contentType:types[name.split('.').at(-1)]??'text/html'});
});
try{
  await game.goto(origin+'/?seat=p1');
  await game.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await game.getByRole('button',{name:'Selene Wallet',exact:true}).click();
  const pairing=new URL(await game.getByRole('link',{name:'Open in wallet',exact:true}).getAttribute('href'));
  pairing.searchParams.set('pr','wss');
  await selene.goto(releaseOrigin+'/');
  await selene.getByText('Wallet Tools',{exact:true}).waitFor();
  await selene.goto(releaseOrigin+'/debug');
  await selene.getByText('Debug Options',{exact:true}).click();
  await selene.locator('select').filter({has:selene.locator('option[value="chipnet"]')}).selectOption('chipnet');
  await selene.getByText('Wallet Tools',{exact:true}).waitFor();
  await selene.goto(releaseOrigin+'/apps/wizardconnect');
  await selene.locator('form input[type="text"]').fill(pairing.href);
  await selene.getByRole('button',{name:'Pair',exact:true}).click();
  await selene.getByRole('button',{name:'Connect',exact:true}).click({timeout:30000});
  await game.locator('#dialog').getByText('Selene Wallet',{exact:true}).waitFor({timeout:30000});
  await game.locator('#dialog').getByText('Address needs proof',{exact:true}).waitFor();
  const address=await game.locator('#dialog').getByLabel('Chipnet CashAddr',{exact:true}).inputValue();
  assert.match(address,/^bchtest:q/);
  await selene.getByText('VAULTBORN Chipnet',{exact:true}).waitFor();
  await game.screenshot({path:resolve(output,'vaultborn-selene-connected.png')});
  await selene.screenshot({path:resolve(output,'selene-wizardconnect.png')});
  await game.reload();
  await game.getByRole('button',{name:/^Wallet bchtest:/}).click();
  await game.locator('#dialog').getByText('Selene Wallet',{exact:true}).waitFor({timeout:30000});
  assert.equal(await game.locator('#dialog').getByLabel('Chipnet CashAddr',{exact:true}).inputValue(),address);
  await game.locator('#dialog').getByRole('button',{name:'Disconnect wallet',exact:true}).click();
  await game.locator('#dialog').getByRole('button',{name:'Selene Wallet',exact:true}).waitFor();
  assert.deepEqual(gameErrors,[]);
  assert.deepEqual(missingAssets,[]);
  assert.deepEqual(financialPosts,[]);
  assert.equal(broadcasts,0);
  const gameHashes={};
  for(const name of ['ritual-wallet.js','screens.js','vendor/wizardconnect.js'])
    gameHashes[name]=createHash('sha256').update(await readFile(resolve('apps/web',name))).digest('hex');
  await writeFile(resolve(output,'result.json'),JSON.stringify({release:manifest.release,fixture:'Official web release assets, supplied pinned SQL.js WASM, disposable unfunded wallet, local relay with wss-to-ws harness bridge',gameHashes,
    paired:true,sameAddressAfterReload:true,disconnected:true,financialPosts:0,broadcasts,externalSocketsBlocked:blockedSockets.length},null,2)+'\n');
  console.log('Official Selene release paired, restored the same Chipnet address after reload, and disconnected through loopback only. No transaction was requested or broadcast.');
}catch(error){
  await game.screenshot({path:resolve(output,'failure-game.png')}).catch(()=>{});
  await selene.screenshot({path:resolve(output,'failure-selene.png')}).catch(()=>{});
  console.error({game:await game.locator('body').innerText().catch(()=>''),selene:await selene.locator('body').innerText().catch(()=>''),missingAssets,blockedSockets},error);
  process.exitCode=1;
}finally{
  await browser.close();
  for(const socket of relay.clients)socket.terminate();
  relay.close();app.close();
  if(dirname(scratch)===resolve('var'))await rm(scratch,{recursive:true,force:true});
}
