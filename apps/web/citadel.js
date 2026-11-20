import { html as esc, number, title, formatDate, confirmationText } from './view.js';
import { icon } from './icons.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

let page = location.pathname.startsWith('/verify/battle/') ? 'verify' : location.pathname === '/council.html' ? 'council' : 'ledger';
const root = document.getElementById('citadel-main');
const toast = document.getElementById('citadel-toast');
const embedded=Boolean(root.closest('.citadel-embedded'));
let authenticated=embedded;
let renderRevision=0;
const sats = value => number(value) + ' sat';
const chainLink = txid => NETWORK.explorer + txid;
const date = value => value == null ? '—' : formatDate(value);
let adminToken = '';
let toastTimer;
let adminRows;
let popup;

function markPage() {
  for(const link of document.querySelectorAll('[data-citadel-link]')){
    if(link.dataset.citadelLink===page) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
}

async function api(path, body, admin = false) {
  const headers = {};
  if (admin) headers.Authorization = 'Bearer ' + adminToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api' + path, { cache: 'no-store', headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}

function feedback(message, error = false) {
  toast.textContent = message;
  toast.toggleAttribute('data-error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

const hero = (name, image, text, label = 'Citadel archives') => `<section class="citadel-hero" style="--hero:url('/art/${image}.webp')">
  <span class="citadel-label">${esc(label)}</span><h1>${esc(name)}</h1><p>${esc(text)}</p></section>`;
const block = (label, content) => `<section class="citadel-block"><h2>${esc(label)}</h2>${content}</section>`;
const action = (label, kind, value = '', type = '') => `<button type="button" class="btn ${type}" data-act="${kind}" data-value="${esc(value)}">${esc(label)}</button>`;
const link = (label, url, type = '') => `<a class="btn ${type}" href="${esc(url)}">${esc(label)}</a>`;
const submit = label => `<div><button class="btn primary" type="submit">${esc(label)}</button></div>`;
const field = (name, label, options = '') => `<label>${esc(label)}<input name="${name}" ${options}></label>`;
const deed = (name, content) => `<form data-deed="${name}">${content}</form>`;
const stats = entries => `<dl class="citadel-stats citadel-grid">${entries.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
const txLink = txid => txid ? `<a href="${chainLink(txid)}" target="_blank" rel="noopener noreferrer">${esc(txid)}</a>` : '—';
const records = (items, item, empty) => items.length ? `<ul class="citadel-list">${items.map(row => '<li>' + item(row) + '</li>').join('')}</ul>` : '<p>' + esc(empty) + '</p>';
const splitAmounts = allocation => `Development ${sats(allocation.development)} · Seasonal Prizes ${sats(allocation.prize)}`;

// The two collectible categories: whether the game's issuer for each is at work, and where it was created.
function collectibles(ledger) {
  const issuers = [['Territory deeds', ledger.territoryAuthority, ''], ['Treaty charters', ledger.politicalAuthority, link('Political archive', '/verify/politics')]];
  const ready = authority => authority?.status === 'configured';
  const state = authority => !ready(authority) ? 'Not set up' : authority.signingEnabled ? 'Issuer active' : 'Issuer read-only';
  const assets = ledger.territoryAssets ?? [];
  return block('CashTokens collectibles', stats(issuers.map(([label, authority]) => [label, state(authority)])) +
    issuers.filter(([, authority]) => ready(authority)).map(([label, authority, more]) =>
      `<p class="citadel-meta">${esc(label)}: category <span class="citadel-mono">${esc(authority.category)}</span>, created in ${txLink(authority.genesisTxid)}</p>${more}`).join('') +
    records(assets, asset =>
      `<h3>${esc(title(asset.kind))} · ${esc(asset.territoryId)}</h3><p class="citadel-meta">${esc(title(asset.state))} · ${txLink(asset.txid)}</p>
      ${link('Territory record','/verify/territory/'+encodeURIComponent(asset.territoryId))}`,
      ready(ledger.territoryAuthority) ? 'No territory collectible has been issued yet. The game issues one to the linked wallet when a kingdom claims, conquers or leases a territory.' :
        'Confirmed game events queue collectibles when the dedicated issuer is configured.'));
}

function sponsorshipLedger(sponsorship, prizes) {
  if (!sponsorship) return '';
  const { confirmed, pending, policy } = sponsorship;
  const details = [
    ['Confirmed sponsorship', sats(confirmed.total)],
    ['Development allocation', sats(confirmed.development)],
    ['Seasonal Prize allocation', sats(confirmed.prize)],
    ['Pending sponsorship checkouts', number(pending.count)],
  ];
  if (confirmed.externalDevelopment > 0) details.push(['Sent to external Development custody', sats(confirmed.externalDevelopment)]);
  const remaining = prizes?.status === 'open' ? `Season ${prizes.seasonId} claims close ${date(prizes.claimDeadline)}. ${sats(prizes.rolledSatoshis)} carried in from earlier seasons.` :
    prizes?.status === 'rollover' ? `Season ${prizes.seasonId} did not qualify for payouts. ${sats(prizes.poolSatoshis)} carry forward.` :
    prizes?.status === 'expired' ? 'The last claim window closed. Unclaimed funds carry forward.' :
    'Season prizes open after the first eligible season closes.';
  return block('Sponsorship funding', `<p>Each new sponsorship sends ${number(policy.developmentPercent)}% to Development and ${number(policy.prizePercent)}% into the Seasonal Prize Fund covenant. Contributions start at ${esc(policy.minimumSatoshis / 1e8 + ' BCH')} (${esc(sats(policy.minimumSatoshis))}). The wallet network fee is separate.</p>` +
    stats(details) + `<p class="citadel-meta">${number(pending.observedCount)} of the pending checkouts have a matched transaction awaiting confirmation.</p>` +
    (confirmed.legacyPrize ? `<p class="citadel-meta">${esc(sats(confirmed.legacyPrize))} of the prize allocation came from historical single-output sponsorships.</p>` : '') +
    `<p class="citadel-meta">${esc(remaining)}</p>` + (prizes?.status === 'open' && prizes.deferredSatoshis > 0 ?
      `<p class="citadel-meta">${esc(sats(prizes.deferredSatoshis))} of the award base carry forward because of the payout input limit.</p>` : ''));
}

async function showLedger() {
  const ledger = await api('/public/ledger');
  const { buckets, transactions, stats: totals, source } = ledger;
  const mode={simulated:'Local simulation',offline:'Offline archive',chipnet:'Bitcoin Cash ' + NETWORK_LABEL + ''}[source]??'Bitcoin Cash ' + NETWORK_LABEL + '';
  const receipts=embedded?pendingPayments.map(item=>`<article class="citadel-row"><div><h3>${esc(item.title)}</h3>
    <p class="citadel-meta">${esc(sats(item.satoshis))} · ${item.txid?'Awaiting confirmation':'Awaiting wallet approval'}</p></div>
    <button type="button" class="btn" data-modal="payment" data-id="${esc(item.id)}">Open checkout</button></article>`).join(''):'';
  document.title = 'Chain Explorer | VAULTBORN';
  return hero('Chain Explorer', 'event-vault', 'Receipts, escrow and the treasuries of the realm.', mode) +
    block('Treasury balances', stats([['Development', sats(buckets.development)],
      ...(buckets.externalDevelopment > 0 ? [['Delivered to external Development custody', sats(buckets.externalDevelopment)]] : []),
      ['Season prizes', sats(buckets.prize)],
      ['Kingdom reserve', sats(buckets.kingdomReserve)], ['Territory escrow', sats(buckets.territoryEscrow)], ['Treaty principal in escrow',sats(buckets.politicalEscrow ?? 0)],
      ['Competitive fee reserves',sats(buckets.settlementFees ?? 0)],
      ['BCH burned', sats(buckets.burned)], ['Confirmed transactions', number(totals.credited)],
      ['Confirmed network fees', sats(totals.fees)]])) +
    sponsorshipLedger(ledger.sponsorship, ledger.prizes) +
    (receipts?block('Your open checkouts',receipts):'')+
    block('Observed transactions', `<div class="citadel-actions">${action('Refresh receipts', 'refresh')}</div>` +
      records(transactions, row => `<article class="citadel-receipt"><span class="receipt-seal">${icon(row.direction==='outgoing'?'arrow':'bch')}</span><div>
      <h3>${esc(row.title ?? title(row.action))}</h3><p class="citadel-meta">${esc(sats(row.satoshis))} · ${esc(source==='simulated'?'Simulated '+title(row.state):title(row.state))} ·
      ${esc(number(row.confirmations))} confirmations ${row.feeSatoshis == null ? '' : ' · fee ' + esc(sats(row.feeSatoshis))}</p><p class="citadel-meta">${source==='simulated'?esc(row.txid):txLink(row.txid)}</p>
      ${row.allocations ? `<details><summary>Verified transaction outputs</summary>${stats(row.allocations.map(output => ['Output ' + output.vout + ' · ' + (output.label ?? title(output.role)), sats(output.satoshis)]))}</details>` : ''}
      ${row.event ? `<p class="citadel-meta">Event commitment <span class="citadel-mono">${esc(row.event.digest)}</span></p>` : ''}
      ${row.event?.kind === 'battle-settlement' ? link('Verify battle', '/verify/battle/' + row.event.subject) : ''}
      ${row.politics ? link('Political archive','/verify/politics'+(row.politicalRecord?'#'+encodeURIComponent(row.politicalRecord):'')) : ''}
      ${row.territory ? link('Territory record','/verify/territory/'+encodeURIComponent(row.territory)) : ''}</div></article>`,
      source==='offline'?'No receipts are available in this offline save.':'No transactions have been observed in this save.')) +
    collectibles(ledger);
}

async function showBattle() {
  const id = location.pathname.split('/').at(-1);
  const report = await api('/public/battle/' + id);
  const { battle, initiation } = report.record;
  const current = [battle.attackerName, battle.defenderName];
  const winner = battle.winner === 'attacker' ? current[0] : current[1];
  document.title = id + ' Battle Record | VAULTBORN';
  return hero(current.join(' v. '), 'battlefield', winner + ' prevailed after ' + battle.events.length + ' rounds.', 'Battle record ' + id) +
    block('Verification', stats([['Deterministic replay', report.verified ? 'Matches archived result' : 'Mismatch'],
      ['Protocol', report.rules.version], ['Settlement', report.settlement || report.territorySettlement ? '' + NETWORK_LABEL + ' verified' : title(report.anchorStatus)],
      ['Terrain', title(battle.input.terrain)]]) +
      `<p class="citadel-meta">Result hash <span class="citadel-mono">${esc(battle.hash)}</span></p>
       <p class="citadel-meta">Archive hash <span class="citadel-mono">${esc(report.recordHash ?? 'Legacy record')}</span></p>
       <p class="citadel-meta">Initiation ${txLink(initiation?.txid)}</p><p class="citadel-meta">Settlement ${txLink(report.settlement?.txid ?? report.territorySettlement?.txid)}</p>
       ${report.territorySettlement ? '<p>'+link('Territory settlement archive','/verify/territory/'+encodeURIComponent(report.territorySettlement.territory))+'</p>' : ''}
       <div class="citadel-actions">${link('Open complete record (JSON)', location.pathname + '?format=json', 'primary')}</div>`) +
    block('Round record', records(battle.events, event => `<h3>Round ${event.round} · ${esc(event.phase)}</h3>
      <p class="citadel-meta">Attacker lost ${event.attackerLoss} · Defender lost ${event.defenderLoss}</p>`, 'No rounds.'));
}

function campaignRow(campaign, mode) {
  const active = mode === 'public';
  const admin = mode === 'admin';
  const options = [];
  if (active) options.push(`<a class="btn primary" href="${esc(campaign.link)}" target="_blank" rel="noopener noreferrer" data-sponsor-click="${esc(campaign.id)}">Sponsor site</a>`);
  if (!active && !admin && campaign.status === 'approved' && campaign.received < campaign.amount && campaign.start > Date.now()) {
    options.push(action('Pay ' + sats(campaign.amount), 'sponsor-pay', campaign.id, 'primary'));
  }
  if (admin && campaign.status === 'pending') options.push(action('Approve', 'sponsor-approve', campaign.id, 'primary'), action('Decline', 'sponsor-deny', campaign.id));
  const { confirmed, pending, quoted } = campaign.allocation ?? {};
  const currentSplit = confirmed?.count ? ['Confirmed allocation', confirmed] : pending?.count ? ['Pending checkout', pending] :
    quoted ? ['Quoted allocation before fees', quoted] : null;
  return `<article class="citadel-row" ${active ? 'data-impression="' + esc(campaign.id) + '"' : ''}>
    <div><div class="branded-title">${active && campaign.logoUrl ? '<img class="sponsor-crest" alt="" src="' + esc(campaign.logoUrl) + '">' : icon('flag')}
    <div><span class="citadel-label">${esc(campaign.placement === 'tournament' ? 'Title tournament' : 'Season banner')}</span><h3>${esc(campaign.title)}</h3></div></div>
    <p>Sponsored by ${esc(campaign.sponsor)}${campaign.blurb ? ' · ' + esc(campaign.blurb) : ''}</p>
    <p class="citadel-meta">Season ${campaign.seasonId} · ${esc(date(campaign.start))} to ${esc(date(campaign.end))} · ${esc(sats(campaign.received))} funded
    ${active ? '' : ' · ' + esc(title(campaign.status))}${campaign.decision?.note ? ' · ' + esc(campaign.decision.note) : ''}</p>
    ${currentSplit ? `<p class="citadel-meta">${currentSplit[0]} · ${esc(splitAmounts(currentSplit[1]))}</p>` : ''}
    ${campaign.analytics ? `<p class="citadel-meta">${number(campaign.analytics.impression ?? 0)} daily unique impressions · ${number(campaign.analytics.click ?? 0)} daily unique clicks</p>` : ''}
    ${Array.isArray(campaign.standings) ? '<details><summary>Tournament standings</summary><p class="citadel-meta">15 points for a raid win and 10 for a successful defense. The first eligible battle between each pair counts each UTC day.</p>' +
      records(campaign.standings, (player) => esc(player.city) + ' · ' + number(player.points) + ' points', 'No qualifying raids in this window.') + '</details>' : ''}</div>
    <div class="citadel-actions">${options.join('')}</div></article>`;
}

function sponsorForm(sponsor) {
  const selection = sponsor.packages.map(({id,name,satoshis,allocation}, i) => `<label class="citadel-choice"><input type="radio" name="package" value="${id}" ${i === 0 ? 'checked' : ''}><span>${esc(name + ' · ' + satoshis / 1e8 + ' BCH · ' + sats(satoshis))}${allocation ? `<br><small>${esc(splitAmounts(allocation))}</small>` : ''}</span></label>`).join('');
  return deed('sponsor', `<fieldset><legend>Package</legend>${selection}</fieldset>
    <div class="citadel-inline">${field('sponsor','Sponsor name','required maxlength="52"')}${field('title','Campaign title','required maxlength="80"')}</div>
    ${field('link','Sponsor website','type="url" required maxlength="256" placeholder="https://"')}
    <label>Campaign description<textarea name="blurb" maxlength="180" rows="2"></textarea></label>
    ${field('logo','Logo (PNG or WebP, up to 7 KB)','type="file" accept="image/png,image/webp"')}
    <div class="citadel-inline">${field('start','Starts (your local time)','type="datetime-local" required')}${field('end','Ends (your local time)','type="datetime-local" required')}</div>
    ${submit('Request campaign approval')}`);
}

function councilRow(proposal) {
  const choices = ['yes','no','abstain'].map(vote => action(proposal.vote === vote ? 'Voted ' + vote : title(vote), 'vote-' + vote, proposal.id, proposal.vote === vote ? 'primary' : '')).join('');
  return `<h3>${esc(proposal.title)}</h3><p>${esc(proposal.reason)}</p>
    <p class="citadel-meta">${esc(sats(proposal.satoshis))} · ${esc(title(proposal.status))} · closes ${esc(date(proposal.endsAt))} · Quorum ${proposal.quorum}/${proposal.voterCount}</p>
    <p class="citadel-meta">${proposal.totals.yes} yes · ${proposal.totals.no} no · ${proposal.totals.abstain} abstain</p>
    ${proposal.txid ? `<p class="citadel-meta">${txLink(proposal.txid)}</p>` : ''}
    <div class="citadel-actions">${proposal.canVote ? choices : ''}${adminRows && proposal.status === 'passed' ? action('Review authorized transfer','dao-quote',proposal.id) : ''}</div>`;
}

function treasury(state) {
  const { vault, wallet } = state;
  const unified = vault.warChestSatoshis != null;
  const withdrawal = wallet?.address ? deed('kingdom-quote', field('satoshis','Amount to take out of your War Chest (satoshis, in whole thousands)','type="number" min="2000" step="1000" required') +
      '<p class="citadel-meta">Exactly this amount leaves your War Chest. Your wallet receives it less the network fee, which is shown before you confirm. An output must be about a day old (144 blocks) before it can be withdrawn.</p>' +
      `<p class="citadel-meta">Verified destination <span class="citadel-mono">${esc(wallet.address)}</span></p>` +
      `<input type="hidden" name="address" value="${esc(wallet.address)}">` + submit('Review withdrawal')) :
      '<p class="citadel-meta">Link your wallet in the game before withdrawing.</p>';
  // Sent to the War Chest and not confirmed yet: a deposit, or the War Chest share of a service payment.
  const incoming = (state.payments ?? []).filter(item => item.direction !== 'outgoing' && ['submitted', 'seen_in_mempool', 'confirming', 'uncertain'].includes(item.state))
    .map(item => [item, item.action === 'war-chest' ? item.satoshis : (item.outputs ?? []).filter(output => output.role === 'kingdom').reduce((total, output) => total + (output.satoshis ?? 0), 0)])
    .filter(([, satoshis]) => satoshis > 0);
  if (unified) return stats([['War Chest · always at risk', sats(vault.warChestSatoshis)],
    ...incoming.map(([item, satoshis]) => ['On its way · ' + confirmationText(item), sats(satoshis)]), ['Open to a matched raid now', sats(vault.capturableSatoshis ?? 0)],
    ...(vault.reservedSatoshis ? [['Matched against raids being settled', sats(vault.reservedSatoshis)]] : []),
    ...(vault.pendingChestSatoshis ? [['Waiting to join (earlier payments)', sats(vault.pendingChestSatoshis)]] : []),
    ...(vault.earlierChestSatoshis ? [['Earlier War Chest revision', sats(vault.earlierChestSatoshis)]] : []),
    ...(vault.exitingChestSatoshis ? [['Leaving (exit started)', sats(vault.exitingChestSatoshis)]] : []),
    ['Locked in your own stakes', sats(vault.lockedSatoshis ?? 0)],
    ...Object.entries(vault.serviceCredits ?? {}).map(([kind, count]) => ['Paid and owed to you: ' + ({ rush:'rush', premium:'premium improvement', protectorate:'protectorate proposal', 'espionage-paid':'paid intelligence mission', 'political-operation':'political operation' }[kind] ?? kind), count + ' · your next one is free (a game credit, not a BCH refund)']),
    ...(vault.depositedSatoshis ? [['Earlier vault deposit', sats(vault.depositedSatoshis)]] : []), ['Season claim available', sats(vault.claimableSatoshis)]]) +
    '<p class="citadel-meta">Your War Chest is at risk in PvP raids. You can withdraw what is not in a raid, or leave with your wallet key alone (about 2 days).</p>' + withdrawal;
  // A server without the War Chest contracts sells no paid services and holds no player money.
  return stats([['War Chest', 'Not available on this server'], ['Season claim available', sats(vault.claimableSatoshis)]]);
}

async function showCouncil() {
  authenticated = embedded || (await api('/session')).authenticated;
  const [sponsor, council, state] = await Promise.all([
    api('/public/sponsors'), api('/council'), authenticated ? api('/state?background=1') : null,
  ]);
  const contribution = !state ? 'Eligible service payments and direct sponsorship fund the pool.' :
    state.config?.economy ? 'Part of every service payment and all sponsorship go into the season reward pool.' :
    state.config?.allocationPolicy === 'separate-stake-v2' ?
      'Service payments contribute 10% (at least 546 sats to keep the output spendable). Competitive stakes stay in escrow. Direct sponsorship also funds the pool.' :
      'Eligible gameplay charges contribute to the pool under this realm’s checkout policy.';
  const rules = sponsor.allocationRules;
  document.title = 'Council & Sponsors | VAULTBORN';
  return hero('The Council', 'event-season', 'Fund a season, oversee the development treasury, and manage your kingdom’s confirmed ' + NETWORK_LABEL + ' funds.') +
    block('Your kingdom', state ? treasury(state) : '<p>Enter your kingdom to manage its treasury, request sponsorship, or vote.</p>' + link('Enter VaultBorn','/','primary')) +
    block('Active sponsorships', records(sponsor.publicCampaigns, item => campaignRow(item,'public'), 'No funded campaigns are active.')) +
    (sponsor.completedTournaments.length ? block('Tournament archive', records(sponsor.completedTournaments, item => campaignRow(item,'archive'), '')) : '') +
    block('Sponsor a season', `<p>${number(rules?.prizePercent ?? 70)}% of a sponsorship goes to the season prize pool and ${number(rules?.developmentPercent ?? 30)}% to Development. Any part not awarded returns to your wallet.</p>` + (authenticated ?
      records(sponsor.own, item => campaignRow(item,'own'), 'You have no sponsorship requests.') +
      '<details><summary>Request a sponsorship slot</summary>' + sponsorForm(sponsor) + '</details>' : '')) +
    block('Development council', `<p>Verified active members vote for three days. At least ${council.minimumMembers} voters and 25% participation are required. Approval needs ${council.passingPercent}% of yes and no votes. The operator reviews the exact transfer and fee after the vote.</p>` +
      records(council.proposals, councilRow, 'No spending proposals are open.') +
      (council.eligible && council.members >= council.minimumMembers ? '<details><summary>Propose a treasury transfer</summary>' +
        deed('proposal', field('title','Proposal title','required maxlength="85"') +
          '<label>Reason<textarea name="reason" required minlength="10" maxlength="500"></textarea></label>' +
          field('address','' + NETWORK_LABEL + ' CashAddr','required maxlength="150"') +
          field('satoshis','Amount (satoshis)','type="number" min="600" max="100000" required') + submit('Open vote')) + '</details>' : '')) +
    block('Season prizes', `<p>${contribution} When at least two registered players finish with a positive score, the top five ranks earn 40%, 25%, 15%, 10% and 10% of the award base. The ledger reserves 15% for network fees and liquidity. Prizes can be claimed for seven days to a verified wallet. Unclaimed funds and awards below 600 satoshis carry forward.</p>`) +
    block('Administrator', `<details ${adminRows ? 'open' : ''}><summary>Campaign approval and council transfers</summary>
      ${adminRows ? records(adminRows, item => campaignRow(item, 'admin'), 'No pending or scheduled campaigns.') :
      deed('admin', field('token','Administrator token','type="password" required minlength="32" maxlength="256" autocomplete="off"') + submit('Unlock'))}
    </details>`);
}

function trackImpressions() {
  if (!authenticated || !('IntersectionObserver' in globalThis)) return;
  const watcher = new IntersectionObserver(entries => {
    for (const entry of entries.filter(item => item.isIntersecting)) {
      const id = entry.target.dataset.impression;
      watcher.unobserve(entry.target);
      void api('/sponsors/' + id + '/impression', {}).catch(() => {});
    }
  }, { threshold: .5 });
  for (const item of root.querySelectorAll('[data-impression]')) watcher.observe(item);
}

let pendingPayments=[];
async function render() {
  const revision=++renderRevision;
  const markup=await ({ ledger: showLedger, verify: showBattle, council: showCouncil })[page]();
  if(revision!==renderRevision)return;
  root.innerHTML=markup;
  markPage();
  if (page === 'council') trackImpressions();
}

export function openCitadel(target,payments=[]) {
  page=target;
  setCitadelPayments(payments);
  root.innerHTML='<p role="status">Opening the archive…</p>';
  return render().catch(error=>{root.textContent=error.message;});
}
export function setCitadelPayments(payments) {
  pendingPayments=payments.filter(item=>!['credited','confirmed','expired','rejected'].includes(item.state)).slice(0,8);
}

function confirmation(label, details, run) {
  popup?.remove();
  popup = document.createElement('dialog');
  popup.className = 'dialog frame';
  popup.innerHTML = `<h2>${esc(label)}</h2>${details}<div class="citadel-actions"><button class="btn primary" value="yes" autofocus>Confirm</button>
    <button class="btn" value="cancel">Cancel</button></div>`;
  popup.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.value === 'cancel') return popup.close();
    button.disabled = true;
    try { await run(); popup.close(); await render(); } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  document.body.append(popup);
  popup.showModal();
}

const payoutDetails = quote => (quote.kind === 'kingdom-withdraw' ?
  '<p>Leaves your War Chest: ' + esc(sats(quote.satoshis + quote.feeSatoshis)) + '</p><p>Network fee: ' + esc(sats(quote.feeSatoshis)) + '</p><p><strong>Your wallet receives: ' + esc(sats(quote.satoshis)) + '</strong></p>' :
  '<p>Send ' + esc(sats(quote.satoshis)) + ' · network fee ' + esc(sats(quote.feeSatoshis)) + '</p>') + '<p class="citadel-mono">' + esc(quote.address) + '</p>';
const logoData = file => {
  if (!file?.size) return null;
  if (file.size > 7000) throw new Error('Use a PNG or WebP logo smaller than 7 KB.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not open the logo.'));
    reader.readAsDataURL(file);
  });
};

root.addEventListener('submit', async event => {
  const form = event.target.closest('[data-deed]');
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const kind = form.dataset.deed;
    if (kind === 'sponsor') {
      await api('/sponsors', { ...data, start: Date.parse(data.start), end: Date.parse(data.end), logo: await logoData(data.logo) });
      feedback('Sponsorship request recorded.');
    } else if (kind === 'admin') {
      adminToken = data.token;
      try { adminRows = await api('/admin/sponsors', undefined, true); } catch (error) { adminToken = ''; throw error; }
      feedback('Administrator access unlocked.');
    } else if (kind === 'proposal') {
      await api('/council/proposals', { ...data, satoshis: Number(data.satoshis) });
      feedback('Council vote opened.');
    } else if (kind === 'kingdom-quote') {
      const body = { kind: 'kingdom-withdraw', address: data.address, satoshis: Number(data.satoshis) };
      const { result: quote } = await api('/vault/quote', body);
      confirmation('Review withdrawal', payoutDetails(quote), async () => {
        await api('/vault/payout', { ...body, consent: true, expectedFee: quote.feeSatoshis, expectedSatoshis: quote.satoshis });
        feedback('Withdrawal recorded. Check the chain explorer for confirmations.');
      });
      return;
    }
    await render();
  } catch (error) { feedback(error.message, true); }
  finally { button.disabled = false; }
});

root.addEventListener('click', async event => {
  const click = event.target.closest('[data-sponsor-click]');
  if (authenticated && click) void api('/sponsors/' + click.dataset.sponsorClick + '/click', {}).catch(() => {});
  const control = event.target.closest('[data-act]');
  if (!control) return;
  const { act, value } = control.dataset;
  control.disabled = true;
  try {
    if (act === 'sponsor-pay') {
      // Inside the game the payment goes through the game's own checkout, which first asks for a connected wallet.
      if (embedded) { root.dispatchEvent(new CustomEvent('vaultborn-archive-pay',{detail:{ type: 'sponsor-fund', campaignId: value, consent: true },bubbles:true})); return; }
      const { result } = await api('/payments', { type: 'sponsor-fund', campaignId: value, consent: true });
      if(embedded) root.dispatchEvent(new CustomEvent('vaultborn-archive-payment',{detail:result,bubbles:true}));
      else location.assign('/?payment=' + encodeURIComponent(result.id));
      return;
    }
    if (act === 'sponsor-approve' || act === 'sponsor-deny') {
      const decision = act === 'sponsor-approve' ? 'approved' : 'denied';
      await api('/admin/sponsors/review', { id: value, decision }, true);
      adminRows = await api('/admin/sponsors', undefined, true);
      feedback('Campaign ' + decision + '.');
    }
    if (act.startsWith('vote-')) {
      await api('/council/vote', { id: value, vote: act.slice(5) });
      feedback('Your vote was recorded.');
    }
    if (act === 'dao-quote') {
      const quote = await api('/admin/council/quote', { id: value }, true);
      confirmation('Review council transfer', payoutDetails(quote), async () => {
        await api('/admin/council/spend', { id: value, consent: true, expectedFee: quote.feeSatoshis, expectedSatoshis: quote.satoshis }, true);
        feedback('Council transfer recorded.');
      });
      return;
    }
    await render();
  } catch (error) { feedback(error.message, true); }
  finally { control.disabled = false; }
});

if(!embedded) void render().catch(error => { root.textContent = error.message; });
