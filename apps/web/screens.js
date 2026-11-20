import { icon } from './icons.js';
import { art, bch, btn, command, confirmationText, costs, crest, duration, empty, formatDate, html, labelOf, list, number, paidButton, pay, paymentsInFlight, resources, tag, tabbar, title, values } from './view.js';
import { gameSelect as dropdown } from './game-select.js';
import { walletAddress, walletLabel, wizardState } from './ritual-wallet.js';
import { territoryAtlas, territoryAssets, territoryDetail } from './territory-field.js';
import { comparison, raidStandards, squadDetail, timeLabel } from './strategy-stats.js';
import { achievementDialog, dailyContents, eventDispatch, eventHero, offlineContents, tradeBalances, tradeHistory } from './campaign-ledger.js';
import { whatNext, whatNextContents } from './what-next.js';
import { bchActionsContents } from './bch-actions.js';
import { renderIdentity } from './decentralized-identity.js';
import { guideLink, renderCodex } from './game-guide.js';
import { battleReport } from './battle-report.js';

import { politicalFormAnswer, renderPoliticalDialog, renderPolitics } from './political-assembly.js';
import { NETWORK, NETWORK_LABEL } from './network.js';

const cityTabs = [['build','Construction'],['army','Army'],['heroes','Commanders'],['defense','Defense'],['research','Research'],['market','Marketplace'],['inventory','Inventory']];
const warTabs = [['operations','Operations'],['expeditions','Expeditions'],['intelligence','Intelligence'],['politics','Protectorates'],['territory','Territories']];
const allianceTabs = [['roster','Roster'],['diplomacy','Diplomacy'],['rallies','War council'],['chat','Chat']];
const heroGlyphs = {warden:'shield',engineer:'hammer',keeper:'vault',commander:'war',ranger:'spy',queen:'horn',merchant:'coins',scholar:'book'};
const statusLabel = { awaiting_signature:'Awaiting wallet payment', seen_in_mempool:'Seen in mempool', credited:'Confirmed · recorded', submitted:'Submitted', confirmed:'Confirmed', reorg:'Chain reorganization', uncertain:'Awaiting chain observation' };
const cssStatus = state => ['credited','confirmed','success','active'].includes(state) ? 'success' : ['rejected','reorg','failed','detected'].includes(state) ? 'danger' : 'quiet';
const image = (src, className, alt = '') => `<img class="${className}" src="${src}" alt="${html(alt)}">`;
const eventArt = (id) => image('/art/event-' + id + '.webp', 'event-art');
const heading = (titleText, symbol, eyebrow, action = '') => `
  <header class="page-heading">${icon(symbol)}<div><span class="kicker">${html(eyebrow)}</span><h1>${html(titleText)}</h1></div>${action}</header>`;
const well = (label, content) => `<div class="well"><h3>${html(label)}</h3>${content}</div>`;
const row = (heading, detail = '', action = '') => `<div class="row"><div><strong>${html(heading)}</strong>${detail ? '<p>' + html(detail) + '</p>' : ''}</div>${action ? '<div class="buttons">' + action + '</div>' : ''}</div>`;
const field = (label, name, markup, hint = '') => `<label>${html(label)}${markup}${hint ? '<small class="hint">' + html(hint) + '</small>' : ''}</label>`;
const hidden = (name,value) => `<input type="hidden" name="${name}" value="${html(value)}">`;
const input = (label,name,value = '',type = 'text', attrs = '') => field(label,name,`<input name="${name}" type="${type}" value="${html(value)}" ${attrs} required>`);
const submit = (label, glyph, className = '', attrs = '') => `<button class="btn ${className}" type="submit" ${attrs}>${icon(glyph)}${html(label)}</button>`;
const gameLink = (label, url, glyph) => `<a class="btn game-link" href="${html(url)}">${icon(glyph)}${html(label)}</a>`;
const form = (id, contents, action) => `<form class="stack" data-form="${id}">${contents}<p class="form-error" aria-live="polite"></p><div class="buttons">${action}</div></form>`;
const timer = (when, now) => `<time data-until="${html(when)}">${duration(when - now)}</time>`;
const cityName = (ctx,id) => ctx.cities.find(item => item.id === id)?.name ?? id;
const allianceName = (ctx,id) => list(ctx.ui.state.alliances).find(item => item.id === id)?.name ?? id;
const cityOptions = (ctx, predicate = () => true) => ctx.cities.filter(item => item.id !== ctx.own.id && predicate(item)).map(item => [item.id,item.name]);
const configs = (object) => Object.entries(object ?? {}).map(([id,def]) => [id,labelOf(def,id)]);
const convertCosts = (cost) => Array.isArray(cost) ? Object.fromEntries(cost.map((value,i) => [resources[i],value])) : cost;
const hasCost = (own, cost) => Object.entries(cost ?? {}).every(([id,qty]) => own.resources?.[id] >= qty);
const chainOpen = ctx => ctx.ui.state.chain?.enabled === true && !ctx.ui.state.vault?.quarantined;
const kingdomStats = ctx => ctx.ui.state.player.stats;
const guideButton = (own, legacyLabel = 'Start tutorial') => !own.onboarding && own.guideOpen
  ? btn(legacyLabel, 'quest', { modal: 'tutorial' })
  : btn(own.onboarding?.status === 'paused' ? 'Resume campaign guide' : 'Campaign guide', 'quest', { 'show-guide': 'true' });
const timerRows = (jobs, ctx) => jobs.length ? jobs.map(job => {
  const { units, buildings, tech } = ctx.ui.state.config;
  const label = labelOf(units[job.key] ?? buildings[job.key] ?? tech[job.key],job.key);
  const description = job.count ? number(job.count) + ' recruits' : 'Level ' + number(job.level);
  const imageSrc=job.count?'unit-'+job.key:job.kind==='building'?job.key+'-'+Math.min(3,job.level):'library-2';
  const progress=Math.max(0,Math.min(100,(ctx.gameNow-job.startedAt)/Math.max(1,job.completesAt-job.startedAt)*100));
  return `<div class="row queue-entry"><img src="/art/${html(imageSrc)}.webp" alt=""><div><strong>${html(label)}</strong><p>${html(description)} · ${job.startedAt>ctx.gameNow?'Queued':'In progress'}</p>
    <progress max="100" value="${progress}" data-started="${job.startedAt}" data-ends="${job.completesAt}" aria-label="${html(label)} progress"></progress></div>${timer(job.completesAt,ctx.gameNow)}</div>`;
}).join('') : empty('Queue clear.');

function buildView(ctx) {
  const { own, ui } = ctx;
  const config = ui.state.config;
  const jobs = list(own.queue);
  const tiles = Object.entries(config.buildings).map(([id,def]) => {
    const current = own.buildings?.[id] ?? 1;
    const tier = Math.min(3,current);
    const active = jobs.find(job => job.key === id && job.kind === 'building');
    return `<button type="button" class="tile building-tile${active ? ' under-construction' : ''}" data-modal="building" data-id="${id}">
      ${image('/art/' + id + '-' + tier + '.webp','building-image')}<h3>${html(def.name)}</h3>
      <p>Level ${number(current)}${active ? ' · Building' : ''}</p>
    </button>`;
  }).join('');
  return `
    <section class="city-overview">
      ${image(art(own),'city-overview-art')}
      <div class="city-overview-info">
        <span class="kicker">Level ${number(ctx.level(own))} stronghold</span>
        <h2>${html(own.name)}</h2>
        <p>City stores replenish while you are away</p>
        <div class="buttons">
          ${btn('Daily supplies','gift',{modal:'daily'},'primary')}
          ${guideButton(own)}
        </div>
      </div>
    </section>
    <div class="split">
      ${well('Production / hour',costs(own.production))}
      ${well('Construction queue',timerRows(jobs.filter(job => job.kind === 'building'),ctx))}
    </div>
    <div class="tiles">${tiles}</div>`;
}

function armyView(ctx) {
  const {own,ui} = ctx;
  const config = ui.state.config;
  const stats=kingdomStats(ctx);
  const jobs = list(own.queue).filter(job => job.kind === 'troop');
  const rulers = `<div class="tile-controls">${btn('Formation & tactics','war',{modal:'formation'},'primary')}</div>`;
  return eventHero('barracks-3','Army muster','The garrison','Review your strength, field orders and training before you march.')+
    values('Garrison', [['Available troops',ctx.armyCount(own) + ' / ' + number(own.troopCapacity)],['Deployed',number(stats?.military.deployed)],
    ['Matchmaking power',number(stats?.military.matchmakingPower ?? own.power)],['Formation',labelOf(config.formations[own.formation],own.formation)]]) +
    rulers +
    (stats ? `<details class="strategy-details"><summary>How kingdom power is calculated</summary>${comparison({rosterPower:stats.military.rosterPower,
      fortificationPower:stats.military.fortificationPower,infrastructurePower:stats.military.infrastructurePower,queuedTroops:stats.military.queued,
      openingPressure:stats.military.openingPressure,foodUpkeepPerHour:stats.economy.foodUpkeepPerHour,moralePercent:stats.military.moralePercent},null,'Readiness breakdown')}
      <p>Matchmaking power sets comparable brackets. Formations, terrain, counters and commander traits decide the battle.</p></details>`:'')+
    `<div class="tiles">${Object.entries(config.units).map(([id,def]) => {
      const unit=stats?.units[id];
      const prereq=unit?.training?.prerequisite;
      const requirement=prereq&&!unit.training.unlocked ? labelOf(config.buildings[prereq.building],prereq.building)+' '+prereq.level : '';
      return `<article class="tile troop-tile">${image('/art/unit-' + id + '.webp','unit-image')}
        <h3>${html(def.name)}</h3><p>Attack ${def.attack} · Guard ${def.guard} · Life ${def.life}</p>
        ${tag(requirement ? 'Requires '+requirement : number(own.troops?.[id]) + ' available')}
        ${btn('Train','plus',{modal:'training',id},'primary')}</article>`;
    }).join('')}</div>` +
    well('Training queue',timerRows(jobs,ctx));
}
function heroesView(ctx) {
  const {own,ui} = ctx;
  const roster=kingdomStats(ctx)?.commands;
  return (roster?.unavailableUntil>ctx.gameNow ? `<p class="strategy-note">Your active commander is recovering · ${timeLabel(roster.unavailableUntil,ctx.gameNow)}</p>`:'')+
    `<div class="tiles heroes">${Object.entries(ui.state.config.heroes).map(([id,def]) => `
    <article class="tile hero-card ${own.hero === id ? 'chosen' : ''}">
      ${image('/art/hero-' + id + '.webp','hero-portrait',def.name)}
      <div class="hero-copy">
        ${tag(def.rarity,own.hero === id ? 'success' : 'quiet')}<h3>${html(def.name)}</h3>
        <p>${icon(heroGlyphs[id])} <strong>${html(def.ability)}</strong> · ${html(def.role)}</p>
        <p>${html(def.description)}</p>
        ${roster?.roster[id] ? `<p>${html(title(roster.roster[id].ownership))} · Mastery ${number(roster.roster[id].level)} · ${number(roster.roster[id].xp)} XP</p>${roster.roster[id].nextXp?
          `<progress class="commander-xp" max="${roster.roster[id].nextXp}" value="${roster.roster[id].xp}" aria-label="Mastery progress for ${html(def.name)}"></progress>`:''}`:''}
        <div class="buttons">${['permanent','rented'].includes(roster?.roster[id]?.ownership) ?
          command(own.hero===id?'Assigned':'Assign','flag',{type:'configure',hero:id},'primary',own.hero===id) :
          ['locked','expired'].includes(roster?.roster[id]?.ownership) ? btn('Hire or recruit','clock',{modal:'commander',id},'primary') : ''}
        ${btn('Review commander','flag',{modal:'commander',id})}</div>
      </div>
    </article>`).join('')}</div>`;
}

function commanderDialog(ctx,id) {
  const config=ctx.ui.state.config;
  const catalog=kingdomStats(ctx)?.commands;
  const profile=catalog?.roster[id];
  const desc=config.heroes[id];
  if (!profile || !desc) return modal('Commander roster',empty('This commander is unavailable.'));
  const decoded=profile.recruitment;
  const owned=profile.ownership==='permanent';
  const available=owned||profile.ownership==='rented';
  const installed=profile.equipment;
  const wait=profile.cooldownUntil>ctx.gameNow;
  const busyFitting=item=>Object.entries(catalog.roster).find(([hero,row])=>hero!==id&&row.equipment===item)?.[1].name;
  const contractRows=Object.entries(decoded.rentals).map(([days,cost])=>`<div class="strategy-order"><div><strong>${html(days)}-day contract</strong>${costs(cost)}</div>${command('Rent for '+days+(Number(days)===1?' day':' days'),'clock',
    {type:'commander-rent',hero:id,days:Number(days)},'primary',!decoded.rentalEligible || !hasCost(ctx.own,cost) ||
      Math.max(ctx.gameNow,profile.expiresAt??0)+Number(days)*86_400_000>ctx.gameNow+7*86_400_000)}</div>`).join('');
  return modal(desc.name,`<div class="commander-heading">${image('/art/hero-'+id+'.webp','commander-portrait',desc.name)}<div>
    <span class="kicker">${html(profile.rarity)} · ${html(profile.role)}</span><h3>${html(profile.ability)}</h3><p>${html(desc.description)}</p>
    <p>${html(title(profile.ownership))}${profile.expiresAt?` · Expires in ${timeLabel(profile.expiresAt,ctx.gameNow)}`:''}</p>
    <p>Mastery ${number(profile.level)} / ${number(profile.maxLevel)} · ${number(profile.xp)}${profile.nextXp?' / '+number(profile.nextXp):''} XP</p>
    ${available?command(catalog.selected===id?'Assigned commander':'Assign commander','flag',{type:'configure',hero:id},'primary',catalog.selected===id):''}</div></div>
    ${comparison(profile.effects,owned?profile.nextEffects:null,'Active traits','Next mastery')}
    <details class="strategy-details"><summary>Base traits before gear and mastery</summary>${comparison(profile.baseEffects,null,'Base traits')}</details>
    ${owned&&profile.nextEffects?`<div class="strategy-order"><div><strong>Mastery advancement</strong><p>Earn mastery by using this commander. Permanently recruited commanders can advance.</p>${costs(profile.upgradeCost)}</div>
      ${command('Advance mastery','upgrade',{type:'commander-upgrade',hero:id},'primary',!profile.upgradeEligible||!hasCost(ctx.own,profile.upgradeCost))}</div>`:''}
    ${!owned?`<section class="strategy-ledger"><h3>Recruitment</h3><div class="strategy-order"><div><strong>Permanent recruitment</strong>
      <p>Requires the tutorial and ${html(decoded.prerequisite.label)} ${number(decoded.prerequisite.level)}.</p>${costs(decoded.cost)}</div>
      ${command('Recruit permanently','flag',{type:'commander-recruit',hero:id},'primary',!decoded.eligible||!hasCost(ctx.own,decoded.cost))}</div>
      ${decoded.rentAfter>ctx.gameNow?`<p>Renewal available in ${timeLabel(decoded.rentAfter,ctx.gameNow)}.</p>`:''}${contractRows}</section>`:''}
    ${owned?`<section class="strategy-ledger"><h3>Equipment fittings</h3>${wait?`<p>Next attunement in ${timeLabel(profile.cooldownUntil,ctx.gameNow)}.</p>`:''}
    ${Object.entries(catalog.equipment).map(([item,gear])=>{const assigned=busyFitting(item);return `<div class="strategy-order"><div><strong>${html(gear.name)}</strong><p>${html(gear.description)} ${assigned?'Assigned to '+html(assigned)+'.':''}</p>
      ${gear.owned?'':`<p>Requires ${html(labelOf(config.buildings[gear.building],gear.building))} ${number(gear.level)}.</p>${costs(gear.cost)}`}</div>
      ${gear.owned?command(installed===item?'Remove fitting':'Equip fitting','shield',{type:'commander-equip',hero:id,equipment:installed===item?null:item},'primary',wait||Boolean(assigned)):
        command('Forge fitting','hammer',{type:'commander-forge',equipment:item},'primary',!gear.eligible||!hasCost(ctx.own,gear.cost))}</div>`;}).join('')}</section>`:''}`);
}
function defenseView(ctx) {
  const own = ctx.own;
  const cooldown = own.counterspyCooldown > ctx.gameNow;
  return `<div class="split">
    ${well('Wall Fortress',`<p>Fortifications improve defender protection during raids.</p><div class="buttons">${btn('Inspect walls','shield',{modal:'building',id:'walls'},'primary')}</div>`)}
    ${well('Watchtower',`<p>${own.counterspyUntil > ctx.gameNow ? 'Counterintelligence active for ' + duration(own.counterspyUntil - ctx.gameNow) : 'Establish a four-hour counterintelligence watch.'}</p>
      ${costs({wood:26,stone:24,food:48,crystal:6})}<div class="buttons">${command(cooldown ? 'Counterspy recovering' : 'Activate counterspy','spy',{type:'counterspy'},'intel',cooldown)}${btn('Deploy decoys','flag',{modal:'decoy'},'intel')}</div>`)}
    </div>
    ${values('Protection', [['Diplomatic immunity',own.immunityUntil > ctx.gameNow ? duration(own.immunityUntil-ctx.gameNow) : 'Inactive'],['Defense',number(ctx.towerDefense(own))]])}`;
}
function researchView(ctx) {
  const own = ctx.own;
  const jobs = list(own.queue).filter(job => job.kind === 'research');
  const research=kingdomStats(ctx)?.research??{};
  return eventHero('library-3','Library of the frontier','Research & doctrine','Develop logistics, defenses, battlefield doctrine and the signal network.')+
    well('Research queue',timerRows(jobs,ctx)) + `<div class="tiles">${Object.entries(ctx.ui.state.config.tech).map(([id,def]) => {
    const quote=research[id];
    if (!quote) return '';
    const benefit=value=>number(value)+(quote.unit==='%'?'%':' '+quote.unit);
    const glyph=({logistics:'chest',fortification:'shield',tactics:'war',signals:'spy'})[id]??'flask';
    return `<article class="tile research-decree"><span class="research-seal">${icon(glyph)}</span><h3>${html(def.name)}</h3><p>${html(def.description)}</p>
      ${tag(quote.next==null ? 'Maximum tier' : 'Tier ' + quote.current + ' · Next tier requires Library ' + quote.requiresLibrary)}
      <p>Current: ${html(benefit(quote.value))}${quote.next==null?'': ' → Next: '+html(benefit(quote.nextValue))+' · '+html(duration(quote.duration))}</p>
      ${quote.next==null?'': costs(quote.cost)+command('Research','book',{type:'research',tech:id},'primary',jobs.length>0||!quote.eligible||!hasCost(own,quote.cost))}</article>`;
  }).join('')}</div>`;
}
function marketView(ctx) {
  const names = resources.map(id => [id,title(id)]);
  const selection=ctx.ui.marketFields??{};
  return `<div class="market-forge">${eventHero('market-3','Guild exchange','The marketplace','Exchange earned supplies at the current guild rate. No BCH is used.')}
    ${form('trade',`<div class="market-selectors">${dropdown('Give','give',names,selection.give??'wood')+
      dropdown('Receive','take',names,selection.take??'stone')+input('Amount to exchange','amount',selection.amount??'50','number','min="10" max="500" step="1"')}</div>`+
      '<div data-market-quote aria-live="polite">Reading guild rates…</div><input type="hidden" name="quotedReceived">',submit('Exchange','market','primary','disabled'))}
    ${well('Your stores',tradeBalances(ctx.own))}${well('Recent exchanges',tradeHistory(ctx.own.marketHistory))}</div>`;
}
function inventoryView(ctx) {
  const battles = list(ctx.ui.state.battles);
  const earned = ctx.own.achievements ?? {};
  const achievements = [
    ['First banner','Complete your first campaign tutorial.',!ctx.own.guideOpen,'flag'],
    ['The builder','Complete a construction project.',earned['the-builder'] || list(ctx.own.history).some(job => job.kind === 'building'),'hammer'],
    ['Eyes in the mist','Return with successful intelligence.',earned['eyes-in-mist'] || list(ctx.ui.state.intelArchive).length > 0,'spy'],
    ['Frontier defender','Win a battle for your city.',earned['frontier-defender'] || battles.some(battle => battle[battle.winner] === ctx.own.id),'shield'],
    ['Landmark keeper','Control a landmark.',earned['landmark-keeper'] || list(ctx.ui.state.nodes).some(node => node.owner === ctx.own.id),'crown'],
  ];
  return `<div class="split">${well('Resource stores',costs(ctx.own.resources))}${well('City entitlements',Object.keys(ctx.own.perks ?? {}).length ?
    Object.entries(ctx.own.perks).map(([id]) => row(labelOf(ctx.ui.state.config.buildings[id],id),'' + NETWORK_LABEL + '-verified city entitlement')).join('') : empty('No premium entitlements recorded.'))}</div>
    ${Object.values(ctx.own.rushCredits ?? {}).some(qty => qty > 0) ? well('Saved rush passes',Object.entries(ctx.own.rushCredits).filter(([,qty]) => qty > 0).map(([id,qty]) => row(labelOf(ctx.ui.state.config.buildings[id],id),number(qty) + ' left, used by the next upgrade')).join('')) : ''}
    ${well('Achievements',`<p>${achievements.filter(([, ,unlocked])=>unlocked).length} of ${achievements.length} honors earned.</p><div class="honor-wall">${achievements.map(([name,description,earned,glyph])=>
      `<article class="honor ${earned?'earned':''}"><span class="honor-seal">${icon(glyph)}</span><div><strong>${html(name)}</strong><p>${html(description)}</p><small>${earned?'Earned':'Available'}</small></div></article>`).join('')}</div>`)}
    ${territoryAssets(ctx.ui.state.territories,ctx)}${well('On-chain assets',walletAssets(ctx))}`;
}
function cityPage(ctx) {
  const tab = ctx.ui.tabs.city ?? 'build';
  const body = ({build:buildView, army:armyView, heroes:heroesView, defense:defenseView, research:researchView, market:marketView, inventory:inventoryView})[tab](ctx);
  return heading(ctx.own.name,'city','My City',btn('World map','map',{page:'map'})) +
    `<div class="page-body">${tabbar(cityTabs,tab)}${body}</div>`;
}

function allianceRoster(ctx) {
  const {alliance, alliances} = ctx.ui.state;
  const who = ctx.own.id;
  const my = alliance ? values(alliance.name, [['Members',alliance.members.length],['Power',number(alliance.power)],['Contribution',number(alliance.score)]]) + well('Roster',
    alliance.members.map(member => row(member.name,member.city + ' · ' + title(member.role) + (member.npc ? ' · NPC' : ''))).join('') +
    `<div class="buttons">${btn('Transfer aid','relief',{modal:'aid'})}${alliance.leader === who ? btn('Invite city','plus',{modal:'invite'},'primary') : ''}${btn('Leave alliance','arrow',{modal:'leave'})}</div>`)
    : well('Create an alliance',form('alliance-create',input('Alliance name','name','','text','maxlength="30" minlength="2"') +
      dropdown('Membership','privacy',[['open','Open'],['invite','Invite only']],'open'),submit('Found alliance','flag','primary')));
  return `<div class="split"><div>${my}</div>${well('Alliance directory',list(alliances).map(team => row(team.name,team.members.length + ' members · ' + title(team.privacy),
    team.id !== alliance?.id && (!alliance && (team.privacy === 'open' || team.invited)) ?
      command('Join','plus',{type:'alliance-join',id:team.id},'primary') : tag('Power ' + number(team.power)))).join(''))}</div>`;
}
function diplomacy(ctx) {
  const {alliance,treaties} = ctx.ui.state;
  return well('Diplomatic ledger',
    (alliance?.leader === ctx.own.id ? `<div class="buttons">${btn('Issue diplomatic order','flag',{modal:'treaty'},'primary')}</div>` : '') +
    (list(treaties).length ? list(treaties).map(item => row(item.name,allianceName(ctx,item.from) + ' → ' + allianceName(ctx,item.to) + ' · ' + title(item.status) + ' · ' + formatDate(item.endsAt),
      item.status === 'pending' && item.to === alliance?.id && alliance.leader === ctx.own.id ?
        command('Accept','check',{type:'treaty-respond',id:item.id,accept:true},'primary') + command('Decline','x',{type:'treaty-respond',id:item.id,accept:false}) : tag(title(item.status),cssStatus(item.status)))).join('') : empty('No agreements or diplomatic orders.')));
}
function rallyView(ctx) {
  const alliance = ctx.ui.state.alliance;
  if (!alliance) return empty('Join an alliance to use its war council.');
  return well('Campaign rallies',
    form('rally',dropdown('Campaign target','target',cityOptions(ctx,item => item.alliance !== alliance.id),ctx.city?.id),submit('Open or join rally','flag','primary')) +
    (list(alliance.rallies).length ? alliance.rallies.map(item => row(cityName(ctx,item.target),item.participants.length + ' participants · ' + duration(item.endsAt - ctx.gameNow),
      command('Join rally','plus',{type:'rally',target:item.target},'primary',item.participants.includes(ctx.own.id)))).join('') : empty('No active rallies.')));
}
function chatView(ctx) {
  const alliance = ctx.ui.state.alliance;
  const messages = list(ctx.ui.state.messages);
  return `<div class="split">${['world', 'alliance'].map(channel => well(title(channel) + ' dispatches',
    (channel === 'alliance' && !alliance ? empty('Join an alliance to send private dispatches.') :
      form('chat',hidden('channel',channel)+input('Message','text','','text','maxlength="240"'),submit('Send','send','primary'))) +
    messages.filter(message => message.channel === channel).slice(0,18).map(message => row(message.name ?? message.city,message.text)).join(''))).join('')}</div>`;
}
function alliancePage(ctx) {
  const tab = ctx.ui.tabs.alliance ?? 'roster';
  const body = ({roster:allianceRoster,diplomacy,rallies:rallyView,chat:chatView})[tab](ctx);
  return heading('Alliance','alliance',ctx.ui.state.alliance?.name ?? 'Diplomatic council')+`<div class="page-body">${tabbar(allianceTabs,tab)}${body}</div>`;
}

function intelligence(ctx) {
  const state = ctx.ui.state;
  const reports = list(state.intelArchive);
  const missions = list(state.missions);
  return values('Scout tower', [['Scout points',number(ctx.own.scoutPoints)],['Available spies',number(ctx.own.spies)],
    ['Counterintelligence',ctx.own.counterspyUntil > ctx.gameNow ? duration(ctx.own.counterspyUntil-ctx.gameNow) : 'Inactive']]) +
    `<div class="tile-controls">${btn('Plan mission','spy',{modal:'scout'},'intel')}${btn('Watchtower','shield',{page:'city','start-tab':'defense'})}</div>
    <div class="split">
    ${well('Mission history',missions.length ? missions.map(mission => row(labelOf(state.config.missions[mission.mission],mission.mission),
      cityName(ctx,mission.target) + ' · ' + (mission.status === 'pending' ? duration(mission.completesAt-ctx.gameNow) : formatDate(mission.startedAt)), tag(title(mission.status),cssStatus(mission.status)))).join('') : empty('No dispatched missions.'))}
    ${well('Intel archive',reports.length ? reports.map(intel => row(cityName(ctx,intel.target),title(intel.kind) + ' · ' + Math.round(intel.confidence*100) + '% confidence',
      btn('View report','scroll',{modal:'report',id:intel.id}))).join('') : empty('Successful missions file reports here.'))}
    </div>`;
}
function battleRows(ctx) {
  const battles = list(ctx.ui.state.battles);
  return battles.length ? battles.map(battle => row(battle.attackerName + ' vs ' + battle.defenderName,
    title(battle.kind) + ' · ' + formatDate(battle.at),btn('Battle report','journal',{modal:'battle',id:battle.id},'primary'))).join('') : empty('No battles recorded for your city.');
}
function operations(ctx) {
  const opponents = list(ctx.ui.state.targets).filter(item => item.eligibility?.ok);
  return `<div class="split">
    ${well('Matchmaking',opponents.length ? opponents.map(city => row(city.name,city.terrainName + ' · ~' + number(city.power) + ' power' + (city.npc?' · NPC':''),
      btn('Plan raid','war',{modal:'attack',id:city.id},'attack') + btn('Scout','spy',{modal:'scout',id:city.id},'intel'))).join('') : empty('No cities currently meet the seasonal raid rules.'))}
    ${well('Raid rules',`<p>You may raid any opponent who is not more than 20% weaker than you; stronger opponents are always open. Daily limits and cooldowns apply to free and paid attacks.</p>${row('Attacks remaining',ctx.countLeft() + ' in your rolling day')}${row('' + NETWORK_LABEL + ' attack fee',ctx.feeLabel('attack-paid'))}${btn('Set formation','helmet',{modal:'formation'},'primary')}`)}
    </div>` + well('Battle history',battleRows(ctx));
}

function expeditions(ctx) {
  const distance = city => Math.hypot(city.x-ctx.own.x,city.y-ctx.own.y);
  const targets = list(ctx.ui.state.targets).filter(city=>city.npc && city.expedition)
    .toSorted((left,right)=>Number(right.expedition.ok)-Number(left.expedition.ok) || distance(left)-distance(right));
  const rule = ctx.ui.state.config.expeditionRules;
  const courts = targets.map(city=>row(city.name,`${city.npcProfile?.name ?? 'NPC kingdom'} · ${city.terrainName} · ${city.expedition.ok?'Ready for an expedition':city.expedition.reason}`,
    btn('Plan expedition','war',{modal:'expedition',id:city.id},city.expedition.ok?'attack':'') +
    btn('Visit court','crown',{modal:'npc-court',id:city.id}))).join('');
  return eventHero('battlefield','Frontier campaigns','Expeditions',
    'Challenge NPC kingdoms with earned supplies and bring surviving troops and spoils home.')+
    `<div class="split">
      ${well('NPC kingdoms',courts||empty('No NPC kingdoms are available here.'))}
      ${well('Campaign orders',`${rule?costs(rule.cost):''}
        <p>${rule?`${number(rule.dailyLimit)} expeditions per day · ${duration(rule.playerCooldown)} between marches`:''}</p>
        <p>Victory transfers goods from the defending city. Your army can take casualties. Frontier camps share your expedition limit.</p>
        ${btn('Find frontier camps','pin',{page:'war','start-tab':'territory'},'primary')}`)}
    </div>`;
}
function pactView(ctx, pact) {
  const mine = ctx.own.id;
  const r = pact.rebellion;
  const reply = ['accept','reject','negotiate','resist'].map(decision => command(({accept:'Accept terms',reject:'Reject',negotiate:'Negotiate (8 Influence)',resist:'Resist'})[decision],
    decision === 'resist' ? 'war' : 'flag',{type:'respond',id:pact.id,decision},decision === 'resist' ? 'attack' : '')).join('');
  const isDefender = mine === pact.defender;
  const isOverlord = mine === pact.overlord;
  let actions = '';
  if (pact.status === 'pending' && isDefender) actions = reply;
  if (pact.status === 'active') {
    if (isOverlord) actions += command('Release city','flag',{type:'release',id:pact.id},'primary') + btn('Send aid','relief',{modal:'aid',id:pact.defender});
    if (isDefender && (!r || r.status === 'preparing' || r.status === 'failed')) actions += command('Organize rebel cell','horn',{type:'rebellion-prepare',id:pact.id},'intel',r?.cells >= 4 || r?.retryAt > ctx.gameNow);
    if (isDefender && r?.status === 'preparing') actions += command('Raise rebellion','horn',{type:'rebel',id:pact.id},'attack',r.cells < 2 || ctx.gameNow < r.readyAt);
    if (!isDefender && !isOverlord && r?.status === 'preparing') actions += command('Back the rebels','flag',{type:'rebellion-support',id:pact.id},'intel',r.supporters.includes(mine));
    if (isOverlord && r?.status === 'mustering') actions += command('Reinforce','shield',{type:'rebellion-respond',id:pact.id,decision:'reinforce'},'attack',r.reinforced);
  }
  if (pact.challenge) actions += btn('Resistance battle','journal',{modal:'battle',id:pact.challenge});
  if (r?.battle) actions += btn('Rebellion battle','journal',{modal:'battle',id:r.battle});
  return well(cityName(ctx,pact.defender) + ' · ' + cityName(ctx,pact.overlord),
    `<p>${tag(title(pact.status),cssStatus(pact.status))} ${pact.status === 'pending' ? 'Response due ' + timer(pact.respondBy,ctx.gameNow) : pact.status === 'active' ? 'Term remaining ' + timer(pact.endsAt,ctx.gameNow) : ''}</p>
    <p>Tribute ${Math.round(pact.tribute*100)}% of earned production. Upkeep is assessed every six hours.</p>
    ${r ? `<p>${tag(title(r.status),cssStatus(r.status))} <strong>${number(r.cells)}</strong> rebel cells · ${number(r.morale)} morale · ${number(r.stability)} stability · ${r.supporters.length} allies</p>
       <p>${r.status === 'preparing' ? 'Preparation ' + timer(r.readyAt,ctx.gameNow) : r.status === 'mustering' ? 'Battle in ' + timer(r.resolveAt,ctx.gameNow) : r.retryAt ? 'Recovery ' + timer(r.retryAt,ctx.gameNow) : ''}</p>` : ''}
    <div class="buttons">${actions}</div>`);
}
function politics(ctx) {
  const state = ctx.ui.state;
  const proposals = list(state.targets).filter(item=>item.protectorateEligibility?.ok);
  const pacts = list(state.politics);
  return eventArt('protectorate') + `<div class="split">${values('Political standing',[['Influence',number(ctx.own.influence)],['Reputation',number(ctx.own.reputation)]])}
    ${well('Eligible protectorate offers', proposals.length ? proposals.map(city => row(city.name,ctx.feeLabel('protectorate')+' · defender response required',btn('Review terms','crown',{modal:'protectorate',id:city.id},'protect'))).join('') : empty('No eligible cities for this alliance leader.'))}</div>` +
    (pacts.length ? pacts.map(pact => pactView(ctx,pact)).join('') : empty('No active negotiations or protectorates for your city.'));
}
function warPage(ctx) {
  const tab = ctx.ui.tabs.war ?? 'operations';
  const body = ({operations,expeditions,intelligence,politics,territory:territoryAtlas})[tab](ctx);
  return heading('War Room','war','Campaign operations')+`<div class="page-body">${tabbar(warTabs,tab)}${body}</div>`;
}

// Checkouts that closed before any BCH was sent are left out: there was no transaction.
const neverPaid = item => ['expired','rejected','voided'].includes(item.state ?? item.status) && !item.txid && item.direction !== 'outgoing';
function paymentRows(ctx) {
  const payments = list(ctx.ui.state.payments).filter(item => !neverPaid(item));
  return payments.length ? payments.map(item => {
    const state = item.state ?? item.status;
    return row(item.title ?? title(item.action),bch(item.satoshis ?? item.amount) + ' BCH · ' + (item.attestation && !item.attestation.complete && state === 'created' ? 'Awaiting prize attestors · ' + item.attestation.signed.length + ' of ' + item.attestation.attestors.length + ' signed' : statusLabel[state] ?? title(state)),
      btn(item.direction === 'outgoing' || item.txid ? 'Receipt' : 'Resume payment','journal',{modal:'payment',id:item.id},cssStatus(state) === 'success' ? 'primary' : ''));
  }).join('') : empty('No ' + NETWORK_LABEL + ' payments recorded.');
}
const creditNames = { rush:'rush', premium:'premium improvement', protectorate:'protectorate proposal', 'espionage-paid':'paid intelligence mission', 'political-operation':'political operation' };
// A paid raid on this city whose payment is on its way: the dialog shows it instead of offering another.
const paidRaid = target => paymentsInFlight().find(item => item.payload?.type === 'attack-paid' && item.payload.target === target) ?? null;
// Sent to the War Chest and not yet confirmed: a deposit, or the War Chest share of a service payment.
function incomingChest() {
  return paymentsInFlight().map(item => ({ ...item, satoshis: item.action === 'war-chest' ? item.satoshis :
    list(item.outputs).filter(output => output.role === 'kingdom').reduce((total, output) => total + (output.satoshis ?? 0), 0) }))
    .filter(item => item.satoshis > 0 && item.state !== 'confirmed');
}
function vaultPage(ctx) {
  const data = ctx.ui.state.vault ?? ctx.ui.vault ?? {};
  const status = !chainOpen(ctx) ? empty(data.quarantined ? 'Settlement is paused for chain reconciliation.' : '' + NETWORK_LABEL + ' services require a configured treasury and observer.') : '';
  return heading('War Chest','vault','Your ' + NETWORK_LABEL + ' funds',btn('Chain journal','journal',{modal:'journal'})) +
     `<div class="page-body">${eventArt('vault')}${status}
       <div class="split">
         ${values('Your wallet',[['Connected wallet',bch(walletBalance(ctx) ?? data.walletSatoshis)],...(data.depositedSatoshis?[['Earlier vault deposit · withdraw it below',bch(data.depositedSatoshis)]]:[]),...Object.entries(data.serviceCredits ?? {}).map(([kind,count])=>['Paid and owed to you · ' + (creditNames[kind] ?? kind),count + ' · your next one is free (a game credit, not a BCH refund)'])])}
         ${data.warChestSatoshis != null ? values('War Chest · always at risk',[['In your War Chest',bch(data.warChestSatoshis)],
           ...incomingChest().map(item=>['On its way · '+confirmationText(item),bch(item.satoshis)]),['Open to a matched raid now',bch(data.capturableSatoshis)],
           ...(data.reservedSatoshis?[['Matched against raids being settled',bch(data.reservedSatoshis)]]:[]),...(data.pendingChestSatoshis?[['Waiting to join (earlier payments)',bch(data.pendingChestSatoshis)]]:[]),
           ...(data.earlierChestSatoshis?[['Earlier War Chest revision · withdraw to move it',bch(data.earlierChestSatoshis)]]:[]),
           ...(data.exitingChestSatoshis?[['Leaving (exit started)',bch(data.exitingChestSatoshis)]]:[]),['Claimable prize BCH',bch(data.claimableSatoshis)]]) : values('War Chest',[['Status','Not available on this server'],['Claimable prize BCH',bch(data.claimableSatoshis)]])}
       </div>
       ${well('Manage funds',`<p>${data.warChestSatoshis != null ? 'Your War Chest is at risk in PvP raids. Half of each payment goes into it, or deposit from ' + number(data.minimumDepositSatoshis ?? 10000) + ' sats. Withdraw what is not in a raid at any time.' : 'Paid services are not available on this server.'}</p><div class="buttons">
         ${ctx.ui.state.config?.personalVault === 'closed' ? '' : btn('Deposit BCH','bch',{modal:'deposit'},'primary',!chainOpen(ctx))}
         ${btn('Fund War Chest','bch',{modal:'chest'},'',!chainOpen(ctx))}
         ${data.depositedSatoshis > 0 ? btn('Withdraw earlier vault deposit','arrow',{modal:'withdraw'},'',!data.payoutsEnabled || !chainOpen(ctx)) : ''}
         ${data.warChestSatoshis > 0 ? gameLink('Withdraw from War Chest','/council.html','arrow') : ''}
         ${btn('Sponsor rewards','gift',{modal:'sponsor'},'protect',!chainOpen(ctx))}
         ${btn('Claim reward','trophy',{modal:'claim'},'protect',!data.payoutsEnabled || !(data.claimableSatoshis > 0) || !chainOpen(ctx))}
         ${btn(walletLabel(ctx.ui.state.wallet),'bch',{modal:'wallet'})}
         ${gameLink('Chain explorer','/ledger.html','journal')}
         ${gameLink('Season pool, sponsors & public accounts','/council.html','crown')}
       </div>`)}
       ${well('Transaction history',paymentRows(ctx))}
     </div>`;
}
function standingsTable(ctx, entries) {
  return `<table class="rank-table"><thead><tr><th scope="col">Rank</th><th scope="col">City or alliance</th><th scope="col">Score</th><th scope="col">Power</th><th scope="col">Territory</th></tr></thead>
    <tbody>${entries.map((item,i) => `<tr><td>${i+1}</td><td>${html(item.name)} ${item.npc ? tag('NPC') : ''}${item.id === ctx.own.id ? tag('You','success') : ''}</td><td>${number(item.score)}</td><td>${number(item.power)}</td><td>${number(item.territories)}</td></tr>`).join('')}</tbody></table>`;
}
function rankingsPage(ctx) {
  const tab = ctx.ui.tabs.rankings ?? 'players';
  const state = ctx.ui.state;
  const campaigns = list(state.sponsors);
  let contents;
  if (tab === 'archive') {
    contents = list(state.archive).length ? list(state.archive).map(season => well(season.name ?? 'Season ' + season.number,
      standingsTable(ctx,list(season.rankings)))).join('') : empty('Completed seasons will appear here.');
  } else {
    const ranking = tab === 'alliances' ? list(state.alliances).sort((a,b) => b.score-a.score || b.power-a.power) : list(state.rankings);
    contents = well(tab === 'alliances' ? 'Alliance rankings' : 'City rankings',standingsTable(ctx,ranking));
  }
  return heading(state.season.name,'trophy','Season '+state.season.number,btn('Prize pool','vault',{page:'vault'})) +
    `<div class="page-body">${eventArt('season')}
      ${campaigns.map(campaign => `<div class="sponsor-standard" data-sponsor-impression="${html(campaign.id)}">
        ${campaign.logoUrl ? image(campaign.logoUrl,'sponsor-standard-logo') : icon('flag')}
        <div><span class="kicker">${campaign.placement === 'tournament' ? 'Title sponsor' : 'Season sponsor'}</span>
        <strong>${html(campaign.title)}</strong><span>Presented by ${html(campaign.sponsor)}</span></div>
        <a class="btn game-link" href="${html(campaign.link)}" data-sponsor-site="${html(campaign.id)}" target="_blank" rel="noopener noreferrer sponsored">Sponsor site</a>
      </div>`).join('')}
      ${values('Season status',[['Time remaining',duration(state.season.endsAt-ctx.gameNow)],['Your contribution',number(ctx.own.score)],['Sponsor funds',bch(state.vault?.sponsoredSatoshis) + ' BCH']])}
      ${tabbar([['players','Cities'],['alliances','Alliances'],['archive','Archive']],tab)}
      ${contents}
    </div>`;
}

export function renderPage(ctx) {
  const pages = {city:cityPage,alliance:alliancePage,war:warPage,politics:renderPolitics,vault:vaultPage,rankings:rankingsPage};
  const topic={city:ctx.ui.tabs.city==='research'?'progression':ctx.ui.tabs.city==='army'?'combat':'city',
    alliance:'politics',politics:'politics',war:'raids',vault:'blockchain',rankings:'seasons'}[ctx.ui.page];
  // Every page starts with the way back; the war and season pages also say whether this kingdom is in the season.
  const season=['war','rankings'].includes(ctx.ui.page) ? `<div class="season-strip">${ctx.own.optIn ?
      tag('You are in the season','success')+'<span>Your raids, territories and score count toward the season prizes.</span>'+btn('Leave the season','war',{modal:'enroll'}) :
      '<strong>You are not in the season.</strong><span>Join to raid other players and compete for the season prizes.</span>'+btn('Join the season','war',{modal:'enroll'},'primary')}</div>` : '';
  return `<div class="codex-context"><button type="button" class="btn page-back" data-page-back>\u2190 Back</button>${topic?guideLink(topic,'Learn these rules'):''}</div>`+season+(pages[ctx.ui.page]?.(ctx)??'');
}

// Everything of the player's that is still running, with the time left: the notification centre lists it on top and the
// bell counts it. Built only from the state the game already sent.
const SENT_STATES = new Set(['submitted','seen_in_mempool','confirming','uncertain','confirmed']);
export function activeWork(ctx) {
  const config = ctx.ui.state.config ?? {};
  const own = ctx.own;
  const items = [];
  for (const job of list(own.queue)) {
    if (job.kind === 'building') items.push({ art:'/art/' + job.key + '-' + Math.min(job.level ?? 1,3) + '.webp', glyph:'hammer',
      title:'Upgrading ' + labelOf(config.buildings?.[job.key],job.key) + ' to level ' + number(job.level) + (job.rushed ? ' · rushed' : ''), until:job.completesAt });
    else if (job.kind === 'troop') items.push({ art:'/art/unit-' + job.key + '.webp', glyph:'helmet',
      title:'Training ' + number(job.count) + ' ' + labelOf(config.units?.[job.key],job.key), until:job.completesAt });
    else if (job.kind === 'research') items.push({ glyph:'book', title:'Researching ' + labelOf(config.tech?.[job.key],job.key) + ' ' + number(job.level), until:job.completesAt });
  }
  for (const mission of list(ctx.ui.state.missions).filter(item => item.status === 'pending'))
    items.push({ glyph:'spy', title:labelOf(config.missions?.[mission.mission],mission.mission) + ' · ' + cityName(ctx,mission.target), until:mission.completesAt });
  for (const march of list(ctx.ui.state.marches).filter(item => item.attacker === own.id && item.endsAt > ctx.gameNow))
    items.push({ glyph:'war', title:'Army on the march', until:march.endsAt });
  for (const payment of list(ctx.ui.state.payments).filter(item => item.direction !== 'outgoing' && item.txid && SENT_STATES.has(item.state)))
    items.push({ glyph:'bch', title:(payment.title ?? title(payment.action)) + ' · ' + confirmationText(payment), modal:{ modal:'payment', id:payment.id } });
  for (const site of list(ctx.ui.state.territories)) {
    const round = site.raffle?.round;
    if (round?.status === 'open' && round.entries?.some(entry => entry.player === own.id))
      items.push({ glyph:'crystal', title:'Raffle at ' + site.name + ' · draw at block ' + number(round.drawHeight), modal:{ modal:'node', id:site.id } });
    if (['open','locked'].includes(site.claim?.status) && site.claim.entries?.some(entry => entry.player === own.id))
      items.push({ glyph:'flag', title:'Claim contest at ' + site.name, until:site.claim.endsAt, modal:{ modal:'node', id:site.id } });
  }
  return items;
}
function workRow(item, ctx) {
  const left = item.until ? timer(item.until, ctx.gameNow) : '';
  const picture = item.art ? `<img class="work-art" src="${html(item.art)}" alt="" loading="lazy" decoding="async">` : `<span class="work-art">${icon(item.glyph)}</span>`;
  return `<article class="work-row">${picture}<div><strong>${html(item.title)}</strong>${left ? '<small>' + left + ' left</small>' : ''}</div>${item.modal ? btn('Open','arrow',item.modal) : ''}</article>`;
}

// A dialog the player cannot close: no Back, no close button (Escape is refused in app.js). Used for founding a city.
function lockedModal(titleText, content) {
  return `<h2 id="dialog-title">${html(titleText)}</h2>${content}`;
}

function modal(titleText, content) {
  return `<button type="button" class="dialog-back" data-dialog-back aria-label="Back">\u2190 Back</button><button type="button" class="dialog-close" aria-label="Close dialog" data-dismiss>${icon('x')}</button><h2 id="dialog-title">${html(titleText)}</h2>${content}`;
}
function buildingDialog(ctx,id) {
  const def = ctx.ui.state.config.buildings[id];
  const upgrade = ctx.own.upgrades?.[id];
  if (!def || !upgrade) return modal('Construction',empty('The building is unavailable.'));
  const jobs = list(ctx.own.queue);
  const current = jobs.find(job => job.key === id && job.kind === 'building');
  const busy = jobs.some(job => job.kind === 'building');
  const canPay = chainOpen(ctx) && ctx.own.paidConvenienceLeft > 0;
  // A rush is for the construction in progress, once. Before the upgrade starts, or after it is rushed, it is not offered.
  const canRush = Boolean(current && !current.rushed);
  // Applied after 1 confirmation when less than an hour is left, otherwise after 2 (see economy.rushOneConfirmationBelow).
  const quick = current && current.completesAt - ctx.gameNow < (ctx.ui.state.config.economy?.rushOneConfirmationBelow ?? 3_600_000);
  const rushNote = current?.rushed ? 'Already rushed.' : current ? 'Rush halves the time left. Applied after ' + (quick ? '1 confirmation (~10 min).' : '2 confirmations (~20 min).') : 'Start the upgrade to rush it.';
  const owned = Boolean(ctx.own.perks?.[id]);
  return modal(def.name,`
    <div class="upgrade-preview">${image('/art/' + id + '-' + Math.min(upgrade.level,3) + '.webp','building-image')}${upgrade.effects?.next ? icon('arrow')+image('/art/' + id + '-' + Math.min(upgrade.nextLevel,3) + '.webp','building-image') : ''}</div>
    <p>Level ${upgrade.level}${upgrade.effects?.next?' → Level '+upgrade.nextLevel:''}. ${html(def.description)}</p>
    ${comparison(upgrade.effects?.current,upgrade.effects?.next,'Building effects')}
    <dl class="kv"><dt>Standard build time</dt><dd>${duration(upgrade.duration)}${upgrade.headStart ? ' · first-day head start, 3× faster' : ''}</dd>${current ? '<dt>Construction finishes</dt><dd>' + timer(current.completesAt,ctx.gameNow) + '</dd>' : ''}</dl>
    ${costs(upgrade.cost)}
    ${!upgrade.eligible ? '<p class="quiet-text">'+html(upgrade.reason)+'</p>' : busy ? '<p class="quiet-text">A construction project is already active.</p>' : ''}
    <div class="buttons">${command('Start standard upgrade','hammer',{type:'upgrade',building:id},'primary',!upgrade.eligible || busy || !hasCost(ctx.own,upgrade.cost))}</div>
    ${ctx.ui.dialog.guided ? '' : `<div class="well"><h3>${NETWORK_LABEL} convenience</h3>
      <p>${rushNote}${def.premium ? ' Premium: ' + html(def.premium) + (owned ? ' (owned).' : '.') : ''}</p>
      ${!chainOpen(ctx) ? '<p>' + NETWORK_LABEL + ' payments are unavailable.</p>' : ctx.own.paidConvenienceLeft === 0 ? '<p>Used today: one rush or premium per day.</p>' : ''}
      <div class="buttons">${pay(current?.rushed ? 'Rushed' : 'Rush upgrade · ' + ctx.feeLabel('rush'),'clock',{type:'rush',building:id},'protect',!canPay || !canRush)}
      ${def.premium ? pay(owned ? 'Premium owned' : 'Upgrade with BCH · ' + ctx.feeLabel('premium'),'bch',{type:'premium',building:id},'primary',!canPay || owned) : ''}</div>
    </div>`}`);
}
function trainingDialog(ctx,id) {
  const config=ctx.ui.state.config;
  const def=config.units[id], stats=kingdomStats(ctx)?.units[id];
  if (!def || !stats) return modal('Recruitment',empty('Select a troop class.'));
  const training=stats.training;
  const available=training.unlocked&&training.spaceRemaining>0&&training.queued<training.slots&&hasCost(ctx.own,training.cost);
  return modal('Train ' + def.name,eventHero('unit-'+id,'Barracks recruits',def.name,'Review the effects of your current orders before training.')+
    squadDetail(stats,config)+`<p>${training.queued} / ${training.slots} queue slots used · ${number(training.spaceRemaining)} army spaces free</p>
    ${!training.unlocked?'<p>Requires '+html(labelOf(config.buildings[training.prerequisite.building],training.prerequisite.building))+' '+number(training.prerequisite.level)+'.</p>':''}
    <p>Per recruit · ${duration(training.duration)} training · ${training.upkeepPerHour} food / hour</p>${costs(training.cost)}`+
    form('train',hidden('unit',id)+input('Recruits','count',String(Math.max(1,Math.min(5,training.spaceRemaining))),'number',
      'min="1" max="'+Math.max(1,Math.min(30,training.spaceRemaining))+'" step="1"')+
      '<div data-training-quote aria-live="polite"></div>',
      submit('Queue recruits','helmet','primary',available?'':'disabled')));
}
function formationFields(ctx) {
  const config = ctx.ui.state.config;
  const roster=kingdomStats(ctx)?.commands;
  const eligible=roster?configs(config.heroes).filter(([id])=>['permanent','rented'].includes(roster.roster[id]?.ownership)):configs(config.heroes);
  return dropdown('Formation','formation',configs(config.formations),ctx.own.formation) +
    dropdown('Tactic','tactic',configs(config.tactics),ctx.own.tactic) +
    dropdown('Commander','hero',eligible,eligible.some(([id])=>id===ctx.own.hero)?ctx.own.hero:eligible[0]?.[0]);
}
function formationDialog(ctx) {
  return modal('Formation & tactics',form('configure',formationFields(ctx),submit('Save formation','flag','primary')));
}
function attackDialog(ctx,id) {
  const city = ctx.cities.find(item => item.id === id) ?? ctx.city;
  if (!city || city.id === ctx.own.id) return modal('Plan a raid',empty('Select a rival city on the map.'));
  const config = ctx.ui.state.config;
  const allowed = city.eligibility?.ok;
  const payment=config.competitiveRaid;
  return modal('Raid ' + city.name,
    `${raidStandards(ctx.own,city,config.heroes[ctx.own.hero]?.name)}
    <p class="raid-availability"><strong>${html(ctx.countLeft())} attacks remaining</strong> ${allowed ? tag('Comparable opponent','success') : tag(city.eligibility?.reason || 'Ineligible','danger')}</p>
    ${form('attack',hidden('target',city.id)+'<div class="raid-orders">'+formationFields(ctx)+'</div>'+
      '<div class="raid-dossier" aria-live="polite" data-attack-preview>Reading the scouting ledger…</div><div class="raid-review" data-raid-review hidden></div>',
    submit('Launch free raid','war','attack raid-launch',allowed ? '' : 'disabled') +
    (city.npc?'':paidRaid(city.id) ? paidButton(paidRaid(city.id)) : submit('Prepare paid raid · ' + (config.raid?.matched ? 'stake from ' : '') + ctx.feeLabel('attack-paid'),'bch','protect',`name="paid" value="1" ${allowed && chainOpen(ctx) ? '' : 'disabled'}`)))}
    ${city.npc?`<div class="buttons">${btn('Plan expedition','war',{modal:'expedition',id:city.id},'primary')}</div>`:''}
    ${!city.npc && config.raid?.matched?`<p class="strategy-note">Optional paid raid with matched stakes: you choose a stake from ${number(config.raid.minimumStake)} sats, and it is offered only against a defender whose War Chest holds the same amount. A free raid uses the same combat rules.</p>`:''}
    ${!city.npc && payment?.settlement?`<p class="strategy-note">Optional paid raid: ${number(payment.battle)} sats at stake, plus a ${number(payment.settlement)} sats settlement reserve. A free raid uses the same combat rules.</p>`:''}
    ${!city.npc && !chainOpen(ctx) ? '<p class="quiet-text">' + NETWORK_LABEL + ' payment service is unavailable. Free raids remain available to eligible cities.</p>' : ''}
    <details><summary>Tactical brief</summary>${Object.values(config.tactics).map(def => row(def.name,def.description)).join('')}</details>`);
}

function expeditionDialog(ctx,id) {
  const city = ctx.cities.find(item=>item.id===(id??ctx.city?.id));
  if (!city?.npc || !city.expedition) return modal('Plan an expedition',empty('Select an NPC kingdom.'));
  const rule = city.expedition;
  const commander = ctx.ui.state.config.heroes[ctx.own.hero]?.name;
  return modal('Expedition to '+city.name,raidStandards(ctx.own,city,commander)+`
    <p class="raid-availability">${tag('NPC kingdom')} ${rule.ok?tag('Available','success'):tag(rule.reason||'Unavailable','danger')}</p>
    <p>Choose your orders. The army you field can take casualties. A victory transfers goods from the defending city.</p>
    ${rule.nextAt>ctx.gameNow?`<p>Available in ${timer(rule.nextAt,ctx.gameNow)}.</p>`:''}
    ${costs(rule.cost)}
    ${form('expedition',hidden('target',city.id)+'<div class="raid-orders">'+formationFields(ctx)+'</div>',
      submit('Lead expedition','war','attack',rule.ok?'':'disabled'))}
    <div class="buttons">${btn('Scout this kingdom','spy',{modal:'scout',id:city.id},'intel')}${btn('Visit court','crown',{modal:'npc-court',id:city.id})}</div>`);
}

function npcCourtDialog(ctx,id) {
  const city = ctx.cities.find(item=>item.id===(id??ctx.city?.id));
  if (!city?.npc || !city.npcEnvoy) return modal('NPC court',empty('Select an NPC kingdom.'));
  const plan = city.npcEnvoy;
  const outcome = ctx.ui.dialog?.envoy;
  return modal('Court of '+city.name,eventHero('event-protectorate','NPC kingdom',city.name,city.npcProfile?.agenda??'')+
    (outcome ? `<section class="well"><h3>${outcome.accepted?'Ceasefire signed':'Envoy turned away'}</h3>
      <p>${html(outcome.reply)}</p>${outcome.treaty?.expiresAt>ctx.gameNow?`<p>Protection ends in ${timer(outcome.treaty.expiresAt,ctx.gameNow)}.</p>`:''}
      ${costs(outcome.cost)}</section>` : `<p>Offer a twelve-hour ceasefire. Your envoy uses earned supplies and the court decides whether to accept.</p>${costs(plan.cost)}`)+
    `<p class="territory-rule">${plan.ok?'Send one envoy every twelve hours.':html(plan.reason||'Unavailable.')}
      ${plan.nextAt>ctx.gameNow?` · Ready in ${timer(plan.nextAt,ctx.gameNow)}`:''}</p>
    <div class="buttons">${command('Send envoy','crown',{type:'npc-envoy',target:city.id},'primary',!plan.ok)}
      ${btn('Plan expedition','war',{modal:'expedition',id:city.id})}</div>`);
}
function protectorateDialog(ctx,id) {
  const city = ctx.cities.find(item => item.id === id) ?? ctx.city;
  if (!city || city.id === ctx.own.id) return modal('Protectorate offer',empty('Select a rival city on the map.'));
  const allowed = city.protectorateEligibility?.ok;
  const rules = ctx.ui.state.config.economy;
  return modal('Protectorate offer',eventArt('protectorate') +
    `<dl class="kv"><dt>Defending city</dt><dd>${html(city.name)}</dd><dt>Response deadline</dt><dd>${duration(rules.protectorateResponseTime)}</dd><dt>Maximum term</dt><dd>${duration(rules.protectorateTerm)}</dd><dt>Resource tribute</dt><dd>${Math.round(rules.protectorateTribute*100)}% of earned production</dd><dt>Proposal fee</dt><dd>${html(ctx.feeLabel('protectorate'))}</dd><dt>Influence</dt><dd>12</dd></dl>
    <p>The defending city may review the offer, negotiate, resist or refuse. A protectorate can end through release, expiry or a successful rebellion.</p>
    ${costs({wood:85,stone:65,iron:45,food:100,crystal:18})}
    <p>${!allowed ? html(city.protectorateEligibility?.reason) : !chainOpen(ctx) ? '' + NETWORK_LABEL + ' payment service is unavailable.' : tag('Eligible for an offer','success')}</p>
    <div class="buttons">${pay('Prepare ' + NETWORK_LABEL + ' proposal','crown',{type:'protectorate',target:city.id},'protect',!allowed || !chainOpen(ctx))}</div>`);
}
function intelDetails(intel,ctx) {
  if (!intel) return empty('There is no report for this target.');
  const percent = Math.round((intel.confidence ?? 0)*100);
  return `<p>${tag(title(intel.kind),intel.expiresAt > ctx.gameNow ? 'success' : 'quiet')} ${intel.expiresAt > ctx.gameNow ? 'Expires in ' + timer(intel.expiresAt,ctx.gameNow) : 'Stale intelligence'}</p>
    <p>Confidence ${percent}% · ${html(formatDate(intel.at))}</p><div class="meter"><i style="width:${Math.max(0,Math.min(100,percent))}%"></i></div>
    <dl class="kv"><dt>Estimated troops</dt><dd>${number(intel.army)}</dd><dt>Estimated power</dt><dd>${number(intel.power)}</dd>
    <dt>Estimated defense</dt><dd>${number(intel.defense)}</dd>${intel.formation ? '<dt>Probable formation</dt><dd>'+html(title(intel.formation))+'</dd>' : ''}</dl>
    ${intel.troops ? well('Estimated composition',Object.entries(intel.troops).map(([id,count]) => row(labelOf(ctx.ui.state.config.units[id],id),number(count))).join('')) : ''}
    ${intel.resources ? well('Estimated stockpile',costs(intel.resources)) : ''}
    ${ctx.ui.state.alliance && !intel.sharedBy && intel.expiresAt > ctx.gameNow ? command('Share with alliance','send',{type:'share-intel',target:intel.target},'intel') : ''}`;
}
function scoutDialog(ctx,id,decoy) {
  const city = decoy ? ctx.own : ctx.cities.find(item => item.id === id) ?? ctx.city;
  const config = ctx.ui.state.config;
  const entries = Object.entries(config.missions).filter(([id]) => decoy ? id === 'decoy' : id !== 'decoy');
  const missionList = entries.map(([id,profile]) => `
    <div class="row mission-row"><div><strong>${html(profile.name)}</strong><p>${html(profile.description)} · ${profile.points} scout points · ${duration(profile.time)}</p>${costs(convertCosts(profile.cost))}</div>
    ${command('Dispatch','spy',{type:'scout',mission:id,target:city?.id},'intel',(!decoy && city?.id === ctx.own.id) || ctx.own.scoutPoints < profile.points ||
      !hasCost(ctx.own,convertCosts(profile.cost)) || list(ctx.ui.state.missions).some(item => item.status === 'pending'))}</div>`).join('');
  const pending = list(ctx.ui.state.missions).filter(mission => mission.status === 'pending');
  return modal(decoy ? 'Deploy decoys' : 'Spy mission planner',
    eventHero('scout-3','Intelligence service',decoy?'Deceive the enemy':city?.name??'Choose a rival',
      `${number(ctx.own.scoutPoints)} scout points · ${number(ctx.own.spies)} spies`)+`
     ${pending.length ? well('Underway',pending.map(m => `<p>${html(labelOf(config.missions[m.mission],m.mission))} · ${timer(m.completesAt,ctx.gameNow)}</p>`).join('')) : ''}
     ${missionList}
     ${!decoy && city?.id !== ctx.own.id && chainOpen(ctx) ? pay('Commission Recon · ' + ctx.feeLabel('espionage'),'spy',
        {type:'espionage-paid',mission:'recon',target:city?.id},'intel',pending.length > 0) : ''}
     ${city?.intel ? well('Latest intelligence',intelDetails(city.intel,ctx)) : ''}
     ${btn('Intel archive','journal',{page:'war','start-tab':'intelligence',dismiss:'true'})}`);
}
function battleDialog(ctx,id) {
  return battleReport(ctx,id,modal);
}
function receiptLink(item,txid) {
  const candidate = item.explorerUrl ?? item.explorer ?? item.receipt?.explorerUrl;
  if (typeof candidate !== 'string') return '';
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:' && url.href.includes(txid)) return `<a href="${html(url.href)}" target="_blank" rel="noopener noreferrer">View in ${NETWORK_LABEL} explorer</a>`;
  } catch {
    return '';
  }
  return '';
}
function walletTray(intent) {
  const state = wizardState();
  const selector = `<div class="wallet-selection">
    ${state.canReconnect?btn('Reconnect wallet','bch',{'wallet-reconnect':'true'},'primary'):''}
    ${btn('Selene Wallet','bch',{'wallet-pair':'Selene Wallet'},'primary')}
    ${btn('Other WizardConnect wallet','bch',{'wallet-pair':'WizardConnect wallet'})}
  </div>`;
  const tray = state.status === 'opening' ? '<p role="status">Opening WizardConnect…</p>' :
    state.status === 'restoring' ? '<p role="status">'+(state.waitingApproval?'Confirm the connection in your wallet. Pairing is waiting for your consent.':'Restoring the wallet connection…')+'</p>' + btn('Disconnect wallet','close',{'wallet-close':'true'}) :
    state.status === 'closing' ? '<p role="status">Disconnecting the wallet…</p>' :
    state.status === 'pairing' ? `<div class="wallet-pairing"><img alt="WizardConnect pairing QR code" src="${html(state.code)}">
      <div><p>${state.walletChoice==='Selene Wallet'?(NETWORK.realValue ? 'In Selene, open Apps → WizardConnect to scan the code or paste the pairing link.' : 'Enable ' + NETWORK_LABEL + ' in Selene’s Debug Options, then open Apps → WizardConnect to scan the code or paste the pairing link.'):'Open WizardConnect in your ' + NETWORK_LABEL + ' wallet and scan the code or paste the pairing link.'}</p>
      ${state.waitingApproval?'<p role="status">Confirm the connection in your wallet. Pairing is waiting for your consent.</p>':''}
      <a class="btn primary" href="${html(state.uri)}">Open in wallet</a>
      ${btn('Copy pairing code','copy',{copy:state.uri})}
      ${state.walletChoice==='Selene Wallet'?'<a class="btn" href="https://app.selene.cash/" target="_blank" rel="noopener noreferrer">Open Selene Web</a><a class="btn" href="https://app.selene.cash/debug" target="_blank" rel="noopener noreferrer">Selene Web network settings</a>':''}
      ${btn('Cancel pairing','close',{'wallet-close':'true'})}</div></div>` :
    state.status === 'broadcasting' ? '<p role="status">Submitting the signed transaction to ' + NETWORK_LABEL + '…</p>' :
    state.status === 'ready' || state.status === 'signing' ?
      `<p>${tag(state.walletName ?? 'Wallet paired','success')}${state.address?' '+html(walletLabel(null)):''}</p>
      ${state.asleep && state.status==='ready' ? '<p class="quiet-text">Connected. Your wallet app is closed or asleep right now; a request reaches it as soon as you open the wallet app.</p>' : ''}<div class="buttons">
        ${intent && state.status === 'ready' ? btn('Approve with wallet','bch',{'wallet-approve':intent.id},'primary') : ''}
        ${state.status === 'signing' ? btn('Cancel approval','close',{'wallet-cancel':'true'}) : btn('Disconnect wallet','close',{'wallet-close':'true'})}
        ${state.status === 'signing' ? '<span role="status">' + (state.proving ? 'Approve the request in your wallet. It proves the wallet is yours; it sends nothing and spends nothing.' : 'Waiting for approval in your wallet…') + '</span>' : ''}</div>` :
      selector;
  return well('WizardConnect', tray + (state.error ? '<p class="form-error">' + html(state.error) + '</p>' : ''));
}
function paymentDialog(ctx,id) {
  const intent = list(ctx.ui.state.payments).find(item => item.id === id) ?? ctx.ui.dialog.intent;
  if (!intent) return modal('' + NETWORK_LABEL + ' receipt',empty('This payment intent is unavailable.'));
  const state = intent.state ?? intent.status;
  const address = intent.address ?? intent.recipient ?? intent.payTo;
  const visibleTxid = intent.receipt?.txid ?? intent.txid;
  const isOutgoing = intent.direction === 'outgoing';
  const submittable = !isOutgoing && ['created','awaiting_signature','rejected','expired'].includes(state) && (!intent.expiresAt || intent.expiresAt > ctx.gameNow);
  const actualFee = intent.feeSatoshis ?? intent.receipt?.feeSatoshis;
  const confirmation = intent.receipt?.confirmations ?? intent.confirmations ?? 0;
  const fulfillment = intent.fulfillment;
  const recovery = fulfillment?.recovery;
  const outputs = intent.receipt?.allocations ?? intent.outputs;
  const sponsorOutputs = intent.action === 'sponsor-fund' ? list(outputs).filter(output => ['development','prize'].includes(output.role)) : [];
  const sponsorLabels = { development:'Development', prize:'Seasonal Prizes' };
  const booked=intent.satoshis??intent.amount;
  const outputTotal=isOutgoing?0:list(intent.outputs).reduce((total,output)=>total+(output.satoshis??0),0);
  const reserveAdded=outputTotal>booked?outputTotal-booked:0;
  const result=fulfillment?.result;
  let appliedDetail=result?.message;
  if (result && intent.action==='rush') {
    const job=result.queue?.find(order=>order.kind==='building'&&order.key===result.building);
    appliedDetail = job ? `The rushed construction now finishes at ${ctx.formatDate(job.completesAt)}.` :
      result.rushCredits?.[result.building] ? 'One rush credit is stored for the next upgrade.' : undefined;
  }
  if (result && intent.action==='premium' && result.perks?.[result.building]) appliedDetail=`Unlocked: ${result.perks[result.building].name}.`;
  if (result?.events) appliedDetail='The battle was recorded. Open its report for the actual result, losses, and rewards.';
  const fundingDetail={
    'vault-deposit':'The vault deposit is confirmed.', 'war-chest':'Your War Chest is funded. All of it is at risk in PvP.', 'sponsor-fund':'The confirmed Development and Seasonal Prize allocations are listed below.',
    withdraw:'The withdrawal of your earlier vault deposit is confirmed.', 'kingdom-withdraw':'The War Chest withdrawal is confirmed.',
    claim:'The reward payment is confirmed.'
  }[intent.action];
  const verifiedReceipt=intent.receipt && ['confirmed','credited'].includes(state);
  // Sent, not yet final: say what happens next and how long it usually takes.
  const sentWaiting=!isOutgoing && ['submitted','seen_in_mempool','confirming','uncertain'].includes(state);
  const needed=intent.appliesAfter??intent.minConfirmations??2;
  const arrives=intent.action==='war-chest' ? 'It joins your War Chest' : intent.action==='sponsor-fund' ? 'It joins the season rewards' : intent.action==='vault-deposit' ? 'It reaches your vault' : 'Your order is applied';
  const sentStatus=sentWaiting ? eventHero('event-vault','Payment sent · '+confirmationText(intent),
    'Your wallet sent '+number(booked)+' sats',
    fulfillment?.status==='applied' ? (appliedDetail ?? 'Applied.') :
    arrives+' after '+needed+' confirmation'+(needed===1?'':'s')+', usually about '+(needed*10)+' minutes. You get a notification.') : '';
  const paymentStatus=verifiedReceipt ? eventHero('event-vault','Verified ' + NETWORK_LABEL + ' receipt',
    fulfillment?.status==='review' ? 'Payment verified · order needs review' : fulfillment?.status==='credit' ? 'Payment verified · the service is owed to you' : fulfillment?.redeemedCredit ? 'Paid earlier · delivered now' : fulfillment?.status==='applied' ? 'Payment verified · order recorded' : 'Payment confirmed',
    `${number(booked)} sats${actualFee!=null?` · ${number(actualFee)} sat network fee`:''}. ${appliedDetail??fundingDetail??''}`.trim()) : '';
  return modal(intent.title ?? title(intent.action),
    `${paymentStatus}${sentStatus}<p>${tag(intent.attestation && !intent.attestation.complete && state === 'created' ? 'Awaiting prize attestors · ' + intent.attestation.signed.length + ' of ' + intent.attestation.attestors.length + ' signed' : statusLabel[state] ?? title(state),cssStatus(state))} ${tag(ctx.ui.state.chain?.simulated?'Local simulation':'' + NETWORK_LABEL + '')}</p>
    ${intent.description ? '<p>' + html(intent.description) + '</p>' : ''}
    ${NETWORK.realValue && submittable ? '<p class="quiet-text">Real BCH: a sent payment cannot be reversed.</p>' : ''}
    <dl class="kv">
      <dt>${reserveAdded ? 'Price' : 'Amount'}</dt><dd><strong>${number(intent.satoshis ?? intent.amount)} sats</strong> · ${html(bch(intent.satoshis ?? intent.amount))} BCH</dd>
      ${reserveAdded ? '<dt>Your wallet sends</dt><dd><strong>' + number(outputTotal) + ' sats</strong> (incl. ' + number(reserveAdded) + ' sat network reserve)</dd>' : ''}
      ${actualFee != null ? '<dt>Network fee</dt><dd>' + number(actualFee) + ' sats</dd>' : ''}
      ${intent.expiresAt && submittable ? '<dt>Expires</dt><dd>' + timer(intent.expiresAt,ctx.gameNow) + '</dd>' : ''}
      ${visibleTxid ? '<dt>Confirmations</dt><dd>' + number(confirmation) + '</dd>' : ''}
    </dl>
    <details class="payment-details"><summary>Payment details</summary>
      <dl class="kv">
        ${!intent.outputs || isOutgoing ? '<dt>Destination</dt><dd class="transaction-id">' + html(address ?? '—') + '</dd>' : ''}
        ${visibleTxid ? '<dt>Transaction ID</dt><dd class="transaction-id">' + html(visibleTxid) + '</dd>' : ''}
        ${intent.receipt?.vout != null ? '<dt>Output index</dt><dd>' + number(intent.receipt.vout) + '</dd>' : ''}
      </dl>
      ${outputs?.length ? well('Outputs', outputs.map(output => row(
        sponsorOutputs.length && sponsorLabels[output.role] ? sponsorLabels[output.role] : output.label ?? title(output.role), number(output.satoshis) + ' sat' +
        (output.vout == null ? '' : ' · output ' + output.vout))).join('')) : ''}
      ${sponsorOutputs.length ? `<dl class="kv">${sponsorOutputs.map(output =>
        `<dt>${html(sponsorLabels[output.role])}</dt><dd class="transaction-id">${html(output.address)}</dd>`).join('')}</dl>` : ''}
    </details>
    ${visibleTxid&&!ctx.ui.state.chain?.simulated ? receiptLink(intent,visibleTxid) : ''}
    ${fulfillment?.status === 'credit' ? well('Owed to you',
      `<p>${html(fulfillment.reason)}</p><p>Your next ${html(creditNames[intent.action] ?? 'action of this kind')} is free.</p>`) :
      fulfillment?.redeemedCredit ? '<p>' + tag('Delivered from a service you had already paid for','success') + '</p>' :
      recovery?.pool === 'kingdom' ? well('Returned to your War Chest',
      `<p>${number(recovery.satoshis)} sats are in your War Chest.</p><p>${html(fulfillment.reason)}</p>` + gameLink('Open War Chest','/council.html','vault')) :
      fulfillment?.status === 'review' ? '<p class="form-error">Payment verified. Fulfillment needs review. ' + html(fulfillment.reason) + '</p>' :
      fulfillment?.status === 'applied' ? '<p>' + tag('Done','success') + '</p>' : ''}
    ${fulfillment?.result?.events ? '<div class="buttons">' + btn('Open battle report','war',{modal:'battle',id:fulfillment.result.id},'primary') + '</div>' : ''}
    ${neverPaid(intent) ? '<p>Not paid. No BCH was sent for this order, so nothing was spent. You can start it again any time.</p>' :
      typeof intent.lastError === 'string' ? '<p class="form-error">' + html(intent.lastError) + '</p>' : ''}
    ${submittable ? !ctx.ui.state.chain?.enabled ? '<p>' + NETWORK_LABEL + ' checkout is currently offline. You can keep this receipt for reference.</p>' :
      '<p>Approve it in your wallet. This window updates by itself.</p>' +
      (ctx.ui.state.chain?.walletConnect?walletTray(intent):'<p>Wallet pairing is disabled on this server.</p>') : ''}
    ${!submittable ? '<div class="buttons">' + btn('Transaction journal','journal',{modal:'journal'}) + '</div>' : ''}`);
}
function treasuryDialog(ctx, mode) {
  const chest = mode === 'chest';
  const deposit = mode === 'deposit' || chest;
  const sponsor = mode === 'sponsor';
  const claim = mode === 'claim';
  const data = ctx.ui.state.vault ?? {};
  const sponsorRules = data.sponsorshipPolicy ?? { minimumSatoshis:25_000_000, maximumSatoshis:2_500_000_000, satoshiStep:10, developmentPercent:30, prizePercent:70 };
  const verifiedWallet = ctx.ui.state.wallet?.address;
  const heading = chest ? 'Fund your War Chest' : deposit ? 'Deposit ' + NETWORK_LABEL + ' BCH' : sponsor ? 'Fund the season rewards' : claim ? 'Claim a season reward' : 'Withdraw your earlier vault deposit';
  const consent = chest ? 'I put these funds at risk in PvP. An attacker who stakes the same amount and wins takes it from my War Chest.' : deposit ? 'I consent to a ' + NETWORK_LABEL + ' deposit locked to my vault covenant with zero PvP exposure.' :
    sponsor ? 'I consent to the irreversible sponsorship allocation.' :
    'I approve the destination and the ' + NETWORK_LABEL + ' network fee deducted from the pool.';
  const check = `<label class="checkbox"><input type="checkbox" name="consent" value="true" required><span>${html(consent)}</span></label>`;
  // Rewards and withdrawals always go to the wallet the player connected. There is no address to type.
  if (!deposit && !sponsor && !verifiedWallet) return modal(heading, '<p>Connect your wallet first. ' + (claim ? 'The award is paid' : 'The money is paid out') + ' to your connected ' + NETWORK_LABEL + ' wallet.</p>' + btn('Connect wallet','bch',{modal:'wallet','return-wallet-mode':claim?'claim':null},'primary'));
  const amountLimits = sponsor ? `min="${sponsorRules.minimumSatoshis}" max="${sponsorRules.maximumSatoshis}" step="${sponsorRules.satoshiStep}"` :
    chest ? `min="${data.minimumDepositSatoshis ?? 10000}" max="250000" step="${data.depositStepSatoshis ?? 1000}"` : deposit ? 'min="1000" max="250000" step="1"' : 'min="600" step="1"';
  const quantity = claim ? `<p>Claimable ${bch(data.claimableSatoshis)} BCH${data.claimDeadline ? ' until ' + html(formatDate(data.claimDeadline)) : ''}.</p>` :
    input('Amount in satoshis','satoshis', chest ? String(data.minimumDepositSatoshis ?? 10000) : deposit || sponsor ? '5000' : '', 'number', amountLimits);
  const details = deposit || sponsor ? check : hidden('address', verifiedWallet) +
    `<p class="paid-to">Paid to your connected wallet <span class="transaction-id">${html(verifiedWallet)}</span></p>`;
  const help = chest ? 'All of it is at risk in PvP raids. Lose a raid and the attacker takes their stake; win and you take theirs. You can always take it out with your wallet (about 2 days).' : deposit ? 'Deposits become available for withdrawal after confirmation.' : sponsor ?
    `${number(sponsorRules.prizePercent)}% goes to the season prize pool, ${number(sponsorRules.developmentPercent)}% to Development. ${number(sponsorRules.minimumSatoshis)}–${number(sponsorRules.maximumSatoshis)} sats, in steps of ${number(sponsorRules.satoshiStep)}.` :
    claim ? 'The award goes to the wallet you connected. The prize pool covers the network fee.' :
    'The game key co-signs; the vault contract only lets this deposit return to the wallet you verified when you made it.';
  return modal(heading,
    `<p>${help}</p>` +
    form(mode,quantity + details,submit(deposit || sponsor ? 'Create payment intent' : 'Review ' + NETWORK_LABEL + ' payout','bch','primary')));
}
function payoutReview(ctx) {
  const quote = ctx.ui.dialog.quote;
  if (!quote) return modal('Review ' + NETWORK_LABEL + ' payout',empty('The payout quote is unavailable.'));
  const total = BigInt(quote.satoshis) + BigInt(quote.feeSatoshis);
  return modal(quote.kind === 'claim' ? 'Confirm season reward' : 'Confirm vault withdrawal',
    `<p>Confirm this operator-signed transfer on ${NETWORK_LABEL}. The recipient receives the exact amount below. The vault or sponsor pool covers the network fee.</p>
    <dl class="kv"><dt>Destination</dt><dd class="transaction-id">${html(quote.address)}</dd>
      <dt>Recipient receives</dt><dd>${bch(quote.satoshis)} BCH · ${number(quote.satoshis)} sat</dd>
      <dt>Network fee</dt><dd>${bch(quote.feeSatoshis)} BCH · ${number(quote.feeSatoshis)} sat</dd>
      <dt>Pool debit</dt><dd>${bch(total)} BCH</dd></dl>` +
    form('payout-confirm',
      hidden('kind',quote.kind) + hidden('address',quote.address) + hidden('satoshis',quote.satoshis) + hidden('feeSatoshis',quote.feeSatoshis) +
      '<label class="checkbox"><input type="checkbox" name="consent" value="true" required><span>I approve the exact destination, amount and fee.</span></label>',
      submit('Authorize ' + NETWORK_LABEL + ' payout','bch','primary') + btn('Back','arrow',{modal:quote.kind})));
}
function walletBalance(ctx) {
  const current = ctx.ui.walletAssets;
  if (current?.wallet?.address !== walletAddress(ctx.ui.state.wallet)) return null;
  if (typeof current?.whole?.totalSatoshis === 'number') return current.whole.totalSatoshis;
  return typeof current?.balance === 'number' ? current.balance : current?.balance?.confirmedSatoshis;
}
function walletAssets(ctx) {
  const ui = ctx.ui;
  const address = walletAddress(ui.state.wallet);
  if (!address) return '<p>Connect your ' + NETWORK_LABEL + ' wallet to see BCH and CashTokens.</p>'+
    btn('Connect wallet','bch',{modal:'wallet'},'primary');
  const current = ui.walletAssets?.wallet?.address === address ? ui.walletAssets : null;
  const tokens = current?.tokens;
  return `<p class="transaction-id">${html(address)}</p>
    <div class="buttons">${btn('Copy address','copy',{copy:address})}
    ${btn(ui.walletLoading ? 'Refreshing balance…' : 'Refresh balance','journal',{ 'wallet-assets':'true' },'primary',ui.walletLoading||!ui.state.chain?.walletRead)}</div>
    ${ui.walletError ? '<p class="form-error">' + html(ui.walletError) + '</p>' : ''}
    <p>Wallet BCH · ${walletBalance(ctx) == null ? 'Balance unavailable' : bch(walletBalance(ctx)) + ' BCH'}
    ${current?.observedAt ? ' · Checked '+html(formatDate(current.observedAt)) : ''}</p>
    ${current?.whole ? `<p class="quiet-text">Whole wallet: ${number(current.whole.checked)} addresses checked${current.whole.funded.length ? ', funds on ' + current.whole.funded.length : ''}.</p>
      ${current.whole.funded.length ? `<details><summary>Where your BCH is</summary>${current.whole.funded.map(item => row(bch(item.satoshis) + ' BCH · ' + (item.path === 'change' ? 'change' : 'receiving') + ' address ' + number(item.index), item.address)).join('')}</details>` : ''}` :
      current ? '<p class="quiet-text">This is the receiving address only. Connect your wallet to see the whole wallet.</p>' : ''}
    ${current ? `<details><summary>${current.whole ? 'CashTokens in your wallet' : 'CashTokens for this address'}</summary>${tokens == null ? empty('CashTokens index lookup unavailable.') : !tokens.length ? empty(current.whole ? 'No confirmed CashTokens found in your wallet.' : 'No confirmed CashTokens found for this address.') : tokens.map(token =>
        `<div class="row"><div>${tag(token.capability == null ? 'Fungible token' : 'NFT', 'success')}
          <dl class="kv"><dt>Category</dt><dd class="transaction-id">${html(token.category)}</dd>
          <dt>Output</dt><dd class="transaction-id">${html(token.txid)}:${number(token.vout)}</dd>
          <dt>Confirmations</dt><dd>${number(token.confirmations)}</dd>
          <dt>Amount</dt><dd>${html(token.amount)}</dd>
          ${token.capability == null ? '' : '<dt>Capability</dt><dd>' + html(token.capability) + '</dd><dt>Commitment</dt><dd class="transaction-id">' + html(token.commitment || '(empty)') + '</dd>'}</dl>
          ${receiptLink(token,token.txid)}</div></div>`).join('')}</details>` : ''}`;
}
function walletDialog(ctx) {
  const wallet = ctx.ui.state.wallet;
  const session=wizardState();
  const active=walletAddress(wallet);
  const verified=Boolean(active&&wallet?.address===active);
  const returnTerritory=ctx.ui.dialog.returnTerritory;
  const returnWalletMode=ctx.ui.dialog.returnWalletMode;
  const challenge = ctx.ui.dialog.challenge;
  const address = ctx.ui.dialog.address;
  const generate = form('wallet-challenge',
    input('' + NETWORK_LABEL + ' CashAddr','address',address ?? active ?? '','text','maxlength="150" autocomplete="off" spellcheck="false"'),
    submit('Create ownership challenge','lock','primary'));
  const verify = challenge ? well('Sign ownership challenge',
    `<p>Copy this exact text to your ${NETWORK_LABEL} wallet’s Sign Message tool and paste its Base64 signature below. If you use the VaultBorn CLI, paste the 128-character signature and its public key. A signed message is free and spends no BCH.</p>
      <div class="wallet-challenge transaction-id">${html(challenge)}</div>
      ${btn('Copy challenge','copy',{copy:challenge})}` +
    form('wallet-verify',
      hidden('address',address) +
      field('Compressed public key (legacy proof only)','publicKey',`<input name="publicKey" value="${html(address===session.address?session.publicKey:'')}" maxlength="66" pattern="[A-Fa-f0-9]{66}" autocomplete="off" spellcheck="false">`) +
      input('Ownership signature','signature','','text','maxlength="128" minlength="88" autocomplete="off" spellcheck="false"'),
      submit('Verify ownership','check','primary'))) : '';
  const proof = ctx.ui.walletProof;
  const connected = Boolean(session.address && ['ready','signing','broadcasting'].includes(session.status));
  // Three things a player can see here: connected and verified; connected and being verified; or what went wrong and one button to try again.
  // The wallet belongs to another kingdom: one button opens it (this kingdom is left; without a wallet it cannot be opened again).
  const otherKingdom = proof?.openOther ? `<p>${tag('Another kingdom','quiet')} ${html(proof.error)}</p><p>${ctx.ui.state.signIn?.bch||ctx.ui.state.signIn?.nostr?'You can come back to this kingdom later with its own sign-in.':'This kingdom has no wallet, so you cannot come back to it after you switch.'}</p><div class="buttons">${btn('Open that kingdom','arrow',{'wallet-open-other':'true'},'primary')}</div>` : '';
  const status = otherKingdom ? otherKingdom : !active ? '' : verified ? '<p>' + tag(connected ? 'Wallet connected and verified' : 'Wallet verified','success') + (connected || !ctx.ui.state.chain?.walletConnect ? '' : ' Connect it again to pay or sign.') + '</p>' :
    proof?.asking || session.proving ? '<p role="status">' + tag('Verifying','quiet') + ' Approve the request in your wallet. It proves the wallet is yours; it sends nothing and spends nothing.</p>' :
    connected ? `<p>${tag('Not verified yet','quiet')} ${html(proof?.error ?? 'The wallet has not approved the check yet.')}</p><div class="buttons">${btn('Verify wallet now','check',{'wallet-prove':'true'},'primary')}</div>` :
    '<p>' + tag('Wallet not connected right now','quiet') + '</p>';
  return modal('' + NETWORK_LABEL + ' wallet',
    `${ctx.ui.dialog.notice?'<p class="form-error" role="alert">'+html(ctx.ui.dialog.notice)+'</p>':''}
    ${returnTerritory?'<div class="buttons">'+btn('Return to territory','arrow',{'wallet-return':returnTerritory},verified?'primary':'')+'</div>':''}
    ${returnWalletMode==='claim'?'<div class="buttons">'+btn('Return to reward claim','arrow',{'wallet-return-mode':returnWalletMode},verified?'primary':'')+'</div>':''}
    ${ctx.own.founding&&ctx.ui.state.chain?.walletConnect?'<p>Already have a kingdom? Connect its wallet and it opens.</p>':''}
    <p>${ctx.ui.state.chain?.walletConnect?'Connect your ' + NETWORK_LABEL + ' wallet. It is verified in the same step: your wallet asks you to approve a check that sends nothing and spends nothing. After that you can pay, raid and withdraw.':
      'Wallet pairing is disabled on this server. You can still prove a ' + NETWORK_LABEL + ' receiving address with a signed message below.'}${ctx.ui.state.chain?.walletConnect&&!ctx.ui.state.chain?.enabled?' ' + NETWORK_LABEL + ' checkout is currently offline.':''}</p>
    ${ctx.ui.state.chain?.walletConnect?walletTray():''}
    ${status}${active ? walletAssets(ctx) : ''}
    ${challenge ? verify : '<details '+(!ctx.ui.state.chain?.walletConnect&&!verified?'open':'')+'><summary>Other way: verify an address with a signed message</summary><p>Only needed for a wallet that cannot pair with WizardConnect.</p>' + generate + '</details>'}`);
}
function profileDialog(ctx) {
  const {own,ui} = ctx;
  const settings = own.settings ?? {};
  const checkbox = (label,name,checked) => `<label class="checkbox"><input name="${name}" type="checkbox" value="yes" ${checked ? 'checked' : ''}><span>${html(label)}</span></label>`;
  const slider = (label, name, value) => field(label,name,`<input name="${name}" type="range" min="0" max="100" step="1" value="${html(value)}">`);
  return modal('Profile & settings',`
    <div class="profile-title">${crest(own)}<div><span class="kicker">${html(ctx.factionName(own))}</span><h2>${html(own.owner)}</h2></div></div>
    <p>${html(own.name)} · ${own.optIn ? 'In the season' : 'Not in the season'}</p>
    <div class="buttons">
      ${own.founding ? btn('Choose faction & found city','city',{modal:'found'},'primary') : ''}
      ${guideButton(own,'Play tutorial')}
      ${guideLink('')}
      ${btn(own.optIn ? 'Leave the season' : 'Join the season','war',{modal:'enroll'},own.optIn?'':'primary')}
      ${btn(walletLabel(ui.state.wallet),'bch',{modal:'wallet'})}
      ${btn(ui.state.identity?.walletMatches && ui.state.identity?.status==='active' ? 'Verified BCH + Nostr identity' : 'Decentralized identity','journal',{modal:'identity'})}
      ${btn('Sign out','arrow',{modal:'sign-out'})}
    </div>
    ${values('Kingdom muster',[['Matchmaking power',number(own.power)],['Available troops',number(own.stats?.military?.available)],
      ['Deployed troops',number(own.stats?.military?.deployed)],['Holdings',number(ui.state.territories?.filter(site=>site.controller===own.id).length)],
      ['Commander',labelOf(ui.state.config.heroes[own.hero],own.hero)],['Season score',number(own.score)]])}
    ${well('Resource stores',costs(own.resources))}
    ${values('BCH balances',[['Receiving address BCH',bch(walletBalance(ctx))],['Personal vault BCH',bch(ui.state.vault?.depositedSatoshis)],
      ...(ui.state.vault?.warChestSatoshis != null ? [['War Chest BCH (all at risk)',bch(ui.state.vault.warChestSatoshis)]] : [])])}
    ${well('Accessibility',form('settings',
      checkbox('Reduce motion','reducedMotion',settings.reducedMotion) +
      checkbox('High contrast','highContrast',settings.highContrast) +
      checkbox('Mute audio','muted',settings.muted ?? false) +
      slider('Music volume','musicVolume',settings.musicVolume ?? 42) +
      slider('Effects volume','sfxVolume',settings.sfxVolume ?? 65),submit('Save settings','settings','primary'))+
      '<p class="quiet-text">Music: Legionnaire, Age of Wonder and Song Of The Forge by Scott Buckley (<a href="https://www.scottbuckley.com.au" target="_blank" rel="noopener noreferrer">scottbuckley.com.au</a>), <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.</p>')}`);
}
function tutorialDialog(ctx) {
  const { own } = ctx;
  if (own.onboarding) return modal('Your first campaign', `<p>Captain Elowen is ready to resume your training.</p>${guideButton(own)}`);
  const trail = [
    [own.collectAvailableAt > ctx.gameNow, 'Open My City and collect your daily supplies.'],
    [list(own.queue).some(job => job.kind === 'building') || list(own.history).some(job => job.kind === 'building'), 'Start a standard upgrade with city resources.'],
    [list(own.queue).some(job => job.kind === 'troop') || list(own.history).some(job => job.kind === 'troop'), 'Train recruits in the barracks.'],
    [list(ctx.ui.state.missions).length > 0, 'Dispatch a scout to reveal a rival’s garrison.'],
  ];
  return modal('Your first campaign',`<ol class="tutorial-steps">
    ${trail.map(([done,label]) => `<li class="${done ? 'objective-complete' : ''}">${done ? icon('check') : icon('quest')}${html(label)}</li>`).join('')}</ol>
    <p>Seasonal PvP is voluntary. Eligible free raids and paid raids share the same cooldown and daily limit.</p>
    <div class="buttons">
      ${command('Complete tutorial','check',{type:'tutorial'},'primary',!ctx.own.guideOpen)}
      ${btn('Read campaign guide','book',{'show-guide':'true'})}
      ${btn('Open My City','city',{page:'city',dismiss:'true'})}
    </div>`);
}
// The tutorial and the instructions, offered once to a kingdom that has just signed up and always from the corner button.
function learnDialog(ctx, first) {
  const progress = ctx.own.onboarding;
  const tutorialLabel = progress?.status === 'paused' ? 'Resume the tutorial' : progress?.status === 'active' && progress.step !== 'welcome' ? 'Continue the tutorial' : 'Start the tutorial';
  return modal(first ? 'Welcome to VaultBorn' : 'Tutorial and instructions',
    eventHero('event-season', first ? 'Your kingdom is ready' : 'Learn the game', first ? 'Where would you like to begin?' : 'Need a hand?',
      'The tutorial walks you through your first steps, one at a time: your homeland, building, troops, your commander and your first battle. The instructions explain every rule of the game, to read at your own pace.') +
    `<div class="learn-choices">
      ${btn(tutorialLabel,'quest',{learn:'tutorial'},'primary')}
      ${btn('Read the instructions','book',{learn:'instructions'})}
      ${btn(first ? 'Skip' : 'Close','close',{learn:'close'})}
    </div>
    <p class="quiet-text">${first ? 'You can open both at any time with the Tutorial button in the bottom-left corner.' : 'This button stays in the bottom-left corner.'}</p>`);
}
function nodeDialog(ctx,id) {
  const site = list(ctx.ui.state.territories).find(item => item.id === id);
  return site ? modal(site.name,territoryDetail(ctx,site)) : modal('Territory',empty('This territory is unavailable.'));
}
const treatyKinds = [['defense','Defense pact'],['nonaggression','Nonaggression pact'],['ceasefire','Ceasefire'],['war','War declaration'],['demand','Diplomatic demand'],['trade','Trade accord']];
function allianceDialog(ctx,mode,id) {
  const ownAlliance = ctx.ui.state.alliance;
  if (mode === 'treaty') return modal('Diplomatic order',form('treaty',
    dropdown('Recipient alliance','target',list(ctx.ui.state.alliances).filter(item => item.id !== ownAlliance?.id).map(item => [item.id,item.name])) +
    dropdown('Order','kind',treatyKinds),submit('Issue order','flag','primary')));
  if (mode === 'invite') return modal('Invite to alliance',form('alliance-invite',
    dropdown('City','target',cityOptions(ctx,city => !city.alliance && !city.npc)),
    submit('Send invitation','send','primary')));
  if (mode === 'leave') return modal('Leave alliance',`<p>Leaving starts a 24-hour transfer cooldown.</p>${command('Confirm departure','arrow',{type:'alliance-leave'},'attack')}`);
  return modal('Transfer aid',form('aid',dropdown('Recipient city','target',cityOptions(ctx),id) +
    dropdown('Resource','resource',resources.map(id => [id,title(id)])) +
    input('Amount','amount','50','number','min="10" max="500" step="1"'),submit('Send aid','relief','primary')));
}

export function renderDialog(ctx) {
  const {mode,id} = ctx.ui.dialog;
  switch (mode) {
    case 'building': return buildingDialog(ctx,id)+(ctx.ui.dialog.guided?'':guideLink('city','Learn about construction'));
    case 'training': return trainingDialog(ctx,id);
    case 'formation': return formationDialog(ctx);
    case 'commander': return commanderDialog(ctx,id);
    case 'daily': return modal('Daily supplies',dailyContents(ctx.own.dailyReward,ctx.gameNow,command('Claim daily supplies','gift',{type:'collect'},'primary')));
    case 'dispatch': return modal(ctx.ui.dialog.presentation?.title??'Kingdom dispatch',achievementDialog(ctx.ui.dialog.presentation));
    case 'offline-report': return modal('While you were away',offlineContents(ctx.ui.state.offlineReport));
    case 'bch': return modal('Use BCH',bchActionsContents(ctx));
    case 'next': return modal('What next',whatNextContents(whatNext({own:ctx.own,state:ctx.ui.state,guide:ctx.ui.guide,walletLinked:Boolean(ctx.ui.state.wallet?.address)}),ctx.own));
    case 'attack': return attackDialog(ctx,id)+guideLink('raids','Learn about raid rules');
    case 'expedition': return expeditionDialog(ctx,id)+guideLink('raids','Learn about expeditions');
    case 'npc-court': return npcCourtDialog(ctx,id);
    case 'protectorate': return protectorateDialog(ctx,id)+guideLink('politics','Learn about protectorates');
    case 'scout': return scoutDialog(ctx,id,false)+guideLink('raids','Learn about espionage');
    case 'decoy': return scoutDialog(ctx,id,true)+guideLink('raids','Learn about espionage');
    case 'report': return modal('Intelligence report',intelDetails(list(ctx.ui.state.intelArchive).find(item => item.id === id),ctx));
    case 'battle': return battleDialog(ctx,id);
    case 'journal': return modal('' + NETWORK_LABEL + ' journal',`<p>${ctx.ui.state.chain?.enabled ? 'Confirmation policy: ' + ctx.ui.state.chain.minConfirmations + ' blocks.' : 'Configured ' + NETWORK_LABEL + ' payment and observation services are unavailable.'}</p>${paymentRows(ctx)}`);
    case 'payment': return paymentDialog(ctx,id)+guideLink('blockchain','Learn about BCH payments');
    case 'chest':
    case 'deposit':
    case 'withdraw':
    case 'sponsor':
    case 'claim': return treasuryDialog(ctx,mode);
    case 'payout-review': return payoutReview(ctx);
    case 'profile': return profileDialog(ctx);
    case 'codex': return modal('Game guide',renderCodex(ctx.ui.state,id)+(ctx.ui.dialog.back?btn('Back to previous screen','arrow',{'codex-back':'yes'}):''));
    case 'sign-out': return ctx.ui.state.signIn?.bch||ctx.ui.state.signIn?.nostr ?
      modal('Sign out',`<p>Your kingdom stays here. To return, use ${ctx.ui.state.signIn?.bch&&ctx.ui.state.signIn?.nostr?'your BCH wallet or Nostr key':ctx.ui.state.signIn?.bch?'your verified BCH wallet':'your linked Nostr key'}.</p>${btn('Confirm sign out','check',{'confirm-sign-out':'yes'},'primary')}<p class="form-error" role="alert"></p>`) :
      // A new kingdom without a wallet: signing out leaves it for good. Connecting a wallet keeps it.
      modal('Sign out',`<p>This kingdom has no wallet yet. If you sign out now, you cannot come back to it.</p><p>To keep it, connect a wallet first. To use a kingdom you already have, sign out and connect that kingdom's wallet on the start page.</p><div class="buttons">${btn('Connect wallet','bch',{modal:'wallet'},'primary')}${btn('Sign out and leave this kingdom','arrow',{'confirm-sign-out':'for-good'})}</div><p class="form-error" role="alert"></p>`);
    case 'identity': return modal('Decentralized identity',renderIdentity(ctx));
    case 'tutorial': return tutorialDialog(ctx);
    case 'welcome':
    case 'learn': return learnDialog(ctx, ctx.ui.dialog.mode === 'welcome');
    // A new kingdom must be named before the game opens: this dialog cannot be closed.
    case 'found': return lockedModal('Found a city',eventHero('event-season','Your founding charter','Claim your banner')+
      '<p class="founding-hint">Choose a name and a banner for your city. You’ll begin with a protected Starter Territory and a garrison.</p>'+form('found',
      // Each kingdom starts with names of its own; the player may keep them or write new ones.
      input('Commander name','name',ctx.own.owner === 'New Commander' ? '' : ctx.own.owner,'text','maxlength="30" minlength="2" placeholder="Your name as commander"') +
      input('Settlement name','cityName',ctx.own.name === 'New Settlement' ? '' : ctx.own.name,'text','maxlength="30" minlength="2" placeholder="Name your city"') +
      '<p class="founding-hint">Keep these names or write your own.</p>' +
      dropdown('Faction','faction',configs(ctx.ui.state.config.factions),ctx.own.faction), submit('Found city','city','primary')) +
      '<div class="buttons">'+btn('Sign in to an existing kingdom','bch',{modal:'wallet'})+'</div>');
    case 'wallet': return walletDialog(ctx)+guideLink('blockchain','Learn about your wallet');
    // Shown once, right after the welcome, to a kingdom that has no wallet yet.
    case 'wallet-prompt': return modal('Connect your wallet',eventHero('event-vault','Keep your kingdom','Connect your BCH wallet',
      'Your kingdom is tied to your wallet. Without one, your progress lives only in this browser and can be lost. Every payment in the game is also approved in your wallet.')+
      `<div class="learn-choices">${btn('Connect wallet','bch',{modal:'wallet'},'primary')}${btn('Not now','close',{'wallet-later':'true'})}</div>`);
    case 'enroll': return modal('Seasonal PvP',`<p>${ctx.own.optIn ? 'Leaving seasonal PvP suspends normal attacks, espionage and protectorate proposals while your city continues producing resources.' :
      'Joining seasonal PvP allows eligible cities to scout and attack your city under the published matchmaking and cooldown rules. Loot uses earned resources.'}</p>${command(ctx.own.optIn ? 'Confirm leaving' : 'Opt in to season','war',{type:'opt-in',enabled:!ctx.own.optIn},'primary')}`);
    case 'inbox': {
      const notifications = list(ctx.ui.state.notifications);
      const work = activeWork(ctx);
      return modal('Notifications',
        `<section class="work-list" aria-label="In progress"><h3>In progress <span class="count">${number(work.length)}</span></h3>${work.length ? work.map(item => workRow(item,ctx)).join('') : empty('Nothing is running right now.')}</section>`+
        (ctx.ui.state.offlineReport?'<div class="buttons">'+btn('While you were away','journal',{modal:'offline-report'},'primary')+'</div>':'')+
        `<h3>History</h3>`+(notifications.length ? notifications.map(eventDispatch).join('') : empty('No notifications yet.')));
    }
    case 'treaty':
    case 'aid':
    case 'invite':
    case 'leave': return allianceDialog(ctx,mode,id);
    case 'node': return nodeDialog(ctx,id)+guideLink('territory','Learn about territory');
    case 'political': return renderPoliticalDialog(ctx)+guideLink('politics','Learn about diplomacy');
    default: return modal('Campaign',empty('Choose an available action.'));
  }
}

export function formAnswer(mode,data) {
  if (mode.startsWith('political-')) return politicalFormAnswer(mode,data);
  const typed = payload => ({command:{type:mode,...payload}});
  switch (mode) {
    case 'attack': {
      const {target,tactic,formation,hero,paid,stake} = data;
      return paid === '1' ? {payment:{type:'attack-paid',target,tactic,formation,hero,...(stake && {stake:Number(stake)})}} : typed({target,tactic,formation,hero});
    }
    case 'territory-attack': return {payment:{type:mode,...data}};
    case 'expedition':
    case 'frontier-conquest': return typed(data);
    case 'territory-garrison':
    case 'territory-aid': return typed({...data,count:Number(data.count)});
    case 'scout':
    case 'found':
    case 'configure':
    case 'chat':
    case 'rally':
    case 'alliance-create':
    case 'alliance-invite':
    case 'treaty': return typed(data);
    case 'train': return typed({...data,count:Number(data.count)});
    case 'aid': return typed({...data,amount:Number(data.amount)});
    case 'trade': return typed({...data,amount:Number(data.amount),quotedReceived:data.quotedReceived===''?undefined:Number(data.quotedReceived)});
    case 'settings': return typed({muted:data.muted === 'yes',reducedMotion:data.reducedMotion === 'yes',highContrast:data.highContrast === 'yes',
      musicVolume:Number(data.musicVolume),sfxVolume:Number(data.sfxVolume)});
    case 'chest':
    case 'deposit':
    case 'sponsor': return {payment:{type:mode === 'chest' ? 'war-chest' : mode === 'deposit' ? 'vault-deposit' : 'sponsor-fund',satoshis:Number(data.satoshis),consent:data.consent === 'true'}};
    case 'withdraw':
    case 'claim': return {route:'/vault/quote',body:{kind:mode,satoshis:Number(data.satoshis || 0),address:data.address.trim()}};
    case 'payout-confirm': {
      const satoshis = Number(data.satoshis);
      return {route:'/vault/payout',body:{kind:data.kind,satoshis,address:data.address,consent:data.consent === 'true',
        expectedFee:Number(data.feeSatoshis),expectedSatoshis:satoshis}};
    }
    case 'wallet-challenge': return {route:'/wallet/challenge',body:{address:data.address.trim()}};
    case 'wallet-verify': return {route:'/wallet/verify',body:{address:data.address.trim(),signature:data.signature.trim(),
      ...(/^[a-fA-F0-9]{128}$/.test(data.signature.trim())&&{publicKey:data.publicKey.trim()})}};
    default: return null;
  }
}
