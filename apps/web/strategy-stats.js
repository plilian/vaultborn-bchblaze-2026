import { art,duration, formatDate, html, number, title } from './view.js';
import { ATTESTOR_ADJECTIVE } from './network.js';

const labels={defenseReduction:'Early defensive losses reduced',openingAttack:'Opening attack bonus',constructionReduction:'Construction time reduced',
  storageBonus:'Storage bonus',scoutSuccess:'Scout success bonus',rebellionMorale:'Rebellion morale',marketBonus:'Exchange rate bonus',
  researchReduction:'Research cost reduced',cityDefensePercent:'Terrain and fortification defense',moralePercent:'Political morale',
  doctrinePercent:'Doctrine',trainingTimePercent:'Training time relative to base',constructionTimePercent:'Build time relative to base'};
const points=new Set(['rebellionMorale']);
const ratio=new Set(['defenseReduction','openingAttack','constructionReduction','storageBonus','scoutSuccess','marketBonus','researchReduction']);
const negativeReduction=new Set(['defensePressurePercent','terrainDefensePercent','cityDefensePercent']);
const human=key=>title(key.replace(/([a-z])([A-Z])/g,'$1 $2'));
const entries=(item,trail='')=>Object.entries(item??{}).flatMap(([key,value])=>{
  const label=trail?trail+' · '+human(key):labels[key]??human(key);
  return value && typeof value==='object' ? entries(value,label) : [[trail?label:key,{label,value}]];
});

function formatted(key,value) {
  if (value==null) return '—';
  if (typeof value==='boolean') return value?'Unlocked':'Locked';
  if (typeof value!=='number') return String(value);
  const scaled=ratio.has(key)?value*100:negativeReduction.has(key)?-value:value;
  const unit=key.split(' · ').at(-1);
  return number(Math.round(scaled*100)/100)+(ratio.has(key)||key.endsWith('Percent')?'%':points.has(key)||unit.endsWith('Points')?' points':'');
}

export function comparison(current,next,heading='Effective stats',comparisonLabel='Next tier') {
  const before=new Map(entries(current));
  const after=new Map(entries(next));
  if (!before.size && !after.size) return '';
  const hasNext=next!=null && after.size>0;
  return `<section class="strategy-ledger"><h3>${html(heading)}</h3><table><thead><tr><th scope="col">Attribute</th><th scope="col">Current</th>${hasNext?`<th scope="col">${html(comparisonLabel)}</th>`:''}</tr></thead><tbody>${[...new Set([...before.keys(),...after.keys()])].map(key=>{
    const entry=before.get(key)??after.get(key);
    const a=before.get(key)?.value,b=after.get(key)?.value;
    const delta=typeof a==='number'&&typeof b==='number'&&a!==b?formatted(key,b-a):null;
    return `<tr><th scope="row">${html(entry.label)}</th><td>${html(formatted(key,a))}</td>${hasNext?`<td>${html(formatted(key,b))}${delta ? `<small>${html(delta.startsWith('-')?delta:'+'+delta)}</small>`:''}</td>`:''}</tr>`;
  }).join('')}</tbody></table></section>`;
}

const intelSource=enemy=>enemy.source==='scouting'?'Scouting estimate':enemy.source==='allied'?'Allied report':'Unknown defenses';
const meta=(name,value)=>`<div><dt>${html(name)}</dt><dd>${html(value)}</dd></div>`;
const percent=value=>value==null?'Unknown':`${number(value)}%`;
const signedPercent=value=>`${value>0?'+':''}${number(value)}%`;

export function raidStandards(attacker,defender,hero) {
  return `<div class="raid-versus"><div class="raid-banner"><img src="${art(attacker)}" alt=""><div><span class="kicker">Attacker</span>
    <strong>${html(attacker.name)}</strong><small data-raid-commander>${html(hero??'Your army')}</small></div></div>
    <span class="raid-mark" aria-label="versus"><span>VS</span></span>
    <div class="raid-banner defending"><img src="${art(defender)}" alt=""><div><span class="kicker">Defender</span>
    <strong>${html(defender.name)}</strong><small>${html(defender.terrainName??'Defending ground')}</small></div></div></div>`;
}
function troopStandards(troops,config) {
  return `<div class="raid-roster">${Object.entries(troops??{}).filter(([,count])=>count>0).map(([id,count])=>{
    if (!Object.hasOwn(config.units,id)) return '';
    const label=`${number(count)} ${config.units[id].name}`;
    return `<span class="raid-unit" title="${html(label)}" aria-label="${html(label)}"><img src="/art/unit-${id}.webp" alt=""><b>${number(count)}</b></span>`;
  }).join('')}</div>`;
}
export function raidStakes(raid) {
  if (!raid) return '';
  const sats=value=>number(value)+' sats';
  const line=(name,value)=>`<dt>${html(name)}</dt><dd>${html(value)}</dd>`;
  if (raid.matched) {
    // Matched stakes: the attacker chooses S; the defender's War Chest is held to the same S; network fees are shown apart.
    const choices=[...new Set([...(raid.suggestedStakes??[]),raid.maximumStakeSatoshis,raid.stakeSatoshis])].filter(value=>value>=raid.minimumStakeSatoshis&&value<=raid.maximumStakeSatoshis).sort((a,b)=>a-b);
    const picker=choices.length?`<label class="field"><span>Your stake (S)</span><select name="stake">${choices.map(value=>`<option value="${value}" ${value===raid.stakeSatoshis?'selected':''}>${html(sats(value))}${value===raid.maximumStakeSatoshis&&choices.length>1?' · the most this opponent can cover':''}</option>`).join('')}</select></label>`:'';
    const terms=raid.win?`<dl class="kv">${line('Your stake (S)',sats(raid.stakeSatoshis))}${line('Defender’s matched exposure (S)',sats(raid.defenderExposureSatoshis))}
      ${line('Defender’s verified capturable War Chest',sats(raid.defenderCapturableSatoshis))}
      ${line('Network reserve (the unused part returns)',sats(raid.networkReserveSatoshis))}${line('Total wallet payment',sats(raid.totalPaymentSatoshis))}
      ${line('If you win · reaches your wallet',sats(raid.win.receiveSatoshis))}${line('If you win · network fee',sats(raid.win.feeSatoshis))}${line('If you win · net result','+'+sats(raid.win.netSatoshis))}
      ${line('If you lose · defender receives',sats(raid.loss.defenderReceivesSatoshis))}${line('If you lose · returns to your wallet',sats(raid.loss.receiveSatoshis))}${line('If you lose · net result','−'+sats(-raid.loss.netSatoshis))}
      ${line('Most BCH you can win',sats(raid.maxWinSatoshis))}${line('Most BCH you can lose',sats(raid.maxLossSatoshis)+' and the network fee')}</dl>`:
      `<dl class="kv">${line('Defender’s verified capturable War Chest',sats(raid.defenderCapturableSatoshis))}${line('Smallest stake',sats(raid.minimumStakeSatoshis))}</dl>`;
    return `<div class="strategy-risk" data-raid-stakes><strong>Paid raid: matched stakes</strong>
      ${raid.eligible||raid.maximumStakeSatoshis?picker:''}${terms}
      ${raid.eligible?'':`<p><strong>${html(raid.reason)}</strong> A free raid uses the same combat rules and never moves BCH.</p>`}
      <p>Both sides risk the same amount. If you win, one transaction pays you your own stake, the same amount from the defender’s War Chest, and the reserve it did not use. If you lose, the defender receives your whole stake. The outcome is signed by ${html(number(raid.attestorThreshold??1))} of ${html(number(raid.attestors??1))} ${ATTESTOR_ADJECTIVE} attestor${raid.attestors===1?'':'s'} after replaying the battle; the game cannot choose it. A higher stake never changes the battle. One paid raid between the same two kingdoms every ${html(number(raid.pairCooldownHours))} hours. If the defender starts leaving the War Chest after you paid, your win is still taken from it for about ${html(number(Math.round(raid.exitBlocks/144)))} days.</p></div>`;
  }
  const none=raid.maxWinSatoshis===0;
  return `<div class="strategy-risk" data-raid-stakes><strong>Paid raid: what you can win and lose</strong>
    <dl class="kv">${line('Your stake',sats(raid.stakeSatoshis))}${line('Network reserve (not returned)',sats(raid.networkReserveSatoshis))}
    ${line('Opponent’s capturable War Chest',sats(raid.opponentWarChestSatoshis))}
    ${none?line('Capture if you win','Nothing'):line('Capture if you win',sats(raid.captureSatoshis))+line('Network fee of the capture',sats(raid.captureFeeSatoshis))+line('Reaches your wallet',sats(raid.maxWinSatoshis))}
    ${line('Most you can lose',sats(raid.maxLossSatoshis+raid.networkReserveSatoshis))}</dl>
    ${none?'<p><strong>This opponent has no capturable War Chest BCH, so a paid raid is not offered.</strong> A free raid uses the same combat rules.</p>':''}</div>`;
}
export function raidDossier(preview,config) {
  const {own,enemy,terrain,risk,limits,eligibility}=preview;
  const commander=config.heroes[own.hero]?.name??'No active commander';
  const portrait=Object.hasOwn(config.heroes,own.hero)?`<img class="raid-portrait" src="/art/hero-${own.hero}.webp" alt="">`:'';
  const counterHints=Object.entries(own.troops).filter(([,count])=>count>0).flatMap(([id])=>{
    const opposing=Object.entries(enemy.troops??{}).filter(([,count])=>count>0).sort((a,b)=>b[1]-a[1]).slice(0,2);
    return opposing.flatMap(([against])=>{
      const value=config.counters?.[id]?.[Object.keys(config.units).indexOf(against)];
      return value && Math.abs(value-1)>=.12?[`${config.units[id].name} ${value>1?'counters':'struggles against'} ${config.units[against].name}`]:[];
    });
  }).slice(0,3);
  return `<div class="strategy-columns"><section><h3>Ready army</h3><div class="raid-captain">${portrait}<div><strong>${html(commander)}</strong><small>${html(config.heroes[own.hero]?.ability??'No active trait')}</small></div></div><dl>${meta('Opening pressure',number(own.openingPressure))}
    ${meta('Roster power',number(own.rosterPower))}${meta('Doctrine / morale',`${percent(own.doctrinePercent)} / ${percent(own.moralePercent)}`)}${meta('Scouting opening bonus',percent(own.intelOpeningPercent))}</dl>
    ${troopStandards(own.troops,config)}</section>
    <section><h3>${html(intelSource(enemy))}</h3><dl>${meta('Troops',enemy.army==null?'Unknown':number(enemy.army))}
    ${meta(enemy.source==='allied'?'Roster power':'Scouted power',enemy.power==null?'Unknown':number(enemy.power))}${meta('Fortification level',enemy.wall==null?'Unknown':number(enemy.wall))}${meta('Terrain',terrain.name??title(terrain.id))}</dl>
    ${enemy.source==='scouting'?`<p class="strategy-troops">${html(number(enemy.confidence*100))}% confidence · reported ${html(formatDate(enemy.observedAt))}${enemy.expiresAt?' · expires '+html(formatDate(enemy.expiresAt)):''}</p>`:''}
    ${enemy.source==='unknown'?'<p class="strategy-troops">Scout to estimate strength. Enemy tactics and commander may still be unknown.</p>':troopStandards(enemy.troops,config)}</section></div>
    <p class="strategy-note"><strong>Terrain:</strong> ${html(number(Math.abs(terrain.defensePercent)))}% defensive modifier${own.fortificationAssault?' · Siege stance reduces fortification pressure':''}.
    ${own.troops.cavalry>0&&terrain.cavalryOpeningPercent!=null?`Cavalry pressure modifier: ${signedPercent(terrain.cavalryOpeningPercent)} at opening, ${signedPercent(terrain.cavalryLatePercent)} after exchange three.`:''}
    <strong>Ordinary loot:</strong> up to ${html(number(limits.maxLootPerResourcePercent))}% per eligible resource and ${html(number(limits.lootCapacityPerSurvivingTroop))} units per surviving troop.</p>
    ${raidStakes(preview.raid)}
    ${counterHints.length?`<p class="strategy-note"><strong>Against the reported army:</strong> ${counterHints.map(html).join(' · ')}.</p>`:''}
    ${risk?`<div class="strategy-risk"><strong>${html(number(risk.range[0]))}–${html(number(risk.range[1]))} modeled losses</strong>
      <p>${html(number(risk.sampleWins))} attacker wins in ${html(number(risk.samples))} scouting scenarios. ${html(risk.assumptions)} This is a scenario range, not a win guarantee.</p></div>`:''}
    ${!eligibility.allowed&&eligibility.reason?`<p class="strategy-note">${html(eligibility.reason)}</p>`:''}`;
}

export function squadDetail(unit,config) {
  if (!unit) return '';
  const name=item=>config.units[item.against]?.name??title(item.against);
  const alignment=items=>items.map(item=>`${name(item)} (${number(item.multiplier*100-100)}%)`).join(' · ')||'None';
  return comparison(unit.base,null,'Base combat attributes')+comparison({openingPressurePerTroop:unit.effective.openingAttack,
    resilience:unit.effective.resilience},null,'With your current orders')+
    `<dl class="strategy-summary">${meta('Strong against',alignment(unit.advantages??[]))}${meta('Weak against',alignment(unit.disadvantages??[]))}</dl>`;
}

export function timeLabel(ends,now) {
  return ends>now ? `<time data-until="${html(ends)}">${html(duration(ends-now))}</time>` : 'Ready';
}
