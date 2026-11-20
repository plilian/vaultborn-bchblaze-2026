import {icon} from './icons.js';
import {btn,costs,empty,formatDate,html,labelOf,list,number,tag,title} from './view.js';
import {battleCampNames} from './battle-motion.js';

const sides=['attacker','defender'];
const sum=roster=>Object.values(roster??{}).reduce((count,value)=>count+value,0);
const artwork=(path,classes,alt='')=>`<img class="${classes}" src="/art/${html(path)}.webp" alt="${html(alt)}">`;

function sideSeal(battle,side,names,config) {
  const input=battle.input?.[side],hero=config.heroes[input?.hero];
  return `<div class="battle-camp ${side}">
    ${hero?artwork('hero-'+input.hero,'battle-command-portrait',hero.name):`<span class="battle-command-emblem">${icon(side==='attacker'?'war':'shield')}</span>`}
    <div><small>${html(title(side))}</small><strong>${html(names[side])}</strong><span>${html(hero?.name??'No active commander')}</span>
    <span>${html(labelOf(config.formations[input?.formation],title(input?.formation)))} · ${html(labelOf(config.tactics[input?.tactic],title(input?.tactic)))}</span></div>
  </div>`;
}

function forceLedger(battle,side,names,config) {
  const input=battle.input?.[side],losses=battle.losses?.[side]??{},troops=input?.troops??{};
  const opening=input?.commanderTraits?.openingAttack??(input?.hero==='commander'?.06:0);
  const guard=input?.commanderTraits?.defenseReduction??(input?.hero==='warden'?.08:0);
  const factors=[
    opening && ['Opening pressure','+'+number(opening*100)+'%'],
    side==='defender'&&guard && ['Early defensive losses','−'+number(guard*100)+'%'],
    input?.tech?.tactics && ['Doctrine','+'+number(input.tech.tactics*2)+'%'],
    input?.politicalMorale!=null&&input.politicalMorale!==1 && ['Morale',number(input.politicalMorale*100)+'%'],
    input?.intel>0 && ['Recon pressure','+'+number(input.intel*6)+'%'],
    side==='defender'&&input?.wall && ['Wall and fortification tier',number(input.wall)]
  ].filter(Boolean);
  return `<article class="battle-force ${side}">
    <h4>${html(names[side])} ${battle.winner===side?tag('Winner','success'):''}</h4>
    <p>${number(sum(troops)-sum(losses))} survive · ${number(sum(losses))} lost</p>
    <table><thead><tr><th scope="col">Unit</th><th scope="col">Sent</th><th scope="col">Lost</th><th scope="col">Left</th></tr></thead>
    <tbody>${Object.keys(config.units).filter(unit=>troops[unit]||losses[unit]).map(unit=>`
      <tr><th scope="row">${artwork('unit-'+unit+(side==='defender'?'-crimson':''),'battle-unit-mark')} ${html(labelOf(config.units[unit],unit))}</th>
      <td>${number(troops[unit]??0)}</td><td>${number(losses[unit]??0)}</td><td>${number((troops[unit]??0)-(losses[unit]??0))}</td></tr>`).join('')}</tbody></table>
    ${factors.length?`<dl class="battle-field-factors">${factors.map(([name,value])=>`<dt>${html(name)}</dt><dd>${html(value)}</dd>`).join('')}</dl>`:''}
  </article>`;
}

function rewards(battle,ownSide,won,ctx,receipt,names) {
  const personal=ownSide?battle.aftermath?.[ownSide]:null,ledger=battle.treasury;
  const amounts=costs(battle.loot);
  const honors=personal?[
    personal.campaignPoints&&['flag','+'+number(personal.campaignPoints)+' campaign points'],
    personal.mastery&&['helmet','+'+number(personal.mastery)+' commander XP'],
    personal.influence&&['crown','+'+number(personal.influence)+' influence'],
    personal.achievement&&['trophy','Achievement: '+title(personal.achievement)],
    personal.shieldUntil&&['shield','Recovery protection '+(personal.shieldUntil>ctx.gameNow?'until '+formatDate(personal.shieldUntil):'has ended')]
  ].filter(Boolean):[];
  const recipient=ctx.cities.find(city=>city.id===ledger?.recipient)?.name??ledger?.recipient;
  const occupationUntil=battle.conquest?.occupationUntil;
  const occupiedThrough=occupationUntil?' Occupation ends '+html(formatDate(occupationUntil))+'.':'';
  return `<div class="battle-trophy">${icon(won?'trophy':'shield')}<div>
    <h4>${won?'Spoils of war':ownSide?'Battle consequences':'Battle spoils'}</h4>
    <p>${ownSide==='defender'?'Earned resources lost':ownSide==='attacker'?'Earned resources captured':'Resources captured by the attacker'}</p>
    ${amounts||'<span>No resources were transferred.</span>'}</div></div>
    ${honors.length?`<div class="battle-gains">${honors.map(([symbol,text])=>`<span>${icon(symbol)}${html(text)}</span>`).join('')}</div>`:''}
    ${personal?.expeditionSupplies?`<div class="battle-trophy">${icon('market')}<div><h4>Expedition supplies spent</h4>
      ${costs(personal.expeditionSupplies)}</div></div>`:''}
    ${battle.conquest?`<p class="conquest-banner">${icon('flag')} ${html(battle.conquest.name)} now belongs to ${html(names[battle.winner])}.${occupiedThrough}</p>`:''}
    ${battle.paid?`<div class="battle-settlement">${icon('bch')}<div><h4>War Chest and stake</h4>
      ${ledger?.matched?`<p>Matched stakes: ${number(ledger.escrowSatoshis)} sats on each side.</p>
      <p>${ledger.stakeLane==='attacker-wins'?`The attacker receives both stakes: ${number(ledger.stakePayouts.attacker)} sats. ${number(ledger.capturedSatoshis)} sats leave the defender’s War Chest.`:
        ledger.stakeLane==='defender-wins'?`The defender receives the attacker’s whole stake: ${number(ledger.stakePayouts.defender)} sats. The defender’s War Chest is untouched.`:
        'No BCH outcome: the stake returns to the attacker and the War Chest is untouched.'} Network fees are shown in the payment journal.</p>`:
      ledger?`<p>${number(ledger.escrowSatoshis)} sats stake · ${number(ledger.capturedSatoshis)} sats captured</p>
      <p>${ledger.stakePayouts?`${number(ledger.stakePayouts.attacker)} sats returned to the attacker · ${number(ledger.stakePayouts.defender)} sats forfeited to the defender`:'Stake credited to '+html(recipient)+'.'}</p>`:'<p>Review the chain proof for this operation.</p>'}
      <span data-battle-chain>${receipt?.state==='credited'?'Funding confirmed · checking settlement proof':'Checking settlement proof'}</span></div></div>`:''}`;
}

// What an attack won, for the reward popup shown when a battle the player just fought ends: only what this battle
// actually recorded for the attacker.
export function raidSpoils(battle,player) {
  if (!battle||battle.attacker!==player||battle.winner!=='attacker'||battle.kind==='tutorial-drill') return null;
  const personal=battle.aftermath?.attacker??{},ledger=battle.treasury;
  const loot=Object.fromEntries(Object.entries(battle.loot??{}).filter(([,amount])=>Number.isFinite(amount)&&amount>0));
  const facts=[
    personal.campaignPoints&&['Campaign points','+'+number(personal.campaignPoints)],
    personal.mastery&&['Commander XP','+'+number(personal.mastery)],
    personal.influence&&['Influence','+'+number(personal.influence)],
    personal.achievement&&['Achievement',title(personal.achievement)],
    battle.conquest&&['Conquered',battle.conquest.name],
    battle.paid&&ledger?.matched&&ledger.stakeLane==='attacker-wins'&&ledger.stakePayouts?.attacker&&['BCH stake won',number(ledger.stakePayouts.attacker)+' sats'],
  ].filter(Boolean);
  if (!Object.keys(loot).length&&!facts.length) return null;
  return {art:'event-victory',kicker:'Spoils of war',title:'Your rewards',
    detail:'Your army returns from '+(battle.conquest?.name??battle.defenderName)+' with these spoils.',
    ...(Object.keys(loot).length&&{resources:loot}),facts,sound:'reward'};
}

export function battleReport(ctx,id,modal) {
  const battle=ctx.ui.dialog.battle??list(ctx.ui.state.battles).find(item=>item.id===id);
  if(!battle) return modal('Battle report',empty('This report is unavailable to your city.'));
  const config=ctx.ui.state.config, names=battleCampNames(battle);
  const domestic=battle.kind==='political-front'&&battle.attacker===battle.defender;
  const ownSide=domestic?null:sides.find(side=>battle[side]===ctx.own.id);
  const won=ownSide===battle.winner, artStyle=ownSide&&!won?'defeat':domestic?'rebellion':'victory';
  const result=ownSide?(won?'VICTORY':'DEFEAT'):names[battle.winner].toUpperCase()+' VICTORY';
  const territory=ctx.ui.state.territories?.find(site=>site.id===battle.territoryId);
  const location=battle.conquest?.name??territory?.name??battle.defenderName;
  const terrain=labelOf(config.terrains?.[battle.input?.terrain],title(battle.input?.terrain||'unknown terrain'));
  const receipt=list(ctx.ui.state.payments).find(item=>item.fulfillment?.result?.id===battle.id || item.id===battle.treasury?.payment);
  const training = battle.kind === 'tutorial-drill';
  return modal(training ? 'Frontier Guard drill' : 'Battle of '+location,`
    <div class="battle-marquee"><span>${html(title(battle.kind))} <b>◆</b> ${html(terrain)}</span><span>${battle.paid?'BCH stake':'No BCH stake'} <b>◆</b> ${list(battle.events??battle.replay).length} exchanges</span></div>
    ${training ? '<p class="strategy-note">Practice battle. The units shown are a snapshot of your army. Your actual troops and supplies stay with your kingdom.</p>' : ''}
    <section class="battle-versus" aria-label="Commanding armies">${sideSeal(battle,'attacker',names,config)}<span class="battle-vs">${icon('war')}<b>VS</b></span>${sideSeal(battle,'defender',names,config)}</section>
    <div class="replay-scene">
      <div class="replay-army replay-attacker">${icon('flag')}</div><div class="replay-army replay-defender">${icon('shield')}</div>
      <header class="battle-field-top"><span>ATTACKER <b data-battle-survivors="attacker">${number(sum(battle.input?.attacker?.troops))}</b></span>
       <span>DEFENDER <b data-battle-survivors="defender">${number(sum(battle.input?.defender?.troops))}</b></span></header>
      <div class="replay-readout" aria-live="polite"><strong id="replay-status">The armies muster</strong><span id="replay-loss">Both forces ready</span></div>
    </div><div class="battle-timeline"><i id="replay-meter" style="width:0%"></i></div>
    <div class="replay-controls"><button type="button" class="btn primary" data-replay>${icon('play')}Play battle replay</button>
      <input type="range" id="replay-seek" aria-label="Battle replay position" min="0" max="100" step="0.05" value="0">
      <button class="btn" type="button" data-replay-skip>${icon('arrow')}Show result</button></div>
    <section hidden class="battle-result ${artStyle}" data-battle-result aria-labelledby="battle-result-title">
      <header class="battle-finale"><span>THE FIELD IS DECIDED</span><h3 id="battle-result-title" tabindex="-1">${html(result)}</h3>
        <p>${html(names[battle.winner])} ${domestic?'won the front at':'holds the field at'} ${html(location)}.</p></header>
      <div class="battle-aftermath">
        ${training ? '<p class="strategy-note">Losses below apply to this exercise. There are no spoils or campaign rewards.</p>' : rewards(battle,ownSide,won,ctx,receipt,names)}
        <details class="battle-tactical" open><summary>Field report · forces and tactics</summary>
          <div class="battle-forces">${sides.map(side=>forceLedger(battle,side,names,config)).join('')}</div>
          <p class="battle-factors-blurb" data-battle-factors>Battle outcomes combine surviving unit strength, defensive terrain and pressure across the exchanges.</p>
          <div data-battle-exchanges></div></details>
        <div class="buttons">${receipt?btn('Chain receipt','bch',{modal:'payment',id:receipt.id}):''}
          ${training ? '' : `<a class="btn game-link" href="/verify/battle/${html(battle.id)}">${icon('journal')}Verify battle</a>`}
          <button type="button" class="btn" data-dismiss>${icon('arrow')}${training ? 'Return to guide' : 'Continue campaign'}</button></div>
        <details class="battle-tactical"><summary>Audit data</summary><dl class="kv"><dt>Battle result hash</dt><dd class="transaction-id">${html(battle.hash)}</dd>
        <dt>Input commitment</dt><dd class="transaction-id">${html(battle.commitment)}</dd><dt>Battle seed</dt><dd class="transaction-id">${html(battle.seed)}</dd></dl></details>
      </div>
    </section>`);
}
