import { icon } from './icons.js';
import { activateGameAudio, configureGameAudio, playGameCue, setBattleAudio } from './game-audio.js';
import { art, bch, btn, command, compact, crest, duration, faction, factionIcons, formatDate, html, list, nav, number, resources, setPaymentsInFlight, stat, tag, title } from './view.js';
import { activeWork, renderPage, renderDialog, formAnswer } from './screens.js';
import { battleCampNames, battleTimeline, mountBattleMotion } from './battle-motion.js';
import { raidSpoils } from './battle-report.js';
import { claimableTasks, whatNext, whatNextPanel } from './what-next.js';
import { adoptWizardSession, approveWizard, cancelWizardApproval, closeWizard, connectWizard, proveWizard, walletAddress, walletKeys, walletLabel, wizardState } from './ritual-wallet.js';
import { openCitadel, setCitadelPayments } from './citadel.js';
import { presentTerritoryNews } from './territory-outcomes.js';
import { territoryMarker } from './territory-field.js';
import { paintPoliticalOverlay, syncPoliticalFields } from './political-assembly.js';
import { politicalOutcomePage, presentPoliticalNews } from './political-outcomes.js';
import { attachIdentityControls, enterIdentity } from './decentralized-identity.js';
import { raidDossier } from './strategy-stats.js';
import { constrainCamera, moveCamera } from './world-camera.js';
import { commandDispatch, confirmedDispatch, marketQuoteView, noticeDispatch, paymentDispatch, trainingOrderView } from './campaign-ledger.js';
import { guideSteps, guideStepTargets, renderGuide } from './first-campaign.js';
import { filterCodex } from './game-guide.js';
import './game-tooltips.js';
import { NETWORK, NETWORK_LABEL } from './network.js';
import { mountBlazeBar } from './blaze-bar.js';
import { morph } from './morph.js';

const select = id => document.getElementById(id);
const dom = Object.fromEntries(['masthead', 'theater', 'world', 'world-stage', 'territories', 'world-cities', 'city-dock', 'activity-dock', 'inspector', 'atlas-controls', 'campaign', 'loading', 'dock', 'dialog', 'toast'].map(id => [id, select(id)]));
// The hackathon bar sits above the game, which is made shorter by its height (see blaze-bar.css).
mountBlazeBar(document.getElementById('blaze-banner'), { compact: true });
const citadel=select('campaign-citadel');
const guide=select('campaign-guide');
const regionNavigation = select('region-navigation');
const ui = {
  state: null, page: 'map', tabs: {}, targetId: null, inspector: true,
  channel: 'world', scale: 1.15, dx: 0, dy: 0, labels: false,
  dialog: null, vault: null, busy: false, replay: null,
  guide: null, guideReviewIndex: 0, guideSeen: new Set(), guideMarkup: '',
};
const labels = { gold: 'Imperial Domain', emerald: 'Dominion', azure: 'Royal Order', violet: 'Free Cities', crimson: 'Crimson Legion' };
const colors = { emerald: '#5af4b7', azure: '#67d9ef', crimson: '#fb795c', violet: '#c48ff3', gold: '#f0c35f' };
const strongholds = new Set(['p1','p2','p4','p5','p6','p9']);
let toastTimer;
let refreshPending = false;
let stream;
let replayController;
let mapPaintActors = '';
let regionPaint = '';
const sponsorImpressions = new Set();
const cityMenu = document.createElement('div');
cityMenu.className = 'select-menu world-context-menu';
cityMenu.popover = 'auto';
cityMenu.setAttribute('role','menu');
cityMenu.setAttribute('aria-label','City orders');
document.body.append(cityMenu);

function cities() {
  return list(ui.state?.cities);
}
const coreRegion = { id:'core', name:'Emerald Frontier', x:0, y:0, neighbors:[] };
const regions = () => ui.state?.atlas?.regions ?? [coreRegion];
const currentRegion = () => regions().find(item => item.id === ui.regionId) ?? coreRegion;
const regionOf = item => item?.region ?? 'core';
function localPosition(item, region = currentRegion()) {
  return { ...item, x:item.x-region.x, y:item.y-region.y };
}
function visibleCities() {
  const region = currentRegion();
  return cities().filter(city => regionOf(city) === region.id).map(city => localPosition(city, region));
}
function visibleSites() {
  const region = currentRegion();
  return list(ui.state?.territories).filter(site => regionOf(site) === region.id).map(site => localPosition(site, region));
}
function target() {
  return cities().find(city => city.id === ui.targetId) ?? null;
}
function gameNow() {
  return ui.state?.now == null ? Date.now() : ui.state.now + performance.now() - ui.receivedAt;
}
function playerCity() {
  const p = ui.state?.player ?? {};
  return p.city ?? p;
}
function factionName(city) {
  const id = faction(city);
  const def = ui.state?.config?.factions?.[id];
  return (typeof def === 'string' ? def : def?.label ?? def?.name) ?? labels[id];
}
function level(city) {
  return city.level ?? city.buildings?.hall?.level ?? city.buildings?.hall ?? 1;
}
function towerDefense(city) {
  return city.defense ?? city.wallDefense ?? city.buildings?.walls?.level ?? city.buildings?.walls;
}
function armyCount(city) {
  if (!city.troops) return city.garrison ?? city.troopCount;
  return Object.values(city.troops).reduce((sum, val) => sum + Number(val || 0), 0);
}
function countLeft() {
  const p = ui.state.player;
  const cap = ui.state.config?.rules?.attacksDaily ?? 3;
  const remaining = p.attacksLeft ?? p.attacksRemaining ?? Math.max(0, cap - list(p.attacks).filter(attack => (attack?.at ?? attack) > gameNow() - 86_400_000).length);
  return remaining + ' / ' + cap;
}
function price(name) {
  const fees = ui.state.config?.fees ?? {};
  const aliases = { 'attack-paid':['attack','attackPaid'], protectorate:['protectorate','protectorateProposal'], premium:['premium','upgrade'], rush:['rush'] };
  for (const key of [name, ...(aliases[name] ?? [])]) {
    const fee = fees[key];
    if (fee != null) return typeof fee === 'object' ? fee.satoshis ?? fee.amount : fee;
  }
  return null;
}
function feeLabel(name) {
  // A service already paid for and not received is owed: the next one costs nothing.
  const owed = ui.state?.vault?.serviceCredits?.[{ espionage:'espionage-paid', political:'political-operation' }[name] ?? name];
  if (owed) return 'free · already paid';
  const amount = price(name);
  return amount == null ? 'Shown at checkout' : bch(amount) + ' BCH';
}
function notify(message, isError = false) {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.hidden = false;
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, isError ? 6500 : 3400);
}
const muted = () => ui.state?.player.settings?.muted ?? !ui.state;

async function api(path, data, { signal } = {}) {
  const options = data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  };
  const response = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store', signal, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error ?? payload.message ?? 'Request failed (' + response.status + ')'),{status:response.status,code:payload.code,preview:payload.preview});
  return payload;
}

// Connecting the wallet is the verification: as soon as a wallet is paired that this kingdom does not hold yet, it is
// asked once to approve the proof (it sends and spends nothing), and the kingdom is linked to it. Nothing to copy or paste.
let provedFor = null;
async function verifyWallet({ again = false } = {}) {
  const session = wizardState();
  if (session.status !== 'ready' || !session.address || !ui.state?.player) return;
  if (ui.state.wallet?.address === session.address) { ui.walletProof = null; return; }
  if (!again && provedFor === session.address) return;
  provedFor = session.address;
  ui.walletProof = { asking:true };
  if (ui.dialog?.mode === 'wallet') refreshDialog();
  try {
    const result = await proveWizard(api);
    // Signing in from a city not founded yet: the wallet already has a kingdom, and that kingdom opens with the wallet still connected.
    const opened = result.result?.player;
    if (opened && opened !== ui.state.player.id) {
      adoptWizardSession(ui.state.player.id, opened, ui.state.chain?.testWizardRelay);
      location.assign('/play');
      return;
    }
    if (result.state) setState(result.state);
    ui.walletProof = null;
    ui.walletAssets = null;
    playGameCue('reward', muted());
    notify('Wallet connected and verified.');
    void inspectWalletAssets();
    continuePendingPayment();
  } catch (error) {
    ui.walletProof = { error: error.message, ...(error.code === 'wallet-other-kingdom' && error.again && { openOther: error.again }) };
    notify(error.message, true);
  }
  renderAll();
  if (ui.dialog?.mode === 'wallet') refreshDialog();
}
// A paid action was refused because this kingdom has no wallet yet: say so, and open the wallet connection right there.
function requireWallet(error) {
  if (error?.code !== 'wallet-required') return false;
  playGameCue('message', muted());
  showDialog('wallet', { notice: error.message });
  void verifyWallet({ again:true });
  return true;
}

// A game event popup waits while another dialog is open, and shows once it closes (the three latest at most).
function presentEvent(view) {
  if (view && !dom.dialog.open && !ui.busy && !ui.archive) {
    playGameCue(view.sound ?? 'message', muted());
    showDialog('dispatch', { presentation:view });
  } else if (view) ui.eventQueue = [...(ui.eventQueue ?? []), view].slice(-3);
}

function setState(state) {
  if (!state?.player) return;
  if (state.revision != null && ui.state?.revision != null && state.revision < ui.state.revision) return;
  const oldPlayer=ui.state?.player?.id;
  const latest = state.notifications?.[0];
  const paymentStates=new Map(list(ui.state?.payments).map(payment=>[payment.id,payment.state]));
  const earlier=new Map(list(ui.state?.payments).map(payment=>[payment.id,payment]));
  // A purchase that just took effect is presented as a game event (picture, details, time); its receipt is one click away.
  const paymentApplied=oldPlayer===state.player.id && list(state.payments).find(payment=>earlier.has(payment.id) &&
    payment.fulfillment?.status==='applied' && earlier.get(payment.id).fulfillment?.status!=='applied' && !payment.fulfillment.redeemedCredit);
  const appliedView=paymentApplied && paymentDispatch(paymentApplied,state.config??{});
  // A checkout that closed before any BCH was sent is not news: nothing was paid, so nothing pops up.
  const paymentChange=oldPlayer===state.player.id && list(state.payments).find(payment=>
    paymentStates.has(payment.id) && ['credited','rejected','expired','reorg'].includes(payment.state) && paymentStates.get(payment.id)!==payment.state &&
    !(['rejected','expired'].includes(payment.state) && !payment.txid && payment.direction!=='outgoing'));
  // Just sent from the wallet: the receipt says how long the confirmation usually takes.
  const paymentSent=oldPlayer===state.player.id && list(state.payments).find(payment=>payment.direction!=='outgoing' &&
    paymentStates.has(payment.id) && ['created','awaiting_signature'].includes(paymentStates.get(payment.id)) && ['submitted','seen_in_mempool','confirming','uncertain'].includes(payment.state));
  let eventView=null;
  if (ui.state) {
    const seen = new Set(list(ui.state.notifications).map(entry => entry.id));
    const updates = list(state.notifications).filter(entry => !seen.has(entry.id));
    const political = presentPoliticalNews(ui.state, state, updates, muted());
    if (!political && latest && updates.length) {
      const cue = /complet|upgrade/i.test(latest.text) ? 'upgrade' : /reward|claim/i.test(latest.text) ? 'reward' : 'message';
      const territory = presentTerritoryNews(updates, muted());
      // Anything else that happened while the player is here gets its own popup: picture and short text.
      const views = territory || oldPlayer!==state.player.id ? [] : updates.map(entry => noticeDispatch(entry,state)).filter(Boolean);
      if (views.length) eventView = views.length>1 ? {...views[0],detail:views[0].detail+' '+(views.length-1)+' more in your notifications.'} : views[0];
      else if (!territory) playGameCue(cue, muted());
    }
  }
  ui.receivedAt = performance.now();
  ui.state = state;
  if(appliedView && !ui.busy && !ui.archive) {
    playGameCue(appliedView.sound,muted());
    showDialog('dispatch',{presentation:appliedView});
  } else if(paymentChange && paymentChange.state==='credited' && earlier.get(paymentChange.id)?.fulfillment?.early) {
    // Already applied and shown when it was seen; the confirmation is recorded in the notifications.
  } else if(paymentChange) {
    const confirmed=paymentChange.state==='credited'&&!['review','credit'].includes(paymentChange.fulfillment?.status);
    playGameCue(confirmed?'reward':'message',muted());
    // A confirmed payment is shown like any game event; one that needs attention opens its receipt.
    if (!dom.dialog.open && !ui.busy && !ui.archive) {
      if (confirmed) showDialog('dispatch',{presentation:confirmedDispatch(paymentChange)});
      else showDialog('payment',{id:paymentChange.id});
    }
  } else if (paymentSent && !ui.busy && !ui.archive && !(ui.dialog?.mode === 'payment' && ui.dialog.id === paymentSent.id)) {
    playGameCue('message',muted());
    showDialog('payment',{id:paymentSent.id});
  } else if (eventView) presentEvent(eventView);
  if (!ui.regionId || oldPlayer !== state.player.id || !regions().some(region => region.id === ui.regionId)) {
    ui.regionId = state.atlas?.homeRegion ?? regionOf(state.player);
  }
  if(oldPlayer&&oldPlayer!==state.player.id) {
    ui.walletAssets=null;
    ui.guide=null;
    ui.guideSeen.clear();
    void closeWizard().then(()=>resumeWizard());
  }
  setCitadelPayments(list(state.payments));
  setPaymentsInFlight(list(state.payments));
  if (!target() || regionOf(target()) !== currentRegion().id) {
    const own = playerCity();
    const here = visibleCities();
    ui.targetId = (here.find(city => city.name === 'Ironhaven' && city.id !== own.id)
      ?? here.find(city => city.id === own.id) ?? here[0])?.id ?? null;
  }
}

function renderHeader() {
  const own = playerCity();
  const state = ui.state;
  const activeAddress=walletAddress(state.wallet);
  const observedBalance = ui.walletAssets?.wallet?.address === activeAddress ? ui.walletAssets?.whole?.totalSatoshis ?? ui.walletAssets?.balance : null;
  const walletSats = (typeof observedBalance === 'number' ? observedBalance : observedBalance?.confirmedSatoshis) ?? state.vault?.walletSatoshis;
  const end = state.season?.endsAt ?? state.season?.endAt;
  const chain = state.chain ?? {};
  const needsAttention = list(state.notifications).length > 0;
  const running = activeWork({ ui, own, cities: cities(), gameNow:gameNow() }).length;
  const rewardsReady = claimableTasks(own).length;
  const resourceRow = resources.map(id => `<div class="resource r-${id}">${icon(id)}<div><small>${title(id)}</small><b data-tooltip="${html(number(own.resources?.[id]))}">${compact.format(own.resources?.[id] ?? 0)}</b></div></div>`).join('');
  morph(dom.masthead, `
    <button class="brand" type="button" data-page="map" aria-label="VAULTBORN home"><img class="icon" src="/logo.webp" width="38" height="48" alt=""><span class="brand-copy"><strong>VAULTBORN</strong><small>Build · Defend · Conquer</small></span></button>
    <div class="resource-bar" aria-label="City resources">${resourceRow}<div class="resource r-bch">${icon('bch')}<div><small>BCH</small><b data-tooltip="Wallet balance">${walletSats == null ? '—' : html(bch(walletSats))}</b></div></div></div>
    <button class="season-tag" type="button" data-page="rankings">${icon('crown')}<span><strong>Season ${html(state.season?.number ?? state.season?.id ?? 'I')}</strong><small ${end ? `data-until="${html(end)}"` : ''}>${end ? duration(end - gameNow()) : 'Campaign standings'}</small></span></button>
    <button class="network wallet-shortcut" data-modal="wallet" type="button" data-tooltip="${html(activeAddress??'Connect ' + NETWORK_LABEL + ' wallet')}" aria-label="${html(activeAddress?'Wallet '+walletLabel(state.wallet):'Connect wallet')}"><i class="status-dot ${wizardState().status==='ready'?'':'off'}"></i><span>${html(walletLabel(state.wallet))}</span>${icon('down')}</button>
    <button class="round-icon next-shortcut" data-modal="next" type="button" aria-label="What next${rewardsReady ? ', ' + rewardsReady + ' rewards to claim' : ''}" data-tooltip="What next">${icon('compass')}${rewardsReady ? '<b class="bell-count">' + rewardsReady + '</b>' : ''}</button>
    <button class="round-icon codex-shortcut" data-modal="codex" type="button" aria-label="Game guide" data-tooltip="Game guide">${icon('journal')}</button>
    <button class="round-icon" data-modal="inbox" type="button" aria-label="Notifications${running ? ', ' + running + ' in progress' : ''}">${icon('bell')}${running ? '<b class="bell-count">' + running + '</b>' : needsAttention ? '<i></i>' : ''}</button>
    <button class="round-icon" data-modal="profile" type="button" aria-label="Profile and settings">${icon('profile')}</button>`);
}

function renderNav() {
  const corner = select('tutorial-launch');
  if (corner && !corner.dataset.drawn) { corner.innerHTML = icon('quest') + '<span>Tutorial</span>'; corner.dataset.drawn = 'true'; }
  morph(dom.dock, nav.map(([id,label,glyph]) => `<button type="button" data-page="${id}" class="dock-item ${ui.page === id ? 'active' : ''}" ${ui.page === id ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></button>`).join(''));
}

function renderCityDock() {
  const own = playerCity();
  const total = Object.values(own.production ?? own.income ?? {}).reduce((sum, item) => sum + Number(item || 0), 0);
  const showTime = own.shieldUntil > gameNow();
  const actions = [['build','Build','hammer'],['army','Army','helmet'],['defense','Defense','shield'],['research','Research','upgrade']];
  morph(dom['city-dock'], `
    <div class="profile-title">${crest(own)}<div><span class="kicker">My city</span><h2>${html(own.name ?? 'Found a city')}</h2><span class="level-chip">LEVEL ${number(level(own))}${showTime ? ' · SHIELDED' : ''}</span><span class="progress"><i style="width:${Math.min(95,40+level(own)*9)}%"></i></span></div><img class="profile-art" src="${art(own)}" alt=""></div>
    <div class="stats">${stat('Power',number(own.power),'war')}${stat('Troops',number(armyCount(own)),'troops')}${stat('Defense',number(towerDefense(own)),'shield')}${stat('Income / h',total > 0 ? '+' + number(total) : '—','income','gain')}</div>
    <div class="city-actions">${actions.map(([id,text,glyph]) => `<button class="city-action" data-page="city" data-start-tab="${id}" type="button">${icon(glyph)}${text}${icon('chevron')}</button>`).join('')}</div>
    ${whatNextPanel(whatNext({ own, state:ui.state, guide:ui.guide, walletLinked:Boolean(walletAddress(ui.state.wallet)) }), own)}`);
}

function channelEntries() {
  const state = ui.state;
  if (ui.channel === 'system') {
    return [...list(state.notifications), ...list(state.activity)].sort((a,b) => b.at-a.at).slice(0,6);
  }
  const recent = list(state.messages).filter(item => (item.channel ?? 'world') === ui.channel);
  return (ui.channel === 'world' ? [...recent, ...list(state.activity)].sort((a,b) => b.at-a.at) : recent).slice(0,6);
}
// The chat starts folded away so the map stays clear for new players; it opens with one click and stays as it was left.
let chatOpen = (() => { try { return localStorage.getItem('vaultborn-chat') === 'open'; } catch { return false; } })();
function renderActivity() {
  const input = dom['activity-dock'].querySelector('input');
  if (input === document.activeElement) return;
  const entries = channelEntries();
  dom['activity-dock'].classList.toggle('folded', !chatOpen);
  if (!chatOpen) {
    morph(dom['activity-dock'], `<button type="button" class="activity-toggle" data-chat-toggle="open" aria-expanded="false">${icon('message')}<span>Chat and world news</span>${icon('chevron')}</button>`);
    return;
  }
  const disabled = ui.channel === 'system' || (ui.channel === 'alliance' && !ui.state.alliance);
  morph(dom['activity-dock'], `
    <button type="button" class="activity-hide" data-chat-toggle="close" aria-expanded="true" aria-label="Hide chat">${icon('x')}</button>
    <div class="activity-tabs" role="tablist">${['world','alliance','system'].map(channel => `<button type="button" role="tab" aria-selected="${channel === ui.channel}" class="${channel === ui.channel ? 'active' : ''}" data-channel="${channel}">${title(channel)}</button>`).join('')}</div>
    <div class="activity-entries" aria-live="polite">${entries.length ? entries.map(item => `<div class="message message-${ui.channel}">${icon(ui.channel === 'system' ? 'crown' : 'message')}<div><b>${html(item.senderName ?? item.authorName ?? item.fromName ?? item.name ?? item.author ?? (ui.channel === 'system' ? 'System' : 'World'))}</b> ${html(item.text ?? item.message ?? item.detail ?? '')} ${item.at ? `<small>${html(new Date(item.at).toLocaleTimeString([], {hour: '2-digit',minute:'2-digit'}))}</small>` : ''}</div></div>`).join('') : `<p class="message">${icon('message')}<span>${ui.channel === 'alliance' && !ui.state.alliance ? 'Join an alliance to open this channel.' : 'No dispatches yet.'}</span></p>`}</div>
    <form class="chat-form" data-form="chat">
      <input type="hidden" name="channel" value="${ui.channel}">
      <input aria-label="Chat message" name="text" maxlength="240" required autocomplete="off" placeholder="${disabled ? 'Channel is read-only' : 'Send a dispatch…'}"${disabled ? ' disabled' : ''}>
      <button aria-label="Send dispatch" type="submit"${disabled ? ' disabled' : ''}>${icon('send')}</button>
    </form>`);
}

function renderMap() {
  const own = playerCity();
  const selected = target();
  const region = currentRegion();
  const current = visibleCities();
  const landmarks = visibleSites();
  const actorKey = JSON.stringify([region.id, landmarks.map(site => [site.id,site.x,site.y,site.name,site.controller,site.claim?.status,site.lease?.id]), own.perks?.hall, current.map(city => [city.id,city.name,city.x,city.y,city.faction,level(city),city.shieldUntil,city.protectorate?.id,city.id === ui.targetId,city.id === own.id,city.id === selected?.id && ui.inspector])]);
  dom['world-stage'].dataset.region = region.id;
  if (mapPaintActors !== actorKey) {
    mapPaintActors = actorKey;
    dom['world-cities'].innerHTML = current.filter(city => Number.isFinite(city.x) && Number.isFinite(city.y)).map((city, idx) => {
      const isOwn = city.id === own.id;
      const isSelected = city.id === selected?.id && ui.inspector;
      const isCapital = city.id === 'p9' || /imperial Palace/i.test(city.name);
      const honor = isOwn && own.perks?.hall;
      const prominence = isCapital ? 'capital' : isOwn || isSelected || strongholds.has(city.id) ? '' : idx < 10 ? 'secondary' : 'minor';
      return `<button class="world-city faction ${faction(city)} ${prominence} ${isSelected ? 'selected' : ''}" style="left:${city.x*100}%;top:${city.y*100}%;z-index:${20 + Math.round(city.y*50)}" data-target="${html(city.id)}" type="button" aria-pressed="${isSelected}" aria-label="${html(city.name)} level ${number(level(city))}">
        <img src="${art(city)}" alt=""><span class="flag ${honor ? 'founder-flag' : ''}">${icon(honor ? 'crown' : factionIcons[faction(city)])}</span>
        <span class="marker-label">${html(city.name)}<small>Lv. ${number(level(city))}${isOwn ? ' <em>· Home</em>' : ''}${isCapital ? ' · Seat of power' : ''}${city.protectorate ? ' <em class="pact-marker">· Protectorate</em>' : ''}</small></span>
      </button>`;
    }).join('') + landmarks.map(site => territoryMarker(site,cities(),own,gameNow())).join('');
  }
  dom['world-cities'].classList.toggle('labels', ui.labels);
  paintTerritories();
  renderMapControls();
  renderRegionNavigation();
}

function paintTerritories() {
  if (!ui.state) return;
  const canvas = dom.territories;
  const ctx = canvas.getContext('2d');
  const stage = dom['world-stage'];
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) {
    canvas.width = Math.round(width*dpr);
    canvas.height = Math.round(height*dpr);
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,width,height);
  const region = currentRegion();
  const current = visibleCities().filter(city => Number.isFinite(city.x) && Number.isFinite(city.y));
  const own = playerCity();
  const atlas = new Map(current.map(city => [city.id,city]));
  const roads = region.id === 'core'
    ? [['p1','p2'],['p1','p3'],['p1','p5'],['p2','p3'],['p2','p4'],['p2','p6'],['p3','p9'],['p4','p5'],['p4','p7'],['p4','p8'],['p5','p8'],['p6','p9'],['p6','p7']]
    : current.flatMap((city, index) => current.slice(index+1)
      .filter(neighbor => Math.hypot(city.x-neighbor.x, city.y-neighbor.y) < .22)
      .map(neighbor => [city.id, neighbor.id]));
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = '#e8c8797a';
  ctx.setLineDash([2,4]);
  for (const [from,to] of roads) {
    const a = atlas.get(from);
    const b = atlas.get(to);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x*width, a.y*height);
    ctx.quadraticCurveTo((a.x+b.x)*width*.5+8,(a.y+b.y)*height*.5+18,b.x*width,b.y*height);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const [idx,city] of current.entries()) {
    const selected = city.id === ui.targetId && ui.inspector;
    const large = strongholds.has(city.id) || city.id === own.id || selected;
    const radius = Math.min(width*.065,height*.105) * (large ? 1 : .53);
    const color = colors[faction(city)];
    ctx.beginPath();
    for (let offset = 0; offset <= 16; offset++) {
      const i = offset % 16;
      const angle = i * Math.PI / 8;
      const dist = radius * (1 + Math.sin(i * 2.32 + idx * 1.15) * .125);
      const x = city.x * width + Math.cos(angle) * dist;
      const y = city.y * height - 5 + Math.sin(angle) * dist * .59;
      if (offset === 0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    }
    ctx.closePath();
    ctx.fillStyle = color + (selected ? '4a' : large ? '25' : '13');
    ctx.fill();
    ctx.strokeStyle = color + (selected ? 'f6' : large ? 'bf' : '6c');
    ctx.lineWidth = selected ? 2.3 : large ? 1.5 : 1;
    ctx.shadowBlur = selected ? 15 : large ? 6 : 0;
    ctx.shadowColor = color;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  const sites = new Map(visibleSites().map(site => [site.id, site]));
  for (const march of list(ui.state?.marches)) {
    const from = atlas.get(march.attacker);
    const to = sites.get(march.territory) ?? atlas.get(march.defender);
    const progress = Math.max(0,Math.min(1,(gameNow()-march.at)/(march.endsAt-march.at)));
    if (!from || !to || progress === 1) continue;
    const start = [from.x*width,from.y*height];
    const end = [to.x*width,to.y*height];
    ctx.setLineDash([4,5]);
    ctx.strokeStyle = colors[faction(from)];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(...start);
    ctx.lineTo(...end);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffdc9a';
    ctx.shadowColor = colors[faction(from)];
    ctx.shadowBlur = 9;
    ctx.beginPath();
    ctx.arc(start[0]+(end[0]-start[0])*progress,start[1]+(end[1]-start[1])*progress,4,0,Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  if (ui.politicalOverlay) paintPoliticalOverlay({ ...pageContext(), cities:current }, ctx, width, height);
}

function renderRegionNavigation() {
  const atlas = regions();
  const current = currentRegion();
  regionNavigation.hidden = atlas.length < 2 || ui.page !== 'map' || Boolean(ui.archive);
  if (regionNavigation.hidden) return;
  const home = ui.state.atlas?.homeRegion;
  const markup = '<details><summary>' + icon('map') + html(current.name) + icon('down') + '</summary><ul>' +
    atlas.map(region => {
      const context = [region.id === home && 'Home', current.neighbors.includes(region.id) && 'Adjacent'].filter(Boolean);
      return '<li><button type="button" data-region-pick="' + html(region.id) + '"' +
        (region.id === current.id ? ' aria-current="location"' : '') + '>' + html(region.name) +
        (context.length ? '<small>' + context.join(' · ') + '</small>' : '') + '</button></li>';
    }).join('') + '</ul></details>';
  if (markup === regionPaint) return;
  regionNavigation.innerHTML = markup;
  regionPaint = markup;
}

function chooseRegion(id, focusCity) {
  if (!regions().some(region => region.id === id)) return;
  ui.regionId = id;
  ui.scale = 1.15;
  ui.dx = 0;
  ui.dy = 0;
  ui.targetId = focusCity ?? visibleCities().find(city => city.id === playerCity().id)?.id ??
    visibleCities().find(city => city.npc)?.id ?? visibleCities()[0]?.id ?? null;
  ui.inspector = true;
  transformMap();
}
function renderMapControls() {
  const controls = [
    ['out','Zoom out','minus'],['in','Zoom in','plus'],['reset','Reset view','target'],['labels','Toggle all city labels','layers'],['political','Toggle political overlay','flag'],
  ];
  morph(dom['atlas-controls'], `<output aria-label="Current map zoom">${Math.round(ui.scale*100)}%</output>` + controls.map(([id,text,glyph]) => `<button type="button" data-map="${id}" aria-label="${text}" data-tooltip="${text}" ${['labels','political'].includes(id) ? 'aria-pressed="' + (id === 'labels' ? ui.labels : Boolean(ui.politicalOverlay)) + '"' : ''}>${icon(glyph)}</button>`).join(''));
}
function renderInspector() {
  const city = target();
  const own = playerCity();
  dom.inspector.hidden = !city || regionOf(city) !== currentRegion().id || !ui.inspector || ui.page !== 'map' || !!ui.archive;
  if (dom.inspector.hidden) return;
  const owned = city.id === own.id;
  const eligible = city.eligibility ?? { ok: false, reason: 'Eligibility is being checked.' };
  const hostile = !owned && faction(city) !== faction(own);
  const subtitle = owned ? 'Home city' : hostile ? 'Rival territory' : 'Friendly territory';
  const garrison = owned ? armyCount(own) : city.intel?.troops ? armyCount({ troops:city.intel.troops }) : city.intel?.army;
  const political = city.protectorateEligibility ?? { ok: false, reason: 'Protectorate terms are unavailable.' };
  const reasons = !owned && !eligible.ok ? eligible.reason : '';
  morph(dom.inspector, `
    <div class="inspector-art"><img src="${art(city)}" alt=""><span class="tag ${hostile ? 'danger' : 'success'}">${html(city.terrainName ?? 'Settlement')}</span></div>
    <button class="inspector-close" type="button" data-close-target aria-label="Close inspector">${icon('x')}</button>
    <div class="inspector-head faction ${faction(city)}">${crest(city)}<div><h2>${html(city.name)}</h2><span class="kicker">Lv. ${number(level(city))} · ${html(subtitle)}${city.npc ? ' · NPC' : ''}</span></div></div>
    <div class="inspector-body">
      <div class="stats">${owned ? stat('Power',number(own.power),'war') : stat('Military intelligence',city.intel?.source==='scouting' || city.intel?.confidence ? 'Scout estimate' : 'Unknown','war')}${stat('Defense',owned ? number(towerDefense(own)) : city.intel?.defense==null ? 'Unknown' : number(city.intel.defense),'shield')}${stat('Garrison',garrison == null ? 'Scout first' : number(garrison),'troops')}${stat('Faction',factionName(city),'flag')}${owned ? '' : stat('Raid checkout',feeLabel('attack-paid'),'bch') + stat('Attacks left',countLeft(),'clock')}</div>
      <div class="inspector-actions">
        ${btn('Political standing','flag',{page:'politics','political-focus':city.id})}
        ${owned ? btn('My city','city',{ page:'city' },'primary') : [
          btn('Scout','spy',{ modal:'scout' },'intel'),
          btn('Attack','war',{ modal:'attack' },'attack'),
          btn('Protectorate','crown',{ modal:'protectorate' },'protect'),
        ].join('')}
        ${city.npc && !owned ? btn('Expedition','war',{modal:'expedition',id:city.id},'primary')+
          btn('Visit court','flag',{modal:'npc-court',id:city.id}) : ''}
      </div>
      ${owned ? '' : `<div class="eligibility">${eligible.ok ? tag('Attack eligible','success') : html(reasons ?? 'Attack unavailable')}${political.ok ? ' ' + tag('Protectorate eligible','success') : ''}</div>`}
    </div>`);
}

function pageContext() {
  return {
    ui, own: playerCity(), city: target(), cities: cities(), gameNow: gameNow(),
    factionName, towerDefense, armyCount, countLeft, price, feeLabel, level, tag, formatDate,
  };
}
const editing = () => document.activeElement?.closest('input,textarea,[data-game-select]');
function renderCampaign(force = false) {
  const isMap = ui.page === 'map';
  const mapVisible=isMap&&!ui.archive;
  dom.campaign.hidden = isMap||!!ui.archive;
  citadel.hidden=!ui.archive;
  dom['city-dock'].hidden = !mapVisible;
  dom['activity-dock'].hidden = !mapVisible;
  dom['atlas-controls'].hidden = !mapVisible;
  renderRegionNavigation();
  if (isMap||ui.archive) return;
  if (!force && dom.campaign.contains(editing())) return;
  const marketForm=dom.campaign.querySelector('form[data-form=trade]');
  if (marketForm) ui.marketFields=Object.fromEntries(new FormData(marketForm));
  morph(dom.campaign, renderPage(pageContext()));
  if (ui.page==='city'&&ui.tabs.city==='market') void updateMarketQuote();
  if (ui.page === 'politics') syncPoliticalFields(dom.campaign);
  for (const element of dom.campaign.querySelectorAll('[data-sponsor-impression]')) {
    const id = element.dataset.sponsorImpression;
    if (sponsorImpressions.has(id)) continue;
    sponsorImpressions.add(id);
    void api('/sponsors/' + id + '/impression', {}).catch(() => {});
  }
}
let marketRequest=0,marketTimer;
async function updateMarketQuote() {
  const form=dom.campaign.querySelector('form[data-form=trade]');
  if (!form) return;
  const section=form.querySelector('[data-market-quote]'),button=form.querySelector('button[type=submit]');
  const {give,take,amount}=Object.fromEntries(new FormData(form));
  const request=++marketRequest;
  button.disabled=true;
  form.elements.quotedReceived.value='';
  const invalid=give===take?'Choose two different resources.':
    !/^\d{1,3}$/.test(amount)||Number(amount)<10||Number(amount)>500?'Enter a whole amount from 10 to 500.':'';
  if(invalid){section.textContent=invalid;section.removeAttribute('aria-busy');return;}
  section.setAttribute('aria-busy','true');
  try {
    const quote=await api('/market-preview?'+new URLSearchParams({give,take,amount}));
    if (request!==marketRequest||!form.isConnected) return;
    form.elements.quotedReceived.value=quote.received;
    section.innerHTML=marketQuoteView(quote);
    button.disabled=!quote.eligible;
  } catch(error) {
    if(request===marketRequest&&form.isConnected) section.textContent=error.message;
  } finally {
    if(request===marketRequest) section.removeAttribute('aria-busy');
  }
}
let trainingRequest=0,trainingTimer;
async function updateTrainingQuote(){
  const form=dom.dialog.querySelector('form[data-form=train]');
  if (!form) return;
  const section=form.querySelector('[data-training-quote]'),button=form.querySelector('button[type=submit]');
  const {unit,count}=Object.fromEntries(new FormData(form)),request=++trainingRequest;
  button.disabled=true;
  if(!/^\d{1,2}$/.test(count)||Number(count)<1||Number(count)>30){
    section.textContent='Enter a whole troop count from 1 to 30.';
    return;
  }
  try {
    const quote=await api('/training-preview?'+new URLSearchParams({unit,count}));
    if (request!==trainingRequest||!form.isConnected) return;
    section.innerHTML=trainingOrderView(quote);
    button.disabled=!quote.eligible;
  } catch(error) {
    if (request===trainingRequest&&form.isConnected) section.textContent=error.message;
  }
}
let dossierRequest=0;
async function refreshRaidDossier() {
  const form=dom.dialog.querySelector('form[data-form="attack"]');
  const section=form?.querySelector('[data-attack-preview]');
  if (!section) return;
  const request=++dossierRequest;
  const orders=new URLSearchParams(new FormData(form));
  section.setAttribute('aria-busy','true');
  try {
    const preview=await api('/attack-preview?'+orders);
    if (request!==dossierRequest||!section.isConnected) return;
    section.innerHTML=raidDossier(preview,ui.state.config);
    // A paid raid is offered only when the defender's War Chest covers the chosen stake.
    const unrewarded=preview.raid?.matched ? !preview.raid.eligible : preview.raid?.maxWinSatoshis===0;
    const standard=dom.dialog.querySelector('[data-raid-commander]');
    if (standard) standard.textContent=ui.state.config.heroes[preview.own.hero]?.name??'No active commander';
    for (const button of form.querySelectorAll('button[type="submit"]')) {
      button.disabled=!preview.eligibility.allowed || (button.name==='paid' && (!ui.state.chain?.enabled||ui.state.vault?.quarantined||unrewarded));
    }
  } catch (error) {
    if (request===dossierRequest&&section.isConnected) section.textContent=error.message;
  } finally {
    if (request===dossierRequest) section.removeAttribute('aria-busy');
  }
}
function refreshDialog() {
  if (!ui.dialog) return;
  const dialog = dom.dialog;
  if (dialog.open && ui.dialog.mode === 'identity' && dialog.querySelector('.identity-panel')) return;
  if (dialog.open && (dialog.contains(editing()) || dialog.querySelector('.order-error'))) return;
  // The player has just closed this dialog and its close is still being handled: an update arriving now must not reopen it.
  // (A dialog being opened is always emptied first by showDialog.)
  if (!dialog.open && dialog.childNodes.length) return;
  // An open dialog is updated in place; a newly opened one is drawn whole.
  if (dialog.open && dialog.childNodes.length) morph(dialog, renderDialog(pageContext()));
  else dialog.innerHTML = renderDialog(pageContext());
  if (ui.dialog.mode === 'political') syncPoliticalFields(dialog);
  if (!dialog.open) dialog.showModal();
  if (ui.dialog.mode === 'attack') void refreshRaidDossier();
  if (ui.dialog.mode === 'training') void updateTrainingQuote();
}
function showDialog(mode, details = {}) {
  closeBattleReplay();
  dom.dialog.classList.toggle('battle-report-dialog', mode === 'battle');
  // Coming from another dialog: that one is where Back leads.
  if (!details.cameBack && ui.dialog && dom.dialog.open && ui.dialog.mode !== mode) { dialogTrail.push(ui.dialog); if (dialogTrail.length > 12) dialogTrail.shift(); }
  ui.dialog = { mode, ...details };
  if (dom.dialog.open) dom.dialog.close();
  dom.dialog.replaceChildren();
  if (mode === 'identity') enterIdentity(details.id==='auth'?'choose-login':null,playerCity().id);
  refreshDialog();
  if (mode==='battle') mountBattleReplay();
  if (mode==='wallet') markEducationVisit('bch-wallet');
  if (mode==='building' && details.id==='hall'&&!details.guided) markEducationVisit('bch-actions');
  if (mode==='codex' && details.id==='blockchain') markEducationVisit('discover-bch');
}
attachIdentityControls({api,getPlayer:()=>playerCity().id,updated:(state)=>{setState(state);renderAll(true);},notify:(message)=>{
  playGameCue('reward',muted());
  showDialog('dispatch',{presentation:{art:'event-season',title:message.replace(/\.$/,''),
    detail:'Your kingdom and its campaign history remain with this account.',back:{mode:'identity'}}});
},authenticated:()=>{
  location.assign('/play');
},draw:()=>{
  if (dom.dialog.open && ui.dialog?.mode==='identity') {
    dom.dialog.innerHTML=renderDialog(pageContext());
    dom.dialog.querySelector('input:not([readonly]), textarea:not([readonly]), .identity-choices button')?.focus();
  }
}});
function renderAll(force = false) {
  if (!ui.state) return;
  const settings = ui.state.player.settings ?? {};
  configureGameAudio(settings);
  document.documentElement.classList.toggle('reduced', Boolean(settings.reducedMotion));
  document.documentElement.classList.toggle('contrasted', Boolean(settings.highContrast));
  dom.loading.hidden = true;
  renderHeader();
  renderNav();
  renderCityDock();
  renderActivity();
  renderMap();
  renderInspector();
  renderCampaign(force);
  if (['payment','journal','building','scout','decoy','inbox'].includes(ui.dialog?.mode)) refreshDialog();
  refreshGuide();
}

function refreshGuide({ focus = false } = {}) {
  const progress = playerCity().onboarding;
  const reviewing = ui.guide === 'review';
  const showing = !ui.archive && (reviewing || (ui.guide === 'active' && progress?.status === 'active'));
  guide.hidden = !showing;
  for (const item of document.querySelectorAll('.guide-relevant')) item.classList.remove('guide-relevant');
  if (!showing) return;
  const current = reviewing ? { step: guideSteps[ui.guideReviewIndex].id, position: ui.guideReviewIndex + 1,
    total: guideSteps.length, ready: true, drill: progress?.drill } : progress;
  const markup = renderGuide({ progress: current, review: reviewing, confirmSkip: ui.guideConfirmSkip,
    seen: ui.guideSeen.has(current.step) });
  if (markup !== ui.guideMarkup) {
    guide.innerHTML = markup;
    ui.guideMarkup = markup;
  }
  const selector=guideStepTargets[current.step];
  if (selector && (!current.ready || (guideSteps.find(step=>step.id===current.step)?.requiresVisit&&!ui.guideSeen.has(current.step)))) {
    const target = [...document.querySelectorAll(selector)].find(node=>node.getClientRects().length);
    if (target) target.classList.add('guide-relevant');
  }
  if (focus) select('campaign-guide-title')?.focus({ preventScroll: true });
}

// A kingdom that has just signed up is greeted once: the server forgets the greeting as soon as it is shown, so it never
// returns, in this browser or another one.
function greetNewKingdom() {
  if (!playerCity()?.welcome || ui.welcomed || ui.archive) return;
  ui.welcomed = true;
  // After the welcome, a kingdom without a wallet is asked to connect one.
  ui.walletPromptDue = !ui.state?.wallet?.address;
  showDialog('welcome');
  void api('/command', { type: 'welcomed', requestId: crypto.randomUUID() }).catch(() => { ui.welcomed = false; });
}
function learnChoice(choice) {
  // Straight after the welcome: first the wallet prompt, then what the player chose.
  if (ui.walletPromptDue && ui.dialog?.mode === 'welcome') {
    ui.walletPromptDue = false;
    ui.afterWalletPrompt = choice;
    showDialog('wallet-prompt');
    return;
  }
  if (choice === 'tutorial') showGuide();
  else if (choice === 'instructions') { dom.dialog.close(); openModal('codex', ''); }
  else dom.dialog.close();
}
function showGuide() {
  const { onboarding } = playerCity();
  dom.dialog.close();
  ui.guideConfirmSkip = false;
  if (onboarding?.status === 'paused') {
    void runGuideCommand('resume');
    return;
  }
  if (onboarding?.status === 'active') {
    ui.guide = 'active';
  } else {
    ui.guide = 'review';
    ui.guideReviewIndex = 0;
  }
  refreshGuide({ focus: true });
}

async function openGuideObjective(step) {
  const player = playerCity();
  if (step === 'homeland') {
    await changePage('map');
    const site = list(ui.state.territories).find(item => item.category === 'starter' && item.owner === player.id);
    if (!site) return notify('Your Starter Territory is unavailable. Refresh the campaign to try again.', true);
    openModal('node', site.id);
  } else if (step === 'construction') {
    await changePage('city', 'build');
    showDialog('building', { id: 'hall', guided: ui.guide === 'active' });
  } else if (step === 'stores') {
    await changePage('city', 'build');
    openModal('daily');
  } else if (step === 'troops') {
    await changePage('city', 'army');
    openModal('training', 'infantry');
  } else if (step === 'commander') {
    await changePage('city', 'heroes');
    openModal('commander', player.hero);
  } else if (step === 'tactics') {
    await changePage('city', 'army');
    openModal('formation');
  } else if (step === 'drill') {
    const drill = player.onboarding?.drill;
    if (drill) showDialog('battle', { battle: drill.battle, trace: drill.trace });
    else if (ui.guide === 'review') await runGuideCommand('practice');
    else await runGuideCommand('drill');
  } else if (step === 'discover-bch') {
    openModal('codex','blockchain');
  } else if (step === 'bch-wallet') {
    openModal('wallet');
  } else if (step === 'bch-actions') {
    await changePage('city','build');
    showDialog('building',{id:'hall',guided:false});
    markEducationVisit(step);
  } else if (step === 'season-rewards') {
    await changePage('rankings');
  }
}

function markEducationVisit(step) {
  const current=ui.guide==='review'?guideSteps[ui.guideReviewIndex]?.id:ui.guide==='active'?playerCity().onboarding?.step:null;
  if(current===step) { ui.guideSeen.add(step); refreshGuide(); }
}

async function runGuideCommand(action) {
  if (ui.busy) return;
  const button = guide.querySelector(`[data-guide-action="${action}"]`);
  if (button) button.disabled = true;
  try {
    await act({ type: 'tutorial', action, step: playerCity().onboarding?.step });
  } catch (error) {
    const message = guide.querySelector('.guide-error');
    if (message && !guide.hidden) message.textContent = error.message;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

guide.addEventListener('click', event => {
  const button = event.target.closest('[data-guide-action]');
  if (!button || ui.busy) return;
  activateGameAudio(muted());
  const action = button.dataset.guideAction;
  if (action === 'close') {
    ui.guide = null;
    refreshGuide();
    return;
  }
  if (action === 'confirm-skip' || action === 'keep') {
    ui.guideConfirmSkip = action === 'confirm-skip';
    refreshGuide({ focus: true });
    return;
  }
  if (ui.guide === 'review' && ['back', 'next'].includes(action)) {
    ui.guideReviewIndex += action === 'back' ? -1 : 1;
    refreshGuide({ focus: true });
    return;
  }
  if (action === 'open') {
    const step = ui.guide === 'review' ? guideSteps[ui.guideReviewIndex].id : playerCity().onboarding?.step;
    void openGuideObjective(step);
    return;
  }
  void runGuideCommand(action);
});
function scrollTop() {
  dom.campaign.scrollTop = 0;
}

async function getVault() {
  try {
    ui.vault = await api('/vault');
  } catch (error) {
    ui.vault = { error: error.message };
  }
}
async function inspectWalletAssets() {
  const address=walletAddress(ui.state?.wallet);
  if (!address||ui.walletLoadingAddress===address||!ui.state?.chain?.walletRead) return;
  ui.walletLoadingAddress=address;
  ui.walletLoading = true;
  ui.walletError = null;
  if (ui.dialog?.mode === 'wallet') refreshDialog();
  renderCampaign(true);
  try {
    // An HD wallet keeps change and later payments on other addresses: with the wallet connected, the whole wallet is read
    // (from the public keys of its first receiving and change addresses), next to the tokens of the linked address.
    const keys=await walletKeys({receive:20,change:20}).catch(()=>[]);
    const [assets,whole]=await Promise.allSettled([api('/wallet/assets?address='+encodeURIComponent(address)),
      keys.length?api('/wallet/balance',{keys}):Promise.resolve(null)]);
    if(assets.status==='rejected'&&!whole.value) throw assets.reason;
    if(ui.walletLoadingAddress===address&&walletAddress(ui.state?.wallet)===address)
      ui.walletAssets={...(assets.value??{wallet:{address},balance:null,tokens:null}),...(whole.value&&{whole:whole.value}),observedAt:Date.now()};
  } catch (error) {
    if(ui.walletLoadingAddress===address&&walletAddress(ui.state?.wallet)===address) ui.walletError=error.message;
  } finally {
    if(ui.walletLoadingAddress===address) {
      ui.walletLoadingAddress=null;
      ui.walletLoading=false;
      renderAll();
      if (ui.dialog?.mode === 'wallet') refreshDialog();
    }
  }
}
function resumeWizard() {
  if(ui.state?.chain?.walletConnect) return connectWizard(undefined,{
    player:ui.state.player.id,testRelay:ui.state.chain.testWizardRelay,resume:true,
  });
}
function archiveAtPath() {
  return location.pathname==='/council.html'?'council':['/ledger.html','/explorer'].includes(location.pathname)?'ledger':null;
}
function showArchive(page,{push=false}={}) {
  if(page===ui.archive) return;
  if(push) history.pushState({...history.state,vaultbornArchive:true},'',page==='council'?'/council.html':'/ledger.html');
  ui.archive=page;
  if(!ui.state) return;
  if(page) {
    if(dom.dialog.open) dom.dialog.close();
    citadel.scrollTop=0;
    void openCitadel(page,list(ui.state.payments));
  } else {
    document.title='VAULTBORN';
  }
  renderAll(true);
}
function leaveArchive({replace=false}={}) {
  if(!ui.archive) return;
  const returnPath=ui.archiveEntry??'/play';
  if(replace) history.replaceState(null,'',returnPath);
  else history.pushState(null,'',returnPath);
  showArchive(null);
}
// Every page and every dialog has a Back button. The pages and dialogs the player came through are remembered here.
const pageTrail = [], dialogTrail = [];
function goBackPage() {
  const previous = pageTrail.pop() ?? { page:'map' };
  void changePage(previous.page, previous.tab, { back:true });
}
function goBackDialog() {
  const previous = dialogTrail.pop();
  if (!previous) { dom.dialog.close(); return; }
  const { mode, ...details } = previous;
  showDialog(mode, { ...details, cameBack:true });
}
async function changePage(page, subtab, { back = false } = {}) {
  if (!nav.some(([id]) => id === page)) return;
  if(ui.archive) leaveArchive();
  dom.toast.hidden = true;
  if (!back && ui.page !== page) { pageTrail.push({ page:ui.page, tab:ui.tabs[ui.page] }); if (pageTrail.length > 20) pageTrail.shift(); }
  if (page === 'map') pageTrail.length = 0;
  ui.page = page;
  if (subtab) ui.tabs[page] = subtab;
  if (page === 'vault') void getVault().then(() => { if (ui.page === 'vault') renderCampaign(); });
  renderAll(true);
  if (page==='rankings') markEducationVisit('season-rewards');
  scrollTop();
}
function handleMapControl(action) {
  if (action === 'in'||action==='out') setZoom(ui.scale*(action==='in'?1.19:1/1.19));
  if (action === 'reset') { ui.scale = 1.15; ui.dx = 0; ui.dy = 0; }
  if (action === 'labels') ui.labels = !ui.labels;
  if (action === 'political') {
    ui.politicalOverlay = !ui.politicalOverlay;
    paintTerritories();
  }
  transformMap();
  dom['world-cities'].classList.toggle('labels', ui.labels);
  renderMapControls();
}
function cameraDimensions() {
  return {width:dom.world.clientWidth,height:dom.world.clientHeight,stageWidth:dom['world-stage'].offsetWidth,stageHeight:dom['world-stage'].offsetHeight};
}
function mapPoint(x,y) {
  const box=dom.world.getBoundingClientRect();
  return [x-box.left-box.width/2,y-box.top-box.height/2];
}
function setZoom(scale,from=[0,0],to=from,camera=ui) {
  Object.assign(ui,moveCamera(camera,cameraDimensions(),scale,from,to));
  transformMap();
}
function transformMap() {
  const dimensions=cameraDimensions();
  if (!dimensions.width||!dimensions.height) return;
  Object.assign(ui,constrainCamera(ui,dimensions));
  dom['world-stage'].style.transform = `translate(${ui.dx}px,${ui.dy}px) scale(${ui.scale})`;
  const zoom=dom['atlas-controls'].querySelector('output');
  if (zoom) zoom.value=Math.round(ui.scale*100)+'%';
}

async function refresh({presentOffline=false}={}) {
  if (refreshPending) return;
  refreshPending = true;
  try {
    setState(await api(document.visibilityState==='visible'?'/state':'/state?background=1'));
    renderAll();
    if (!archiveAtPath() && ui.state?.player?.founding && !ui.foundingShown) {
      ui.foundingShown = true;
      showDialog('found');
    } else if (presentOffline&&document.visibilityState==='visible'&&ui.state?.offlineReport?.unread&&!dom.dialog.open&&
        ui.offlinePresented!==ui.state.offlineReport.id) {
      ui.offlinePresented=ui.state.offlineReport.id;
      showDialog('offline-report');
    }
  } catch (error) {
    if (error.status===401 && ui.state && !ui.signingOut) {
      stream?.close();
      location.replace('/?sign-in=expired');
      return;
    }
    if (!ui.state) {
      dom.loading.innerHTML = `<div class="loading-art" aria-hidden="true"></div><div class="loading-card"><div class="loading-mark"><img src="/logo.webp" width="84" height="107" alt=""></div><h1>VAULTBORN</h1><p class="loading-status">${html(error.message)}</p><div class="buttons">${btn('Retry','arrow',{ retry: 'true' },'primary')}</div></div>`;
    }
  } finally {
    refreshPending = false;
  }
}
function connectStream() {
  if (stream) return;
  stream = new EventSource('/api/events');
  stream.onmessage = () => { if (!ui.busy) void refresh(); };
}
document.addEventListener('visibilitychange',()=>{
  if (document.visibilityState==='visible'&&!ui.busy) void refresh({presentOffline:true});
});

async function perform(path, payload, onSuccess) {
  ui.busy = true;
  dom.dialog.querySelector('.order-error')?.remove();
  try {
    const result = await api(path, payload);
    if (result.state) setState(result.state);
    if (!result.state && !['/session/logout','/vault/payout','/vault/quote','/wallet/challenge'].includes(path)) await refresh();
    await onSuccess(result);
    renderAll(true);
  } catch (error) {
    if (requireWallet(error)) throw error;
    if ((path==='/command'&&!['tutorial','chat','settings'].includes(payload.type))||path.startsWith('/vault/')||path==='/payments') {
      presentOrderFailure(error.message);
    } else {
      const message = dom.dialog.querySelector('.form-error');
      if (message && dom.dialog.open) message.textContent = error.message;
      else notify(error.message, true);
    }
    throw error;
  } finally {
    ui.busy = false;
  }
}

function presentOrderFailure(message) {
  playGameCue('message',muted());
  if (!dom.dialog.open) {
    showDialog('dispatch',{presentation:{art:'scout-3',kicker:'Kingdom dispatch',title:'Order could not be completed',detail:message}});
    return;
  }
  dom.dialog.querySelector('.order-error')?.remove();
  const notice=document.createElement('div');
  notice.className='order-error';
  notice.setAttribute('role','alert');
  notice.innerHTML=`<strong>Order could not be completed</strong><p>${html(message)}</p>${btn('Dismiss message','check',{'dismiss-order-error':'yes'})}`;
  dom.dialog.querySelector('#dialog-title').after(notice);
  notice.querySelector('button').focus();
}

function act(payload) {
  return perform('/command', { ...payload, requestId: crypto.randomUUID() }, result => {
    const value = result.result ?? result;
    if (payload.type === 'found' && playerCity().onboarding?.status === 'active') {
      dom.dialog.close();
      const own = playerCity();
      ui.targetId = own.id;
      ui.inspector = true;
      void changePage('map');
      const { height, stageWidth, stageHeight } = cameraDimensions();
      const point = localPosition(own);
      const position = [ui.dx + (point.x - .5) * stageWidth * ui.scale, ui.dy + (point.y - .5) * stageHeight * ui.scale];
      setZoom(ui.scale, position, [0, -Math.min(height * .13, 72)]);
      playGameCue('claim', muted());
      greetNewKingdom();
      return;
    }
    if (payload.type === 'tutorial' && payload.action) {
      ui.guideConfirmSkip = false;
      if (value.completed) {
        ui.guide = null;
        playGameCue('reward', muted());
        showDialog('dispatch', { presentation: { art: 'event-season', kicker: 'First campaign', title: 'First banner raised',
          detail: 'Your charter is recorded. The quartermaster has issued your first banner supplies.', resources: value.reward } });
      } else if (payload.action === 'pause') {
        ui.guide = null;
        notify('Guide paused. Resume it from My City or your profile.');
      } else if (payload.action === 'resume') {
        ui.guide = 'active';
      } else if (['drill','practice'].includes(payload.action) && value.drill) {
        showDialog('battle', { battle: value.drill.battle, trace: value.drill.trace, live:true });
      } else {
        playGameCue('select', muted());
      }
      refreshGuide({ focus: !dom.dialog.open });
      return;
    }
    if (payload.type === 'npc-envoy') {
      playGameCue(value.accepted ? 'dispatch' : 'message', muted());
      showDialog('npc-court', { id:payload.target, envoy:value });
      return;
    }
    const newBattle = value.battle ?? (value.events && value.winner ? value : null);
    const presentation=commandDispatch(payload,value,ui.state.config);
    if (newBattle) {
      const battle = typeof newBattle === 'string' ? list(ui.state.battles).find(item => item.id === newBattle) : newBattle;
      if (battle) {
        // A battle that was just fought plays first, as it happens; the result and replay follow.
        showDialog('battle', { id:battle.id, battle, live:true });
      }
    } else if (presentation) {
      playGameCue(presentation.sound,muted());
      showDialog('dispatch',{presentation});
      if (presentation.resources&&!ui.state.player.settings?.reducedMotion&&!matchMedia('(prefers-reduced-motion: reduce)').matches)
        requestAnimationFrame(()=>{
          for(const id of Object.keys(presentation.resources)) if(presentation.resources[id])
            dom.masthead.querySelector('.resource.r-'+CSS.escape(id))?.animate(
              [{filter:'brightness(1)'},{filter:'brightness(1.65)'},{filter:'brightness(1)'}],560);
        });
    } else if (ui.dialog && ['political','attack','protectorate','training','trade','treaty','aid','formation','invite','leave','enroll','found'].includes(ui.dialog.mode)) {
      dom.dialog.close();
      notify(({configure:'Army orders updated.',aid:'Supplies sent.',found:'Your settlement is founded.',
        'opt-in':'Seasonal enrollment updated.', 'alliance-leave':'You left the alliance.',
        'alliance-invite':'Invitation dispatched.'})[payload.type]??'Orders dispatched.');
    } else if (ui.dialog?.mode==='commander' && (payload.type.startsWith('commander-')||payload.type==='configure')) {
      playGameCue('reward',muted());
      showDialog('commander',{id:ui.dialog.id});
      notify('Active commander assigned.');
    } else if (payload.type === 'settings') {
      showDialog('profile');
      notify('Settings saved.');
    } else if (payload.type === 'tutorial') {
      playGameCue('reward', muted());
      dom.dialog.close();
      notify('Tutorial complete. Welcome to the frontier.');
    } else if (payload.type === 'chat') {
      const input = dom['activity-dock'].querySelector('input[name=text]');
      if (input) input.value = '';
    } else {
      notify('Orders carried out.');
    }
  });
}
// Connected means: this browser is paired with the wallet right now (a phone wallet that is asleep still counts) and the
// kingdom is linked to that same wallet. A kingdom linked earlier on another device is not connected here.
const walletLive = () => {
  const session = wizardState();
  return ['ready','signing','broadcasting'].includes(session.status) && Boolean(session.address) && session.address === ui.state?.wallet?.address;
};
// A saved pairing is restored a moment after the page opens; a payment pressed in that moment waits for it.
async function walletSettled() {
  for (let waited = 0; ['opening','restoring','closing'].includes(wizardState().status) && waited < 4000; waited += 200) {
    await new Promise(done => setTimeout(done, 200));
  }
}
async function startPayment(payload) {
  // Every payment is made from the player's own wallet: without a connected one, the wallet dialog opens instead, and the
  // payment continues by itself once the wallet is connected. A connected wallet goes straight to the checkout.
  if (ui.state?.chain?.enabled) {
    await walletSettled();
    // The wallet may have been linked in another tab a moment ago, so the kingdom is read once more first.
    if (!ui.state?.wallet?.address || (ui.state?.chain?.walletConnect && !walletLive())) await refresh().catch(() => {});
    if (!ui.state?.wallet?.address || (ui.state?.chain?.walletConnect && !walletLive())) {
      ui.pendingPayment = payload;
      requireWallet({ code:'wallet-required', message:'Connect your wallet first. Every payment is approved in your own wallet.' });
      return;
    }
  }
  ui.pendingPayment = null;
  return perform('/payments', payload, result => {
    const intent = result.intent ?? result.result?.intent ?? result.result ?? result;
    showDialog('payment', { id: intent.id, intent });
  });
}
// The wallet asked for by a payment is now connected and linked: the payment goes on to its checkout.
function continuePendingPayment() {
  if (!ui.pendingPayment || ui.dialog?.mode !== 'wallet' || ui.busy || !walletLive()) return;
  const payload = ui.pendingPayment;
  ui.pendingPayment = null;
  void startPayment(payload).catch(() => {});
}

function openModal(mode, id, returnTerritory, returnWalletMode) {
  if (ui.guide && ((mode === 'node' && id === 'starter-' + playerCity().id) || mode === 'commander')) {
    ui.guideSeen.add(mode === 'node' ? 'homeland' : 'commander');
    refreshGuide();
  }
  if (mode === 'battle') {
    const battle = list(ui.state.battles).find(item => item.id === id);
    showDialog(mode, { id, battle });
  } else if(mode==='wallet') {
    showDialog('wallet',{returnTerritory: returnTerritory??null,returnWalletMode:returnWalletMode??null});
    if(walletAddress(ui.state.wallet)&&!ui.walletAssets) void inspectWalletAssets();
  } else if(mode==='codex') {
    showDialog(mode,{id,back:ui.dialog&&ui.dialog.mode!=='codex'?{...ui.dialog}:null});
  } else {
    showDialog(mode, { id });
  }
}
function closeBattleReplay() {
  if (!replayController) return;
  replayController.destroy();
  replayController = null;
  setBattleAudio('idle');
}

function mountBattleReplay() {
  const battle=ui.dialog?.battle??list(ui.state.battles).find(item=>item.id===ui.dialog?.id);
  const scene=dom.dialog.querySelector('.replay-scene');
  if (!battle||!scene||!list(battle.events??battle.replay).length) return;
  const label=scene.querySelector('#replay-status');
  const losses=scene.querySelector('#replay-loss');
  const survivors=Object.fromEntries(['attacker','defender'].map(side=>[side,scene.querySelector('[data-battle-survivors="'+side+'"]')]));
  const meter=dom.dialog.querySelector('#replay-meter');
  const slider=dom.dialog.querySelector('#replay-seek');
  const play=dom.dialog.querySelector('[data-replay]');
  const skip=dom.dialog.querySelector('[data-replay-skip]');
  const result=dom.dialog.querySelector('[data-battle-result]');
  const heading=result.querySelector('h3');
  const reducedMotion=Boolean(ui.state.player.settings?.reducedMotion||matchMedia('(prefers-reduced-motion: reduce)').matches);
  const names=battleCampNames(battle);
  // A battle just fought plays by itself, without replay controls, until it ends.
  let live=Boolean(ui.dialog?.live);
  const spoils=live?raidSpoils(battle,playerCity().id):null;
  let timeline=battleTimeline(battle,ui.dialog?.trace ?? null,{reducedMotion});
  let motion=mountBattleMotion(scene,battle,timeline,{reducedMotion});
  let elapsed=0;
  let frameId;
  let playing=false;
  let disposed=false;
  let resolved=false;
  const put=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
  const updateButton=(text,glyph)=>{play.innerHTML=icon(glyph)+text;};

  function draw(milliseconds) {
    const frame=timeline.at(milliseconds);
    elapsed=frame.elapsed;
    const percent=elapsed/timeline.duration*100;
    slider.value=percent;
    meter.style.width=percent+'%';
    put(label,frame.ending?names[battle.winner]+' prevails':frame.round?frame.phase+' · Round '+frame.round:'The armies muster');
    put(losses,frame.round?number(frame.casualties.attacker)+' attacker lost · '+number(frame.casualties.defender)+' defender lost':'Both forces ready');
    for (const side of ['attacker','defender']) put(survivors[side],number(frame.remaining[side]));
    scene.dataset.replayRound=String(frame.round);
    scene.dataset.replayImpact=String(frame.hit);
    scene.dataset.replayTrace=timeline.traced?'verified':'aggregate';
    motion.draw(elapsed);
  }

  function reveal({sound=false,focus=false}={}) {
    cancelAnimationFrame(frameId);
    playing=false;
    draw(timeline.duration);
    updateButton('Replay battle','play');
    result.hidden=false;
    skip.hidden=true;
    if (live) {
      live=false;
      play.hidden=false;
      slider.hidden=false;
      // Then what the attack won, in its own popup; Continue returns to this report.
      if (spoils) setTimeout(()=>{
        if (replayController!==controller) return;
        playGameCue(spoils.sound,muted());
        showDialog('dispatch',{presentation:{...spoils,back:{mode:'battle',id:battle.id,battle,revealed:true}}});
        // Back from the popup must not play the battle again.
        if (dialogTrail.at(-1)?.live) dialogTrail.pop();
      },1200);
    }
    if (!resolved) {
      resolved=true;
      setBattleAudio('ending');
      const domestic=battle.kind==='political-front'&&battle.attacker===battle.defender;
      const victor=battle[battle.winner];
      if (sound) playGameCue(domestic?'battle-result':victor===playerCity().id?'battle-victory':'battle-defeat',muted());
    }
    if (focus) {
      heading.focus({preventScroll:true});
      result.scrollIntoView({block:'start',behavior:reducedMotion?'instant':'smooth'});
    }
  }

  function frame(now) {
    if (disposed||!playing) return;
    const before=elapsed;
    draw(now-playStart);
    for (const event of timeline.marks) {
      if (before<event.at&&event.at<=elapsed&&elapsed-event.at<450) playGameCue(event.cue,muted());
    }
    if (elapsed===timeline.duration) reveal({sound:true,focus:true});
    else frameId=requestAnimationFrame(frame);
  }

  function pause() {
    cancelAnimationFrame(frameId);
    playing=false;
    updateButton('Resume replay','play');
    setBattleAudio('paused',elapsed);
  }

  let playStart;
  function toggle() {
    if (playing) {pause();return;}
    activateGameAudio(muted());
    if (elapsed===timeline.duration) {
      elapsed=0;
      result.hidden=true;
      skip.hidden=false;
      resolved=false;
    }
    playing=true;
    updateButton('Pause replay','pause');
    setBattleAudio('playing',elapsed);
    if (elapsed===0) playGameCue('battle-march',muted());
    draw(elapsed);
    playStart=performance.now()-elapsed;
    frameId=requestAnimationFrame(frame);
  }

  play.addEventListener('click',toggle);
  skip.addEventListener('click',()=>{
    activateGameAudio(muted());
    reveal({sound:true,focus:true});
  });
  slider.addEventListener('input',()=>{
    const position=Number(slider.value);
    if (playing) pause();
    if (position>=100) {reveal();return;}
    result.hidden=true;
    skip.hidden=false;
    resolved=false;
    if (position===0) updateButton('Play battle replay','play');
    else updateButton('Resume replay','play');
    draw(position*timeline.duration/100);
  });
  const controller={
    step(milliseconds) {
      if (playing) pause();
      if (elapsed+milliseconds>=timeline.duration) reveal();
      else draw(elapsed+milliseconds);
    },
    destroy() {disposed=true;cancelAnimationFrame(frameId);motion.destroy();},
  };
  replayController=controller;
  draw(0);
  if (ui.dialog?.revealed) reveal();
  else if (live) {
    play.hidden=true;
    slider.hidden=true;
    toggle();
  }
  if (!/^b\d{1,12}$/.test(battle.id)) return;
  const chain=result.querySelector('[data-battle-chain]');
  function showSettlement(proof) {
    if (!chain) return;
    put(chain,proof.settlement||proof.territorySettlement?'Settlement confirmed on ' + NETWORK_LABEL + '':
      proof.anchorStatus==='reorg'?'Settlement under chain reconciliation':
      proof.record?.initiation||proof.anchorStatus!=='unfunded'?'Settlement pending confirmation':'No confirmed settlement proof available');
  }
  void api('/public/battle/'+battle.id+'?cinematic=1').then(proof=>{
    if (replayController!==controller) return;
    showSettlement(proof);
    if (!proof.verified||!Array.isArray(proof.trace)) return;
    timeline=battleTimeline(battle,proof.trace,{reducedMotion});
    if (!timeline.traced) return;
    motion.destroy();
    motion=mountBattleMotion(scene,battle,timeline,{reducedMotion});
    draw(elapsed);
    const exchanges=result.querySelector('[data-battle-exchanges]');
    const factors=result.querySelector('[data-battle-factors]');
    const first=proof.trace[0], last=proof.trace.at(-1);
    if (first&&last) {
      factors.textContent='Attack and defense pressure were '+number(first.attacker.pressure)+' to '+number(first.defender.pressure)+' in the opening exchange and '+number(last.attacker.pressure)+' to '+number(last.defender.pressure)+' in the final exchange. The result weighs surviving unit strength, defensive terrain and initiative.';
      exchanges.innerHTML='<ol class="battle-exchanges" aria-label="Losses by exchange">'+timeline.rounds.map(({event})=>
        '<li><span>'+number(event.round)+'</span><small>'+number(event.attackerLoss)+' / '+number(event.defenderLoss)+' lost</small></li>').join('')+'</ol>';
    }
  }).catch(()=>{if (replayController===controller&&chain) put(chain,'Settlement proof unavailable');});
}
document.addEventListener('click', event => {
  const archiveLink=event.target.closest('a[href]');
  if(archiveLink&&archiveLink.origin===location.origin&&['/ledger.html','/explorer','/council.html'].includes(archiveLink.pathname)&&
    !event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0) {
    event.preventDefault();
    if(!ui.archive) ui.archiveEntry=location.pathname+location.search;
    activateGameAudio(muted());
    showArchive(archiveLink.pathname==='/council.html'?'council':'ledger',{push:true});
    return;
  }
  const sponsor = event.target.closest('[data-sponsor-site]');
  if (sponsor) void api('/sponsors/' + sponsor.dataset.sponsorSite + '/click', {}).catch(() => {});
  const el = event.target.closest('button');
  if (!el || el.disabled) return;
  activateGameAudio(muted());
  const data = el.dataset;
  if (data.walletPair && ui.state?.chain?.walletConnect) void connectWizard(data.walletPair, {player:playerCity().id,testRelay:ui.state.chain.testWizardRelay});
  if ('walletReconnect' in data) void resumeWizard();
  if ('walletClose' in data) void closeWizard();
  if ('walletCancel' in data) cancelWizardApproval();
  if ('archiveBack' in data) leaveArchive();
  if ('showGuide' in data) showGuide();
  if (data.learn) learnChoice(data.learn);
  if (data.walletLater) dom.dialog.close();
  if (data.walletReturn) openModal('node',data.walletReturn);
  if (data.walletReturnMode==='claim') openModal('claim');
  if ('codexBack' in data && ui.dialog?.mode==='codex' && ui.dialog.back) {
    const {mode,...details}=ui.dialog.back;
    showDialog(mode,details);
  }
  if ('codexTopic' in data) {
    filterCodex(el.closest('[data-codex]'),{chapter:data.codexTopic});
    if (data.codexTopic==='blockchain') markEducationVisit('discover-bch');
  }
  if ('dismissOrderError' in data) {
    el.closest('.order-error')?.remove();
    dom.dialog.querySelector('form :is(input, select, textarea, button):not(:disabled):not([type="hidden"]), :scope > .buttons button')?.focus();
    void refresh();
  }
  if (data.walletOpenOther && ui.walletProof?.openOther && !ui.busy) {
    el.disabled=true;
    // The wallet already approved the check: the same proof opens its kingdom, with the wallet still connected there.
    void ui.walletProof.openOther({ switchKingdom:true }).then(result => {
      adoptWizardSession(ui.state.player.id, result.result.player, ui.state.chain?.testWizardRelay);
      location.assign('/play');
    }).catch(error => { ui.walletProof = { error: error.message }; notify(error.message, true); refreshDialog(); });
  }
  if ('confirmSignOut' in data && !ui.busy) {
    el.disabled=true;
    ui.signingOut=true;
    void perform('/session/logout',{leaveForGood:data.confirmSignOut==='for-good'},async()=>{
      await closeWizard();
      location.replace('/');
    }).catch(()=>{ui.signingOut=false;if(el.isConnected)el.disabled=false;});
  }
  if (data.walletApprove) {
    const intent = list(ui.state.payments).find(payment => payment.id === data.walletApprove) ?? ui.dialog?.intent;
    if (intent) void approveWizard(intent, api).then(result => {
      if (result.state) setState(result.state);
      renderAll(true);
    }).catch(error => { if (!requireWallet(error)) presentOrderFailure(error.message); });
  }
  if ('walletProve' in data) void verifyWallet({ again:true });
  if (data.mapFocus) {
    const focal = cities().find(city => city.id === data.mapFocus);
    if (focal && regionOf(focal) !== currentRegion().id) chooseRegion(regionOf(focal), focal.id);
    else ui.targetId = data.mapFocus;
    ui.inspector = true;
    ui.politicalOverlay = true;
  }
  if (data.regionPick) {
    if (data.regionPick !== currentRegion().id) chooseRegion(data.regionPick);
    regionNavigation.querySelector('details').open = false;
    renderMap();
    renderInspector();
    regionNavigation.querySelector('summary')?.focus();
  }
  if (data.page) void changePage(data.page, data.startTab);
  if ('politicalReview' in data || 'politicalDismiss' in data) {
    const notice = select('political-outcome');
    if (notice.matches(':popover-open')) notice.hidePopover();
    if ('politicalReview' in data) void changePage('politics', politicalOutcomePage());
  }
  if (data.politicalFocus) {
    ui.politicalFocus = data.politicalFocus;
    playGameCue('select', muted());
    renderCampaign(true);
    dom.campaign.querySelector('[data-political-focus="' + CSS.escape(data.politicalFocus) + '"]')?.focus({preventScroll:true});
  }
  if (data.tab) {
    ui.tabs[ui.page] = data.tab;
    renderCampaign(true);
    if (ui.page === 'politics') dom.campaign.querySelector('[data-tab="' + CSS.escape(data.tab) + '"]')?.focus({preventScroll:true});
  }
  if (data.target) {
    playGameCue('select', muted());
    ui.targetId = data.target;
    ui.inspector = true;
    renderMap();
    renderInspector();
  }
  if ('closeTarget' in data) {
    ui.inspector = false;
    renderInspector();
    renderMap();
  }
  if (data.channel) { ui.channel = data.channel; renderActivity(); }
  if (data.map) handleMapControl(data.map);
  if (data.modal) openModal(data.modal, data.id, data.returnTerritory, data.returnWalletMode);
  if ('dismiss' in data) dom.dialog.close();
  if ('dialogBack' in data) goBackDialog();
  if ('pageBack' in data) goBackPage();
  if ('retry' in data) void refresh();
  if (data.command && !ui.busy) void act(JSON.parse(data.command),el).catch(() => {});
  if (data.pay && !ui.busy) void startPayment(JSON.parse(data.pay)).catch(() => {});
  if ('walletAssets' in data) void inspectWalletAssets();
  if (data.copy) {
    void navigator.clipboard.writeText(data.copy).then(() => notify('Copied.')).catch(() => notify('Select and copy the address directly.',true));
  }
});
document.addEventListener('vaultborn-wallet-status', () => {
  if (wizardState().status === 'ready') void verifyWallet();
  continuePendingPayment();
  if (wizardState().status === 'closed') { provedFor = null; ui.walletProof = null; }
  if (ui.dialog?.mode === 'wallet' || ui.dialog?.mode === 'payment') refreshDialog();
  if(ui.state) renderHeader();
  if(['ready','closed'].includes(wizardState().status)&&walletAddress(ui.state?.wallet)!==ui.walletAssets?.wallet?.address)
    void inspectWalletAssets();
  // Connected after the first look: read the whole wallet now.
  else if(wizardState().status==='ready'&&ui.walletAssets&&!ui.walletAssets.whole&&!ui.walletAssets.wholeTried){
    ui.walletAssets.wholeTried=true;
    void inspectWalletAssets();
  }
});
dom.dialog.addEventListener('input',event=>{
  if(event.target.hasAttribute('data-codex-search')) filterCodex(event.target.closest('[data-codex]'),{term:event.target.value});
});
document.addEventListener('vaultborn-archive-payment',event=>showDialog('payment',{id:event.detail.id,intent:event.detail}));
document.addEventListener('vaultborn-archive-pay',event=>{ if (!ui.busy) void startPayment(event.detail).catch(() => {}); });
window.addEventListener('popstate',()=>showArchive(archiveAtPath()));
dom.dialog.addEventListener('close', () => {
  if (ui.eventQueue?.length) setTimeout(() => { if (!dom.dialog.open && ui.eventQueue?.length) presentEvent(ui.eventQueue.shift()); }, 400);
  if (!dom.dialog.open) {
    const closed = ui.dialog?.mode;
    ui.dialog = null;
    dialogTrail.length = 0;
    closeBattleReplay();
    // A wallet dialog closed without connecting: the payment that asked for it is dropped.
    if (closed === 'wallet') ui.pendingPayment = null;
    // A kingdom still without a name goes back to founding (after a sign-in dialog was closed, for example).
    if (ui.state?.player?.founding && !ui.archive) { showDialog('found'); return; }
    // The welcome was closed some other way: the wallet prompt still follows it.
    if (closed === 'welcome' && ui.walletPromptDue) {
      ui.walletPromptDue = false;
      ui.afterWalletPrompt = 'close';
      showDialog('wallet-prompt');
      return;
    }
    // The wallet prompt (and the wallet dialog opened from it) are done: continue with what the player chose in the welcome.
    if (ui.afterWalletPrompt && ['wallet-prompt','wallet'].includes(closed)) {
      const choice = ui.afterWalletPrompt;
      ui.afterWalletPrompt = null;
      if (choice !== 'close') learnChoice(choice);
    }
  }
});
// Escape cannot close the founding dialog: the kingdom needs a name first.
dom.dialog.addEventListener('cancel', event => { if (ui.dialog?.mode === 'found') event.preventDefault(); });

dom.world.addEventListener('contextmenu', event => {
  const marker = event.target.closest('.world-city');
  const city = cities().find(item => item.id === marker?.dataset.target);
  if (!city) return;
  event.preventDefault();
  if (cityMenu.matches(':popover-open')) cityMenu.hidePopover();
  const own = city.id === playerCity().id;
  const choices = own ? [['inspect','Inspect city'],['city','Open city']] :
    [['inspect','Inspect city'],['scout','Plan scout mission'],['attack','Open battle planner']];
  cityMenu.innerHTML = choices.map(([action,label]) =>
    `<button type="button" role="menuitem" data-order="${action}">${label}</button>`).join('');
  cityMenu.dataset.targetCity = city.id;
  const rect = marker.getBoundingClientRect();
  cityMenu.style.left = Math.max(8,Math.min(event.clientX || rect.right,innerWidth - 195)) + 'px';
  cityMenu.style.top = Math.max(8,Math.min(event.clientY || rect.bottom,innerHeight - 125)) + 'px';
  cityMenu.showPopover();
  cityMenu.firstElementChild?.focus();
});
cityMenu.addEventListener('click', event => {
  const order = event.target.closest('[data-order]')?.dataset.order;
  if (!order) return;
  cityMenu.hidePopover();
  ui.targetId = cityMenu.dataset.targetCity;
  ui.inspector = true;
  renderMap();
  renderInspector();
  if (order === 'city') void changePage('city','build');
  if (order === 'scout' || order === 'attack') openModal(order,ui.targetId);
});
cityMenu.addEventListener('keydown', event => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...cityMenu.querySelectorAll('[role="menuitem"]')];
  const current = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
    (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
  items[next]?.focus();
});
document.addEventListener('change', event => {
  if (event.target.closest('.politics-form')) syncPoliticalFields(event.target.closest('form').parentElement);
  if (event.target.closest('form[data-form="attack"]')) {
    const review=dom.dialog.querySelector('[data-raid-review]');
    if (review) {review.hidden=true;review.replaceChildren();}
    void refreshRaidDossier();
  }
  if(event.target.closest('form[data-form=trade]')) {
    clearTimeout(marketTimer);
    void updateMarketQuote();
  }
});
document.addEventListener('input',event=>{
  const training=event.target.closest('form[data-form=train]');
  if (training&&event.target.name==='count') {
    training.querySelector('button[type=submit]').disabled=true;
    ++trainingRequest;
    clearTimeout(trainingTimer);
    trainingTimer=setTimeout(updateTrainingQuote,160);
  }
  const form=event.target.closest('form[data-form=trade]');
  if (!form||event.target.name!=='amount') return;
  form.querySelector('button[type=submit]').disabled=true;
  ++marketRequest;
  clearTimeout(marketTimer);
  marketTimer=setTimeout(updateMarketQuote,175);
});
dom.dialog.addEventListener('click',event=>{
  if (event.target.closest('[data-continue-dispatch]')) {
    const back=ui.dialog?.presentation?.back;
    if (back) { const {mode,...details}=back; showDialog(mode,details); }
    else dom.dialog.close();
  }
  const cancelRaid=event.target.closest('[data-cancel-raid]');
  if(cancelRaid){
    const review=cancelRaid.closest('[data-raid-review]');
    const launch=review.closest('form').querySelector('.raid-launch');
    review.hidden=true;
    review.replaceChildren();
    launch?.focus();
  }
  const dismiss=event.target.closest('[data-dismiss-report]');
  if (dismiss) {
    dismiss.disabled=true;
    void api('/offline-report/dismiss',{id:dismiss.dataset.dismissReport}).then(value=>{
      const report=value.report??value;
      if (ui.state.offlineReport?.id===dismiss.dataset.dismissReport) ui.state.offlineReport={...ui.state.offlineReport,...report,unread:false};
      dom.dialog.close();
    }).catch(error=>{notify(error.message,true);dismiss.disabled=false;});
  }
});
document.addEventListener('submit', event => {
  const form = event.target;
  const mode = form.dataset.form;
  if (!mode) return;
  event.preventDefault();
  if (ui.busy) return;
  const data = Object.fromEntries(new FormData(form, event.submitter));
  if (mode==='attack'&&data.paid!=='1'&&data.confirmed!=='1') {
    const review=form.querySelector('[data-raid-review]');
    const targetCity=cities().find(city=>city.id===data.target);
    review.innerHTML=`<p><strong>Commit the army to ${html(targetCity?.name??'the target')}?</strong> A raid spends an attack slot. Troops can be lost.</p>
      <div class="buttons"><button class="btn attack raid-launch" type="submit" name="confirmed" value="1">${icon('war')} Confirm attack</button><button class="btn" type="button" data-cancel-raid>Keep planning</button></div>`;
    review.hidden=false;
    review.querySelector('button').focus();
    return;
  }
  const response = formAnswer(mode, data, pageContext());
  if (!response) return;
  const submitter = event.submitter;
  if (submitter) submitter.disabled = true;
  const run = response.command ? act(response.command,submitter) : response.payment ? startPayment(response.payment) : perform(response.route, response.body, async result => {
    if (mode === 'wallet-challenge') {
      const value = result.result ?? result;
      showDialog('wallet', { returnTerritory:ui.dialog?.returnTerritory,returnWalletMode:ui.dialog?.returnWalletMode,
        challenge: value.challenge ?? value.message, address: value.address ?? data.address });
    } else if (mode === 'wallet-verify') {
      ui.walletAssets = null;
      showDialog('wallet',{returnTerritory:ui.dialog?.returnTerritory,returnWalletMode:ui.dialog?.returnWalletMode});
      void inspectWalletAssets();
      playGameCue('reward',muted());
    } else if (response.route === '/vault/quote') {
      showDialog('payout-review', { quote:result.result ?? result });
    } else if (response.route === '/session') {
      dom.dialog.close();
      notify('Your city is ready.');
      await refresh();
    } else {
      await getVault();
      const intent = result.result ?? result;
      if (intent.id) showDialog('payment', { id:intent.id, intent });
      else dom.dialog.close();
      notify(result.message ?? 'Request recorded.');
    }
  });
  void run.catch(() => {}).finally(() => { if (submitter?.isConnected) submitter.disabled = false; });
});

const mapPointers=new Map();
let gesture,suppressMapTapUntil=0;
function gestureShape() {
  const [first,second]=[...mapPointers.values()];
  if (!first) return null;
  const center=second?[(first.x+second.x)/2,(first.y+second.y)/2]:[first.x,first.y];
  return {center,distance:second?Math.max(1,Math.hypot(first.x-second.x,first.y-second.y)):null};
}
function resetGesture() {
  const shape=gestureShape();
  gesture=shape&&{...shape,from:mapPoint(...shape.center),camera:{scale:ui.scale,dx:ui.dx,dy:ui.dy},dragging:false};
  dom.world.classList.toggle('grabbed',Boolean(gesture?.distance));
}
dom['activity-dock'].addEventListener('click', event => {
  const toggle = event.target.closest('[data-chat-toggle]');
  if (!toggle) return;
  chatOpen = toggle.dataset.chatToggle === 'open';
  try { localStorage.setItem('vaultborn-chat', chatOpen ? 'open' : 'closed'); } catch { /* The choice lasts for this visit. */ }
  renderActivity();
  if (chatOpen) dom['activity-dock'].querySelector('input:not([disabled])')?.focus();
  else dom['activity-dock'].querySelector('[data-chat-toggle]')?.focus();
});
// A page (My City, Vault, Politics…) lies over the map: a click on the map around it closes the page, like the Map button.
const pageOverMap = () => ui.page !== 'map' && !ui.archive && !dom.campaign.hidden;
dom.world.addEventListener('pointerdown', event => { if (pageOverMap()) event.stopImmediatePropagation(); }, true);
dom.world.addEventListener('click', event => {
  if (!pageOverMap()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void changePage('map');
}, true);
dom.world.addEventListener('pointerdown', event => {
  if (event.button!==0 || (event.pointerType==='mouse'&&event.target.closest('button'))||mapPointers.size>=2) return;
  mapPointers.set(event.pointerId,{x:event.clientX,y:event.clientY,capture:event.target});
  event.target.setPointerCapture?.(event.pointerId);
  resetGesture();
  if (mapPointers.size===2) suppressMapTapUntil=performance.now()+400;
});
dom.world.addEventListener('pointermove', event => {
  const point=mapPointers.get(event.pointerId);
  if (!point||!gesture) return;
  point.x=event.clientX;point.y=event.clientY;
  const shape=gestureShape();
  if (!gesture.dragging&&!shape.distance&&Math.hypot(shape.center[0]-gesture.center[0],shape.center[1]-gesture.center[1])<5) return;
  gesture.dragging=true;
  suppressMapTapUntil=performance.now()+350;
  dom.world.classList.add('grabbed');
  setZoom(gesture.camera.scale*(shape.distance&&gesture.distance?shape.distance/gesture.distance:1),
    gesture.from,mapPoint(...shape.center),gesture.camera);
});
for (const name of ['pointerup','pointercancel','lostpointercapture']) {
  dom.world.addEventListener(name,event=>{
    if (!mapPointers.delete(event.pointerId)) return;
    if (gesture?.dragging||gesture?.distance) suppressMapTapUntil=performance.now()+300;
    resetGesture();
  });
}
dom.world.addEventListener('click',event=>{
  if (event.detail&&performance.now()<suppressMapTapUntil) {event.preventDefault();event.stopImmediatePropagation();}
},true);
dom.world.addEventListener('wheel', event => {
  event.preventDefault();
  const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?dom.world.clientHeight:1);
  setZoom(ui.scale*Math.exp(-Math.max(-180,Math.min(180,pixels))*.00175),mapPoint(event.clientX,event.clientY));
}, { passive:false });
dom.world.addEventListener('keydown', event => {
  if (event.target !== dom.world) return;
  const delta = {ArrowLeft:[48,0],ArrowRight:[-48,0],ArrowUp:[0,48],ArrowDown:[0,-48]}[event.key];
  if (delta) {
    event.preventDefault();
    ui.dx += delta[0];
    ui.dy += delta[1];
    transformMap();
  } else if (['+','=','-','0'].includes(event.key)) {
    event.preventDefault();
    handleMapControl(event.key === '0' ? 'reset' : event.key === '-' ? 'out' : 'in');
  }
});
document.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'f' || event.target.closest('input,textarea,[data-game-select]')) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
});
new ResizeObserver(()=>{transformMap();paintTerritories();}).observe(dom['world-stage']);
setInterval(() => {
  for (const timer of document.querySelectorAll('[data-until]')) timer.textContent = duration(Number(timer.dataset.until) - gameNow());
  for (const meter of document.querySelectorAll('progress[data-started]')) meter.value=Math.min(100,Math.max(0,
    (gameNow()-Number(meter.dataset.started))/Math.max(1,Number(meter.dataset.ends)-Number(meter.dataset.started))*100));
},1000);
setInterval(() => {
  if (ui.page === 'map' && (ui.politicalOverlay || list(ui.state?.marches).length) && !ui.state?.player?.settings?.reducedMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches) paintTerritories();
},100);
window.render_game_to_text = () => JSON.stringify({
  mode: ui.page, player: ui.state?.player?.id ?? null, city: playerCity().name ?? null,
  guide: ui.guide==='review' ? {status:'review',step:guideSteps[ui.guideReviewIndex]?.id,visible:!guide.hidden} :
    playerCity().onboarding ? { status: playerCity().onboarding.status, step: playerCity().onboarding.step, visible: !guide.hidden } : null,
  network: ui.state?.chain?.network ?? null, selection: target()?.name ?? null,
  map: { zoom: ui.scale, pan: [ui.dx,ui.dy], region:currentRegion().id, axes: 'x right, y down', cities: cities().map(city => ({ id:city.id,name:city.name,x:city.x,y:city.y,region:regionOf(city) })) },
  politics: ui.page === 'politics' ? {
    tab: ui.tabs.politics ?? 'government',
    selection: ui.politicalFocus ?? playerCity().id,
    tabs: [...dom.campaign.querySelectorAll('[role="tab"]')].map(tab => tab.textContent),
    visible: dom.campaign.querySelector('.politics-workspace')?.innerText ?? null,
  } : null,
  payment: ui.dialog?.mode === 'payment' ? (ui.state?.payments?.find(item => item.id === ui.dialog.id)?.state ?? ui.dialog.intent?.state) : null,
});
window.advanceTime = ms => { paintTerritories(); replayController?.step(ms); };
const demoSeat = new URLSearchParams(location.search).get('seat');
async function openCampaignSession() {
  try {
    const session = await api('/session');
    if (!session.authenticated) {
      const useDemo = session.demo && ['p1','p2','p3','p4'].includes(demoSeat);
      const result = await api('/session', useDemo ? { demo: demoSeat } : { entry: 'new' });
      setState(result.state);
    }
  } catch (error) {
    dom.loading.innerHTML = `<div class="loading-art" aria-hidden="true"></div><div class="loading-card"><div class="loading-mark"><img src="/logo.webp" width="84" height="107" alt=""></div><h1>VAULTBORN</h1><p class="loading-status">${html(error.message)}</p><div class="buttons"><a class="btn" href="/">Return to the entrance</a></div></div>`;
    return;
  }
  await refresh({ presentOffline: !archiveAtPath() });
  // A guide still in progress opens again on every return, in any browser: the kingdom keeps its place in it.
  if (playerCity().onboarding?.status === 'active') {
    ui.guide = 'active';
    refreshGuide();
  }
  if (!playerCity().founding && !dom.dialog.open) greetNewKingdom();
  select('app').classList.add('campaign-arrived');
  if (archiveAtPath()) showArchive(archiveAtPath());
  void resumeWizard();
  const resumedPayment = new URLSearchParams(location.search).get('payment');
  if (resumedPayment && list(ui.state?.payments).some(item => item.id === resumedPayment)) showDialog('payment', { id: resumedPayment });
  if (ui.state) connectStream();
}
await openCampaignSession();
