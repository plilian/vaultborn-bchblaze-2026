import {btn,duration,html} from './view.js';
import { NETWORK, NETWORK_LABEL } from './network.js';
import { ATTESTOR_ADJECTIVE } from './network.js';

const topics = [
  ['start','Getting started','Raise your first banner', () => [
    'Found your city, name its commander, and choose a faction. Your first protected castle cannot be captured. Your garrison and resources stay with the same kingdom as you develop it.',
    'Follow Captain Elowen: queue City Hall, claim daily tribute, train infantry, save army orders, and run a practice battle. Practice uses the real combat rules without spending supplies or losing troops.',
    'Connect your BCH wallet (the wallet button at the top, or Connect wallet on the start page): it is verified in the same step and is then your key to this kingdom from any browser. You can also link a Nostr key in Profile. Play starts a new kingdom; Connect wallet or Sign in opens an existing one.'
  ]],
  ['city','Buildings & resources','Keep the storehouses full', () => [
    'Farm & Mine produces wood, stone, iron, food, and crystal. The Vault Treasury raises storage limits. Offline production accrues for up to 12 hours and stops at capacity. Claim daily tribute when your stores have room.',
    'City Hall limits the level of supporting buildings. Select a building to see the exact materials, time, and level effects. Construction, research, and troop training have separate queues.',
    'The Marketplace spends earned goods, not BCH. Check the amount you will receive and remaining storage before accepting the quote.'
  ]],
  ['combat','Troops, commanders & combat','Build an army with a purpose', () => [
    'Infantry holds the line, shields counter cavalry, cavalry pressures archers, and siege helps against walls and shields. Workshop 2 unlocks siege and Research Library 2 unlocks war mages. Open Barracks to see current training cost, time, and garrison capacity.',
    'Assign one active commander. Choose Battle Line for general pressure, Spearhead for infantry and cavalry, or Skirmish Screen for archers and mages. Compare terrain, defenses, and intel before committing.',
    'Replays record nine exchanges, losses by troop class, and the actual rewards. Losing troops reduces your standing army. Scout reports are estimates and can be stale or misleading.'
  ]],
  ['territory','World map & territory','Hold what you can supply', ({territoryRules:r}) => [
    'Use the atlas region selector to travel. Your Starter Territory cannot be contested. New regions open as plots fill; established residents unlock additional ordinary sites as they finish onboarding.',
    `Inspect a site to see its current owner, yield, eligibility, and claim or attack quote. Range, upkeep, garrison strength, and holding limits all matter. ${r?.maxCityHoldings ? `The normal limits are ${r.maxCityHoldings} sites per city and ${r.maxAllianceHoldings} per alliance; your own capacity is shown on the map.` : ''}`,
    'Ordinary NPC camps can be occupied for 48 hours using expedition supplies. You can hold one camp at a time. Strategic and rare sites have distinct rules; a rare site may use a drawing rather than immediate conquest. A failed paid attack on a territory forfeits half of its stake to the defender; a territory attack never touches a War Chest.'
  ]],
  ['raids','PvE, PvP & raids','Choose a fight you can sustain', ({config}) => {
    const r=config?.expeditionRules;
    const limits=config?.rules;
    return [r ? `After the tutorial, expeditions against NPCs cost ${r.cost.wood} wood and ${r.cost.food} food. You can launch ${r.dailyLimit} per rolling day, with ${duration(r.playerCooldown)} between expeditions and ${duration(r.rematchCooldown)} between rematches. Bring at least ${r.minimumTroops} troops. The target garrison also has a shared rest window.` :
      'After the tutorial, look for eligible NPC expeditions in War. These cost earned supplies and have independent recovery timers.',
    'NPC victories can award earned goods and Season Points. Both sides can lose troops.',
    `Standard rival raids require seasonal PvP enrollment and spend an attack slot. ${limits?.attacksDaily?`You have ${limits.attacksDaily} attacks per rolling day, with ${duration(limits.repeatAttack)} between raids on the same opponent. `:''}There are no shields this season: power bands, agreements, daily limits and recent raids are what can block an attack. Open the raid planner to see the live checks. A paid raid is different: you stake BCH against the same amount in the defender’s War Chest, and it only applies after confirmation. It is offered only when the defender’s War Chest covers your stake.`,
    'Basic Recon estimates an army; Deep Recon examines its composition; Supply exposes estimates of stores. Sabotage can disrupt production temporarily. Each mission costs supplies and Scout Points. Detection can remove an agent while a replacement is trained. Counterintelligence makes hostile missions harder, and decoys can mislead reports. Check the Scout Tower for current costs, recovery timers, and the confidence and expiry of each report.'];
  }],
  ['politics','Alliances, diplomacy & protectorates','Win at the council table', () => [
    'Alliance members can send supplies, share reports, and rally troops. Diplomats can propose or counter ceasefires, defense or trade agreements, reparations, and other treaties. A treaty can remove a target from your eligible raids.',
    'The Politics assembly tracks legitimacy, loyalty, influence, and unrest. Taxes, trade restrictions, relief, and political choices affect production or morale. Rebellion uses covert cells and a preparation window before battle.',
    'A protectorate is temporary and has response options. An active pact can divert 8% of earned production for up to 48 hours. The sponsor pays upkeep; the defender can resist or prepare rebellion. No pact can debit an ordinary wallet.'
  ]],
  ['progression','Progression, research & items','Specialize your kingdom', () => [
    'Research Library unlocks Logistics, Fortification, War Doctrine, and Signalcraft. Compare the current and next effects before spending supplies. City levels, troops, and research persist when a season ends.',
    'Commanders specialize in different jobs, and relevant actions can grant mastery. Open Commander Hall for current perks and unlock requirements, and Inventory for items, entitlements, and stored rush credits.',
    'A BCH rush halves the time left on a construction in progress, once per construction. It is applied after 1 confirmation when less than an hour is left, otherwise after 2. Rush and premium upgrades share one use per rolling day. Ordinary upgrades and research remain available using earned resources.'
  ]],
  ['seasons','Seasons, rankings & rewards','Make each campaign count', ({config}) => [
    `Seasons last ${duration(config?.economy?.seasonLength ?? 604800000)}. Earn points through development, research, defense, intelligence, battles, and diplomacy. Standings archive at rollover; season scores and seasonal holdings reset while your city and army remain.`,
    'A prize depends on the archived eligible ranking, verified funding, and a valid claim window. A season with fewer than two eligible participants carries funds forward. Check Rankings and your War Chest page before expecting a reward.',
    'Verify a BCH receiving address to claim a funded prize. The payout quote shows the amount, destination, and fee. A pending payout or leaderboard place is not a confirmed reward.'
  ]],
  ['blockchain','BCH wallet, payments & treasuries','Powered by Bitcoin Cash', ({chain}) => [
    'Connect a compatible BCH wallet to prepare a checkout. Connecting and signing an ownership message cost no BCH. A link becomes a sign-in credential when you prove ownership of the receiving address.',
    `Selected upgrades, funded attacks and territory contests, protectorate actions, political operations and War Chest deposits use BCH when available. Review network, amount, outputs, possible losses, and the separate fee before approving. ${chain?.minConfirmations ? `Ordinary payments need ${chain.minConfirmations} confirmations in this realm. Rare drawings use separate confirmation rules.` : ''}`,
    (NETWORK.realValue ? 'This realm’s payments are real Bitcoin Cash on Mainnet. Only pay what you can afford to lose in play, and check every amount in your wallet before you approve.' : 'This realm’s payment flows run on ' + NETWORK_LABEL + ', the BCH test network: its coins have no value. Only use the network shown at checkout.') + ' The journal distinguishes pending, verified, applied, and reviewed outcomes. Signing or submitting a transaction does not prove it was applied.',
    'You have one treasury in the game: your War Chest. It is separate from your external wallet and from the seasonal prize pool. Every service payment is split by your own transaction: 50% to your War Chest, 20% to the season prize pool, 20% to Development and 10% burned. Network reserves are shown apart from the price. You can also deposit straight into your War Chest; a deposit is not split.',
    'A BCH payment is final once it confirms. If the service you paid for can no longer be delivered at that moment, you are given one credit for the same kind of service and your next one costs nothing. That credit is kept by the game, not on the blockchain: it is not a BCH refund and cannot be withdrawn, transferred or exchanged.',
    'The whole War Chest is always at risk in PvP, under matched stakes. A paid raid is sold only when the defender’s War Chest covers the attacker’s chosen stake. If the attacker wins, one transaction pays the attacker both stakes; if the defender wins, the defender receives the attacker’s whole stake. The ' + ATTESTOR_ADJECTIVE + ' attestors replay the battle and sign the outcome; the game cannot choose it, and a higher stake never changes the battle. Free raids never move BCH.' +
      (NETWORK.attestorOperation === 'owner' ? ' This season the attestors are run by the VaultBorn team; anyone can replay a battle from the public record.' : ''),
    'If a payment becomes final after the action it was bought for has ended (an upgrade finished, a treaty lapsed, the checkout expired), nothing is lost: your War Chest share is yours as always, and the service is owed to you. Your next request of that kind is delivered at once, without a checkout. A withdrawal takes exactly the amount you name out of your War Chest, in whole thousands of satoshis; your wallet receives it less the network fee shown before you confirm.',
    'Sponsorship allocates 30% to the Development address and 70% to the Seasonal Prize Fund covenant, which pays prizes only with the ' + ATTESTOR_ADJECTIVE + ' attestor signature. The Chain Explorer shows the recorded allocation and its verification evidence.'
  ]],
  ['identity','CashTokens & Nostr','Carry your identity and proofs', () => [
    'CashTokens back transferable proof collectibles when supported by the realm. Transferring a collectible does not move command of a city, its garrison, or a territory lease.',
    'Nostr sign-in uses a signed private challenge. You can also link BCH and Nostr to make a verifiable public association between both keys and your kingdom. That public proof discloses the linked identifiers; the standalone sign-in does not publish it.',
    'Wallet pairing alone does not prove ownership. Sign the exact challenge with your verified key. Keep private keys in your own signer.'
  ]],
  ['faq','Frequently asked questions','From the quartermaster', () => [
    'Do I need BCH or a wallet? No. You can found a city, build, recruit, research, trade earned goods, and go on NPC expeditions without a wallet.',
    'Why can’t I raid? Check the planner for power, attack slots, treaties, and cooldowns. NPC expeditions have their own requirements.',
    'Can I run the guide again? Open the First Campaign below. You can resume where you stopped or review a completed campaign without receiving the reward again.',
    'I paid, but the action was no longer available. What now? The service is owed to you: the next action of the same kind is free and needs no checkout. Your War Chest page lists what is owed.',
    'Where are my receipts? Open the ' + NETWORK_LABEL + ' journal or Chain Explorer. Follow the receipt until the observer verifies the matching outputs and the game records the result.'
  ]],
];

export const guideLink=(topic='start', label='Game guide')=>btn(label,'journal',{modal:'codex',id:topic},'codex-link');

export function renderCodex(state,requested){
  const selected = topics.some(([id])=>id===requested) ? requested : '';
  return `<div class="codex" data-codex>
    <div class="codex-intro"><p class="kicker">The frontier codex</p><p>Rules, costs, and advice for your kingdom.</p></div>
    <label class="codex-search">Search the guide<input type="search" data-codex-search placeholder="Try ‘expedition’ or ‘vault’" autocomplete="off"></label>
    <nav aria-label="Guide chapters" class="codex-chapters"><button type="button" data-codex-topic="" aria-pressed="${!selected}">All</button>${topics.map(([id,name])=>`<button type="button" data-codex-topic="${id}" aria-pressed="${selected===id}">${html(name)}</button>`).join('')}</nav>
    <p class="codex-empty" data-codex-empty hidden role="status">No chapters matched. Try a different word.</p>
    ${topics.map(([id,name,kicker,paragraphs])=>`<details data-codex-section="${id}" ${selected&&selected!==id?'hidden':''} ${selected===id?'open':''}>
      <summary>${html(name)}</summary><div class="codex-entry"><p class="kicker">${html(kicker)}</p>${paragraphs(state).map(p=>`<p>${html(p)}</p>`).join('')}</div></details>`).join('')}
    <div class="buttons">${btn('Open the First Campaign','flag',{'show-guide':'true'},'primary')}</div></div>`;
}

export function filterCodex(root,{chapter,term}={}){
  const field=root.querySelector('[data-codex-search]');
  const query=(term??'').trim().toLowerCase();
  for (const tab of root.querySelectorAll('[data-codex-topic]')) tab.setAttribute('aria-pressed',String(!query&&tab.dataset.codexTopic===(chapter??'')));
  if (chapter!==undefined) field.value='';
  let matches=0;
  for (const article of root.querySelectorAll('[data-codex-section]')) {
    const match = query ? query.split(/\s+/).every(word=>article.textContent.toLowerCase().includes(word)) : (!chapter||article.dataset.codexSection===chapter);
    article.hidden=!match;
    article.open=Boolean(match&&(chapter||query));
    if (match) matches++;
  }
  root.querySelector('[data-codex-empty]').hidden=matches!==0;
}
