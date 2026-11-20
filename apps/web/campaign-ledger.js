import { icon } from './icons.js';
import { bch,btn,costs,duration,formatDate,html,list,number,resources,title } from './view.js';

const portraits={wood:'farm-1',stone:'walls-1',iron:'workshop-1',food:'farm-2',crystal:'vault-2'};
export const eventHero=(art,kicker,name,detail='')=>`<div class="dispatch-hero"><img src="/art/${art}.webp" alt=""><div>
  <span class="kicker">${html(kicker)}</span><strong>${html(name)}</strong>${detail?`<p>${html(detail)}</p>`:''}</div></div>`;
const signed=(value,fmt=number)=>String(value>0?'+':'')+fmt(value);
const fmtRate=new Intl.NumberFormat('en-US',{maximumFractionDigits:4});

export function supplyCards(items,{sign=false}={}) {
  return `<div class="supply-cards">${resources.filter(id=>Number.isFinite(items?.[id])).map(id=>`<div class="supply-card r-${id}">
    <img src="/art/${portraits[id]}.webp" alt=""><span>${icon(id)}${title(id)}</span><b>${sign?signed(items[id]):number(items[id])}</b></div>`).join('')}</div>`;
}

export function dailyContents(reward,now,onClaim) {
  if (!reward) return '<p>The quartermaster is checking the stores.</p>';
  const receipt=reward.lastClaim;
  const active=reward.status==='available';
  return eventHero('event-vault','Quartermaster’s grant','Daily tribute',
    active?'A new shipment has reached your gates.':'The quartermaster has closed today’s ledger.')+
    `<p class="supply-state">${active?'Ready to claim':'Already claimed'} · Common supply grant</p>`+
    supplyCards(active?reward.claimable:(receipt?.collected??reward.reward))+
    (active?`<p>Only resources that fit in your stores will be added.</p><div class="buttons">${onClaim}</div>`:
      `<p>Next shipment in <time data-until="${reward.availableAt}">${duration(reward.availableAt-now)}</time>.</p>`);
}

export function tradeBalances(own) {
  return supplyCards(own.resources);
}

export function marketQuoteView(quote) {
  const token=(caption,id,quantity,balance)=>`<div class="market-token r-${id}"><img src="/art/${portraits[id]}.webp" alt="">
    <div><span class="kicker">${caption}</span><strong>${html(number(quantity))} ${html(title(id))}</strong><small>In store: ${number(balance)}</small></div></div>`;
  return `<div class="market-exchange">${token('You give',quote.give,quote.amount,quote.balance)}
    <span aria-hidden="true">${icon('arrow')}</span>${token('You receive',quote.take,quote.received,quote.receiveBalance)}</div>
    <p class="market-rate">Rate ${fmtRate.format(quote.unitRate)} ${html(title(quote.take))} per ${html(title(quote.give))} ·
    ${number(quote.receiveCapacity)} receiving storage · Rounded down to whole units${quote.feePercent!=null?` · market spread ${fmtRate.format(quote.feePercent)}%`:''}.</p>
    ${quote.reason?`<p class="strategy-note">${html(quote.reason)}</p>`:''}`;
}

export function tradeHistory(history) {
  return list(history).slice(0,8).map(item=>`<div class="market-history-row"><span>${icon(item.give)} −${number(item.amount)} ${html(title(item.give))}</span>
    ${icon('arrow')}<strong>${icon(item.take)} +${number(item.received)} ${html(title(item.take))}</strong>
    <time>${html(formatDate(item.at))}</time></div>`).join('')||'<p>No exchanges have cleared yet.</p>';
}
export function trainingOrderView(quote){
  return `<section class="training-order"><h3>${number(quote.count)} ${quote.count===1?'recruit':'recruits'}</h3>
    <p>${duration(quote.duration)} training · ${number(quote.upkeepPerHour)} food / hour</p>
    ${costs(quote.cost)}
    ${quote.eligible?`<p>Expected to complete ${html(formatDate(quote.completesAt))}.</p>`:`<p>${html(quote.reason)}</p>`}</section>`;
}

export function achievementDialog(data) {
  if (!data) return '';
  const values=data.resources?supplyCards(data.resources,{sign:true}):'';
  const facts=data.facts?.length?`<dl class="kv dispatch-facts">${data.facts.map(([label,value])=>`<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join('')}</dl>`:'';
  return eventHero(data.art,data.kicker??'Kingdom dispatch',data.title,data.detail)+facts+
    values+`<div class="buttons">${data.payment?btn('Receipt','bch',{modal:'payment',id:data.payment}):''}${data.open?btn(data.open[0],data.open[1],data.open[2]):''}<button type="button" class="btn primary" data-continue-dispatch>${icon('check')} Continue</button></div>`;
}

// A BCH purchase that took effect, shown like any other game event: a picture, what happened, and when.
export function paymentDispatch(payment,config) {
  const result=payment.fulfillment?.result;
  const building=payment.payload?.building??result?.building;
  const place=building&&(config.buildings?.[building]?.name??title(building));
  const amount=number(payment.satoshis??payment.amount)+' sats';
  const paidAt=['Paid',amount+' · '+formatDate(payment.submittedAt??payment.createdAt??Date.now())];
  const base={payment:payment.id,sound:'reward'};
  switch (payment.action) {
    case 'rush': {
      const job=list(result?.queue).find(item=>item.kind==='building'&&item.key===building);
      return {...base,art:`${building}-${Math.min(3,job?.level??2)}`,kicker:'Construction',title:place+' rushed',
        detail:job?'The builders doubled their pace.':'Rush applied.',facts:[...(job?[['Now finishes',formatDate(job.completesAt)],['Level',String(job.level)]]:[]),paidAt],sound:'build'};
    }
    case 'premium':
      return {...base,art:`${building}-3`,kicker:place,title:'Premium upgrade unlocked',detail:result?.perks?.[building]?.name??config.buildings?.[building]?.premium??'',facts:[paidAt]};
    case 'war-chest':
      return {...base,art:'event-vault',kicker:'War Chest',title:'War Chest funded',detail:'At risk in PvP raids.',facts:[['Added',amount],['Confirmed',formatDate(Date.now())]]};
    case 'territory-raffle':
      return {...base,art:'event-season',kicker:'Rare territory',title:'Raffle entry confirmed',detail:'You are in the draw. The result arrives in your notifications.',
        facts:[...(result?.entry?.included?[['In block',number(result.entry.included)]]:[]),paidAt]};
    case 'territory-claim':
      return {...base,art:'terrain',kicker:'Frontier',title:'Claim entry confirmed',detail:'Your army stands in the contest.',facts:[paidAt]};
    case 'territory-attack':
      return {...base,art:'battlefield',kicker:'Frontier',title:'Attack launched',detail:'Open the territory for the battle.',facts:[paidAt]};
    case 'espionage-paid':
      return {...base,art:'scout-3',kicker:'Scout Tower',title:'Scouts dispatched',detail:result?.completesAt?'Report expected '+formatDate(result.completesAt)+'.':'',facts:[paidAt]};
    case 'protectorate':
      return {...base,art:'event-protectorate',kicker:'Diplomacy',title:'Protectorate offer sent',detail:'The other kingdom decides.',facts:[paidAt]};
    case 'sponsor-fund':
      return {...base,art:'event-season',kicker:'Season',title:'Season sponsored',detail:'Thank you. Your sponsorship is in the prize pool.',facts:[paidAt]};
    case 'political-operation':
      return {...base,art:'event-rebellion',kicker:'Politics',title:'Operation under way',detail:result?.message??'',facts:[paidAt]};
    default: return null;
  }
}

// Something that happened while the player is in the game, shown as a popup with a picture and a short text. Only
// events the player did not cause just now: their own orders already have their own popups.
export function noticeDispatch(entry,state) {
  const job=entry.job, own=state.player?.id;
  const honor=entry.achievement?[['Achievement',title(entry.achievement)]]:[];
  const at=[['When',formatDate(entry.at)]];
  if (entry.title==='Construction complete'&&job) return {art:`${job.key}-${Math.min(3,job.level??1)}`,kicker:'Construction',title:'Construction complete',
    detail:entry.text,facts:[...honor,...at],sound:'upgrade'};
  if (entry.title==='Training complete'&&job) return {art:`unit-${job.key}`,kicker:'Barracks',title:'Training complete',detail:entry.text,facts:at,sound:'upgrade'};
  if (entry.title==='Research complete'&&job) return {art:'library-2',kicker:'Research library',title:'Research complete',detail:entry.text,facts:at,sound:'upgrade'};
  if (entry.title==='Scouting report arrived') return {art:'scout-3',kicker:'Scout Tower',title:'Scouting report arrived',detail:entry.text,
    facts:[...honor,...at],open:entry.reportId?['Read report','spy',{modal:'report',id:entry.reportId}]:null,sound:'reward'};
  if (entry.threat&&entry.kind==='spy') return {art:'scout-3',kicker:'Watchtower',title:entry.title,detail:entry.text,facts:at,sound:'message'};
  if (entry.kind==='spy'&&!entry.title&&/scout|decoy/i.test(entry.text??'')&&!/active for four hours|shared a scouting report/i.test(entry.text))
    return {art:'scout-2',kicker:'Scout Tower',title:/lost|withdrew/i.test(entry.text)?'Scout mission failed':'Scout Tower report',detail:entry.text,facts:at,sound:'message'};
  if (entry.title==='Rental expired') return {art:entry.commander?`hero-${entry.commander}`:'workshop-2',kicker:'Commander hall',title:'Contract ended',detail:entry.text,facts:at,sound:'message'};
  if (entry.title==='Mission called back') return {art:'scout-2',kicker:'Scout Tower',title:entry.title,detail:entry.text,facts:at,sound:'message'};
  if (entry.kind==='diplomacy'&&/as aid\.$|cargo arrived/i.test(entry.text??'')) return {art:'event-protectorate',kicker:'Alliance dispatch',
    title:/aid/i.test(entry.text)?'Aid received':'Trade cargo arrived',detail:entry.text,facts:at,sound:'reward'};
  if (entry.kind==='battle'&&entry.battleId) {
    const battle=list(state.battles).find(item=>item.id===entry.battleId);
    if (!battle||battle.defender!==own||battle.attacker===own) return null;
    const won=battle.winner==='defender';
    const lost=Object.values(battle.losses?.defender??{}).reduce((total,count)=>total+count,0);
    const taken=Object.fromEntries(Object.entries(battle.loot??{}).filter(([,qty])=>qty>0).map(([id,qty])=>[id,-qty]));
    return {art:won?'event-victory':'event-defeat',kicker:'Your city was attacked',title:won?'Attack repelled':'Your city was raided',
      detail:`${battle.attackerName} attacked ${battle.defenderName}. ${number(lost)} of your ${lost===1?'troop was':'troops were'} lost.`,
      ...(!won&&Object.keys(taken).length&&{resources:taken}),facts:[...honor,...at],open:['Battle report','war',{modal:'battle',id:battle.id}],sound:won?'battle-victory':'battle-defeat'};
  }
  return null;
}

// A BCH payment that confirmed: a picture, what it was and the amount; the receipt is one click away.
export function confirmedDispatch(payment) {
  const outgoing=payment.direction==='outgoing';
  const amount=number(payment.satoshis??payment.amount)+' sats';
  const name=payment.title??title(payment.action??'payment');
  return {art:outgoing||['war-chest','vault-deposit'].includes(payment.action)?'event-vault':payment.action==='attack-paid'?'battlefield':'event-season',
    kicker:'BCH '+(outgoing?'sent to your wallet':'payment'),title:outgoing?'BCH sent to your wallet':'Payment confirmed',detail:name,
    facts:[['Amount',amount],['Confirmed',formatDate(Date.now())]],payment:payment.id,sound:'reward'};
}

export function eventDispatch(item) {
  const cat={receipt:'bch',military:'war',battle:'war',army:'helmet',training:'helmet',city:'hammer',construction:'hammer',building:'hammer',research:'book',
    territory:'flag',political:'crown',achievement:'trophy',market:'market',daily:'gift',intel:'spy',spy:'spy',cooldown:'clock'};
  const link=item.payment?btn('Receipt','bch',{modal:'payment',id:item.payment}):item.battleId?btn('Battle report','war',{modal:'battle',id:item.battleId}):
    item.territoryId?btn('Inspect territory','pin',{modal:'node',id:item.territoryId}):
    item.job?btn('Open queue','clock',{page:'city','start-tab':({building:'build',troop:'army',research:'research'})[item.job.kind]??'build',dismiss:'true'}):
    item.commander?btn('Review commander','flag',{modal:'commander',id:item.commander}):'';
  const detail=item.detail??(item.title&&item.text!==item.title?item.text:null);
  // Resources a raid took from this kingdom, or brought home.
  const moved=Object.entries(item.resources??{}).filter(([,qty])=>Number.isFinite(qty)&&qty!==0);
  const spoils=moved.length?`<p>${moved.map(([id,qty])=>`<span class="tag quiet">${icon(id)}${html(title(id))} ${signed(qty)}</span>`).join(' ')}</p>`:'';
  return `<article class="chronicle-entry${item.threat?' chronicle-threat':''}">${icon(cat[item.kind]??'journal')}<div><strong>${html(item.title??item.text??title(item.kind))}</strong>
    ${detail?`<p>${html(detail)}</p>`:''}${spoils}<time>${html(formatDate(item.at))}${item.until?' · finishes '+html(formatDate(item.until)):''}</time></div>${link}</article>`;
}

export function offlineContents(report) {
  if (!report) return '<p>No offline report has been recorded for this kingdom yet.</p>';
  const troops=Object.entries(report.troopChanges??{}).filter(([,qty])=>qty!==0);
  const treasury=Object.entries(report.treasuryChanges??{}).filter(([,qty])=>Number.isFinite(qty)&&qty!==0);
  // What went against the kingdom comes first: attacks, raids, caught scouts, sabotage, lost land and War Chest losses.
  const events=list(report.events);
  const threats=events.filter(item=>item.threat);
  const lost={};
  for (const item of threats) for (const [id,qty] of Object.entries(item.resources??{})) if (qty<0) lost[id]=(lost[id]??0)+qty;
  const troopsLost=threats.reduce((total,item)=>total+(item.troopsLost??0),0);
  // BCH that left the War Chest while the kingdom was attacked.
  const chestLost=threats.some(item=>item.kind==='battle')?treasury.filter(([id,qty])=>id==='atRiskSatoshis'&&qty<0):[];
  const count=test=>threats.filter(test).length;
  const tally=[
    [count(item=>item.kind==='battle'&&/^(Raided by|Attack repelled)/.test(item.title??'')),'attack','attacks'],
    [count(item=>item.kind==='battle'&&item.title==='Defeat'),'defeat','defeats'],
    [count(item=>item.title==='Enemy scout caught'||item.title==='Watchtower alarm'),'scout caught','scouts caught'],
    [count(item=>item.title==='Sabotage detected'),'sabotage','sabotage'],
    [count(item=>item.kind==='territory'),'territory lost','territories lost'],
  ].filter(([n])=>n).map(([n,one,many])=>`<span class="tag danger">${number(n)} ${n===1?one:many}</span>`);
  const against=`<section class="chronicle-threats"><h3>${icon('shield')} Attacks, scouting and losses</h3>
    ${threats.length||chestLost.length?`${tally.length?`<p>${tally.join(' ')}</p>`:''}
    ${Object.keys(lost).length?`<p>Resources taken from your stores</p>${supplyCards(lost,{sign:true})}`:''}
    ${troopsLost?`<p>${number(troopsLost)} ${troopsLost===1?'troop':'troops'} lost in battle.</p>`:''}
    ${chestLost.length?`<p>${chestLost.map(([,qty])=>`<span class="tag danger">War Chest ${signed(qty,bch)} BCH</span>`).join(' ')}</p>`:''}
    ${threats.map(eventDispatch).join('')}`:
    '<p>No attacks, caught scouts, sabotage or losses were recorded against your kingdom while you were away.</p>'}
    <p class="strategy-note">A scout your watchtower does not catch leaves no trace. A higher Scout Tower and counterintelligence catch more of them.</p></section>`;
  return eventHero('event-season','Return to the frontier','Kingdom chronicle',`${formatDate(report.from)} — ${formatDate(report.to)}`)+against+
    `<h3>Net store changes</h3>${Object.keys(report.resourceChanges??{}).length?supplyCards(report.resourceChanges,{sign:true}):'<p>Your stores did not change.</p>'}
    ${troops.length?`<h3>Available army change</h3><p>${troops.map(([id,qty])=>`<span class="tag quiet">${html(title(id))} ${signed(qty)}</span>`).join(' ')}</p>`:''}
    ${treasury.length?`<h3>Vault and treasury changes</h3><p>${treasury.map(([id,qty])=>`<span class="tag quiet">${html(title(id.replace(/Satoshis$/,'').replace(/[A-Z]/g,letter=>' '+letter)))} ${signed(qty,bch)} BCH</span>`).join(' ')}</p>`:''}
    <h3>${threats.length?'Other dispatches':'Recorded dispatches'}</h3>${events.filter(item=>!item.threat).map(eventDispatch).join('')||'<p>No other events during this interval.</p>'}
    ${report.olderEvents?`<p>${number(report.olderEvents)} earlier ${report.olderEvents===1?'event is':'events are'} not shown in this summary.</p>`:''}
    <div class="buttons"><button class="btn primary" type="button" data-dismiss-report="${html(report.id)}">${icon('check')} Continue to kingdom</button></div>`;
}

export function commandDispatch(payload,value,config) {
  if (payload.type==='task-claim-all') return {art:'event-vault',kicker:'Campaign tasks',title:'Rewards claimed',
    detail:`${number(value.claimed?.length??0)} task rewards. ${Object.values(value.collected??{}).some(Boolean)?'Your stores were credited.':'Your stores were full, so nothing was added.'}`,
    resources:value.collected,sound:'reward',back:{mode:'next'}};
  if (payload.type==='task-claim') return {art:'event-vault',kicker:'Campaign task',title:'Reward claimed',
    detail:`${value.title}. ${Object.values(value.collected??{}).some(Boolean)?'Your stores were credited.':'Your stores were full, so nothing was added.'}`,
    resources:value.collected,sound:'reward',back:{mode:'next'}};
  if (payload.type==='collect'&&value.collected) return {art:'event-vault',kicker:'Daily tribute',title:'Reward claimed',
    detail:`${Object.values(value.collected).some(Boolean)?'Your stores were credited.':'Your stores were full, so nothing was added.'} Next shipment: ${formatDate(value.availableAt)}.`,resources:value.collected,sound:'reward'};
  if (payload.type==='trade') return {art:'market-3',kicker:'Marketplace',title:'Trade completed',
    detail:`Exchanged ${number(value.amount)} ${title(value.give)} for ${number(value.received)} ${title(value.take)}.`,
    resources:{[value.give]:-value.amount,[value.take]:value.received},sound:'reward'};
  if (payload.type==='train') return {art:`unit-${payload.unit}`,kicker:'Barracks',title:'Training ordered',detail:`${number(value.count)} ${config.units[value.key]?.name??title(value.key)} expected ${formatDate(value.completesAt)}.`,resources:negate(value.cost),sound:'build'};
  if (payload.type==='research') return {art:'library-2',kicker:'Research library',title:'Research under way',
    detail:`${config.tech[value.key]?.name??title(value.key)} · Tier ${value.level} · Expected ${formatDate(value.completesAt)}.`,resources:negate(value.cost),sound:'build'};
  if (payload.type==='upgrade') return {art:`${value.key}-${Math.min(3,value.level)}`,kicker:'Construction',title:'Works commissioned',
    detail:`${config.buildings[value.key]?.name??title(value.key)} · Level ${value.level} · Expected ${formatDate(value.completesAt)}.`,resources:negate(value.cost),sound:'build',back:{mode:'building',id:payload.building}};
  if (payload.type==='scout') return {art:'scout-3',kicker:'Scout Tower',title:'Scout mission dispatched',
    detail:`${title(value.mission)} · ${number(value.scoutPoints)} scout points spent · Expected ${formatDate(value.completesAt)}.`,
    resources:negate(value.cost),sound:'dispatch',back:payload.mission==='decoy'?{mode:'decoy'}:{mode:'scout',id:payload.target}};
  if (payload.type==='counterspy') return {art:'scout-3',kicker:'Scout Tower',title:'Counterintelligence active',
    detail:`Your watch runs until ${formatDate(value.until)}. You can renew it from ${formatDate(value.nextAt)}.`,resources:negate(value.cost),sound:'dispatch'};
  if (payload.type==='aid') return {art:'event-protectorate',kicker:'Alliance dispatch',title:'Supplies delivered',
    detail:`You sent ${number(payload.amount)} ${title(payload.resource)}. The recipient’s stores received ${number(value.received)} after transfer costs.`,
    resources:{[payload.resource]:-payload.amount},sound:'dispatch'};
  if (payload.type==='rally') return {art:'event-victory',kicker:'Alliance dispatch',title:'Rally joined',
    detail:`${number(value.participants.length)} pledged. Rally closes ${formatDate(value.endsAt)}.`,sound:'dispatch'};
  if (value.site && ['territory-fortify','territory-garrison','territory-aid','territory-abandon'].includes(payload.type)) {
    const territory=value.site.name;
    const back={mode:'node',id:value.territoryId};
    const base={art:'event-victory',kicker:'Frontier dispatch',sound:'dispatch',back};
    if (payload.type==='territory-fortify') return {...base,title:'Fortification completed',
      detail:`${territory} now has level ${number(value.site.defenses.level)} defenses.`,resources:negate(value.cost)};
    if (payload.type==='territory-abandon') return {...base,title:'Territory abandoned',detail:`${territory} returned to neutral control. Its garrison returned to your city.`};
    const recall=payload.recall===true||payload.direction==='recall';
    return {...base,title:recall?'Garrison recalled':'Garrison reinforced',
      detail:recall ? `${number(payload.count)} ${title(payload.unit)} returned from ${territory}.` : `${number(payload.count)} ${title(payload.unit)} deployed to ${territory}.`};
  }
  if (['commander-recruit','commander-rent','commander-upgrade','commander-forge','commander-equip'].includes(payload.type)) {
    const hero=payload.hero??value.hero;
    const names={'commander-recruit':'Commander recruited','commander-rent':'Contract signed','commander-upgrade':'Mastery advanced',
      'commander-forge':'Fitting forged','commander-equip':payload.equipment?'Fitting equipped':'Fitting removed'};
    const expires=value.expiresAt?` · Expires ${formatDate(value.expiresAt)}`:'';
    return {art:hero?`hero-${hero}`:'workshop-2',kicker:'Commander hall',title:names[payload.type],
      detail:`${config.heroes[hero]?.name??title(payload.equipment)}${expires}`,resources:negate(value.cost),sound:'reward',back:hero?{mode:'commander',id:hero}:null};
  }
  return null;
}
const negate=items=>items&&Object.fromEntries(Object.entries(items).map(([id,count])=>[id,-count]));
