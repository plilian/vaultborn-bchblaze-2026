import { NETWORK, NETWORK_LABEL } from './network.js';
let manager;
let relay;
let timeout;
let pending;
let phase = { status: 'closed' };
let packagePromise;
let generation = 0;
const load = () => packagePromise ??= import('./vendor/wizardconnect.js');
// A pairing stays until the player disconnects it or signs out. It is kept in this browser's own storage, so it
// survives other pages, new tabs and a restart of the browser. It is a relay session, not a BCH key: every use of it
// still needs the player's approval in the wallet.
const sessionStore = () => { try { return localStorage; } catch { return undefined; } };
const sessionName = (player, testRelay) => 'vaultborn-wizard-v1:' + player + ':' + (testRelay ?? NETWORK.id);

export const wizardState = () => phase;
// A restored pairing needs its relay connection before a request can go out; that takes a moment after a page opens.
async function relayReady(signal) {
  for (let waited = 0; !manager?.conn && waited < 20_000; waited += 200) { signal?.throwIfAborted(); await new Promise(done => setTimeout(done, 200)); }
  if (!manager?.conn) throw new Error('The wallet connection is still starting. Try again in a moment.');
}
export const walletAddress = linked => phase.address ?? linked?.address ?? null;
export const walletLabel = linked => {
  const address = walletAddress(linked);
  return address ? address.slice(0, 15) + '…' + address.slice(-5) : 'Connect wallet';
};

function update(fields) {
  phase = { ...phase, ...fields };
  document.dispatchEvent(new CustomEvent('vaultborn-wallet-status'));
}

export async function connectWizard(walletChoice='WizardConnect wallet', { testRelay, player, resume=false }={}) {
  if (relay || ['opening','restoring','closing'].includes(phase.status)) return;
  const current = ++generation;
  update({ status: resume?'restoring':'opening', error:null, walletChoice, canReconnect:false });
  try {
    const { initiateDappRelay, DappConnectionManager, qrImage, decodeHdPublicKey, encodeCashAddress, hash160, binToHex } = await load();
    if (current !== generation) return;
    // A relay key is scoped to the current kingdom, endpoint and tab. It is not a BCH spending key.
    let session=false;
    // Storage can be unavailable in a private browsing context; the pairing then lasts for this page only.
    if(player && sessionStore()) session={key:sessionName(player,testRelay),storage:sessionStore()};
    const activeManager = new DappConnectionManager('VAULTBORN '+NETWORK_LABEL, undefined, { session });
    const saved=resume?activeManager.loadStoredSession():null;
    if (resume&&!saved?.walletPublicKey) {
      update({status:'closed'});
      return;
    }
    manager=activeManager;
    const stop = ({ error, canReconnect=false, forget=false }={}) => {
      if (current!==generation) return;
      ++generation;
      clearTimeout(timeout);
      pending?.abort();
      if (forget) activeManager.clearStoredSession();
      void activeManager.destroy();
      relay?.cleanup();
      relay=undefined;
      manager=undefined;
      phase={status:'closed',error,canReconnect};
      update({});
    };
    manager.on('walletready', message => {
      if (current !== generation || pending) return;
      const paths=activeManager.getSessionPaths();
      // Selene announces protocol readiness before asking its user for consent.
      // Its first valid wallet_ready has no HD paths; keep pairing until the
      // approval produces another wallet_ready with the actual receive xpub.
      if (!paths.length) {
        update({waitingApproval:true});
        return;
      }
      clearTimeout(timeout);
      // Selene encodes its selected wallet network in the receive xpub.
      // Other WizardConnect implementations may serialize a network-neutral xpub.
      const receive=paths.find(path=>path.name==='receive');
      // A wallet on the other network is refused at pairing: nothing is ever built for it to sign.
      const walletNetwork=receive ? decodeHdPublicKey(receive.xpub)?.network : undefined;
      if (/\bselene\b/i.test(message.wallet_name) && walletNetwork && walletNetwork!==(NETWORK.realValue?'mainnet':'testnet')) {
        stop({error:NETWORK.realValue ? 'Selene is on a test network. Switch Selene to Mainnet, then pair again.' : 'Selene is on Mainnet. Switch to Chipnet in Selene, then pair again.',forget:true});
        return;
      }
      const key=activeManager.getPubkey(0,0n);
      if (!key) {
        stop({ error:'This wallet did not share a receiving address. Choose a compatible HD wallet and pair again.', forget:true });
        return;
      }
      update({ status:'ready', walletName: message.wallet_name,
        address:encodeCashAddress({prefix:NETWORK.prefix,type:'p2pkh',payload:hash160(key)}).address,
        publicKey:binToHex(key), code:null, uri:null, error:null, canReconnect:false,waitingApproval:false,asleep:false });
    });
    // A phone wallet that is locked or in the background stops answering. That is not a disconnection: the pairing is
    // kept, the wallet is shown as resting, and a request sent meanwhile reaches it when the player opens the wallet.
    manager.on('reconnecting', () => {
      if (current!==generation || !['ready','signing'].includes(phase.status)) return;
      update({asleep:true});
    });
    manager.on('disconnect', (reason, message) => {
      // Only a wallet that cannot speak this protocol is dropped. Anything else keeps the pairing until the player ends it.
      if (/protocol/i.test(String(reason)) || /protocol/i.test(String(message))) { stop({error:message || 'This wallet cannot be used here.',forget:true}); return; }
      if (current===generation && ['ready','signing'].includes(phase.status)) update({asleep:true});
    });
    relay = initiateDappRelay(({client,status}) => {
      if(current===generation) activeManager.updateConnection(client, status);
    }, { ...(testRelay?{explicitRelayUrls:[testRelay]}:{}), ...(saved?{existingCredentials:saved}:{}) });
    activeManager.attachRelay(relay);
    if (resume) {
      // The saved pairing holds the wallet's public keys, so the wallet counts as connected at once, resting until it answers.
      const key=activeManager.getPubkey(0,0n);
      if (key && phase.status!=='ready') {
        update({ status:'ready', walletName:saved.walletName ?? phase.walletChoice ?? 'Wallet',
          address:encodeCashAddress({prefix:NETWORK.prefix,type:'p2pkh',payload:hash160(key)}).address,
          publicKey:binToHex(key), code:null, uri:null, error:null, canReconnect:false, waitingApproval:false, asleep:true });
      } else if (phase.status!=='ready') timeout=setTimeout(()=>{
        if(current!==generation||phase.status!=='restoring')return;
        stop({error:'Wallet did not answer. Open it and reconnect, or start a new pairing.',canReconnect:true});
      },20000);
      return;
    }
    const uri = relay.uri;
    const code = await qrImage(relay.qrUri, { color:{ dark:'#152326',light:'#fff3d2' }, width:230, margin:2 });
    if (current !== generation) return;
    if (phase.status !== 'ready') update({ status:'pairing', uri, code });
    if (phase.status!=='ready') timeout = setTimeout(() => {
      if (phase.status === 'pairing') stop({ error:'Pairing expired. Choose a wallet to try again.', forget:true });
    }, 180_000);
  } catch (error) {
    if (current !== generation) return;
    relay?.cleanup();
    relay = undefined;
    void manager?.destroy();
    manager=undefined;
    phase={status:'closed',error:error.message || 'WizardConnect could not start.'};
    update({});
  }
}

export async function closeWizard() {
  if (phase.status === 'broadcasting') return;
  const closing = ++generation;
  update({status:'closing',address:null,publicKey:null});
  clearTimeout(timeout);
  pending?.abort();
  const active = relay;
  const activeManager=manager;
  relay = undefined;
  manager=undefined;
  activeManager?.clearStoredSession();
  try { if (active) await Promise.race([activeManager.sendDisconnect(), new Promise(resolve => setTimeout(resolve, 800))]); }
  catch { /* The relay can close before receiving a courtesy message. */ }
  finally { void activeManager?.destroy(); active?.cleanup(); }
  if (closing === generation) {
    phase = { status:'closed' };
    update({});
  }
}

// The public keys of the wallet's first addresses on both branches, as the wallet shared them. Never a secret.
function offeredKeys(binToHex, receive, change) {
  return [['receive',0,receive],['change',1,change]].flatMap(([path, branch, count]) =>
    Array.from({ length:count }, (_, index) => {
      const key = manager.getPubkey(branch, BigInt(index));
      return key ? { index, path, publicKey:binToHex(key) } : null;
    }).filter(Boolean));
}

// The game looks at 8 receiving and 4 change addresses and waits 90 seconds for the approval; a caller may ask for more.
export async function approveWizard(intent, api, { receive = 8, change = 4, timeoutMs = 90_000 } = {}) {
  if (phase.status !== 'ready' || !manager) throw new Error('Connect your wallet first.');
  if (pending) throw new Error('A wallet approval is already in progress.');
  const controller = new AbortController();
  pending = controller;
  const deadline = setTimeout(() => controller.abort('Your wallet did not answer. Open the wallet app and try again. If this game is no longer listed under WizardConnect in the wallet, disconnect here and connect once more.'), Math.max(timeoutMs, 180_000));
  update({ status:'signing', error:null });
  try {
    const { binToHex } = await load();
    await relayReady(controller.signal);
    const keys = offeredKeys(binToHex, receive, change);
    if (!keys.length) throw new Error('The wallet did not offer a usable address path.');
    const prefix = '/payments/' + intent.id + '/wallet/';
    const { result: plan } = await api(prefix + 'prepare', { keys });
    controller.signal.throwIfAborted();
    const response = await manager.signTransaction({ transaction: { transaction:plan.transaction, sourceOutputs:plan.sourceOutputs,
      userPrompt:plan.userPrompt, broadcast:false }, inputPaths:plan.inputPaths }, { signal:controller.signal });
    if (typeof response.signedTransaction !== 'string' || !response.signedTransaction) {
      throw new Error(response.error || 'The wallet returned no signature.');
    }
    controller.signal.throwIfAborted();
    update({status:'broadcasting'});
    return await api(prefix + 'broadcast', { signedTransaction:response.signedTransaction });
  } catch (error) {
    throw typeof error === 'string' ? new Error(error) : error;
  } finally {
    clearTimeout(deadline);
    pending = null;
    if (phase.status === 'signing' || phase.status === 'broadcasting') update({ status:relay ? 'ready' : 'closed' });
  }
}

// Connecting is the verification. The wallet signs a proof transaction that is never sent and could not be confirmed:
// its only input is a coin that does not exist, and its output returns the same amount to the wallet's own address.
// The game checks the signature and then knows the wallet is the player's. Nothing is paid, nothing is broadcast.
export async function proveWizard(api, { timeoutMs = 120_000 } = {}) {
  if (phase.status !== 'ready' || !manager || !phase.publicKey) throw new Error('Connect your wallet first.');
  if (pending) throw new Error('A wallet approval is already in progress.');
  const controller = new AbortController();
  pending = controller;
  const deadline = setTimeout(() => controller.abort('The wallet did not answer in time.'), timeoutMs);
  update({ status:'signing', proving:true, error:null });
  try {
    await relayReady(controller.signal);
    const { result: plan } = await api('/identity/wizard/prepare', { publicKey:phase.publicKey });
    controller.signal.throwIfAborted();
    const response = await manager.signTransaction({ transaction: { transaction:plan.transaction, sourceOutputs:plan.sourceOutputs,
      userPrompt:plan.userPrompt, broadcast:false }, inputPaths:plan.inputPaths }, { signal:controller.signal });
    if (typeof response.signedTransaction !== 'string' || !response.signedTransaction) {
      throw new Error(response.error || 'The wallet did not approve the check.');
    }
    controller.signal.throwIfAborted();
    const verify = extra => api('/identity/wizard/verify', { nonce:plan.nonce, signedTransaction:response.signedTransaction, ...extra });
    try { return await verify(); }
    catch (error) { if (error && typeof error === 'object') error.again = verify; throw error; }
  } catch (error) {
    // An aborted wait carries its reason as a plain text.
    throw typeof error === 'string' ? new Error(error) : error;
  } finally {
    clearTimeout(deadline);
    pending = null;
    if (phase.status === 'signing') update({ status:relay ? 'ready' : 'closed', proving:false });
  }
}

// The start page pairs the wallet before it knows which kingdom it opens. The pairing is then handed to that kingdom,
// so the game finds the wallet still connected. Only the relay session moves; it is not a BCH key.
export function adoptWizardSession(from, to, testRelay) {
  try {
    const store = sessionStore();
    const saved = store?.getItem(sessionName(from, testRelay));
    if (saved) { store.setItem(sessionName(to, testRelay), saved); store.removeItem(sessionName(from, testRelay)); }
  } catch { /* Without browser storage the player pairs once more inside the game. */ }
}

// The public keys of the wallet's first addresses, as the wallet shared them. Used to show a balance; never a secret.
export async function walletKeys({ receive = 8, change = 4 } = {}) {
  if (phase.status !== 'ready' || !manager) return [];
  const { binToHex } = await load();
  return offeredKeys(binToHex, receive, change);
}

export function cancelWizardApproval() {
  if (phase.status === 'signing') pending?.abort('Wallet approval canceled.');
}
