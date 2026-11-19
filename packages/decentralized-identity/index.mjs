import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex, hex, sha256, signWalletChallenge, verifyWalletProof, walletFromPublicKey } from '../chain-observer/primitives.mjs';

// A regular application event retains consent history; an ephemeral event is used for challenges.
export const identityKind=7428;
export const authenticationKind=27777;
export const proofTTL=300;
export const maxIdentityRevisions=24;
const hex64=/^[0-9a-f]{64}$/;
const bindingKeys=['version','operation','identity','revision','previous','realm','account','wallet','bchKey','nostrKey','nonce','issuedAt','expiresAt'];
const authKeys=['version','identity','head','audience','nonce','issuedAt','expiresAt'];
const signedKeys=['pubkey','created_at','kind','tags','content','id','sig'];
const isHex64=value=>typeof value==='string' && hex64.test(value);
const safeId=value=>typeof value==='string' && /^[a-z0-9_.:-]{1,120}$/i.test(value);
const pick=(object,keys)=>Object.fromEntries(keys.map(key=>[key,object[key]]));
const sameShape=(object,keys)=>Boolean(object && !Array.isArray(object) && typeof object==='object' &&
  Object.keys(object).length===keys.length && keys.every(key=>Object.hasOwn(object,key)));
const assert=(predicate,description)=>{if (!predicate) throw new Error(description);};
const seconds=()=>Math.floor(Date.now()/1000);
const nonce=()=>randomBytes(32).toString('hex');
const identityPattern=/^nostr:[0-9a-f]{64}$/;

export function identityId(nostrKey) {
  assert(isHex64(nostrKey),'A 32-byte lowercase Nostr public key is required.');
  return 'nostr:'+nostrKey;
}

function validateWindow(value) {
  return Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt>=0 &&
    value.expiresAt>value.issuedAt && value.expiresAt-value.issuedAt<=proofTTL;
}

function assertBinding(payload) {
  assert(sameShape(payload,bindingKeys) && payload.version===1 && ['link','rotate','revoke'].includes(payload.operation) &&
    identityPattern.test(payload.identity ?? '') && Number.isSafeInteger(payload.revision) &&
    payload.revision>=1 && payload.revision<=maxIdentityRevisions && (payload.previous===null || isHex64(payload.previous)) &&
    safeId(payload.realm) && safeId(payload.account) && isHex64(payload.nostrKey) && isHex64(payload.nonce) && validateWindow(payload),
  'Invalid identity binding statement.');
  const wallet=walletFromPublicKey(payload.bchKey);
  assert(wallet.address===payload.wallet && wallet.publicKey===payload.bchKey,'The BCH address does not match its compressed public key.');
  assert(wallet.publicKey.slice(2)!==payload.nostrKey,'Use distinct BCH and Nostr keys.');
  return pick(payload,bindingKeys);
}

function assertAuthentication(payload) {
  assert(sameShape(payload,authKeys) && payload.version===1 && identityPattern.test(payload.identity ?? '') && isHex64(payload.head) &&
    typeof payload.audience==='string' && payload.audience.length>0 && payload.audience.length<=160 &&
    isHex64(payload.nonce) && validateWindow(payload),'Invalid authentication challenge.');
  return pick(payload,authKeys);
}

function template(pubkey,kind,created_at,tags,content) {
  return {pubkey,kind,created_at,tags,content};
}

export function eventDigest(event) {
  return hex(sha256(JSON.stringify([0,event.pubkey,event.created_at,event.kind,event.tags,event.content])));
}

export function signNostrEvent(unsigned,privateKey) {
  assert(isHex64(privateKey),'A local Nostr key is required.');
  const secret=fromHex(privateKey);
  assert(hex(schnorr.getPublicKey(secret))===unsigned.pubkey,'This key does not match the Nostr event author.');
  const id=eventDigest(unsigned);
  return {...unsigned,id,sig:hex(schnorr.sign(fromHex(id),secret))};
}

export function verifyNostrEvent(event) {
  try {
    return sameShape(event,signedKeys) && isHex64(event.pubkey) && isHex64(event.id) &&
      typeof event.sig==='string' && /^[0-9a-f]{128}$/.test(event.sig) && Number.isSafeInteger(event.kind) &&
      event.kind>=0 && event.kind<=65535 && Number.isSafeInteger(event.created_at) && event.created_at>=0 &&
      typeof event.content==='string' && event.content.length<=8192 && Array.isArray(event.tags) && event.tags.length<=8 &&
      event.tags.every(tag=>Array.isArray(tag) && tag.length<=4 && tag.every(value=>typeof value==='string' && value.length<=200)) &&
      eventDigest(event)===event.id && schnorr.verify(fromHex(event.sig),fromHex(event.id),fromHex(event.pubkey));
  } catch { return false; }
}

export function createBindingChallenge({operation,realm,account,wallet,bchKey,nostrKey,previous,now=seconds()}) {
  return assertBinding({version:1,operation,identity:previous?.identity ?? identityId(nostrKey),revision:(previous?.revision ?? 0)+1,
    previous:previous?.head ?? null,realm,account,wallet,bchKey,nostrKey,nonce:nonce(),issuedAt:now,expiresAt:now+proofTTL});
}

export function bindingBchMessage(payload,prior=false) {
  return JSON.stringify(['vaultborn-identity',prior?'authorize-rotation':'binding',assertBinding(payload)]);
}

export function rotationEventTemplate(payload,oldKey,createdAt=seconds()) {
  const data=assertBinding(payload);
  return template(oldKey,authenticationKind,createdAt,[['d',data.identity],['t','vaultborn-identity-rotation-v1']],
    JSON.stringify(['vaultborn-identity','authorize-rotation',data]));
}

export function bindingEventTemplate(payload,bchSignature,approval={},createdAt=seconds()) {
  const data=assertBinding(payload);
  const {priorBchSignature=null,priorNostrEvent=null}=approval;
  return template(data.nostrKey,identityKind,createdAt,[['d',data.identity],['t','vaultborn-identity-v1']],
    JSON.stringify({payload:data,bchSignature,priorBchSignature,priorNostrEvent}));
}

const bchCheck=(addr,key,signature,challenge)=>verifyWalletProof({address:addr,publicKey:key,signature,challenge});
const sameEvent=(given,expected)=>eventDigest(given)===eventDigest(expected);
const inWindow=(when,payload)=>when>=payload.issuedAt && when<=payload.expiresAt;

export function readBindingPayload(event) {
  assert(verifyNostrEvent(event) && event.kind===identityKind,'Invalid signed Nostr binding event.');
  const content=JSON.parse(event.content);
  assert(sameShape(content,['payload','bchSignature','priorBchSignature','priorNostrEvent']),'Invalid binding event content.');
  const payload=assertBinding(content.payload);
  assert(inWindow(event.created_at,payload) && sameEvent(event,bindingEventTemplate(payload,content.bchSignature,content,event.created_at)),
    'The Nostr binding event does not match its signed statement.');
  assert(bchCheck(payload.wallet,payload.bchKey,content.bchSignature,bindingBchMessage(payload)),
    'The BCH key did not sign the binding.');
  return {...content,payload};
}

export function verifyBindingEvent(event,previous=null) {
  const {payload,priorBchSignature,priorNostrEvent}=readBindingPayload(event);
  if (!previous) {
    assert(payload.operation==='link' && payload.revision===1 && payload.previous===null && payload.identity===identityId(payload.nostrKey),
      'Identity history must begin with the initial Nostr key.');
  } else {
    assert(payload.operation!=='link' && payload.identity===previous.identity && payload.realm===previous.realm && payload.account===previous.account &&
      payload.revision===previous.revision+1 && payload.previous===previous.head && event.created_at>=previous.createdAt,
    'The identity binding does not extend the verified revision.');
    const changingBch=payload.bchKey!==previous.bchKey;
    const changingNostr=payload.nostrKey!==previous.nostrKey;
    assert(payload.operation!=='revoke' || previous.status!=='revoked' && !changingBch && !changingNostr,
      'Revocation must be signed by both current keys.');
    if (changingBch) assert(bchCheck(previous.wallet,previous.bchKey,priorBchSignature,bindingBchMessage(payload,true)),
      'The previous BCH key must authorize the rotation.');
    if (changingNostr) assert(verifyNostrEvent(priorNostrEvent) && inWindow(priorNostrEvent.created_at,payload) &&
      priorNostrEvent.created_at<=event.created_at && sameEvent(priorNostrEvent,rotationEventTemplate(payload,previous.nostrKey,priorNostrEvent.created_at)),
    'The previous Nostr key must authorize the rotation.');
    assert((changingBch || priorBchSignature===null) && (changingNostr || priorNostrEvent===null),'Unexpected prior signer.');
  }
  if (!previous) assert(priorBchSignature===null && priorNostrEvent===null,'Initial bindings cannot have prior signers.');
  return {identity:payload.identity,revision:payload.revision,realm:payload.realm,account:payload.account,wallet:payload.wallet,
    bchKey:payload.bchKey,nostrKey:payload.nostrKey,head:event.id,status:payload.operation==='revoke'?'revoked':'active',createdAt:event.created_at};
}

export function verifyIdentityHistory(events) {
  assert(Array.isArray(events) && events.length>0 && events.length<=maxIdentityRevisions,'Identity history is missing or too long.');
  return events.reduce((previous,event)=>verifyBindingEvent(event,previous),null);
}

export function identityDiscoveryFilter(identity) {
  assert(identityPattern.test(identity ?? ''),'Use a VaultBorn Nostr identity such as nostr:<public key>.');
  return {kinds:[identityKind],'#d':[identity],limit:96};
}

export function resolveIdentityEvents(candidates,identity,{expectedHead}={}) {
  identityDiscoveryFilter(identity);
  assert(Array.isArray(candidates) && candidates.length<=192,'Too many discovery events.');
  const byPrevious=new Map();
  for (const event of new Map(candidates.map(event=>[event?.id,event])).values()) {
    try {
      const {payload}=readBindingPayload(event);
      if (payload.identity!==identity) continue;
      const list=byPrevious.get(payload.previous) ?? [];
      list.push(event);
      byPrevious.set(payload.previous,list);
    } catch { /* Unrelated events do not make a valid binding unavailable. */ }
  }
  let current=null;
  const events=[];
  while (events.length<maxIdentityRevisions) {
    const valid=[];
    for (const event of byPrevious.get(current?.head ?? null) ?? []) {
      try { valid.push({event,head:verifyBindingEvent(event,current)}); } catch { /* No authorization for this branch. */ }
    }
    assert(valid.length<=1,'Conflicting valid identity revisions were discovered.');
    if (!valid.length) break;
    current=valid[0].head;
    events.push(valid[0].event);
  }
  assert(current && (!expectedHead || current.head===expectedHead),'Identity was not found at the expected revision.');
  return {identity:current,events};
}

export async function discoverIdentity(fetchEvents,identity,options) {
  return resolveIdentityEvents(await fetchEvents(identityDiscoveryFilter(identity)),identity,options);
}

// Accept an already-connected socket chosen by the caller. This exchange sends only REQ and CLOSE.
export async function readIdentityFromRelay(socket,identity,{expectedHead,timeoutMs=5000}={}) {
  const filter=identityDiscoveryFilter(identity);
  assert(socket?.readyState===1 && Number.isSafeInteger(timeoutMs) && timeoutMs>=10 && timeoutMs<=30_000,
    'Use an open Nostr reader socket and a bounded timeout.');
  const subscription='vaultborn-'+nonce().slice(0,24);
  const events=await new Promise((resolve,reject)=>{
    const found=[];
    const stop=error=>{
      clearTimeout(timer);
      socket.removeEventListener('message',onMessage);
      socket.removeEventListener('close',onClose);
      socket.removeEventListener('error',onClose);
      if (socket.readyState===1) {
        try {socket.send(JSON.stringify(['CLOSE',subscription]));} catch { /* The reader already closed. */ }
      }
      if (error) reject(error);
      else resolve(found);
    };
    const onClose=()=>stop(new Error('Nostr discovery connection closed.'));
    const onMessage=event=>{
      if (typeof event.data!=='string' || event.data.length>12_000) return;
      let frame;
      try {frame=JSON.parse(event.data);} catch {return;}
      if (!Array.isArray(frame) || frame[1]!==subscription) return;
      if (frame[0]==='EOSE') return stop();
      if (frame[0]==='CLOSED') return stop(new Error('Nostr relay rejected identity discovery.'));
      if (frame[0]==='EVENT' && frame.length===3) {
        if (found.length>=96) return stop(new Error('Nostr relay exceeded the identity discovery limit.'));
        found.push(frame[2]);
      }
    };
    const timer=setTimeout(()=>stop(new Error('Nostr discovery timed out.')),timeoutMs);
    socket.addEventListener('message',onMessage);
    socket.addEventListener('close',onClose);
    socket.addEventListener('error',onClose);
    try {socket.send(JSON.stringify(['REQ',subscription,filter]));} catch (error) {stop(error);}
  });
  return resolveIdentityEvents(events,identity,{expectedHead});
}

// Publishes an already signed identity history to a relay chosen by the caller. The history is verified first, so only a
// valid chain is sent, and nothing is signed here: the events carry the two signatures their owner made. Resolves with the
// relay's answer for every event (NIP-01 OK frames).
export async function publishIdentityToRelay(socket,events,{timeoutMs=5000}={}) {
  verifyIdentityHistory(events);
  assert(socket?.readyState===1 && Number.isSafeInteger(timeoutMs) && timeoutMs>=10 && timeoutMs<=30_000,
    'Use an open Nostr socket and a bounded timeout.');
  return new Promise((resolve,reject)=>{
    const answers=new Map();
    const stop=error=>{
      clearTimeout(timer);
      socket.removeEventListener('message',onMessage);
      socket.removeEventListener('close',onClose);
      socket.removeEventListener('error',onClose);
      if (error) reject(error);
      else resolve(events.map(event=>({id:event.id,...(answers.get(event.id) ?? {accepted:false,message:'no answer from the relay'})})));
    };
    const onClose=()=>stop(new Error('Nostr relay connection closed.'));
    const onMessage=event=>{
      if (typeof event.data!=='string' || event.data.length>12_000) return;
      let frame;
      try {frame=JSON.parse(event.data);} catch {return;}
      if (!Array.isArray(frame) || frame[0]!=='OK' || !events.some(item=>item.id===frame[1])) return;
      answers.set(frame[1],{accepted:frame[2]===true,message:String(frame[3] ?? '').slice(0,200)});
      if (answers.size===events.length) stop();
    };
    const timer=setTimeout(()=>stop(),timeoutMs);
    socket.addEventListener('message',onMessage);
    socket.addEventListener('close',onClose);
    socket.addEventListener('error',onClose);
    try { for (const event of events) socket.send(JSON.stringify(['EVENT',event])); } catch (error) {stop(error);}
  });
}

export function createAuthenticationChallenge(binding,audience,now=seconds()) {
  assert(binding?.status==='active','The identity has been revoked.');
  return assertAuthentication({version:1,identity:binding.identity,head:binding.head,audience,nonce:nonce(),issuedAt:now,expiresAt:now+proofTTL});
}

export function authenticationBchMessage(payload) {
  return JSON.stringify(['vaultborn-identity','authenticate',assertAuthentication(payload)]);
}

export function authenticationEventTemplate(payload,binding,bchSignature,createdAt=seconds()) {
  const data=assertAuthentication(payload);
  return template(binding.nostrKey,authenticationKind,createdAt,[['d',data.identity],['t','vaultborn-authentication-v1']],
    JSON.stringify({payload:data,bchSignature}));
}

export function verifyIdentityAuthentication(event,payload,binding,{audience,now=seconds()}={}) {
  try {
    const challenge=assertAuthentication(payload);
    assert(binding?.status==='active' && challenge.identity===binding.identity && challenge.head===binding.head &&
      challenge.audience===audience && inWindow(now,challenge) && verifyNostrEvent(event) && inWindow(event.created_at,challenge) &&
      event.created_at<=now,'Inactive or expired identity challenge.');
    const {bchSignature}=JSON.parse(event.content);
    return sameEvent(event,authenticationEventTemplate(challenge,binding,bchSignature,event.created_at)) &&
      bchCheck(binding.wallet,binding.bchKey,bchSignature,authenticationBchMessage(challenge));
  } catch { return false; }
}

// Local signing is only used by fixtures and user-owned tools. Server code calls verification only.
export function signLocalBchProof(privateKey,message) { return signWalletChallenge(privateKey,message).signature; }
