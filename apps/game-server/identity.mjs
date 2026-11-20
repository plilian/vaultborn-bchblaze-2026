import { createHash, randomBytes } from 'node:crypto';
import { commanderOwnership } from '../../packages/game-engine/progression.mjs';
import { heroes } from '../../config/balance.mjs';
import { decodeAddress } from '../../packages/chain-observer/primitives.mjs';
import { verifiedBchMessageKey } from './bch-sign-in.mjs';
import {
  authenticationBchMessage, authenticationEventTemplate, authenticationKind, bindingBchMessage, bindingEventTemplate,
  createAuthenticationChallenge, createBindingChallenge, eventDigest, identityDiscoveryFilter, identityId, maxIdentityRevisions,
  proofTTL, readBindingPayload, rotationEventTemplate, verifyBindingEvent, verifyIdentityAuthentication, verifyNostrEvent,
} from '../../packages/decentralized-identity/index.mjs';
import { NETWORK_LABEL } from '../../config/network.mjs';
import { proofIsValid, proofPlan } from './wallet-proof.mjs';

const noncePattern=/^[0-9a-f]{64}$/;
const proofPattern=/^[0-9a-f]{128}$/;
const identityRoute=/^\/api\/public\/identity\/([0-9a-f]{64})$/;

export function createIdentity({ store, clock, fail }) {
  const {world}=store.read();
  const realm='vaultborn:'+createHash('sha256').update('identity realm v1\n'+world.secret).digest('hex');
  const audience=realm+':session';
  const seconds=()=>Math.floor(clock()/1000);
  const record=player=>store.portal('identity-account',player);
  const identityOwner=id=>store.portal('identity-id',id)?.player;
  const nostrOwner=key=>store.portal('identity-key',key)?.player;
  const privateNostr=player=>store.portal('identity-local-nostr',player)?.publicKey;
  const sameWallet=(player,binding)=>store.walletKey(player)?.publicKey.toLowerCase()===binding?.bchKey;
  const isRoute=path=>path.startsWith('/api/identity/') || path.startsWith('/api/public/identity/');
  const guarded=fn=>{try {return fn();} catch(error) {if (error.status) throw error; fail(400,error.message);}};

  function summary(player) {
    const binding=record(player)?.head;
    return binding ? {...binding,walletMatches:sameWallet(player,binding),publicPath:'/api/public/identity/'+binding.identity.slice(6)} : null;
  }

  function signIn(player) {
    const binding=record(player)?.head;
    // Once a portable history exists, its current revision controls Nostr access.
    const nostr=binding ? (binding.status==='active' && sameWallet(player,binding) ? binding.nostrKey : null) : privateNostr(player) ?? null;
    return {bch:store.wallet(player)?.address ?? null,nostr};
  }

  function nostrSignInOwner(publicKey) {
    const player=nostrOwner(publicKey);
    return player && signIn(player).nostr===publicKey ? player : null;
  }

  function singleKeyChallenge(type, data, { browser, origin, session, player }) {
    const issuedAt=seconds();
    const payload={nonce:randomBytes(32).toString('hex'),issuedAt,expiresAt:issuedAt+proofTTL,origin,audience};
    let publicKey;
    if (type==='bch-login') {
      let address;
      try {
        const decoded=decodeAddress(data.address);
        if (decoded.tokenSupport || !/^76a914[0-9a-f]{40}88ac$/.test(decoded.script)) throw new Error('Unsupported address');
        address=decoded.address;
      } catch { fail(400,'Enter a personal ' + NETWORK_LABEL + ' P2PKH receiving address.'); }
      payload.address=address;
      // Return the same challenge shape even when nobody has verified this address.
      player=store.walletOwner(address) ?? null;
      publicKey=player ? store.walletKey(player)?.publicKey : null;
    } else {
      publicKey=typeof data.publicKey==='string' && data.publicKey.trim().toLowerCase();
      if (!publicKey || !noncePattern.test(publicKey)) fail(400,'Enter a 64-character Nostr public key.');
      payload.publicKey=publicKey;
      if (type==='nostr-link') {
        if (data.consent!==true) fail(400,'Agree to use this Nostr key to recover this kingdom.');
        checkPrivateLink(player,publicKey);
        payload.account=player;
      } else player=nostrSignInOwner(publicKey);
    }
    const token=type==='nostr-link' ? session.token : browser(true);
    store.saveIdentityChallenge({type,player,publicKey,token,payload},issuedAt);
    const {nonce,expiresAt}=payload;
    return type==='bch-login' ? {nonce,expiresAt,address:payload.address,message:bchLoginMessage(payload)} :
      {nonce,expiresAt,publicKey,template:nostrTemplate(type,payload)};
  }

  function bchLoginMessage(payload) {
    const {address,origin,audience:recipient,nonce,expiresAt}=payload;
    return `VaultBorn: Sign in with Bitcoin Cash\nSite: ${origin}\nAddress: ${address}\nAudience: ${recipient}\nExpires: ${new Date(expiresAt*1000).toISOString()}\nNonce: ${nonce}\nThis signs a message. It does not spend BCH.`;
  }

  function nostrTemplate(type,payload) {
    return {pubkey:payload.publicKey,kind:authenticationKind,created_at:payload.issuedAt,
      tags:[['t',`vaultborn-${type}-v1`],['origin',payload.origin],['challenge',payload.nonce]],
      content:JSON.stringify({purpose:type==='nostr-link'?'Link Nostr to this kingdom':'Sign in to VaultBorn',...payload})};
  }

  function checkPrivateLink(player, publicKey) {
    if (record(player)?.head) fail(409,'Manage the Nostr key through your existing public identity.');
    if (privateNostr(player)) fail(409,'This kingdom already has a Nostr sign-in key.');
    if (nostrOwner(publicKey)) fail(409,'That Nostr key is already associated with a kingdom.');
    if (store.walletKey(player)?.publicKey.slice(2).toLowerCase()===publicKey) fail(400,'Use distinct BCH and Nostr keys.');
  }

  function finishSingleKey(type, data, { session, browser, origin, newSession }) {
    const row=typeof data.nonce==='string' && noncePattern.test(data.nonce) && store.identityChallenge(data.nonce,seconds());
    const token=type==='nostr-link' ? session.token : browser(false);
    if (!row || row.type!==type || row.token!==token || row.payload.origin!==origin ||
      (type==='nostr-link' && session.player!==row.player)) fail(409,'Generate a fresh challenge in this browser.');
    const {payload,player,publicKey}=row;
    if (type==='bch-login') {
      const wallet=player && store.walletKey(player);
      if (!wallet || wallet.address!==payload.address || wallet.publicKey!==publicKey || !verifiedBchMessageKey({
        address:payload.address,publicKey,signature:data.signature,challenge:bchLoginMessage(payload),
      })) fail(400,'This signature could not recover a kingdom. Check the wallet and request a fresh challenge.');
    } else {
      const event=data.event;
      if (!verifyNostrEvent(event) || eventDigest(event)!==eventDigest(nostrTemplate(type,payload))) {
        fail(400,'The Nostr signature does not match this challenge.');
      }
      if (type==='nostr-link') checkPrivateLink(player,publicKey);
      else if (!player || nostrSignInOwner(publicKey)!==player) fail(400,'This Nostr key could not recover a kingdom.');
    }
    // Signing in is how a player reaches their own kingdom: from a browser that holds another kingdom, it opens theirs.
    if (!store.consumeIdentityChallenge(payload.nonce)) fail(409,'This challenge was already used.');
    if (type==='nostr-link') {
      store.savePortal('identity-key',publicKey,{player});
      store.savePortal('identity-local-nostr',player,{publicKey});
      return {publicKey};
    }
    newSession(player);
    return player;
  }

  // ---- A WizardConnect wallet proves its key by signing the proof transaction (see wallet-proof.mjs) ---------------
  // One pair of requests serves the start page and the game:
  //   nobody signed in, the wallet belongs to a kingdom    → that kingdom is opened;
  //   nobody signed in, the wallet is new                  → a new kingdom is created and the wallet linked to it;
  //   signed in                                            → the wallet is linked to this kingdom.
  function wizardChallenge(data, { browser, origin, session }) {
    const publicKey=typeof data.publicKey==='string' && data.publicKey.trim().toLowerCase();
    if (!publicKey || !/^0[23][0-9a-f]{64}$/.test(publicKey)) fail(400,'The wallet did not share a usable public key. Pair it again.');
    const issuedAt=seconds();
    const payload={nonce:randomBytes(32).toString('hex'),issuedAt,expiresAt:issuedAt+proofTTL,origin};
    const plan=guarded(()=>proofPlan({publicKey,...payload}));
    store.saveIdentityChallenge({type:'wizard',player:session?.player ?? null,publicKey,token:session ? session.token : browser(true),payload},issuedAt);
    return {nonce:payload.nonce,expiresAt:payload.expiresAt,address:plan.wallet.address,transaction:plan.transaction,sourceOutputs:plan.sourceOutputs,
      inputPaths:plan.inputPaths,userPrompt:plan.userPrompt};
  }

  function finishWizard(data, { session, browser, origin, newSession, linkWallet, createKingdom }) {
    const row=typeof data.nonce==='string' && noncePattern.test(data.nonce) && store.identityChallenge(data.nonce,seconds());
    const token=session ? session.token : browser(false);
    if (!row || row.type!=='wizard' || row.token!==token || row.payload.origin!==origin || (row.player ?? null)!==(session?.player ?? null)) {
      fail(409,'The wallet check expired. Connect the wallet again.');
    }
    if (!proofIsValid({publicKey:row.publicKey,...row.payload},data.signedTransaction)) fail(400,'The wallet did not sign the proof. Connect it again and approve the request in the wallet.');
    if (!store.consumeIdentityChallenge(row.payload.nonce)) fail(409,'This wallet check was already used.');
    const {address}=proofPlan({publicKey:row.publicKey,...row.payload}).wallet;
    const owner=store.walletOwner(address) ?? null;
    if (session) {
      if (owner && owner!==session.player) {
        // The wallet's own kingdom opens: at once from a city not founded yet (it holds nothing), otherwise when the player
        // has confirmed in the game that they leave this kingdom for it. The wallet proof is the sign-in to that kingdom.
        const {world}=store.read();
        if (world.cities?.[session.player]?.founding || data.switchKingdom===true) { newSession(owner); return {player:owner,created:false,linked:false,switched:true}; }
        const name=world.cities?.[owner]?.founding ? null : world.cities?.[owner]?.name;
        throw Object.assign(new Error('This wallet already belongs to '+(name ? 'the kingdom '+name : 'another kingdom')+'.'),{status:409,code:'wallet-other-kingdom'});
      }
      linkWallet(session.player,address,row.publicKey);
      return {player:session.player,created:false,linked:true};
    }
    if (owner) { newSession(owner); return {player:owner,created:false,linked:false}; }
    const player=createKingdom();
    linkWallet(player,address,row.publicKey);
    newSession(player);
    return {player,created:true,linked:true};
  }

  function publicIdentity(key) {
    const player=identityOwner(identityId(key));
    const current=player && record(player);
    if (!current) fail(404,'No local public profile for this identity.');
    const {world}=store.read();
    const city=world.cities[player];
    const active=current.head.status==='active' && sameWallet(player,current.head);
    return {binding:current.head,events:current.events,discovery:identityDiscoveryFilter(current.head.identity),
      gameAssociation:active && city ? {authority:'VaultBorn save',realm,kingdom:city.name,player:city.id,
        reputation:city.reputation,achievements:Object.keys(city.achievements??{}),
        alliance:world.alliances[city.alliance]?.name??null,commanders:Object.keys(heroes).flatMap(id=>{
          const ownership=commanderOwnership(city,id,clock());
          return ownership==='permanent'||ownership==='rented' ? [{id,name:heroes[id].name,ownership}]:[];
        })} : null};
  }

  function bindingChallenge(player,data) {
    if (data.consent!==true) fail(400,'Approve the public association of your wallet, Nostr key, and kingdom.');
    const previous=record(player)?.head;
    const operation=data.operation;
    if (!['link','rotate','revoke'].includes(operation)) fail(400,'Choose Link, Rotate, or Revoke.');
    if ((operation==='link')===Boolean(previous)) fail(409,previous?'Use rotation or revocation for an existing identity.':'Link an identity first.');
    if (previous?.revision>=maxIdentityRevisions) fail(409,'The local revision limit for this identity has been reached.');
    if (operation==='revoke' && previous.status==='revoked') fail(409,'This identity is already revoked.');
    const wallet=operation==='revoke'?{address:previous.wallet,publicKey:previous.bchKey}:store.walletKey(player);
    if (!wallet) fail(403,'Connect your wallet first. A public identity is tied to your ' + NETWORK_LABEL + ' wallet.');
    const bchKey=wallet.publicKey.toLowerCase();
    const nostrKey=operation==='revoke'?previous.nostrKey:data.nostrKey;
    if (typeof nostrKey!=='string' || !noncePattern.test(nostrKey)) fail(400,'Enter a 64-character Nostr public key.');
    const oldOwner=nostrOwner(nostrKey);
    if (oldOwner && oldOwner!==player) fail(409,'That Nostr key is already associated with another kingdom.');
    if (operation==='link' && privateNostr(player) && privateNostr(player)!==nostrKey) {
      fail(409,'Use your existing Nostr sign-in key when first linking a public identity.');
    }
    if (operation==='rotate' && previous.status==='active' && previous.nostrKey===nostrKey && previous.bchKey===bchKey) {
      fail(400,'Choose at least one different key, or revoke the current identity.');
    }
    const now=seconds();
    const payload=createBindingChallenge({operation,realm,account:player,wallet:wallet.address,bchKey,nostrKey,previous,now});
    store.saveIdentityChallenge({type:'binding',player,payload},now);
    return {payload,message:bindingBchMessage(payload),priorMessage:previous && previous.bchKey!==payload.bchKey ? bindingBchMessage(payload,true) : null,
      priorNostrTemplate:previous && previous.nostrKey!==payload.nostrKey ? rotationEventTemplate(payload,previous.nostrKey,now) : null};
  }

  function authChallenge(data) {
    if (typeof data.identity!=='string' || !/^nostr:[0-9a-f]{64}$/.test(data.identity)) fail(400,'Enter a Nostr identity or 64-character public key.');
    const player=identityOwner(data.identity);
    const binding=player && record(player)?.head;
    if (!binding || binding.status!=='active' || !sameWallet(player,binding)) fail(404,'No active identity is available for sign-in.');
    const now=seconds();
    const payload=createAuthenticationChallenge(binding,audience,now);
    store.saveIdentityChallenge({type:'auth',player,payload},now);
    return {payload,wallet:binding.wallet,nostrKey:binding.nostrKey,message:authenticationBchMessage(payload)};
  }

  function loadChallenge(data,type,player) {
    const row=typeof data.nonce==='string' && noncePattern.test(data.nonce) && store.identityChallenge(data.nonce,seconds());
    if (!row || row.type!==type || (player && player!==row.player)) fail(409,'Generate a fresh challenge for this account.');
    const current=record(row.player);
    if ((type==='auth' ? row.payload.head : row.payload.previous)!==(current?.head.head ?? null)) {
      fail(409,'This challenge belongs to an older identity revision.');
    }
    return {...row,current};
  }

  function prepare(data,type,player) {
    const {payload,current}=loadChallenge(data,type,player);
    if (typeof data.bchSignature!=='string' || !proofPattern.test(data.bchSignature)) fail(400,'Supply the BCH wallet proof signature.');
    const now=seconds();
    return type==='auth' ? authenticationEventTemplate(payload,current.head,data.bchSignature,now) :
      bindingEventTemplate(payload,data.bchSignature,{priorBchSignature:data.priorBchSignature || null,priorNostrEvent:data.priorNostrEvent ?? null},now);
  }

  function finishBinding(player,data) {
    const now=seconds();
    const {payload,current}=loadChallenge(data,'binding',player);
    const {payload:signed}=readBindingPayload(data.event);
    if (JSON.stringify(signed)!==JSON.stringify(payload) || data.event.created_at>now) fail(400,'The signed event does not match this server challenge.');
    const next=verifyBindingEvent(data.event,current?.head);
    if (next.status==='active' && !sameWallet(player,next)) fail(409,'The verified wallet changed. Request a new challenge.');
    if (nostrOwner(next.nostrKey) && nostrOwner(next.nostrKey)!==player) {
      fail(409,'That Nostr key belongs to another kingdom.');
    }
    if (payload.operation==='link' && privateNostr(player) && privateNostr(player)!==next.nostrKey) {
      fail(409,'A Nostr sign-in key was added after this challenge. Generate a fresh challenge.');
    }
    if (!store.consumeIdentityChallenge(payload.nonce)) fail(409,'This challenge was already used.');
    store.savePortal('identity-account',player,{head:next,events:[...(current?.events??[]),data.event]});
    store.savePortal('identity-id',next.identity,{player});
    store.savePortal('identity-key',next.nostrKey,{player});
    return summary(player);
  }

  function finishAuth(data,openSession) {
    const {payload,current,player}=loadChallenge(data,'auth');
    if (!sameWallet(player,current.head) || !verifyIdentityAuthentication(data.event,payload,current.head,{audience,now:seconds()})) {
      fail(400,'The signatures do not authenticate this account and challenge.');
    }
    if (!store.consumeIdentityChallenge(payload.nonce)) fail(409,'This challenge was already used.');
    openSession(player);
    return player;
  }

  async function handle(req,res,path,{readJson,json,session:currentSession,browser,origin,newSession,stateFor,linkWallet,createKingdom,pairing}) {
    // Pairing through the server: start it, then ask how far it got. Bound to this browser's session or proof cookie.
    if (req.method==='POST' && (path==='/api/identity/wizard/pair' || path==='/api/identity/wizard/pair/status')) {
      if (!pairing) fail(404,'Wallet pairing is not available on this server.');
      const data=await readJson(req);
      const session=currentSession();
      const token=session ? session.token : browser(true);
      if (path==='/api/identity/wizard/pair') return json(res,200,{result:guarded(()=>pairing.start({token}))});
      return json(res,200,{result:pairing.status(typeof data.id==='string' ? data.id : '',token)});
    }
    if (req.method==='GET') {
      const publicMatch=identityRoute.exec(path);
      if (publicMatch) return json(res,200,guarded(()=>publicIdentity(publicMatch[1])));
      fail(404,'This identity route does not exist.');
    }
    if (req.method!=='POST') fail(405,'Use POST for identity challenges.');
    const data=await readJson(req);
    let currentPlayer;
    const result=guarded(()=>store.transaction(()=>{
      const session=currentSession();
      currentPlayer=session?.player;
      const context={session,browser,origin,newSession,player:currentPlayer,linkWallet,createKingdom};
      if (path==='/api/identity/wizard/prepare') return wizardChallenge(data,context);
      if (path==='/api/identity/wizard/verify') return finishWizard(data,context);
      if (path==='/api/identity/auth/challenge') return authChallenge(data);
      if (path==='/api/identity/auth/prepare') return prepare(data,'auth');
      if (path==='/api/identity/auth/verify') return finishAuth(data,newSession);
      if (path==='/api/identity/bch/challenge') return singleKeyChallenge('bch-login',data,context);
      if (path==='/api/identity/bch/verify') return finishSingleKey('bch-login',data,context);
      if (path==='/api/identity/nostr/challenge') return singleKeyChallenge('nostr-login',data,context);
      if (path==='/api/identity/nostr/verify') return finishSingleKey('nostr-login',data,context);
      if (!currentPlayer) fail(401,'Open your kingdom before linking an identity.');
      if (path==='/api/identity/nostr/link/challenge') return singleKeyChallenge('nostr-link',data,context);
      if (path==='/api/identity/nostr/link/verify') return finishSingleKey('nostr-link',data,context);
      if (path==='/api/identity/challenge') return bindingChallenge(currentPlayer,data);
      if (path==='/api/identity/prepare') return prepare(data,'binding',currentPlayer);
      if (path==='/api/identity/verify') return finishBinding(currentPlayer,data);
      fail(404,'This identity route does not exist.');
    }));
    if (['/api/identity/auth/verify','/api/identity/bch/verify','/api/identity/nostr/verify'].includes(path)) return json(res,200,{result:{player:result},state:stateFor(result)});
    if (path==='/api/identity/wizard/verify') return json(res,200,{result,state:stateFor(result.player)});
    if (path==='/api/identity/verify' || path==='/api/identity/nostr/link/verify') return json(res,200,{result,state:stateFor(currentPlayer)});
    return json(res,200,{result});
  }

  return {isRoute,handle,summary,signIn};
}
