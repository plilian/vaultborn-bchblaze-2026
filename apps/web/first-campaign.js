import { icon } from './icons.js';
import { html } from './view.js';

export const guideSteps = [
  { id: 'welcome', title: 'Your banner rises', text: 'I’m Captain Elowen. This stronghold is yours to develop. I’ll show you how to turn its first supplies into a kingdom that can hold its own.' },
  { id: 'homeland', title: 'Know your homeland', text: 'Inspect your Starter Territory on the world map. The frontier has granted it to you free of charge, and rival kingdoms cannot take it.', action: 'Inspect your homeland', requiresVisit: true },
  { id: 'construction', title: 'Raise the City Hall', text: 'Open a building and review the cost and completion time. A standard upgrade spends earned supplies. Queue your first project to see the builders get to work.', action: 'Open City Hall' },
  { id: 'discover-bch', title: 'Discover Bitcoin Cash', text: 'Your kingdom starts with earned supplies. Bitcoin Cash powers selected upgrades, matched-stake raids and seasonal prizes. Half of anything you pay for a service goes into your own War Chest. You can build, recruit and fight frontier armies for free.', action: 'Read about Bitcoin Cash', requiresVisit: true, education: true, complete: 'Bitcoin Cash chapter opened' },
  { id: 'bch-wallet', title: 'Your BCH wallet', text: 'A BCH wallet can approve payments and receive prizes. Connecting and signing an ownership message cost no BCH. Open the wallet pane to see your choices; you can leave it unconnected.', action: 'Open wallet options', requiresVisit: true, education: true, complete: 'Wallet options viewed' },
  { id: 'bch-actions', title: 'Review BCH actions', text: 'Your City Hall is being built right now. A BCH rush halves the time it has left, and a premium upgrade adds a lasting perk. Standard construction spends supplies. A paid raid stakes BCH against the same amount in the defender’s War Chest, and the winner takes both. If you ever pay, inspect the exact cost, benefits and network fee first.', action: 'Compare City Hall options', requiresVisit: true, education: true, complete: 'Upgrade options viewed' },
  { id: 'stores', title: 'Open the storehouses', text: 'Your buildings produce supplies over time. The quartermaster’s daily shipment puts supplies directly into your stores when there is room.', action: 'Open daily supplies' },
  { id: 'troops', title: 'Muster your garrison', text: 'Queue at least one recruit in the Barracks. Compare each troop’s attack, guard and life before you choose what to field.', action: 'Train infantry' },
  { id: 'commander', title: 'Meet your commander', text: 'The Warden King leads your first army. Review his abilities and mastery, then learn how other commanders can be recruited or hired as you grow.', action: 'Open Commander Hall', requiresVisit: true },
  { id: 'tactics', title: 'Give the army its orders', text: 'Open Army orders and try a formation or tactic. These orders change how your army fights. Save your choice before taking the field.', action: 'Set formation and tactics' },
  { id: 'drill', title: 'Take the training field', text: 'Face the Frontier Guard with the army and orders you have now. The drill uses the campaign’s combat rules. Your garrison is safe, and no BCH is at stake.', action: 'Start the drill' },
  { id: 'season-rewards', title: 'Earn season rewards', text: 'Earn Season Points and check the standings. Eligible finishers can claim BCH from a funded season. Opening the standings won’t enroll you in PvP, and a prize is never guaranteed.', action: 'Open season standings', requiresVisit: true, education: true, complete: 'Season standings viewed' },
  { id: 'frontier', title: 'The frontier awaits', text: 'Research a technology, join an alliance, or scout a rival. Rival raids and territory contests require separate seasonal enrollment, so choose when you are ready.' },
];

export const guideStepTargets = {
  homeland: '.territory-marker.territory-starter.owned', construction: '[data-modal="building"][data-id="hall"]',
  stores: '#campaign [data-modal="daily"]', troops: '[data-modal="training"][data-id="infantry"]',
  commander: '#campaign [data-modal="commander"]', tactics: '#campaign [data-modal="formation"]',
  'discover-bch': '#masthead [data-modal="codex"], #masthead [data-modal="guide"]',
  'bch-wallet': '#masthead [data-modal="wallet"]',
  'bch-actions': '#campaign [data-modal="building"][data-id="hall"], #dock [data-page="city"]',
  'season-rewards': '#masthead [data-page="rankings"], #dock [data-page="rankings"]',
};

const control = (label, action, glyph, style = '') =>
  `<button type="button" class="btn ${style}" data-guide-action="${action}">${glyph ? icon(glyph) : ''}${html(label)}</button>`;

export function renderGuide({ progress, review, confirmSkip, seen }) {
  const step = guideSteps.find(item => item.id === progress.step);
  if (!step) return '';
  const isFinal = step.id === 'frontier';
  const needsVisit = step.requiresVisit;
  const mayContinue = review || (progress.ready && (!needsVisit || seen));
  const primary = step.action && (review || !mayContinue || needsVisit);
  const drillAction = step.id === 'drill' && progress.drill;
  const readyNote = !review && progress.ready && (!needsVisit || seen) && step.action && !drillAction &&
    (step.complete ?? { homeland: 'Homeland inspected', construction: 'Construction ordered', stores: 'Supplies claimed', troops: 'Recruitment ordered', commander: 'Commander inspected', tactics: 'Orders saved' }[step.id]);
  return `<div class="guide-banner">
    <img src="/art/hero-ranger.webp" alt="">
    <div><span class="guide-kicker">${review ? 'Campaign guide' : 'First campaign'}</span><strong>Captain Elowen</strong></div>
    ${control(review ? 'Close guide' : 'Later', review ? 'close' : 'pause', 'x', 'guide-later')}
  </div>
  <div class="guide-content">
    <div class="guide-chapter"><span>Chapter ${progress.position} of ${progress.total}</span><progress max="${progress.total}" value="${progress.position}" aria-label="Campaign guide progress"></progress></div>
    <h2 id="campaign-guide-title" tabindex="-1">${html(confirmSkip ? 'Dismiss the campaign guide?' : step.title)}</h2>
    <p>${html(confirmSkip ? 'You can read the guide again from your profile. Your kingdom and current orders will be here when you return.' : step.text)}</p>
    ${step.education && !confirmSkip ? `<p class="guide-learning-note">${icon('bch')}<span>No payment required for this lesson</span></p>` : ''}
    ${readyNote && !confirmSkip ? `<p class="guide-complete">${icon('check')}${html(readyNote)}</p>` : ''}
    ${!confirmSkip && drillAction ? `<p class="guide-complete">${icon('check')} Drill complete</p>` : ''}
    <div class="guide-actions">
      ${confirmSkip ? control('Keep the guide', 'keep', null)+control('Skip tutorial', 'skip', 'check', 'primary') :
    `${progress.position > 1 ? control('Back', 'back', null) : ''}
    ${drillAction ? control('Replay the drill', 'open', 'war') : primary ? control(step.action, 'open', step.id === 'drill' ? 'war' : 'arrow', mayContinue ? '' : 'primary') : ''}
    ${mayContinue ? control(isFinal ? (review ? 'Close guide' : 'Finish tutorial') : 'Continue', isFinal && review ? 'close' : isFinal ? 'finish' : 'next', 'arrow', 'primary') : ''}
    ${review ? '' : control('Skip', 'confirm-skip', null, 'guide-skip')}`}
    </div><p class="guide-error" role="status"></p>
  </div>`;
}
