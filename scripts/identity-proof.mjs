import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex,hex,walletFromPrivateKey } from '../packages/chain-observer/primitives.mjs';
import {
  authenticationBchMessage, authenticationEventTemplate, bindingBchMessage, bindingEventTemplate, createAuthenticationChallenge,
  createBindingChallenge, identityDiscoveryFilter, publishIdentityToRelay, readIdentityFromRelay, signLocalBchProof, signNostrEvent,
  verifyIdentityAuthentication, verifyIdentityHistory,
} from '../packages/decentralized-identity/index.mjs';

const [action,path,...rest]=process.argv.slice(2);
// Relays are named by the person running the tool; nothing here chooses one.
const relayUrls=list=>{
  const urls=list.filter(item=>/^wss?:\/\/[^\s]+$/.test(item));
  if (!urls.length || urls.length!==list.length || urls.length>8) throw new Error('Name one to eight relays, each as wss://host.');
  return urls;
};
const withRelay=(url,work)=>new Promise((resolve,reject)=>{
  const socket=new WebSocket(url);
  const timer=setTimeout(()=>{ socket.close(); reject(new Error('could not connect')); },8000);
  socket.addEventListener('error',()=>{ clearTimeout(timer); reject(new Error('could not connect')); });
  socket.addEventListener('open',async()=>{
    clearTimeout(timer);
    try { resolve(await work(socket)); } catch (error) { reject(error); } finally { socket.close(); }
  });
});
const eachRelay=async(urls,work)=>{
  const results=[];
  for (const relay of urls) {
    try { results.push({relay,...await withRelay(relay,work)}); } catch (error) { results.push({relay,error:error.message}); }
  }
  return results;
};
const publish=(urls,events)=>eachRelay(urls,async socket=>({published:await publishIdentityToRelay(socket,events)}));
// Every relay is read and verified on its own, so a relay that withholds or reorders history shows up as a different head.
const discover=async(urls,identity,options)=>{
  const views=await eachRelay(urls,async socket=>{ const found=await readIdentityFromRelay(socket,identity,options); return {binding:found.identity,events:found.events}; });
  const heads=new Set(views.filter(view=>view.binding).map(view=>view.binding.head));
  return {identity,filter:identityDiscoveryFilter(identity),agreed:heads.size===1 && views.every(view=>view.binding),views};
};
const read=async file=>{
  if (!file) throw new Error('A local input file is required.');
  return (await readFile(file,'utf8')).replace(/^\uFEFF/,'').trim();
};
const print=value=>console.log(JSON.stringify(value,null,2));

if (action==='bch-sign') {
  const key=await read(process.env.VAULTBORN_IDENTITY_BCH_KEY_FILE);
  console.log(signLocalBchProof(key,await read(path)));
} else if (action==='nostr-sign') {
  const key=await read(process.env.VAULTBORN_IDENTITY_NOSTR_KEY_FILE);
  print(signNostrEvent(JSON.parse(await read(path)),key));
} else if (action==='verify') {
  const archive=JSON.parse(await read(path));
  print(verifyIdentityHistory(Array.isArray(archive)?archive:archive.events));
} else if (action==='publish') {
  const archive=JSON.parse(await read(path));
  const events=Array.isArray(archive)?archive:archive.events;
  const binding=verifyIdentityHistory(events);
  print({identity:binding.identity,head:binding.head,relays:await publish(relayUrls(rest),events)});
} else if (action==='discover') {
  const found=await discover(relayUrls(rest),path);
  print({...found,views:found.views.map(({events,...view})=>({...view,revisions:events?.length}))});
  if (!found.agreed) process.exitCode=1;
} else if (action==='demo' && path) {
  // The same proof as the offline demo, carried by real relays: two disposable keys are linked, the signed record is
  // published, read back from every relay and verified from the relay data alone, and then both keys answer a challenge.
  const urls=relayUrls([path,...rest]);
  const bch=hex(randomBytes(32));
  const nostr=hex(randomBytes(32));
  const wallet=walletFromPrivateKey(bch);
  const payload=createBindingChallenge({operation:'link',realm:'vaultborn:demo',account:'relay-example',wallet:wallet.address,bchKey:wallet.publicKey,
    nostrKey:hex(schnorr.getPublicKey(fromHex(nostr)))});
  const event=signNostrEvent(bindingEventTemplate(payload,signLocalBchProof(bch,bindingBchMessage(payload))),nostr);
  const identity=verifyIdentityHistory([event]).identity;
  const published=await publish(urls,[event]);
  const found=await discover(urls,identity,{expectedHead:event.id});
  const view=found.views.find(item=>item.binding);
  let authenticated=false;
  if (view) {
    const audience='independent-relying-application';
    const challenge=createAuthenticationChallenge(view.binding,audience);
    const answer=signNostrEvent(authenticationEventTemplate(challenge,view.binding,signLocalBchProof(bch,authenticationBchMessage(challenge))),nostr);
    authenticated=verifyIdentityAuthentication(answer,challenge,view.binding,{audience});
  }
  print({at:new Date().toISOString(),identity,event:event.id,wallet:wallet.address,keys:'two disposable keys made for this run and discarded',
    published,discovered:found.views.map(({events,...item})=>item),agreed:found.agreed,authenticated});
  if (!found.agreed || !authenticated) process.exitCode=1;
} else if (action==='demo') {
  const bch=hex(randomBytes(32));
  const nostr=hex(randomBytes(32));
  const nostrKey=hex(schnorr.getPublicKey(fromHex(nostr)));
  const wallet=walletFromPrivateKey(bch);
  const payload=createBindingChallenge({operation:'link',realm:'vaultborn:demo',account:'local-example',wallet:wallet.address,bchKey:wallet.publicKey,nostrKey});
  const event=signNostrEvent(bindingEventTemplate(payload,signLocalBchProof(bch,bindingBchMessage(payload))),nostr);
  const binding=verifyIdentityHistory([event]);
  class OfflineRelay extends EventTarget {
    readyState=1;
    send(raw) {
      const [method,subscription,filter]=JSON.parse(raw);
      if (method==='CLOSE') return;
      assert.equal(method,'REQ');
      assert.deepEqual(filter,identityDiscoveryFilter(binding.identity));
      queueMicrotask(()=>{
        for (const frame of [['EVENT',subscription,event],['EOSE',subscription]]) {
          this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));
        }
      });
    }
  }
  const discovered=await readIdentityFromRelay(new OfflineRelay(),binding.identity);
  const audience='offchain-example-consumer';
  const challenge=createAuthenticationChallenge(discovered.identity,audience);
  const auth=signNostrEvent(authenticationEventTemplate(challenge,discovered.identity,signLocalBchProof(bch,authenticationBchMessage(challenge))),nostr);
  assert.ok(verifyIdentityAuthentication(auth,challenge,discovered.identity,{audience}));
  print({verified:discovered.identity,discovery:identityDiscoveryFilter(binding.identity),events:discovered.events,
    authentication:'Verified both keys; test recipient, no account or transaction created.'});
} else {
  throw new Error('Use demo [wss://relay …], publish <event archive file> <wss://relay …>, discover <nostr:public key> <wss://relay …>, ' +
    'bch-sign <challenge file>, nostr-sign <unsigned event file>, or verify <event archive file>.');
}
