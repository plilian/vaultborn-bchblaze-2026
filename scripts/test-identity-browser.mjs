import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { resolve,sep } from 'node:path';
import { chromium } from 'playwright';
import { schnorr } from '@noble/curves/secp256k1.js';
import { secp256k1 } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { bchSignMessageDigest } from '../apps/game-server/bch-sign-in.mjs';
import { createChain,signWalletChallenge,walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex,hex } from '../packages/chain-observer/primitives.mjs';
import { signLocalBchProof,signNostrEvent,verifyIdentityHistory } from '../packages/decentralized-identity/index.mjs';

await mkdir('var',{recursive:true});
const scratch=await mkdtemp(resolve('var','identity-browser-'));
Object.assign(process.env,{TEMP:scratch,TMP:scratch,TMPDIR:scratch});
const output=resolve(process.env.DOMINION_BROWSER_OUTPUT??'output/playwright');
await mkdir(output,{recursive:true});
const app=createApp({database:':memory:',localDemo:true,chain:createChain({enabled:false})});
app.server.listen(0,'127.0.0.1');
await once(app.server,'listening');
const origin='http://127.0.0.1:'+app.server.address().port;
const installedEdge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const executablePath=process.env.DOMINION_BROWSER_PATH??(existsSync(installedEdge)?installedEdge:undefined);
let browser;
const bch='17'.repeat(32);
const nostr='24'.repeat(32);
const privateNostr='27'.repeat(32);
const wallet=walletFromPrivateKey(bch);
const nostrKey=hex(schnorr.getPublicKey(fromHex(nostr)));
const errors=[];
const compactSignature=(key,message)=>{
  const signed=secp256k1.signMessageHashRecoverableCompact(fromHex(key),bchSignMessageDigest(message));
  return Buffer.concat([Buffer.of(signed.recoveryId+31),signed.signature]).toString('base64');
};

try {
  browser=await chromium.launch({executablePath,env:{...process.env,TEMP:scratch,TMP:scratch,TMPDIR:scratch},
    args:['--disable-crash-reporter','--disable-breakpad','--disable-background-networking']});
  async function open(viewport,isMobile=false,landing=false,{seat='p1',signer=nostr}={}) {
    const page=await browser.newPage({viewport,isMobile,hasTouch:isMobile});
    await page.route('**/*',route=>{
      assert.ok(route.request().url().startsWith(origin+'/'),'No external request during offline identity QA.');
      return route.continue();
    });
    const key=hex(schnorr.getPublicKey(fromHex(signer)));
    await page.exposeFunction('vaultbornMockNostrSign',unsigned=>signNostrEvent({...unsigned,pubkey:key},signer));
    await page.addInitScript(key=>{
      window.nostr={getPublicKey:async()=>key,signEvent:unsigned=>{
        if (window.rejectIdentityOnce) {
          window.rejectIdentityOnce=false;
          throw new Error('Signature rejected by the browser signer.');
        }
        return window.vaultbornMockNostrSign(unsigned);
      }};
    },key);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if (message.type()==='error') errors.push(message.text());});
    page.on('response',response=>{if (response.status()>=400) errors.push(`${response.status()} ${response.url()}`);});
    await page.goto(origin+(landing?'/':'/?seat='+seat));
    const scope = landing ? page.getByRole('navigation',{name:'Landing navigation'}) : page;
    await scope.getByRole('button',{name:landing?'Sign in':'Profile and settings',exact:true}).waitFor();
    return page;
  }
  const primary=await open({width:1280,height:850});
  const post=async (page,path,data)=>page.evaluate(async ([path,data])=>{
    const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    return [response.status,await response.json()];
  },[path,data]);
  const [status,walletChallenge]=await post(primary,'wallet/challenge',{address:wallet.address});
  assert.equal(status,200);
  assert.equal((await post(primary,'wallet/verify',signWalletChallenge(bch,walletChallenge.result.challenge)))[0],200);
  await primary.reload();
  async function enter(page) {
    await page.getByRole('button',{name:'Profile and settings'}).click();
    const box=page.getByRole('dialog');
    await box.getByRole('button',{name:/^(Decentralized identity|Verified BCH \+ Nostr identity)$/}).click();
    await box.getByRole('heading',{name:'Decentralized identity'}).waitFor();
    return box;
  }
  const gate=page=>page.getByRole('navigation',{name:'Landing navigation'}).getByRole('button',{name:'Sign in',exact:true});
  const state=page=>page.evaluate(async()=>(await fetch('/api/state?background=1')).json());
  async function startSignIn(page,method) {
    await gate(page).click();
    const box=page.getByRole('dialog');
    await box.getByRole('heading',{name:'Return to your kingdom',exact:true}).waitFor();
    await box.getByRole('button',{name:method,exact:true}).click();
    return box;
  }
  async function finishSignIn(page,box,id) {
    await Promise.all([page.waitForURL('**/play'),box.getByRole('button',{name:'Verify and sign in',exact:true}).click()]);
    await page.getByRole('button',{name:'Profile and settings'}).waitFor();
    assert.equal((await state(page)).player.id,id);
  }
  async function checkMobileHeader(page) {
    const controls=page.locator('#masthead > button');
    const boxes=await controls.evaluateAll(nodes=>nodes.map(node=>{
      const {left,right,top,bottom}=node.getBoundingClientRect();
      return {name:node.getAttribute('aria-label'),left,right,top,bottom};
    }));
    assert.equal(boxes.length,6);
    const visible=boxes.filter(box=>box.right>box.left && box.bottom>box.top);
    assert.equal(visible.length,5,'Mobile header exposes brand, wallet, guide, inbox and profile.');
    for (const box of visible) {
      assert.ok(box.left>=0 && box.right<=page.viewportSize().width,`${box.name} stays inside the viewport.`);
      for (const other of visible) if (other!==box) {
        assert.ok(Math.min(box.right,other.right)-Math.max(box.left,other.left)<=0 ||
          Math.min(box.bottom,other.bottom)-Math.max(box.top,other.top)<=0,`${box.name} and ${other.name} do not overlap.`);
      }
    }
    await page.getByRole('button',{name:'VAULTBORN home',exact:true}).click();
    await page.waitForFunction(()=>JSON.parse(window.render_game_to_text()).mode==='map');
    for (const [selector,title] of [
      ['#masthead .wallet-shortcut','Chipnet wallet'],['#masthead .codex-shortcut','Game guide'],
      ['#masthead [aria-label^="Notifications"]','Notifications'],['#masthead [aria-label="Profile and settings"]','Profile & settings'],
    ]) {
      await page.locator(selector).click();
      const box=page.getByRole('dialog');
      await box.getByRole('heading',{name:title,exact:true}).waitFor();
      await box.getByRole('button',{name:'Close dialog',exact:true}).click();
    }
  }
  async function signOut(page) {
    await page.getByRole('button',{name:'Profile and settings'}).click();
    const box=page.getByRole('dialog');
    await box.getByRole('button',{name:'Sign out',exact:true}).click();
    await Promise.all([page.waitForURL(origin+'/'),box.getByRole('button',{name:'Confirm sign out',exact:true}).click()]);
    await gate(page).waitFor();
    assert.equal((await (await page.request.get(origin+'/api/session')).json()).authenticated,false);
  }
  async function newNostrProof(box) {
    await box.getByRole('button',{name:'Read key from Nostr extension',exact:true}).click();
    await box.page().waitForFunction(()=>document.querySelector('#dialog input[name="key"]')?.value.length===64);
    await box.getByRole('button',{name:'Generate challenge',exact:true}).click();
    await box.getByRole('button',{name:'Sign with Nostr extension',exact:true}).click();
    await box.page().waitForFunction(()=>document.querySelector('#dialog textarea[name="event"]')?.value.includes('"sig"'));
  }
  async function sign(box,{rejectFirst=false}={}) {
    const message=await box.getByLabel('BCH challenge (read only)',{exact:true}).inputValue();
    await box.getByLabel('BCH wallet signature (128 hex characters)',{exact:true}).fill(signLocalBchProof(bch,message));
    await box.getByRole('button',{name:'Prepare Nostr proof'}).click();
    if (rejectFirst) {
      await box.page().evaluate(()=>{window.rejectIdentityOnce=true;});
      await box.getByRole('button',{name:'Sign with Nostr extension',exact:true}).click();
      await box.getByText('Signature rejected by the browser signer.',{exact:true}).waitFor();
    }
    await box.getByRole('button',{name:'Sign with Nostr extension',exact:true}).click();
    await box.page().waitForFunction(()=>document.querySelector('#dialog textarea[name="event"]')?.value.includes('"sig"'));
  }
  const link=await enter(primary);
  await link.getByRole('button',{name:'Link BCH and Nostr',exact:true}).click();
  await link.getByRole('button',{name:'Read key from Nostr extension'}).click();
  await primary.waitForFunction(value=>document.querySelector('#dialog input[name="key"]')?.value===value,nostrKey);
  await link.getByLabel(/I consent/).check();
  const challenge=primary.waitForResponse(response=>response.url().endsWith('/api/identity/challenge'));
  await link.getByRole('button',{name:'Generate challenge'}).click();
  const challengeResponse=await challenge;
  assert.ok(challengeResponse.ok(),await challengeResponse.text());
  await sign(link);
  await link.getByRole('button',{name:'Verify both keys'}).click();
  await link.getByRole('heading',{name:'Both identity keys verified',exact:true}).waitFor();
  await link.getByRole('button',{name:'Continue',exact:true}).click();
  await link.getByText('Both keys verified',{exact:true}).waitFor();
  await primary.screenshot({path:resolve(output,'vaultborn-identity-linked.png')});
  const portableUrl=await link.getByRole('link',{name:/Open public proof/}).getAttribute('href');
  const portable=await primary.evaluate(async path=>(await fetch(path)).json(),portableUrl);
  assert.equal(verifyIdentityHistory(portable.events).nostrKey,nostrKey);
  assert.equal(portable.gameAssociation.player,'p1');
  await primary.close();
  const newDevice=await open({width:390,height:844},true,true);
  assert.equal((await (await newDevice.request.get(origin+'/api/session')).json()).authenticated,false);
  const signin=await startSignIn(newDevice,'Both keys');
  await signin.getByLabel('Identity or original Nostr public key').fill(nostrKey);
  await signin.getByRole('button',{name:'Generate challenge'}).click();
  await sign(signin,{rejectFirst:true});
  await newDevice.screenshot({path:resolve(output,'vaultborn-identity-mobile-auth.png')});
  await finishSignIn(newDevice,signin,'p1');
  const restored=await state(newDevice);
  assert.equal(restored.identity?.walletMatches,true);
  assert.ok(await newDevice.locator('#campaign-guide').isHidden());
  const width=await newDevice.evaluate(()=>[document.documentElement.scrollWidth,innerWidth]);
  assert.ok(width[0]<=width[1],'Identity does not cause page overflow.');

  await signOut(newDevice);
  const bchLogin=await startSignIn(newDevice,'BCH wallet');
  await bchLogin.getByLabel('Verified Chipnet receiving address',{exact:true}).fill(wallet.address);
  await bchLogin.getByRole('button',{name:'Generate challenge',exact:true}).click();
  const bchMessage=await bchLogin.getByLabel('BCH challenge (read only)',{exact:true}).inputValue();
  await bchLogin.getByLabel('BCH wallet signature',{exact:true}).fill(compactSignature(bch,bchMessage));
  await newDevice.screenshot({path:resolve(output,'vaultborn-identity-bch-mobile.png')});
  await finishSignIn(newDevice,bchLogin,'p1');
  assert.deepEqual((await state(newDevice)).signIn,{bch:wallet.address,nostr:nostrKey});
  await checkMobileHeader(newDevice);
  await newDevice.close();

  const dualNostr=await open({width:1280,height:850},false,true);
  const nostrLogin=await startSignIn(dualNostr,'Nostr');
  await newNostrProof(nostrLogin);
  await finishSignIn(dualNostr,nostrLogin,'p1');

  // A separately opened tab retains the previous cookie. Signing in elsewhere
  // must return that tab to recovery, rather than automatically founding again.
  const oldTab=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await oldTab.context().addCookies(await dualNostr.context().cookies());
  const revokedResponses=[],oldTabSessions=[];
  await oldTab.route('**/*',route=>{
    const request=route.request();
    assert.ok(request.url().startsWith(origin+'/'),'Expired-session QA stays on loopback.');
    if (request.method()==='POST' && request.url()===origin+'/api/session') oldTabSessions.push(request.url());
    return route.continue();
  });
  oldTab.on('pageerror',error=>errors.push(error.message));
  oldTab.on('response',response=>{
    if (response.status()===401 && new URL(response.url()).pathname==='/api/state') revokedResponses.push(response.url());
    else if (response.status()>=400) errors.push(`${response.status()} ${response.url()}`);
  });
  await oldTab.goto(origin+'/play');
  await oldTab.getByRole('button',{name:'Profile and settings'}).waitFor();
  const citiesBeforeRecovery=Object.keys(app.store.read().world.cities);
  await dualNostr.close();
  const replacement=await open({width:1280,height:850},false,true);
  const replacementLogin=await startSignIn(replacement,'Nostr');
  await newNostrProof(replacementLogin);
  await finishSignIn(replacement,replacementLogin,'p1');
  await oldTab.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))).catch(()=>{});
  await oldTab.waitForURL(origin+'/');
  await oldTab.getByRole('dialog').getByText('Your session ended. Sign in to return to your existing kingdom.',{exact:true}).waitFor();
  await oldTab.getByRole('dialog').getByRole('button',{name:'BCH wallet',exact:true}).waitFor();
  assert.ok(revokedResponses.length>0,'The previous cookie was rejected before recovery.');
  assert.deepEqual(oldTabSessions,[],'Expired tabs never create a new kingdom.');
  assert.deepEqual(Object.keys(app.store.read().world.cities),citiesBeforeRecovery);
  await oldTab.screenshot({path:resolve(output,'vaultborn-identity-expired-session.png')});
  await oldTab.close();

  const nostrOnly=await open({width:1280,height:850},false,false,{seat:'p2',signer:privateNostr});
  const privateLink=await enter(nostrOnly);
  await privateLink.getByRole('button',{name:'Link a Nostr sign-in',exact:true}).click();
  await privateLink.getByLabel(/Let this Nostr key sign in to my kingdom/).check();
  await newNostrProof(privateLink);
  await privateLink.getByRole('button',{name:'Verify and link',exact:true}).click();
  await privateLink.getByRole('heading',{name:'Nostr sign-in linked',exact:true}).waitFor();
  await privateLink.getByRole('button',{name:'Continue',exact:true}).click();
  const privateKey=hex(schnorr.getPublicKey(fromHex(privateNostr)));
  await nostrOnly.waitForFunction(async key=>{
    const value=await (await fetch('/api/state?background=1')).json();
    return value.signIn?.nostr===key && value.signIn.bch===null;
  },privateKey);
  await nostrOnly.keyboard.press('Escape');
  await signOut(nostrOnly);
  const clean=await open({width:320,height:740},true,true,{signer:privateNostr});
  const recovery=await startSignIn(clean,'Nostr');
  await newNostrProof(recovery);
  await clean.screenshot({path:resolve(output,'vaultborn-identity-nostr-only-mobile.png')});
  await finishSignIn(clean,recovery,'p2');
  assert.deepEqual((await state(clean)).signIn,{bch:null,nostr:privateKey});
  assert.equal((await state(clean)).identity,null);
  await checkMobileHeader(clean);
  await clean.getByRole('button',{name:'Profile and settings'}).click();
  await clean.getByRole('dialog').getByRole('button',{name:'Sign out',exact:true}).waitFor();
  assert.equal(app.store.payments().length,0);
  assert.deepEqual(errors,[]);
  console.log('Desktop/mobile portable and private linking, all three sign-in methods, sign-out, fresh-context recovery, and revoked-tab return without duplicate founding passed without payments or external requests.');
} finally {
  await browser?.close();
  const end=once(app.server,'close');
  app.close();
  await end;
  assert.ok(resolve(scratch).startsWith(resolve('var')+sep+'identity-browser-'));
  await rm(scratch,{recursive:true,force:true});
}
