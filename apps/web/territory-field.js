import { icon } from './icons.js';
import { gameSelect } from './game-select.js';
import { btn, command, costs, duration, empty, faction, formatDate, html, labelOf, list, number, pay, shortId, tag, title } from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const categories = {
  starter:{label:'Starter territory',glyph:'city',art:'hall-2'},
  unclaimed:{label:'Unclaimed territory',glyph:'flag',art:'terrain'},
  resource:{label:'Resource territory',glyph:'iron',art:'market-2'},
  strategic:{label:'Strategic territory',glyph:'shield',art:'walls-2'},
  rare:{label:'Rare territory',glyph:'crystal',art:'event-season'},
};
const name = (ctx,id) => ctx.cities.find(city => city.id === id)?.name ?? id ?? 'Neutral';
const time = (until, now) => Number.isFinite(until) ? `<time data-until="${until}">${duration(until-now)}</time>` : '—';
const sats = value => number(value)+' sats';
const explorer = txid => /^[0-9a-f]{64}$/i.test(txid ?? '') ? `<a class="territory-proof-link" target="_blank" rel="noopener" href="${NETWORK.explorer}${txid}" title="${txid}">${shortId(txid)}</a>` : '';
const proofUrl = id => '/verify/territory/'+encodeURIComponent(id);
const section = (heading,body) => `<section class="well territory-section"><h3>${heading}</h3>${body}</section>`;
const lines = rows => rows.length ? `<ul class="territory-list">${rows.map(row => `<li>${row}</li>`).join('')}</ul>` : empty('No records yet.');
const optionList = definition => Object.entries(definition ?? {}).map(([key,value]) => [key,labelOf(value,key)]);
const submit = (label,glyph,kind='primary') => `<button class="btn ${kind}" type="submit">${icon(glyph)}${label}</button>`;
const hidden = (key,value) => `<input type="hidden" name="${key}" value="${html(value)}">`;
const form = (mode,content,button) => `<form class="stack territory-form" data-form="${mode}">${content}<p class="form-error" aria-live="polite"></p>${button}</form>`;
const territoryArt = {mine:'farm-2',watchtower:'scout-2','trade-post':'market-2',fortress:'walls-3',capital:'castle-gold'};
function art(site) {
  const picture = site.frontierCamp ? 'scout-2' : territoryArt[site.type] ?? categories[site.category].art;
  return `/art/${picture}.webp`;
}

function production(site) {
  return Object.entries(site.stats?.productionPerHour??{}).filter(([,amount]) => amount>0).map(([resource,amount]) =>
    `<span>${icon(resource)} +${number(amount)} ${html(title(resource))}/h</span>`).join('');
}

export function territoryMarker(site,cities,own,now) {
  const type = categories[site.category];
  if (!type) return '';
  const controller = cities.find(city => city.id === site.controller);
  const glyph = ({mine:'iron',watchtower:'spy','trade-post':'market',fortress:'shield',ruins:'book',capital:'crown',forest:'wood',quarry:'stone',farm:'food'})[site.type] ?? type.glyph;
  const contest = ['open','locked'].includes(site.claim?.status);
  const state = site.lease ? 'leased' : contest ? 'contested' : controller ? 'controlled' : 'open';
  const recent = site.history?.length && now - (site.lease?.startsAt ?? site.lastChanged) < 8000;
  return `<button class="landmark territory-marker territory-${site.category} ${state} faction ${faction(controller)}${controller?.id===own.id ? ' owned' : ''}${recent && !site.protected ? ' territory-transition' : ''}" style="left:${site.x*100}%;top:${site.y*100}%" data-modal="node" data-id="${html(site.id)}" aria-label="${html(site.name)}" data-tooltip="${html(site.name)} · ${site.frontierCamp?'Frontier camp':type.label}" type="button"><i></i>${icon(glyph)}</button>`;
}

function atlasRows(ctx, sites) {
  return sites.map(site=>{
    const ruler = ctx.cities.find(city=>city.id===site.controller);
    const incumbent = ruler ? ruler.name+(ruler.npc?' · NPC':'') : null;
    const standing = `${incumbent ?? (site.category==='rare'?'' + NETWORK_LABEL + ' draw':'Neutral')} · ${title(site.terrain)}`;
    return `<div class="territory-row territory-${site.category}">
      <img src="${art(site)}" alt="" loading="lazy"><div><strong>${html(site.name)}</strong><p>${html(standing)}</p><div class="territory-yield">${production(site)}</div></div>
      ${btn('Inspect','pin',{modal:'node',id:site.id},'primary')}</div>`;
  }).join('');
}

export function territoryAtlas(ctx) {
  const rules = ctx.ui.state.territoryRules;
  const sites = list(ctx.ui.state.territories);
  const camps = sites.filter(site=>site.frontierCamp).toSorted((left,right)=>
    Number(Boolean(right.frontierEligibility?.ok))-Number(Boolean(left.frontierEligibility?.ok)) ||
    (left.stats?.supply?.distance ?? Infinity)-(right.stats?.supply?.distance ?? Infinity));
  return `<div class="territory-atlas">${section('Territory atlas',`<p>Settlements under your control <strong>${rules?.holdings?.length ?? 0} / ${rules?.capacity ?? 0}</strong></p><a class="territory-proof-link" href="/explorer">Public ${NETWORK_LABEL} ledger</a>`)}
    ${camps.length?section('Frontier camps','<p>Occupy a reachable NPC camp with earned supplies and hold it for up to two days.</p>'+atlasRows(ctx,camps)):''}
    ${Object.entries(categories).map(([id,category]) => section(category.label + (id==='starter' ? ' · protected' : ''),
      atlasRows(ctx,sites.filter(site=>!site.frontierCamp && site.category===id && (id!=='starter' || site.owner===ctx.own.id))) || empty('No sites in this category.'))).join('')}</div>`;
}

function checkout(ctx,eligibility,territoryId) {
  if (eligibility && !eligibility.ok) return `<p class="territory-rule">${html(eligibility.reason ?? 'This city is ineligible.')}</p>`+
    (eligibility.code !== 'territory_enrollment' ? '' : !ctx.own.tutorial ? btn('Play tutorial','quest',{modal:'tutorial'},'primary') :
      !ctx.own.optIn ? btn('Join seasonal PvP','war',{modal:'enroll'},'primary') : `Protection remaining ${time(ctx.own.shieldUntil,ctx.gameNow)}`);
  if (!ctx.ui.state.chain?.payouts || ctx.ui.state.vault?.quarantined) return '<p class="territory-rule">' + NETWORK_LABEL + ' checkout is awaiting the escrow operator.</p>';
  if (!ctx.ui.state.wallet?.address) return '<p>Connect your wallet first. A paid campaign is paid from your ' + NETWORK_LABEL + ' wallet.</p>'+
    btn('Connect wallet','bch',{modal:'wallet','return-territory':territoryId},'primary');
  return '';
}

function claimOrders(ctx,site) {
  const claim = ['open','locked'].includes(site.claim?.status) ? site.claim : null;
  const rules = ctx.ui.state.territoryRules;
  const block = checkout(ctx,site.claimEligibility,site.id);
  const entered = claim?.entries?.some(entry => entry.player === ctx.own.id);
  const military = site.owner || site.protected ? '' : entered ? `<p>${tag('Your entry is in this contest','success')}</p>` :
    block || pay(claim ? 'Enter contest · '+sats(rules.claimFee) : 'Open claim · '+sats(rules.claimFee),'flag',{type:'territory-claim',territory:site.id},'primary');
  return section('Public claim',`<p>${claim ? 'Contest ends in '+time(claim.endsAt,ctx.gameNow)+' · Army lock '+time(claim.lockAt,ctx.gameNow) : 'The first confirmed payment opens a public 60-minute contest.'}</p>
    ${claim ? lines(claim.entries.map(entry => `<strong>${html(name(ctx,entry.player))}</strong><span>${sats(entry.escrowSatoshis)} escrow ${explorer(entry.txid)}</span>`)) : ''}
    <p>Equal entry rules. Armies lock two minutes before close. An uncontested site goes to its sole eligible entrant.</p>${military}`);
}

function armyOrders(ctx) {
  const {config} = ctx.ui.state;
  const roster=ctx.own.stats?.commands?.roster;
  const commanders=optionList(config.heroes).filter(([id])=>!roster||['permanent','rented'].includes(roster[id]?.ownership));
  const active=commanders.some(([id])=>id===ctx.own.hero)?ctx.own.hero:commanders[0]?.[0];
  return gameSelect('Commander','hero',commanders,active)+
    gameSelect('Formation','formation',optionList(config.formations),ctx.own.formation)+gameSelect('Tactic','tactic',optionList(config.tactics),ctx.own.tactic);
}

function conquestOrders(ctx,site) {
  const block = checkout(ctx,site.attackEligibility,site.id);
  return section('Conquest',block || `<p>A successful siege transfers control. A failed attack forfeits half of its stake to the defender. A territory attack never touches a War Chest: the War Chest is exposed to matched paid raids only.</p>`+
    form('territory-attack',hidden('territory',site.id)+armyOrders(ctx),
      submit('Launch conquest · '+sats(ctx.ui.state.territoryRules.attackFee),'sword','attack')));
}

function campOrders(ctx,site) {
  if (site.frontierOccupationUntil>ctx.gameNow) {
    const owner = name(ctx,site.owner);
    return section('Camp occupation',`<p>${html(owner)} occupies this camp for ${time(site.frontierOccupationUntil,ctx.gameNow)}. The surviving garrison returns home when the occupation ends.</p>`);
  }
  const plan = site.frontierEligibility;
  const term = plan?.occupationMs ? duration(plan.occupationMs) : 'two days';
  return section('Frontier expedition',`<p>Defeat the NPC garrison to occupy this camp for ${term}. This uses one of your city’s expedition slots. Up to six surviving soldiers garrison the camp.</p>`+
    (plan?.ok ? costs(plan.cost)+form('frontier-conquest',hidden('territory',site.id)+hidden('expectedOwner',site.owner)+armyOrders(ctx),
      submit('Lead camp expedition','sword','attack')) : `<p class="territory-rule">${html(plan?.reason ?? 'This camp is unavailable.')}</p>`));
}

function defenseOrders(ctx,site) {
  const own = site.owner===ctx.own.id;
  if (!own && !site.canReinforce) return '';
  const config = ctx.ui.state.config;
  const level = site.defenses.level;
  const next=site.stats?.fortification;
  const choices = optionList(config.units).filter(([unit]) => ctx.own.troops?.[unit]>0 || site.defenses.garrison?.[unit]>0);
  const actions = own ? [['send','Deploy from city'],['recall','Recall to city']] : [['send','Send allied aid']];
  const reinforce = choices.length ? form(own?'territory-garrison':'territory-aid',hidden('territory',site.id)+
    gameSelect('Order','direction',actions)+gameSelect('Unit','unit',choices)+
    '<label>Troops<input name="count" type="number" min="1" max="32" value="1" step="1" required></label>',submit(own?'Issue garrison order':'Reinforce garrison','shield')) : '';
  const fortification = own ? `<p>Fortification ${number(level)} / ${number(ctx.ui.state.territoryRules.maxSiteLevel)} · Upkeep ${time(site.nextUpkeep,ctx.gameNow)}</p>
    ${next?.next ? `<p>Defense pressure reduced by ${number(Math.abs(site.stats.localDefensePercent))}% → ${number(Math.abs(next.nextDefensePercent))}%</p>`+costs(next.nextCost)+command('Fortify','hammer',{type:'territory-fortify',territory:site.id}) : ''}
    <details><summary>Abandon territory</summary><p>Surviving troops return to your city. ${site.category==='strategic' || site.frontierCamp ? 'The local NPC garrison takes control.' : 'The site reopens after recovery.'}</p>${command('Confirm abandonment','flag',{type:'territory-abandon',territory:site.id},'attack')}</details>` : '';
  return section(own?'Manage defenses':'Allied reinforcements',reinforce+fortification);
}

function raffleOrders(ctx,site) {
  const raffle = site.raffle;
  if (!raffle) return '';
  const round=raffle.round;
  const cutoff = round && raffle.height!=null ? Math.max(0,round.closeHeight-raffle.height) : null;
  const blocked = raffle.lease || !raffle.open || round?.entries?.some(entry => entry.player===ctx.own.id);
  const owner = raffle.lease ? `<p><strong>${html(name(ctx,raffle.lease.playerId))}</strong> holds the extraction lease · ${time(raffle.lease.expiresAt,ctx.gameNow)} remaining.</p>` : '';
  const phase = round ? `<p>${NETWORK_LABEL} height ${number(raffle.height)} · Entry closes at ${number(round.closeHeight)}${raffle.open ? ' ('+number(cutoff)+' blocks)' : ''} · Draw block ${number(round.drawHeight)}</p>` : '<p>Waiting for confirmed ' + NETWORK_LABEL + ' block data.</p>';
  return section('Rare site raffle',owner+phase+`<p>${sats(raffle.fee)} on ${NETWORK_LABEL} · ${number(raffle.leaseHours)} hours of exclusive extraction · Valid entry escrow is returned after settlement.</p>`+
    (round ? lines(list(round.entries).map(entry => `<strong>${html(name(ctx,entry.player))}</strong><span>${explorer(entry.txid)}</span>`)) : '')+
    (!blocked ? checkout(ctx,null,site.id) || pay('Enter raffle · '+sats(raffle.fee),'crystal',{type:'territory-raffle',territory:site.id},'primary') : '<p class="territory-rule">'+(raffle.lease?'The next raffle opens after this lease.':raffle.open?'Your entry is confirmed.':'Entries are currently closed.')+'</p>')+
    (raffle.history?.length ? `<h4>Previous draws</h4>${lines(raffle.history.map(item => `<strong>${html(item.winner ? name(ctx,item.winner) : 'Escrow returned')}</strong><span>${html(formatDate(item.at))} · <a href="${proofUrl(site.id)}">Draw proof</a></span>`))}` : ''));
}

export function territoryAssets(sites,ctx) {
  const player=ctx.own.id;
  const places=list(sites);
  const records=places.flatMap(site => list(site.assets).filter(asset => places.length===1 || asset.controllerId===player).map(asset => ({asset,site})));
  return section('Territory CashTokens',records.length ? lines(records.map(({asset,site}) => `<strong>${html(title(asset.kind))} · ${html(site.name)}</strong><span>${tag(title(asset.state),asset.state==='confirmed'?'success':'quiet')} ${explorer(asset.txid)} <a href="${proofUrl(site.id)}">Category and UTXO proof</a></span>${asset.commitment ? `<code title="NFT commitment">${html(shortId(asset.commitment))}</code>` : ''}`)) : empty('No territory collectibles have been issued here.'));
}

export function territoryDetail(ctx,site) {
  const selected=categories[site.category];
  const yields=production(site);
  const proof=proofUrl(site.id);
  const alliance=list(ctx.ui.state.alliances).find(item=>item.id===site.controlAlliance);
  const ruler=ctx.cities.find(city=>city.id===site.controller);
  return `<div class="territory-detail territory-${site.category}"><header class="territory-landscape" style="--territory-art:url('${art(site)}')">
      <div>${icon(selected.glyph)} ${html(site.frontierCamp?'Frontier camp':selected.label)} · ${html(title(site.terrain))}</div><strong>${html(site.controller ? name(ctx,site.controller) : 'Neutral control')}${ruler?.npc?' · NPC':''}</strong>
      <small>${alliance ? html(alliance.name)+' · ' : ''}Level ${number(site.level)} · ${site.defenses.count==null?'Garrison unknown':number(site.defenses.count)+' garrisoned'} · ${Math.round(site.x*100)}, ${Math.round(site.y*100)}</small></header>
    ${yields ? `<div class="territory-yield territory-production${site.controller===ctx.own.id?' producing':''}"><strong>${site.controller===ctx.own.id?'Current yield':'Potential yield'}</strong>${yields}</div>` : ''}
    ${site.stats?.supply?.distance==null?'':`<p class="strategy-note">Supply distance: ${number(Math.round(site.stats.supply.distance*100))} / ${number(Math.round(site.stats.supply.range*100))} map units · terrain reduces attack pressure by ${number(Math.abs(site.stats.terrainDefensePercent))}%.</p>`}
    ${site.cooldownUntil>ctx.gameNow ? `<p class="territory-rule">Territory protection · ${time(site.cooldownUntil,ctx.gameNow)}</p>` : ''}
    ${site.protected ? section('Permanent homeland','<p>Starter territory remains protected from conquest.</p>') : site.frontierCamp ? campOrders(ctx,site)+defenseOrders(ctx,site) : site.category==='rare' ? raffleOrders(ctx,site) :
      (!site.owner ? claimOrders(ctx,site) : site.owner!==ctx.own.id ? conquestOrders(ctx,site) : '')+defenseOrders(ctx,site)}
    ${section('Territory history',lines(list(site.history).slice().reverse().map(item => `<strong>${html(title(item.kind))}${item.playerId ? ' · '+html(name(ctx,item.playerId)) : ''}</strong><span>${html(formatDate(item.at))} ${explorer(item.txid)}</span>`)))}
    ${section(site.frontierCamp?'Ownership record':'Battle and economic records',`<a class="btn game-link" href="${proof}">${icon('journal')}${site.frontierCamp?'View ownership record':'Verify territory activity'}</a>`+
      (site.blockchain?.length ? lines(site.blockchain.slice().reverse().map(item => `<strong>${html(title(item.kind))}</strong><span>${explorer(item.txid) || 'Awaiting anchor'}</span>`)) : ''))}
    ${site.assets?.length ? territoryAssets([site],ctx) : ''}</div>`;
}
