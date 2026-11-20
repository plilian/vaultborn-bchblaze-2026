import { icon } from './icons.js';
import { btn, html, list } from './view.js';
import { eventHero } from './campaign-ledger.js';

const premiumBuildings = ['hall', 'vault', 'alliance', 'scout'];

// "Use BCH": every way to use Bitcoin Cash in the game, in one place, each one click away. Payments are always approved
// in the player's own wallet; nothing here pays by itself.
export function bchActionsContents(ctx) {
  const own = ctx.own, state = ctx.ui.state, config = state.config ?? {};
  const open = state.chain?.enabled === true && !state.vault?.quarantined;
  const wallet = Boolean(state.wallet?.address);
  const building = list(own.queue).find(job => job.kind === 'building');
  const premium = premiumBuildings.find(id => config.buildings?.[id]?.premium && !own.perks?.[id]);
  const usedToday = own.paidConvenienceLeft === 0;
  const name = id => config.buildings?.[id]?.name ?? id;
  const go = (data, label = 'Go') => btn(label, 'arrow', { ...data, ...(data.page && { dismiss:'true' }) }, 'primary');
  const rows = [
    building && !building.rushed ?
      ['clock', 'Rush your ' + name(building.key), 'It is being built now. A rush halves the time it has left.', ctx.feeLabel('rush'), go({ modal:'building', id:building.key }, 'Rush')] :
      ['clock', 'Rush a construction', 'Start an upgrade, then rush it: the time left is halved.', ctx.feeLabel('rush'), go({ page:'city', 'start-tab':'build' })],
    premium && ['crown', 'Premium ' + name(premium), config.buildings[premium].premium + '.', ctx.feeLabel('premium'), go({ modal:'building', id:premium })],
    ['spy', 'Paid intelligence mission', 'A recon report on a rival without using your Scout Tower’s points.', ctx.feeLabel('espionage'), go({ page:'war', 'start-tab':'intelligence' })],
    ['flag', 'Rare land raffle or territory claim', 'Win a 72-hour extraction lease on rare land, or claim frontier land.', 'Price shown at checkout', go({ page:'war', 'start-tab':'territory' })],
    ['crown', 'Back a political move', 'Protectorates and political operations.', 'Price shown at checkout', go({ page:'politics' })],
    ['vault', 'Fund your War Chest', 'Backs matched-stake raids. Everything in it is at risk in PvP.', 'You choose the amount', go({ modal:'chest' })],
  ].filter(Boolean);
  return eventHero('event-vault', 'Bitcoin Cash', 'Use BCH in your kingdom',
    'Every payment is approved in your own wallet. Half of what you pay for a service goes into your own War Chest.') +
    (!open ? '<p class="form-error">BCH payments are not available right now.</p>' : '') +
    (usedToday ? '<p class="quiet-text">You have used today’s rush or premium upgrade. The others are still open.</p>' : '') +
    (wallet ? '' : `<ol class="what-next-list"><li>${icon('bch')}<div><strong>Connect your BCH wallet first</strong><p>Free: connecting and proving it is yours sends nothing.</p></div>${btn('Connect', 'bch', { modal:'wallet' }, 'primary')}</li></ol>`) +
    `<ol class="what-next-list bch-actions">${rows.map(([glyph, title, why, price, action]) =>
      `<li>${icon(glyph)}<div><strong>${html(title)}</strong><p>${html(why)}</p><small class="bch-price">${icon('bch')}${html(price)}</small></div>${action}</li>`).join('')}</ol>
    <div class="buttons">${btn('How BCH works in the game', 'journal', { modal:'codex', id:'blockchain' })}</div>`;
}
