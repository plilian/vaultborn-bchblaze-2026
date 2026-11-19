import {btn,html,tag} from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const modes={link:'Link BCH and Nostr',rotate:'Rotate or relink keys',revoke:'Revoke identity',auth:'Sign in with both keys',
  'choose-login':'Choose your sign-in method','auth-bch':'Sign in with BCH','auth-nostr':'Sign in with Nostr','link-nostr':'Link a Nostr sign-in'};
const singlePaths={'auth-bch':'/identity/bch','auth-nostr':'/identity/nostr','link-nostr':'/identity/nostr/link'};
let input=null;
const keyLabel=value=>`<code class="transaction-id">${html(value)}</code>`;
const textarea=(label,name,value='',required=true)=>`<div class="field"><label for="identity-${name}">${html(label)}</label><textarea id="identity-${name}" name="${name}" rows="3" spellcheck="false" ${required?'required':''}>${html(value)}</textarea></div>`;
const publicKey=(label,name,value='')=>`<label class="field"><span>${html(label)}</span><input name="${name}" value="${html(value)}" required autocomplete="off" spellcheck="false" maxlength="70"></label>`;
const button=(label,action)=>btn(label,'check',{'identity-action':action});
const confirm=(label,primary=true)=>`<button type="submit" class="btn${primary?' primary':''}">${html(label)}</button>`;
const safeObject=value=>{try {const obj=JSON.parse(value); if (!obj||Array.isArray(obj)||typeof obj!=='object') throw Error(); return obj;} catch {throw new Error('Paste the signed Nostr JSON object.');}};

export function enterIdentity(operation,player) { input=operation ? {operation,player} : null; }

export function renderIdentity(ctx) {
  const {identity,wallet,signIn}=ctx.ui.state;
  const started=input && input.player===ctx.own.id ? input : null;
  const binding=started?.challenge;
  const auth=started?.operation==='auth';
  const marker=identity ? tag(identity.status==='revoked'?'Revoked':identity.walletMatches?'Both keys verified':'Wallet changed · rotation required',
    identity.status==='active' && identity.walletMatches?'success':'') : tag('No linked identity','');
  const link=wallet?.address? button(identity?'Rotate or relink keys':'Link BCH and Nostr',identity?'rotate':'link') :
    btn('Verify ' + NETWORK_LABEL + ' wallet','bch',{modal:'wallet'});

  if (!started) return `<section class="identity-panel"><p>${marker}</p>
    <p>Return to this kingdom with ${signIn?.bch && signIn?.nostr ? 'either verified key' : signIn?.bch ? 'your verified BCH address' : signIn?.nostr ? 'your linked Nostr key' : 'a key you verify here'}. Signing ownership messages is free and leaves your game progress intact.</p>
    <p>Prove ownership of your BCH wallet and a separate Nostr identity. Linking makes your public keys, wallet address, and kingdom association readable in the local proof. The game does not request private keys, payments, or relay connections.</p>
    ${identity ? `<p>Portable identity<br>${keyLabel(identity.identity)}</p><p>Revision ${html(identity.revision)} · ${html(identity.wallet)}</p>
    <p><a class="btn" href="${html(identity.publicPath)}" target="_blank" rel="noopener">Open public proof (JSON)</a></p>` : ''}
    <div class="buttons">${link}${identity?.status==='active'?button('Revoke identity','revoke'):''}${!signIn?.nostr&&!identity?button('Link a Nostr sign-in','link-nostr'):''}</div>
    <p class="form-error" role="status"></p></section>`;

  if (started.operation==='choose-login') return `<section class="identity-panel"><h3>${modes[started.operation]}</h3>
    <p>Choose a key you previously verified in your kingdom. This signs a message without a transaction or fee.</p>
    <div class="buttons identity-choices">${button('BCH wallet','auth-bch')}${button('Nostr','auth-nostr')}${button('Both keys','auth')}</div></section>`;
  if (Object.hasOwn(singlePaths,started.operation)) return singleFlow(started);

  if (!binding) return `<section class="identity-panel"><h3>${modes[started.operation]}</h3><form data-identity-form="challenge">
    ${auth ? publicKey('Identity or original Nostr public key','key',identity?.identity??'') : started.operation==='revoke' ?
      `<p>Revocation signs a public record with both current keys. The old history stays verifiable and can no longer log in.</p>` :
      `${publicKey('Nostr public key (64 hex characters)','key',started.key??'')}<p>${button('Read key from Nostr extension','read-key')}</p>`}
    ${!auth ? '<label class="checkbox"><input name="consent" value="yes" type="checkbox" required><span>I consent to showing these public keys and their kingdom association in the local public proof.</span></label>' : ''}
    <div class="buttons">${confirm('Generate challenge')}${button('Back','reset')}</div><p class="form-error" role="status"></p></form></section>`;

  const direct=started.template;
  const signedPrior=started.priorNostr;
  return `<section class="identity-panel"><h3>${modes[started.operation]}</h3>
    <p>Use your own BCH signer to sign the exact challenge below. Keep your private keys in your signer. The challenge expires in five minutes.</p>
    ${textarea('BCH challenge (read only)','message',binding.message,false).replace('<textarea ','<textarea readonly ')}
    ${binding.priorMessage ? textarea('Previous BCH wallet challenge (read only)','prior-message',binding.priorMessage,false).replace('<textarea ','<textarea readonly ') : ''}
    ${!direct ? `<form data-identity-form="prepare">${publicKey('BCH wallet signature (128 hex characters)','bchSignature',started.bchSignature??'').replace('maxlength="70"','maxlength="128"')}
      ${binding.priorMessage ? publicKey('Previous BCH wallet signature','priorBchSignature',started.priorBchSignature??'').replace('maxlength="70"','maxlength="128"') : ''}
      ${binding.priorNostrTemplate ? `<p>Approve the rotation with the previous Nostr key. If you sign manually, use the exact unsigned event below.</p>
      ${textarea('Previous Nostr unsigned event (read only)','priorTemplate',JSON.stringify(binding.priorNostrTemplate,null,2),false).replace('<textarea ','<textarea readonly ')}
      ${textarea('Previous Nostr signed event JSON','priorNostr',signedPrior?JSON.stringify(signedPrior,null,2):'')}
      <p>${button('Sign with previous Nostr extension key','sign-prior')}</p>` : ''}
      <div class="buttons">${confirm('Prepare Nostr proof')}${button('Back','reset')}</div></form>` : `<form data-identity-form="finish">
      ${textarea('Nostr unsigned event (read only)','template',JSON.stringify(direct,null,2),false).replace('<textarea ','<textarea readonly ')}
      <p>${button('Sign with Nostr extension','sign-current')}</p>
      ${textarea('Signed Nostr event JSON','event',started.signed?JSON.stringify(started.signed,null,2):'')}
      <div class="buttons">${confirm(auth?'Verify and sign in':'Verify both keys')}${button('Back','reset')}</div></form>`}
    <p class="form-error" role="status"></p></section>`;
}

function singleFlow(flow) {
  const bch=flow.operation==='auth-bch';
  const linking=flow.operation==='link-nostr';
  const binding=flow.challenge;
  const readOnly=(label,name,value)=>textarea(label,name,value,false).replace('<textarea ','<textarea readonly ');
  const fields=bch ? `<label class="field"><span>Verified ${NETWORK_LABEL} receiving address</span><input name="address" required maxlength="100" autocomplete="off" spellcheck="false" value="${html(flow.address??'')}"></label>` :
    `${publicKey('Nostr public key (64 hex characters)','key',flow.key??'')}<p>${button('Read key from Nostr extension','read-key')}</p>`;
  return `<section class="identity-panel"><h3>${modes[flow.operation]}</h3>
    <form data-identity-form="${binding?'finish':'challenge'}">
    ${!binding ? fields + (linking ? '<label class="checkbox"><input name="consent" value="yes" type="checkbox" required><span>Let this Nostr key sign in to my kingdom. This step does not publish a portable BCH–Nostr proof.</span></label>' : '') : bch ?
    `<p>Sign the exact challenge with the key for your verified address. Keep your private key in your signer. Use the 128-character Schnorr signature or a standard BCH signed-message signature.</p>
      ${readOnly('BCH challenge (read only)','message',binding.message)}
      ${publicKey('BCH wallet signature','bchSignature').replace('maxlength="70"','maxlength="256"')}` :
    `<p>Sign the exact event with your Nostr extension or paste an event signed separately. This event is submitted privately to VaultBorn.</p>
      ${readOnly('Nostr unsigned event (read only)','template',JSON.stringify(flow.template,null,2))}
      <p>${button('Sign with Nostr extension','sign-current')}</p>${textarea('Signed Nostr event JSON','event')}`}
    <div class="buttons">${confirm(binding ? (linking ? 'Verify and link' : 'Verify and sign in') : 'Generate challenge')}${button('Back','reset')}</div>
    <p class="form-error" role="status"></p></form></section>`;
}

export function attachIdentityControls({api,draw,getPlayer,updated,notify,authenticated = () => location.reload()}) {
  let activeJob;
  const dialog = document.getElementById('dialog');
  dialog.addEventListener('cancel', () => activeJob?.controller.abort());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    activeJob?.controller.abort();
    input = null;
  });
  const showError=error=>{
    const area=dialog.querySelector('.identity-panel .form-error');
    if (area) area.textContent=error?.message ?? '';
  };
  async function run(operation,target) {
    const flow = input;
    if (!flow || activeJob?.flow === flow) return;
    const controller = new AbortController();
    const job = { flow, controller };
    const current = () => input === flow && dialog.open && !controller.signal.aborted;
    activeJob = job;
    showError();
    if (target) target.disabled=true;
    try { await operation(flow, current, controller.signal); }
    catch (error) { if (current()) showError(error); }
    finally {
      if (activeJob === job) activeJob = null;
      if (target?.isConnected) target.disabled=false;
    }
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('#dialog [data-identity-action]');
    if (!button) return;
    const action=button.dataset.identityAction;
    if (Object.hasOwn(modes,action) || action==='reset') {
      activeJob?.controller.abort();
      const signingIn=input?.operation?.startsWith('auth');
      input=action==='reset'? signingIn?{operation:'choose-login',player:getPlayer()}:null:{operation:action,player:getPlayer()};
      draw();
      return;
    }
    void run(async(flow,isCurrent)=>{
      if (!window.nostr) throw new Error('No Nostr browser signer detected. You can paste a separately signed event.');
      const current=await window.nostr.getPublicKey();
      if (!isCurrent() || !button.isConnected) return;
      if (action==='read-key') {
        button.closest('form').elements.key.value=current;
        return;
      }
      const unsigned=action==='sign-prior'?flow.challenge.priorNostrTemplate:flow.template;
      if (current!==unsigned.pubkey) throw new Error('Choose the indicated Nostr public key in your signer.');
      const {pubkey,...body}=unsigned;
      const signed=await window.nostr.signEvent(body);
      if (!isCurrent() || !button.isConnected) return;
      const field=button.closest('form').elements[action==='sign-prior'?'priorNostr':'event'];
      field.value=JSON.stringify(signed,null,2);
    },button);
  });
  document.addEventListener('submit',event=>{
    const kind=event.target.dataset.identityForm;
    if (!kind || !input) return;
    event.preventDefault();
    const data=Object.fromEntries(new FormData(event.target));
    const auth=input.operation==='auth';
    const path=auth?'/identity/auth':'/identity';
    void run(async(flow,isCurrent,signal)=>{
      const single=singlePaths[flow.operation];
      if (single) {
        if (kind==='challenge') {
          flow.address=data.address?.trim();
          flow.key=data.key?.trim().toLowerCase();
          const reply=await api(single+'/challenge',flow.operation==='auth-bch'?{address:flow.address}:
            {publicKey:flow.key,consent:data.consent==='yes'},{signal});
          if (!isCurrent()) return;
          flow.challenge=reply.result;
          flow.template=reply.result.template;
        } else {
          const proof=await api(single+'/verify',{nonce:flow.challenge.nonce,...(flow.operation==='auth-bch'?
            {signature:data.bchSignature.trim()}:{event:safeObject(data.event)})},{signal});
          if (!isCurrent()) return;
          if (flow.operation!=='link-nostr') { authenticated(proof); return; }
          input=null;
          updated(proof.state);
          notify('Nostr sign-in linked.');
        }
        draw();
        return;
      }
      if (kind==='challenge') {
        const key=(data.key??'').trim().toLowerCase();
        const result=await api(path+'/challenge',auth?{identity:key.startsWith('nostr:')?key:'nostr:'+key} :
          {operation:flow.operation,nostrKey:key,consent:data.consent==='yes'},{signal});
        if (!isCurrent()) return;
        flow.challenge=result.result;
      } else if (kind==='prepare') {
        flow.bchSignature=data.bchSignature.trim().toLowerCase();
        flow.priorBchSignature=data.priorBchSignature?.trim().toLowerCase();
        flow.priorNostr=data.priorNostr?safeObject(data.priorNostr):null;
        const result=await api(path+'/prepare',{nonce:flow.challenge.payload.nonce,bchSignature:flow.bchSignature,
          priorBchSignature:flow.priorBchSignature,priorNostrEvent:flow.priorNostr},{signal});
        if (!isCurrent()) return;
        flow.template=result.result;
      } else {
        const proof=await api(path+'/verify',{nonce:flow.challenge.payload.nonce,event:safeObject(data.event)},{signal});
        if (!isCurrent()) return;
        if (auth) { authenticated(proof); return; }
        input=null;
        updated(proof.state);
        notify(flow.operation==='revoke'?'Identity revoked.':'Both identity keys verified.');
      }
      draw();
    },event.submitter);
  });
}
