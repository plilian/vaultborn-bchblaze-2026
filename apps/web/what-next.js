import { icon } from './icons.js';
import { btn, command, costs, html, list, number } from './view.js';

// Where each campaign task is done.
const taskPlace = {
  daily:{ modal:'daily' }, 'hall-2':{ modal:'building', id:'hall' }, 'hall-3':{ modal:'building', id:'hall' }, 'hall-5':{ modal:'building', id:'hall' },
  'walls-3':{ modal:'building', id:'walls' }, train:{ page:'city', 'start-tab':'army' }, 'army-150':{ page:'city', 'start-tab':'army' },
  research:{ page:'city', 'start-tab':'research' }, scout:{ page:'war', 'start-tab':'intelligence' }, battle:{ page:'war', 'start-tab':'expeditions' },
  alliance:{ page:'alliance' }, commander:{ page:'city', 'start-tab':'heroes' }, territory:{ page:'war', 'start-tab':'territory' },
};

// "What next": the few useful things this kingdom can do right now, most useful first, each one click away.
export function whatNext({ own, state, guide, walletLinked }) {
  if (!own || own.founding) return [];
  const queue = list(own.queue);
  const busy = kind => queue.some(job => job.kind === kind);
  const scouting = list(state.missions).some(mission => mission.status === 'pending');
  const steps = [
    own.onboarding?.status === 'active' && guide !== 'active' &&
      ['quest', 'Continue the guide', 'Captain Elowen shows you the next step.', { 'show-guide':'true' }],
    state.offlineReport?.unread &&
      ['journal', 'See what happened while you were away', 'Attacks, scouting, losses and gains.', { modal:'offline-report' }],
    own.dailyReward?.status === 'available' &&
      ['gift', 'Claim daily supplies', 'A free shipment is waiting at your gates.', { modal:'daily' }],
    !busy('building') &&
      ['hammer', 'Upgrade a building', 'Your builders are idle. Higher buildings produce and protect more.', { page:'city', 'start-tab':'build' }],
    !busy('troop') &&
      ['helmet', 'Train troops', 'Your barracks are idle. A bigger army wins more raids.', { page:'city', 'start-tab':'army' }],
    own.attacksLeft > 0 &&
      ['war', 'Raid an NPC kingdom or a rival', number(own.attacksLeft) + (own.attacksLeft === 1 ? ' attack' : ' attacks') +
        ' left today. Raids bring resources and Season Points.', { page:'war', 'start-tab':'expeditions' }],
    !busy('research') &&
      ['book', 'Research a technology', 'The library is idle. Research makes every troop stronger.', { page:'city', 'start-tab':'research' }],
    own.spies > 0 && !scouting &&
      ['spy', 'Scout a rival', 'Know an army before you attack it.', { page:'war', 'start-tab':'intelligence' }],
    !walletLinked &&
      ['bch', 'Connect your BCH wallet', 'Keeps your kingdom yours on any device and lets you claim prizes.', { modal:'wallet' }],
    !own.alliance &&
      ['alliance', 'Join an alliance', 'Allies send aid and fight together.', { page:'alliance' }],
  ].filter(Boolean);
  return steps.length ? steps : [['trophy', 'Check the season standings', 'See where your kingdom stands.', { page:'rankings' }]];
}

export const claimableTasks = own => list(own?.tasks).filter(task => task.done && !task.claimed);
const openTasks = own => list(own?.tasks).filter(task => !task.done);

// On the screen, under My City: a reward ready to claim first, otherwise the next thing to do; then the next task.
export function whatNextPanel(steps, own) {
  if (!steps.length && !list(own?.tasks).length) return '';
  const ready = claimableTasks(own), next = openTasks(own)[0];
  const [glyph, label, , data] = steps[0] ?? [];
  const main = ready.length ?
    `<button type="button" class="what-next-step reward" data-modal="next">${icon('gift')}<span>${number(ready.length)} ${ready.length === 1 ? 'reward' : 'rewards'} to claim</span>${icon('chevron')}</button>` :
    label ? `<button type="button" class="what-next-step" ${attributes(data)}>${icon(glyph)}<span>${html(label)}</span>${icon('chevron')}</button>` : '';
  const task = next ? `<button type="button" class="what-next-task" ${attributes(taskPlace[next.id] ?? { modal:'next' })}>${icon('quest')}<span>${html(next.title)}</span>${next.goal ?
    `<small>${number(next.progress)}/${number(next.goal)}</small>` : ''}</button>` : '';
  return `<section class="what-next" aria-label="What next"><h3>${icon('compass')}What next
    <button type="button" class="what-next-more" data-modal="next">All</button></h3>${main}${task}</section>`;
}

// The whole list, in its own dialog: rewards ready to claim, the campaign tasks, then what to do right now.
export function whatNextContents(steps, own) {
  const ready = claimableTasks(own), tasks = openTasks(own), claimed = list(own?.tasks).filter(task => task.claimed);
  const taskRow = (task, action) => `<li>${icon(task.done ? 'gift' : 'quest')}<div><strong>${html(task.title)}</strong>
    ${task.goal && !task.done ? `<p>${number(task.progress)}/${number(task.goal)}</p>` : ''}${costs(task.reward)}</div>${action}</li>`;
  return `${ready.length ? `<h3>Rewards to claim</h3><ol class="what-next-list">${ready.map(task =>
      taskRow(task, command('Claim', 'gift', { type:'task-claim', task:task.id }, 'primary'))).join('')}</ol>
      <p class="quiet-text">Only resources that fit in your stores are added.</p>` : ''}
    ${tasks.length ? `<h3>Campaign tasks</h3><ol class="what-next-list">${tasks.slice(0, 4).map(task =>
      taskRow(task, btn('Go', 'arrow', { ...(taskPlace[task.id] ?? {}), ...(taskPlace[task.id]?.page && { dismiss:'true' }) }))).join('')}</ol>
      ${tasks.length > 4 ? `<p class="quiet-text">${number(tasks.length - 4)} more ${tasks.length - 4 === 1 ? 'task follows' : 'tasks follow'}.</p>` : ''}` : ''}
    <h3>Do now</h3><ol class="what-next-list">${steps.slice(0, 4).map(([glyph, label, why, data]) =>
      `<li>${icon(glyph)}<div><strong>${html(label)}</strong><p>${html(why)}</p></div>${btn('Go', 'arrow', { ...data, ...(data.page && { dismiss:'true' }) })}</li>`).join('')}</ol>
    ${claimed.length ? `<p class="quiet-text">${number(claimed.length)} of ${number(list(own?.tasks).length)} task rewards claimed.</p>` : ''}
    <div class="buttons">${btn('Open the game guide', 'journal', { modal:'codex' })}</div>`;
}

const attributes = data => Object.entries(data).map(([key, value]) => `data-${key}="${html(value)}"`).join(' ');
