import { attachIdentityControls, enterIdentity, renderIdentity } from './decentralized-identity.js';
import { mountBlazeBar, openTrailerDialog, trailerVideo } from './blaze-bar.js';
import { NETWORK, NETWORK_LABEL } from './network.js';
import { adoptWizardSession, cancelWizardApproval, closeWizard, connectWizard, proveWizard, wizardState } from './ritual-wallet.js';

// The hackathon bar and the trailer. The trailer plays in place on this page; the video is fetched only then.
function playTrailer() {
  const figure = document.getElementById('trailer');
  if (!figure) return openTrailerDialog();
  const playing = figure.querySelector('video');
  if (playing) void playing.play().catch(() => {});
  else figure.replaceChildren(trailerVideo());
  figure.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
}
mountBlazeBar(document.getElementById('blaze-banner'), { onTrailer: playTrailer });
for (const button of document.querySelectorAll('[data-play-trailer]')) button.addEventListener('click', playTrailer);

const dialog = document.getElementById('dialog');
const identity = document.getElementById('gate-identity');
const heading = document.getElementById('sign-in-title');
let request;
let opener;

function drawIdentity(focusField = true) {
  if (request?.signal.aborted || !dialog.open) return;
  identity.innerHTML = renderIdentity({ own: { id: null }, ui: { state: {} } });
  if (focusField) identity.querySelector('input:not([readonly]), textarea:not([readonly]), .identity-choices button')?.focus();
}

function openSignIn(button) {
  if (dialog.open) return;
  request = new AbortController();
  opener = button;
  enterIdentity('choose-login', null);
  dialog.showModal();
  drawIdentity(false);
  heading.focus();
}

function closeSignIn() {
  request?.abort();
  dialog.close();
}

async function identityApi(path, value, {signal:job}={}) {
  const signal = job ? AbortSignal.any([request.signal, job]) : request.signal;
  const response = await fetch('/api' + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
    signal,
  });
  const result = await response.json();
  signal.throwIfAborted();
  if (!response.ok) throw new Error(result.error ?? 'Sign-in could not be completed. Try again.');
  return result;
}

for (const button of document.querySelectorAll('[data-open-sign-in]')) {
  button.addEventListener('click', () => openSignIn(button));
}

if (new URLSearchParams(location.search).get('sign-in')==='expired') {
  history.replaceState(null,'',location.pathname);
  dialog.querySelector('.gate-dialog-header p').textContent='Your session ended. Sign in to return to your existing kingdom.';
  openSignIn(document.querySelector('[data-open-sign-in]'));
}

dialog.querySelector('.gate-dialog-close').addEventListener('click', closeSignIn);
dialog.addEventListener('cancel', () => request?.abort());
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  request?.abort();
  enterIdentity(null, null);
  identity.replaceChildren();
  opener?.focus({ preventScroll: true });
});

attachIdentityControls({
  api: identityApi,
  draw: drawIdentity,
  getPlayer: () => null,
  authenticated() {
    try { sessionStorage.removeItem('vaultborn-first-campaign'); }
    catch { /* Sign-in does not depend on browser storage. */ }
    location.assign('/play');
  },
});

// ---- Connect wallet: pair with WizardConnect, let the wallet approve the proof, and go into the game ----------------
// Built with DOM calls only. The page never sees a private key; the proof the wallet signs sends and spends nothing.
{
  const walletDialog = document.getElementById('wallet-dialog');
  const panel = document.getElementById('gate-wallet');
  const ENTRANCE = 'entrance';
  let relay, proved = false, entering = false, failure = '';
  const node = (tag, text, attributes = {}) => Object.assign(document.createElement(tag), { textContent: text }, attributes);
  const walletApi = async (path, value) => {
    const response = await fetch('/api' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'The wallet could not be verified. Try again.');
    return result;
  };
  const start = choice => { failure = ''; proved = false; void connectWizard(choice, { player: ENTRANCE, testRelay: relay }); };
  async function enter() {
    if (proved || entering) return;
    proved = true; failure = ''; draw();
    try {
      const { result } = await proveWizard(walletApi);
      entering = true; draw();
      // The pairing goes with the player into the game, so the wallet is still connected there.
      adoptWizardSession(ENTRANCE, result.player, relay);
      try { sessionStorage.removeItem('vaultborn-first-campaign'); } catch { /* Entering does not depend on browser storage. */ }
      location.assign('/play');
    } catch (error) { failure = error.message || 'The wallet could not be verified.'; draw(); }
  }
  function draw() {
    if (!walletDialog.open) return;
    const state = wizardState();
    const parts = [];
    const buttons = (...items) => { const row = node('div', '', { className: 'gate-wallet-actions' }); row.append(...items); return row; };
    const action = (text, run, primary = false) => { const button = node('button', text, { type: 'button', className: primary ? 'gate-button' : 'quiet-link' }); button.addEventListener('click', run); return button; };
    if (entering) parts.push(node('p', 'Wallet verified. Entering your kingdom…', { className: 'gate-wallet-status' }));
    else if (state.status === 'pairing') {
      const pair = node('div', '', { className: 'gate-wallet-pair' });
      pair.append(Object.assign(new Image(230, 230), { src: state.code, alt: 'WizardConnect pairing code' }));
      const side = node('div', '');
      side.append(node('p', state.walletChoice === 'Selene Wallet' ? (NETWORK.realValue ? 'In Selene, open Apps → WizardConnect and scan this code, or paste the pairing link.' : 'Enable ' + NETWORK_LABEL + ' in Selene\u2019s Debug Options, then open Apps → WizardConnect and scan this code, or paste the pairing link.') :
        'Open WizardConnect in your ' + NETWORK_LABEL + ' wallet and scan this code, or paste the pairing link.'));
      if (state.waitingApproval) side.append(node('p', 'Confirm the connection in your wallet.', { className: 'gate-wallet-status' }));
      const open = node('a', 'Open in wallet', { className: 'gate-button', href: state.uri });
      const copy = action('Copy pairing link', async () => { try { await navigator.clipboard.writeText(state.uri); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy is not available here'; } });
      side.append(buttons(open, copy, action('Cancel', () => void closeWizard())));
      pair.append(side);
      parts.push(pair);
    } else if (state.status === 'opening' || state.status === 'restoring' || state.status === 'closing') parts.push(node('p', 'Opening WizardConnect…', { className: 'gate-wallet-status' }));
    else if (state.status === 'signing') {
      parts.push(node('p', 'Approve the request in your wallet. It proves the wallet is yours; it sends nothing and spends nothing.', { className: 'gate-wallet-status' }));
      parts.push(buttons(action('Cancel', () => cancelWizardApproval())));
    } else if (state.status === 'ready') {
      parts.push(node('p', (state.walletName ?? 'Wallet') + ' connected.', { className: 'gate-wallet-status' }));
      if (failure) parts.push(buttons(action('Verify again', () => { proved = false; void enter(); }, true), action('Disconnect', () => void closeWizard())));
    } else {
      parts.push(node('p', 'Choose your wallet. You approve two things in it: the connection, and a check that proves the wallet is yours. No BCH is sent.'));
      parts.push(buttons(action('Selene Wallet', () => start('Selene Wallet'), true), action('Other WizardConnect wallet', () => start('WizardConnect wallet'))));
    }
    const problem = failure || state.error;
    if (problem && !entering) parts.push(node('p', problem, { className: 'gate-wallet-error', role: 'alert' }));
    panel.replaceChildren(...parts);
  }
  document.addEventListener('vaultborn-wallet-status', () => {
    if (!walletDialog.open) return;
    if (wizardState().status === 'ready') void enter();
    draw();
  });
  const close = () => { if (walletDialog.open) walletDialog.close(); };
  walletDialog.querySelector('.gate-dialog-close').addEventListener('click', close);
  // Leaving the dialog ends the pairing, unless the player is on the way into the game with it.
  walletDialog.addEventListener('close', () => { if (!entering) void closeWizard(); panel.replaceChildren(); });
  const openWallet = () => { if (walletDialog.open) return; failure = ''; proved = false; walletDialog.showModal(); draw(); document.getElementById('wallet-title').focus(); };
  for (const button of document.querySelectorAll('[data-connect-wallet]')) button.addEventListener('click', openWallet);
  // Sign in offers the same WizardConnect connection first: the sign-in dialog gives way to the wallet dialog.
  for (const button of document.querySelectorAll('[data-sign-in-wizard]')) button.addEventListener('click', () => { closeSignIn(); openWallet(); });
  // The buttons appear only where wallets can pair with this server.
  fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.json()).then(session => {
    if (!session.walletConnect) return;
    relay = session.testWizardRelay;
    for (const button of document.querySelectorAll('[data-connect-wallet], [data-sign-in-wallet]')) button.hidden = false;
  }).catch(() => { /* Without an answer the page keeps its other ways in. */ });
}

if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const reveal = new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      target.classList.add('in-frame');
      reveal.unobserve(target);
    }
  }, { threshold: .22 });
  for (const chapter of document.querySelectorAll('[data-reveal]')) reveal.observe(chapter);
}
