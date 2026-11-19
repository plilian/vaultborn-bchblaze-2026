import { html, formatDate, number, title } from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const root = document.getElementById('territory-proof');
const siteId = location.pathname.split('/').at(-1);
const arts = {starter:'castle-emerald',unclaimed:'terrain',resource:'event-vault',strategic:'battlefield',rare:'event-rebellion'};
const eventNames = {
  'territory-claim':'Contested claim', 'territory-attack':'Territorial battle', raffle:'Rare draw', 'lease-expired':'Lease expired',
};
const validTxid = /^[0-9a-f]{64}$/;
const tx = (txid, label) => validTxid.test(txid ?? '') ?
  `<a href="${NETWORK.explorer}${txid}" target="_blank" rel="noopener noreferrer">${html(label ?? txid)}</a>` : '—';
const fmt = value => value == null ? '—' : formatDate(value);
const sats = value => number(value ?? 0) + ' sat';
const block = (label, body) => `<section class="citadel-block"><h2>${html(label)}</h2>${body}</section>`;
const list = (items, paint, empty) => items?.length ? `<ul class="citadel-list">${items.map(item => '<li>'+paint(item)+'</li>').join('')}</ul>` : '<p>'+html(empty)+'</p>';
const fields = pairs => `<dl class="citadel-stats citadel-grid">${pairs.map(([key,value])=>`<div><dt>${html(key)}</dt><dd>${html(value)}</dd></div>`).join('')}</dl>`;
const profile = item => `<p class="citadel-meta citadel-mono">${tx(item.txid)} ${item.eventVout == null ? '' : ' · output ' + number(item.eventVout)}</p>`;

function recordView({record,recordHash,proofs,settlement,anchorStatus}) {
  const { id, kind, at, winner, controller, entries, lease, block:entropy, result, treasury, battles } = record;
  return `<article class="territory-proof-row"><div><h3>${html(eventNames[kind] ?? title(kind))}</h3>
    <p class="citadel-meta">${html(id)} · ${html(fmt(at))} · ${html(title(anchorStatus))}</p></div>
    ${settlement ? `<p class="territory-proof-authority">${tx(settlement.txid,'View confirmed settlement')}</p>` : ''}
    </article>
    ${fields([['Winner',winner ?? '—'],['Controller',controller ?? (kind==='territory-claim' ? winner : null) ?? '—'],['Accepted entries',entries?.length ?? 0],
      ['Captured treasury',sats(treasury?.capturedSatoshis)]])}
    ${lease ? `<p>Extraction rights held by ${html(lease.playerId)} from ${html(fmt(lease.startsAt))} to ${html(fmt(lease.expiresAt))}.</p>` : ''}
    <details><summary>Receipts and replay evidence</summary><p class="citadel-meta citadel-mono">Record hash ${html(recordHash)}</p>
    ${entropy ? `<p class="citadel-meta citadel-mono">Draw block ${number(entropy.height)} · ${html(entropy.hash)}<br>Roster hash ${html(result?.rosterHash)}</p>` : ''}
    ${list(proofs,profile,'This event refers to its earlier confirmed settlement.')}
    ${list((battles ?? []).filter(item => item?.id), battle => `<a href="/verify/battle/${encodeURIComponent(battle.id)}">Replay and verify battle ${html(battle.id)}</a>`,'No battle was needed for this event.')}
    </details>`;
}

function assetView(asset) {
  return `<article class="territory-proof-row"><div>
    <h3>${html(title(asset.kind))}</h3>
    <p class="citadel-meta">${html(title(asset.state))} · ${html(asset.id)}${asset.expiresAt ? ' · ' + html(fmt(asset.expiresAt)) : ''}</p>
    <p class="citadel-meta citadel-mono">Category ${html(asset.category ?? '—')}<br>Commitment ${html(asset.commitment ?? '—')}</p>
    ${asset.txid ? `<p class="citadel-meta">${tx(asset.txid,'Issuance transaction')}</p>` : ''}</div>
    <button type="button" class="btn" data-asset="${html(asset.id)}">Verify current output</button>
    <div class="territory-proof-utxo" data-live-proof hidden></div></article>`;
}

async function show() {
  const response = await fetch('/api/public/territories/'+encodeURIComponent(siteId),{cache:'no-store'});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Territory record unavailable.');
  const { territory,records,recent,authority } = data;
  const category = territory.category;
  document.title = territory.name+' | VAULTBORN';
  const claim = territory.claim;
  const raffle = territory.raffle;
  const production = Object.entries(territory.production ?? {}).filter(([,rate]) => rate > 0)
    .map(([resource,rate]) => [title(resource)+' / hour','+'+number(rate)]);
  root.innerHTML = `<section class="citadel-hero" style="--hero:url('/art/${arts[category] ?? 'terrain'}.webp')">
    <span class="citadel-label">${html(title(category))} territory</span><h1>${html(territory.name)}</h1>
    <p>Control records, complete settlement evidence, and CashTokens for this site.</p>
    <a class="btn" href="?format=json">Open complete record (JSON)</a></section>` +
    block('Control & extraction',fields([['Controller',territory.controller ?? 'Open'],['Status',title(territory.status)],
      ['Level',territory.level],['Garrison',territory.defenses?.count ?? 0],...production]) +
      (claim?.status==='open' ? `<p>Claims lock ${html(fmt(claim.lockAt))} and close ${html(fmt(claim.endsAt))}.</p>` : '') +
      (raffle?.lease ? `<p>Exclusive lease expires ${html(fmt(raffle.lease.expiresAt))}.</p>` : '')) +
    block('Verified territory settlements',list(records,recordView,'Confirmed outcomes will appear here.')) +
    block('Entry transactions',list(recent,item => '<h3>'+html(eventNames[item.activity] ?? title(item.activity))+'</h3>'+profile(item),'No confirmed entries for this site.')) +
    block('Complete territory history',list((territory.history ?? []).slice().reverse(),item =>
      `<h3>${html(title(item.kind))}</h3><p>${html(item.playerId ?? '—')} · ${html(fmt(item.at))} ${item.txid ? ' · '+tx(item.txid) : ''}</p>`,
    'No history has been recorded for this territory.')) +
    block('CashTokens',`<p>The game tracks territory control and lease expiry. The token records the event and can be transferred between compatible wallets.</p>
      ${authority?.genesisTxid ? '<p>' + tx(authority.genesisTxid,'Territory authority genesis') + '</p>' : ''}` +
      list(territory.assets,assetView,'No asset has been issued for this site.'));
}

root.addEventListener('click',async event => {
  const button = event.target.closest('[data-asset]');
  if (!button) return;
  const output = button.parentElement.querySelector('[data-live-proof]');
  output.hidden = false;
  output.textContent = 'Checking ' + NETWORK_LABEL + '…';
  button.disabled = true;
  try {
    const response = await fetch('/api/public/territory-assets/'+encodeURIComponent(button.dataset.asset),{cache:'no-store'});
    const asset = await response.json();
    if (!response.ok) throw new Error(asset.error ?? '' + NETWORK_LABEL + ' verification unavailable.');
    const proof = asset.proof;
    output.innerHTML = `<p>${html(title(proof.status))}</p>${proof.current ?
      `<p class="citadel-meta citadel-mono">${html(proof.current.address ?? 'Contract controlled')}<br>
      ${tx(proof.current.txid)}:${number(proof.current.vout)}</p>` : ''}` +
      list(proof.history, item => tx(item.txid,title(item.type)+' · output '+number(item.vout)), 'The observer has no confirmed transfer history.');
  } catch(error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});
void show().catch(error => { root.textContent=error.message; });
