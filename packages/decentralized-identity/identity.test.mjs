import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex, hex, walletFromPrivateKey } from '../chain-observer/primitives.mjs';
import { authenticationBchMessage, authenticationEventTemplate, bindingBchMessage, bindingEventTemplate, createAuthenticationChallenge,
  createBindingChallenge, discoverIdentity, identityDiscoveryFilter, readIdentityFromRelay, resolveIdentityEvents, rotationEventTemplate, signLocalBchProof, signNostrEvent,
  verifyBindingEvent, verifyIdentityAuthentication, verifyIdentityHistory, verifyNostrEvent } from './index.mjs';

const time=1_750_000_000;
const key=value=>value.toString(16).padStart(64,'0');
const y=number=>hex(schnorr.getPublicKey(fromHex(key(number))));
const realm='vaultborn:local-evidence';
const keys=(bch,nostr)=>({wallet:walletFromPrivateKey(key(bch)).address,bchKey:walletFromPrivateKey(key(bch)).publicKey,nostrKey:y(nostr)});
function event({operation='link',bch=31,nostr=41,previous=null,oldBch=null,oldNostr=null,now=time,account='p1'}={}) {
  const payload=createBindingChallenge({operation,realm,account,...keys(bch,nostr),previous,now});
  const sig=signLocalBchProof(key(bch),bindingBchMessage(payload));
  const priorBchSignature=oldBch?signLocalBchProof(key(oldBch),bindingBchMessage(payload,true)):null;
  const priorNostrEvent=oldNostr?signNostrEvent(rotationEventTemplate(payload,y(oldNostr),now),key(oldNostr)):null;
  return signNostrEvent(bindingEventTemplate(payload,sig,{priorBchSignature,priorNostrEvent},now),key(nostr));
}

test('a portable proof validates both key types without a database, rejects same-key proofs and permits signed rotation and revocation',async()=>{
  const first=event();
  const one=verifyBindingEvent(first);
  assert.equal(one.identity,'nostr:'+y(41));
  assert.equal(one.status,'active');
  assert.throws(()=>event({bch:41,nostr:41}),/distinct/);
  assert.equal(verifyNostrEvent({...first,content:first.content+' '}),false);
  const tampered=JSON.parse(first.content);
  tampered.bchSignature='f'.repeat(128);
  assert.throws(()=>verifyBindingEvent(signNostrEvent({pubkey:first.pubkey,created_at:first.created_at,kind:first.kind,tags:first.tags,
    content:JSON.stringify(tampered)},key(41))),/BCH key/);
  assert.throws(()=>verifyIdentityHistory([first,event({operation:'rotate',bch:33,nostr:43,previous:one,oldNostr:41})]),/previous BCH/);
  assert.throws(()=>verifyIdentityHistory([first,event({operation:'rotate',bch:33,nostr:43,previous:one,oldBch:31})]),/previous Nostr/);
  assert.throws(()=>verifyIdentityHistory([first,event({operation:'rotate',account:'p2',bch:33,nostr:43,previous:one,oldBch:31,oldNostr:41})]),/extend/);
  const rotation=event({operation:'rotate',bch:33,nostr:43,previous:one,oldBch:31,oldNostr:41,now:time+30});
  const two=verifyIdentityHistory([first,rotation]);
  const revoke=event({operation:'revoke',bch:33,nostr:43,previous:two,now:time+31});
  const localRelay=async filter=>{
    assert.deepEqual(filter,identityDiscoveryFilter(two.identity));
    return [revoke,event({bch:99,nostr:101}),rotation,first,rotation,{id:'unrelated'}];
  };
  const result=await discoverIdentity(localRelay,one.identity);
  assert.equal(result.identity.status,'revoked');
  assert.deepEqual(result.events,[first,rotation,revoke]);
  assert.throws(()=>resolveIdentityEvents([first],one.identity,{expectedHead:two.head}),/expected revision/);
  assert.throws(()=>resolveIdentityEvents([first,event(),rotation],one.identity),/Conflicting/);
  const relink=event({operation:'rotate',bch:33,nostr:43,previous:result.identity,now:time+40});
  assert.equal(verifyIdentityHistory([...result.events,relink]).status,'active');
});

test('portable authentication rejects another audience, challenge, revision, or time window',()=>{
  const first=event();
  const binding=verifyBindingEvent(first);
  const challenge=createAuthenticationChallenge(binding,'https://consumer.invalid',time+1);
  const auth=signNostrEvent(authenticationEventTemplate(challenge,binding,signLocalBchProof(key(31),authenticationBchMessage(challenge)),time+2),key(41));
  const opts={audience:'https://consumer.invalid',now:time+3};
  assert.equal(verifyIdentityAuthentication(auth,challenge,binding,opts),true);
  assert.equal(verifyIdentityAuthentication(auth,challenge,binding,{...opts,audience:'https://someone.invalid'}),false);
  assert.equal(verifyIdentityAuthentication(auth,{...challenge,nonce:'b'.repeat(64)},binding,opts),false);
  assert.equal(verifyIdentityAuthentication(auth,challenge,{...binding,status:'revoked'},opts),false);
  assert.equal(verifyIdentityAuthentication(auth,challenge,{...binding,head:'f'.repeat(64)},opts),false);
  assert.equal(verifyIdentityAuthentication(auth,challenge,binding,{...opts,now:challenge.expiresAt+1}),false);
  assert.equal(verifyIdentityAuthentication(auth,challenge,binding,{...opts,now:time+1}),false);
});

test('NIP-01 discovery reads a standard mocked relay and does not publish events',async()=>{
  const first=event();
  const binding=verifyBindingEvent(first);
  const sent=[];
  class Relay extends EventTarget {
    readyState=1;
    send(value) {
      const frame=JSON.parse(value);
      sent.push(frame);
      if (frame[0]!=='REQ') return;
      queueMicrotask(()=>{
        for (const data of [['EVENT','unrelated',first],['EVENT',frame[1],first],['EOSE',frame[1]]]) {
          this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));
        }
      });
    }
  }
  const relay=new Relay();
  assert.deepEqual(await readIdentityFromRelay(relay,binding.identity),{identity:binding,events:[first]});
  assert.deepEqual(sent[0].slice(2),[identityDiscoveryFilter(binding.identity)]);
  assert.deepEqual(sent.map(frame=>frame[0]),['REQ','CLOSE']);
  assert.equal(sent[0][1],sent[1][1]);
});
