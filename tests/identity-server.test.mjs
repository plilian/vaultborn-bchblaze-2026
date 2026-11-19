import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { base58AddressToLockingBytecode,secp256k1 } from '@bitauth/libauth';
import { createApp } from '../apps/game-server/index.mjs';
import { bchSignMessageDigest,verifiedBchMessageKey } from '../apps/game-server/bch-sign-in.mjs';
import { createChain, signWalletChallenge, walletFromPrivateKey } from '../packages/chain-observer/index.mjs';
import { fromHex,hex,toAddress } from '../packages/chain-observer/primitives.mjs';
import { signLocalBchProof, signNostrEvent, verifyIdentityHistory } from '../packages/decentralized-identity/index.mjs';

const privateKey=i=>i.toString(16).padStart(64,'0');
const nostrPublic=i=>hex(schnorr.getPublicKey(fromHex(privateKey(i))));
test('local VaultBorn links both public keys, exports portable history, recovers the original seat once, and revokes safely',async t=>{
  let time=1_750_000_000_000;
  const app=createApp({database:':memory:',clock:()=>time,chain:createChain({enabled:false}),localDemo:true});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  t.after(async()=>{const closed=once(app.server,'close');app.close();await closed;});
  const origin='http://127.0.0.1:'+app.server.address().port;
  const client=()=>{
    let cookie='';
    return async (path,data,status=200,headers={})=>{
      const resp=await fetch(origin+'/api/'+path,{headers:{Cookie:cookie,...(data && {'Content-Type':'application/json'}),...headers},
        ...(data && {method:'POST',body:JSON.stringify(data)})});
      const got=await resp.json();
      assert.equal(resp.status,status,`${path}: ${got.error??resp.status}`);
      cookie=resp.headers.get('set-cookie')?.split(';')[0]??cookie;
      return got;
    };
  };
  const original=client(),rival=client(),visitor=client();
  assert.equal((await original('session',{demo:'p1'})).state.identity,null);
  await rival('session',{demo:'p2'});
  await visitor('identity/challenge',{operation:'link',nostrKey:nostrPublic(211),consent:true},401);
  await original('identity/challenge',{operation:'link',nostrKey:nostrPublic(211),consent:true},403);
  async function oldWalletFlow(seat,number) {
    const bchKey=privateKey(number);
    const {address}=walletFromPrivateKey(bchKey);
    const {result}=await seat('wallet/challenge',{address});
    const proof=signWalletChallenge(bchKey,result.challenge);
    await seat('wallet/verify',{...proof,publicKey:proof.publicKey.toUpperCase()});
  }
  await oldWalletFlow(original,201);
  await oldWalletFlow(rival,202);
  await original('identity/challenge',{operation:'link',nostrKey:nostrPublic(211),consent:false},400);
  await original('identity/challenge',{operation:'link',nostrKey:nostrPublic(201),consent:true},400);
  const challenge=(await original('identity/challenge',{operation:'link',nostrKey:nostrPublic(211),consent:true})).result;
  const proof=async (seat,challenge,bch,nostr,auth=false,prior={})=>{
    const now={nonce:challenge.payload.nonce,bchSignature:signLocalBchProof(privateKey(bch),challenge.message),...prior};
    const {result:unsigned}=await seat(`identity/${auth?'auth/':''}prepare`,now);
    return {nonce:now.nonce,event:signNostrEvent(unsigned,privateKey(nostr))};
  };
  const linking=await proof(original,challenge,201,211);
  await rival('identity/verify',linking,409);
  await original('identity/verify',{...linking,event:{...linking.event,id:'0'.repeat(64)}},400);
  const verified=await original('identity/verify',linking);
  assert.equal(verified.state.identity.walletMatches,true);
  await original('identity/verify',linking,409);
  await rival('identity/challenge',{operation:'link',nostrKey:nostrPublic(211),consent:true},409);
  const publicRead=await visitor('public/identity/'+nostrPublic(211));
  assert.deepEqual(verifyIdentityHistory(publicRead.events),publicRead.binding);
  assert.equal(publicRead.gameAssociation.player,'p1');
  assert.ok(publicRead.gameAssociation.commanders.length>1);

  const identity=verified.result.identity;
  const cityIds=Object.keys(app.store.read().world.cities);
  assert.equal((await visitor('session')).authenticated,false);
  const stale=(await visitor('identity/auth/challenge',{identity})).result;
  const auth=(await visitor('identity/auth/challenge',{identity})).result;
  const authProof=await proof(visitor,auth,201,211,true);
  await visitor('identity/auth/verify',{...authProof,event:{...authProof.event,id:'0'.repeat(64)}},400);
  assert.equal((await visitor('session')).authenticated,false);
  assert.deepEqual(Object.keys(app.store.read().world.cities),cityIds);
  const login=await visitor('identity/auth/verify',authProof);
  assert.equal(login.result.player,'p1');
  assert.equal((await visitor('session')).authenticated,true);
  assert.deepEqual(Object.keys(app.store.read().world.cities),cityIds);
  assert.equal((await visitor('state')).identity.identity,identity);
  await visitor('identity/auth/verify',authProof,409);
  await original('identity/challenge',{operation:'revoke',consent:true},401);
  const earlier=await proof(visitor,stale,201,211,true);
  await oldWalletFlow(visitor,203);
  assert.equal((await visitor('state')).identity.walletMatches,false);
  await visitor('identity/auth/verify',earlier,400);
  const change=(await visitor('identity/challenge',{operation:'rotate',nostrKey:nostrPublic(213),consent:true})).result;
  const rotation=await proof(visitor,change,203,213,false,{priorBchSignature:signLocalBchProof(privateKey(201),change.priorMessage),
    priorNostrEvent:signNostrEvent(change.priorNostrTemplate,privateKey(211))});
  await visitor('identity/verify',rotation);
  await visitor('identity/auth/verify',earlier,409);
  const revoke=(await visitor('identity/challenge',{operation:'revoke',consent:true})).result;
  await visitor('identity/verify',await proof(visitor,revoke,203,213));
  await visitor('identity/auth/challenge',{identity},404);
  assert.deepEqual((await visitor('state')).signIn,{bch:walletFromPrivateKey(privateKey(203)).address,nostr:null});
  const revoked=await original('public/identity/'+nostrPublic(211));
  assert.equal(revoked.gameAssociation,null);
  assert.equal(verifyIdentityHistory(revoked.events).status,'revoked');
  const relink=(await visitor('identity/challenge',{operation:'rotate',nostrKey:nostrPublic(213),consent:true})).result;
  time+=301_000;
  await visitor('identity/prepare',{nonce:relink.payload.nonce,bchSignature:signLocalBchProof(privateKey(203),relink.message)},409);
});

const compactSignature=(key,message)=>{
  const signed=secp256k1.signMessageHashRecoverableCompact(fromHex(key),bchSignMessageDigest(message));
  return Buffer.concat([Buffer.of(signed.recoveryId+31),signed.signature]).toString('base64');
};

test('BCH Sign Message agrees with the independent Electron Cash fixture',()=>{
  // Electron-Cash/electroncash/tests/test_bitcoin.py, test_msg_signing, compressed key.
  const known=base58AddressToLockingBytecode('15hETetDmcXm1mM4sEf7U2KXC9hDHFMSzz');
  const proof={address:toAddress(hex(known.bytecode)),challenge:'Chancellor on brink of second bailout for banks',
    signature:'IA+oq/uGz4kKA2bNgxPcM+T216abyUiBhofMg1J8fC5BLAbbIpF2toCHaO7/LQAxhQBtu5D6ROq1JjXiRwPAASg='};
  const revealed=verifiedBchMessageKey(proof);
  assert.match(revealed,/^0[23][a-f0-9]{64}$/);
  assert.equal(verifiedBchMessageKey({...proof,challenge:proof.challenge+'!'}),null);
  assert.equal(verifiedBchMessageKey({...proof,publicKey:walletFromPrivateKey(privateKey(211)).publicKey}),null);
});

test('one-key BCH and Nostr recovery are browser-bound, survive a restart, and resolve one permanent kingdom',async t=>{
  const directory=fileURLToPath(new URL('../var/',import.meta.url));
  await mkdir(directory,{recursive:true});
  const temp=await mkdtemp(join(directory,'auth-test-'));
  let time=1_750_100_000_000;
  let app,base;
  async function stop() {
    if (!app) return;
    const closed=once(app.server,'close');
    app.close();
    await closed;
    app=null;
  }
  t.after(async()=>{
    await stop();
    assert.ok(temp.startsWith(join(directory,'auth-test-')));
    await rm(temp,{recursive:true,force:true});
  });
  async function open() {
    const disabled={list:()=>[],enabled:false,close:()=>{}};
    app=createApp({database:join(temp,'save.sqlite'),clock:()=>time,localDemo:true,territoryAssets:disabled,politicalAssets:disabled,
      chain:createChain({enabled:false,transport:{withClient:async()=>{throw new Error('Authentication cannot use a blockchain transport.');}}})});
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    base='http://127.0.0.1:'+app.server.address().port+'/api/';
  }
  const client=()=>{
    const cookies=new Map();
    const call=async (path,data,status=200,headers={})=>{
      const response=await fetch(base+path,{headers:{cookie:[...cookies.values()].join('; '),
        ...(data && {'Content-Type':'application/json'}),...headers},...(data && {method:'POST',body:JSON.stringify(data)})});
      const got=await response.json();
      assert.equal(response.status,status,`${path}: ${got.error??response.status}`);
      for(const raw of response.headers.getSetCookie()) {
        const first=raw.split(';')[0];
        const name=first.split('=')[0];
        if (raw.includes('Max-Age=0')) cookies.delete(name);
        else cookies.set(name,first);
      }
      return got;
    };
    call.sessionCookie=()=>cookies.get('dominion');
    return call;
  };

  await open();
  const owner=client(), rival=client(), stranger=client();
  const key=privateKey(350), wrong=privateKey(351);
  const {address,publicKey:bchKey}=walletFromPrivateKey(key);
  const signer=privateKey(352), publicKey=nostrPublic(352);
  const started=await owner('session',{entry:'new'});
  const id=started.result.player;
  const initial=Object.keys(app.store.read().world.cities);
  await owner('session/logout',{},409);
  assert.ok((await owner('session')).authenticated);
  await owner('command',{type:'found',name:'Dawn Ledger',cityName:'Dawn Keep',faction:'emerald'});
  await owner('command',{type:'tutorial',action:'next',step:'welcome'});
  await rival('session',{demo:'p2'});
  await stranger('identity/nostr/link/challenge',{publicKey,consent:true},401);
  await owner('identity/nostr/link/challenge',{publicKey,consent:false},400);
  const linking=(await owner('identity/nostr/link/challenge',{publicKey,consent:true})).result;
  const link={nonce:linking.nonce,event:signNostrEvent(linking.template,signer)};
  await rival('identity/nostr/link/verify',link,409);
  await owner('identity/nostr/verify',link,409);
  await owner('identity/nostr/link/verify',{...link,event:signNostrEvent({...linking.template,content:'altered'},signer)},400);
  const saved=(await owner('identity/nostr/link/verify',link)).state;
  assert.deepEqual(saved.signIn,{bch:null,nostr:publicKey});
  assert.equal(saved.player.onboarding.step,'homeland');
  await owner('identity/nostr/link/verify',link,409);
  await rival('identity/nostr/link/challenge',{publicKey,consent:true},409);
  await stranger('public/identity/'+publicKey,undefined,404);

  const preLogout=owner.sessionCookie();
  await owner('session/logout',{});
  assert.ok(app.store.hasSeat(id));
  assert.equal((await owner('session')).authenticated,false);
  await owner('state',undefined,401,{cookie:preLogout});
  await stop();
  await open();
  const clean=client();
  const nostr=(await clean('identity/nostr/challenge',{publicKey})).result;
  const signed={nonce:nostr.nonce,event:signNostrEvent(nostr.template,signer)};
  await stranger('identity/nostr/verify',signed,409);
  const switching=(await rival('identity/nostr/challenge',{publicKey})).result;
  await rival('identity/nostr/verify',{nonce:switching.nonce,event:signNostrEvent(switching.template,signer)},409);
  assert.equal((await rival('state')).player.id,'p2');
  const restored=await clean('identity/nostr/verify',signed);
  assert.equal(restored.result.player,id);
  for (const field of ['name','troops','buildings','resources','score','onboarding','achievements']) assert.deepEqual(restored.state.player[field],saved.player[field]);
  assert.deepEqual(restored.state.archive,saved.archive);
  await clean('identity/nostr/verify',signed,409);

  const verifyWallet=(await clean('wallet/challenge',{address})).result;
  const walletProof={address,signature:compactSignature(key,verifyWallet.challenge)};
  const wallet=(await clean('wallet/verify',walletProof)).state;
  assert.equal(app.store.walletKey(id).publicKey,bchKey);
  assert.deepEqual(wallet.signIn,{bch:address,nostr:publicKey});
  await clean('wallet/verify',walletProof,409);
  const unused=walletFromPrivateKey(wrong).address;
  const unknown=(await stranger('identity/bch/challenge',{address:unused})).result;
  await stranger('identity/bch/verify',{nonce:unknown.nonce,signature:compactSignature(wrong,unknown.message)},400);
  assert.equal((await stranger('session')).authenticated,false);
  const walletDuplicate=(await rival('wallet/challenge',{address})).result;
  await rival('wallet/verify',{address,signature:compactSignature(key,walletDuplicate.challenge)},409);
  await rival('wallet/challenge',{address},403,{Origin:'https://example.invalid'});

  const previouslyValid=clean.sessionCookie();
  time+=31*86_400_000;
  await clean('state',undefined,401,{cookie:previouslyValid});
  const otherBrowser=client();
  const expired=(await otherBrowser('identity/bch/challenge',{address})).result;
  time+=301_000;
  await otherBrowser('identity/bch/verify',{nonce:expired.nonce,signature:compactSignature(key,expired.message)},409);
  const bch=(await otherBrowser('identity/bch/challenge',{address})).result;
  const bchProof={nonce:bch.nonce,signature:compactSignature(key,bch.message)};
  await stranger('identity/bch/verify',bchProof,409);
  await otherBrowser('identity/bch/verify',{...bchProof,signature:compactSignature(wrong,bch.message)},400);
  assert.equal((await otherBrowser('session')).authenticated,false);
  assert.equal((await otherBrowser('identity/bch/verify',bchProof)).result.player,id);
  await otherBrowser('identity/bch/verify',bchProof,409);
  const stale=(await otherBrowser('identity/bch/challenge',{address})).result;
  const replacement=walletFromPrivateKey(wrong).address;
  const replace=(await otherBrowser('wallet/challenge',{address:replacement})).result;
  await otherBrowser('wallet/verify',signWalletChallenge(wrong,replace.challenge));
  await otherBrowser('identity/bch/verify',{nonce:stale.nonce,signature:compactSignature(key,stale.message)},400);
  const duplicate=client();
  await duplicate('session',{demo:'p3'});
  const retired=(await duplicate('wallet/challenge',{address})).result;
  await duplicate('wallet/verify',{address,signature:compactSignature(key,retired.challenge)},409);
  const recovery=(await otherBrowser('identity/bch/challenge',{address:replacement})).result;
  assert.equal((await otherBrowser('identity/bch/verify',{nonce:recovery.nonce,signature:signLocalBchProof(wrong,recovery.message)})).result.player,id);
  assert.deepEqual(Object.keys(app.store.read().world.cities),initial);
  assert.deepEqual(app.store.payments(),[]);
});
