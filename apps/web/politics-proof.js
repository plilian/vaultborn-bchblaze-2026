import { formatDate, html, list, number, title } from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const root=document.getElementById('political-proof');
const txidPattern=/^[0-9a-f]{64}$/i;
const tx=(value,label=value)=>txidPattern.test(value ?? '') ?
  `<a target="_blank" rel="noopener" href="${NETWORK.explorer}${value}">${html(label)}</a>` : '—';
const time=value=>value ? html(formatDate(value)) : '—';
const block=(label,content)=>`<section class="citadel-block"><h2>${html(label)}</h2>${content}</section>`;
const rows=(items,render,empty)=>items?.length ? `<ul class="citadel-list">${items.map(item=>`<li>${render(item)}</li>`).join('')}</ul>` : `<p>${html(empty)}</p>`;
const data=value=>`<pre class="citadel-mono" style="white-space:pre-wrap;overflow-wrap:anywhere">${html(JSON.stringify(value,null,2))}</pre>`;
const profile=(receipt,label)=>receipt?.txid ? `<p class="citadel-meta">${html(label)} · ${tx(receipt.txid)}${receipt.height ? ' · block '+number(receipt.height) : ''}</p>` : '';

function entry({record,recordHash,anchored,payment,opening,chainReview}) {
  return `<article id="${html(record.id)}"><h3>${html(title(record.kind))}</h3>
    <p class="citadel-meta">${html(record.treaty ?? record.conflict ?? record.id)} · ${time(record.at)}</p>
    ${record.principal ? `<p>${number(record.principal)} sats · ${html(record.payer)} → ${html(record.payee)}</p>` : ''}
    ${chainReview ? '<p class="citadel-meta">' + NETWORK_LABEL + ' reorganized. These historical receipts need review.</p>' : ''}
    ${profile(record.funding??payment,chainReview?'Recorded funding':'Confirmed funding')}${profile(record.settlement??anchored,chainReview?'Recorded settlement':'Confirmed settlement')}
    <details><summary>Commitment and verification data</summary><p class="citadel-meta citadel-mono">Record hash ${html(recordHash)}</p>
    ${data({...record,...(opening && {opening})})}</details></article>`;
}

function treaty(record) {
  return `<h3>${html(title(record.kind))}</h3><p class="citadel-meta">${html((record.participants ?? [record.from,record.to]).filter(Boolean).join(' ↔ '))} · ${html(title(record.status))} · Revision ${number(record.version ?? 1)}</p>
    ${record.expiresAt ? `<p>Term ends ${time(record.expiresAt)}</p>` : ''}<details><summary>Ratified terms</summary>${data(record.terms ?? {})}</details>`;
}

function conflict(item) {
  return `<h3>${html(title(item.kind))}</h3><p class="citadel-meta">${html(title(item.status))} · ${time(item.resolvedAt ?? item.at ?? item.startedAt)}</p>
    <details><summary>Public conflict record</summary>${data(item)}</details>`;
}

function asset(item) {
  return `<article id="charter-${html(item.id)}" class="territory-proof-row"><div><h3>Treaty charter</h3>
  <p class="citadel-meta">${html(item.territoryId)} · Revision ${number(item.version ?? 1)} · ${html(title(item.state))}${item.txid ? ' · '+tx(item.txid,'Issuance transaction') : ''}</p>
  <p class="citadel-mono">Category ${html(item.category)}<br>Commitment ${html(item.commitment ?? 'Pending')}</p></div>
  <button type="button" class="btn" data-political-asset="${html(item.id)}">Verify current output</button>
  <div hidden data-live-proof class="territory-proof-utxo"></div></article>`;
}

async function load() {
  const response=await fetch('/api/public/politics',{cache:'no-store'});
  if (!response.ok) throw new Error('The Political Archive is unavailable.');
  const {records,treaties,government,authority,assets}=await response.json();
  root.innerHTML=`<section class="citadel-hero" style="--hero:url('/art/event-protectorate.webp')"><span class="citadel-label">Public records · ${NETWORK_LABEL}</span>
    <h1>Political Archive</h1><p>Ratified treaties, concluded conflicts and verified settlements.</p><a class="btn" href="?format=json">Download public record (JSON)</a></section>`+
    block('Treaty and funding records',rows(records,entry,'No confirmed political payments have been recorded.'))+
    block('Public treaties',rows(treaties,treaty,'No treaties are public yet.'))+
    block('Conflict history',rows(list(government?.conflicts),conflict,'No public conflicts have been recorded.'))+
    block('CashTokens charters',(authority?.genesisTxid ? `<p>${tx(authority.genesisTxid,'Political charter category genesis')}</p>` : '')+
      rows(assets,asset,'No treaty charters have been issued here.'));
  const wanted=new URLSearchParams(location.search).get('txid')?.toLowerCase();
  const matched=txidPattern.test(wanted ?? '') && records.find(({record,anchored,payment}) =>
    [record.funding?.txid,record.settlement?.txid,anchored?.txid,payment?.txid].includes(wanted));
  const focus=document.getElementById(location.hash.slice(1) || (matched ? matched.record.id : ''));
  if (focus) {
    const details=focus.querySelector('details');
    if (details) details.open=true;
    focus.scrollIntoView({block:'start'});
  }
}

root.addEventListener('click',async event=>{
  const button=event.target.closest('[data-political-asset]');
  if (!button) return;
  const pane=button.parentElement.querySelector('[data-live-proof]');
  pane.hidden=false;
  pane.textContent='Checking ' + NETWORK_LABEL + '…';
  button.disabled=true;
  try {
    const result=await fetch('/api/public/political-assets/'+encodeURIComponent(button.dataset.politicalAsset),{cache:'no-store'});
    const remote=await result.json();
    if (!result.ok) throw new Error(remote.error);
    const {proof}=remote;
    pane.innerHTML=`<p>${html(title(proof.status))}</p>${proof.current ? `<p>${tx(proof.current.txid)}:${number(proof.current.vout)} · ${html(proof.current.address)}</p>` : ''}`+
      rows(proof.history,item=>profile(item,title(item.type)),'No confirmed transfer history.');
  } catch(error) { pane.textContent=error.message; }
  finally { button.disabled=false; }
});
void load().catch(error=>{root.textContent=error.message;});
