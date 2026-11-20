import { digest, simulateBattle } from './combat.mjs';
import { award, credit, currentTactic, notify, requireRule } from './world.mjs';

// Bitcoin Cash comes right after the first construction: while City Hall is being built, a rush can finish it sooner.
const lessons = ['welcome', 'homeland', 'construction', 'discover-bch', 'bch-wallet', 'bch-actions', 'stores', 'troops',
  'commander', 'tactics', 'drill', 'season-rewards', 'frontier'];
const requirements = {
  construction: 'Queue a City Hall upgrade or another standard construction project.',
  stores: 'Claim your daily supplies in My City.',
  troops: 'Queue at least one troop in the Barracks.',
  tactics: 'Save a formation or tactic in Army orders.',
  drill: 'Run the training battle against the Frontier Guard.',
};
const firstBannerReward = { wood:45, stone:30, iron:18, food:50, crystal:5 };

export function startOnboarding(city, now) {
  if (!city.pendingOnboarding) return;
  delete city.pendingOnboarding;
  city.onboarding = { status:'active', step:'welcome', startedAt:now, orders:{} };
  // A kingdom that has just signed up is greeted once, with the choice of the tutorial, the instructions or neither.
  city.welcome = 'pending';
}

export function recordOnboardingOrder(city, input) {
  const chapter = city.onboarding;
  if (!chapter || !['active', 'paused'].includes(chapter.status)) return;
  if (input.type === 'upgrade') chapter.orders.construction = true;
  if (input.type === 'train') chapter.orders.troops = true;
  if (input.type === 'configure' && (input.formation !== undefined || input.tactic !== undefined)) {
    chapter.orders.tactics = true;
  }
}

function lessonReady(city, chapter) {
  switch (chapter.step) {
    case 'construction': return !!chapter.orders.construction || city.buildings.hall > 1 || city.queue.some(job => job.kind === 'building');
    case 'stores': return !!(city.dailyClaim || city.lastCollect);
    case 'troops': return !!chapter.orders.troops || city.queue.some(job => job.kind === 'troop') || city.history.some(job => job.kind === 'troop');
    case 'tactics': return !!chapter.orders.tactics;
    case 'drill': return !!chapter.drill;
    default: return true;
  }
}

export function onboardingSnapshot(city) {
  const chapter = city.onboarding;
  if (!chapter) return null;
  const ready = !guideOpen(city) || lessonReady(city, chapter);
  return { status:chapter.status, step:chapter.step, position:lessons.indexOf(chapter.step) + 1, total:lessons.length,
    ready, requirement:ready ? null : requirements[chapter.step], drill:chapter.drill ?? null };
}

// The guide is open until its banner has been raised. Kingdoms that are open from day one carry `tutorialOpen`;
// older ones are told by the tutorial flag alone.
const guideOpen = city => city.tutorialOpen ?? !city.tutorial;

function runDrill(world, city, now) {
  const attacker = currentTactic(city, world, now);
  const guard = { troops:{ infantry:24, shield:10, archer:15, cavalry:5, siege:1, mage:1 },
    hero:'warden', formation:'line', tactic:'balanced', tech:{ tactics:0 }, wall:0, fieldRules:attacker.fieldRules };
  const input = { attacker, defender:guard, terrain:'plains' };
  const seed = digest(['frontier-drill-1', city.id, input]);
  const trace = [];
  const outcome = simulateBattle(input, seed, undefined, exchange => trace.push(exchange));
  const battle = { id:'training', kind:'tutorial-drill', training:true, attacker:city.id, defender:'training-guard',
    attackerName:city.name, defenderName:'Frontier Guard', at:now, input, seed, commitment:digest({input,seed}), paid:false, ...outcome };
  return { battle, trace };
}

function grantFirstBanner(world, city, now) {
  city.tutorial = true;
  delete city.tutorialOpen;
  city.founding = false;
  award(city, 'first-banner', now);
  city.influence = Math.min(100, city.influence + 8);
  const reward = credit(city, firstBannerReward, now);
  const text = city.onboarding ? 'Your first banner is raised. Your kingdom is yours to command.' :
    'Welcome to the frontier. Visit My City to queue a construction project.';
  notify(world, city.id, text, now, 'city', { title:'First banner raised', achievement:'first-banner', resources:reward });
  return { completed:true, reward };
}

export function tutorialCommand(world, city, input, now) {
  if (input.action === 'practice') {
    requireRule(!city.founding, 'founding_required', 'Found your settlement before running the training drill.');
    return { drill:runDrill(world, city, now) };
  }
  requireRule(guideOpen(city), 'tutorial_complete', 'Your tutorial has already been completed.');
  requireRule(!city.pendingOnboarding, 'founding_required', 'Found your settlement before beginning the tutorial.');
  const chapter = city.onboarding;
  if (!chapter) {
    requireRule(input.action === undefined, 'tutorial_missing', 'This kingdom does not have a first chapter.');
    return grantFirstBanner(world, city, now);
  }

  requireRule(input.step === chapter.step, 'tutorial_step_changed', 'The chapter has moved to a different lesson.');
  if (input.action === 'skip' || input.action === 'finish') {
    const skip = input.action === 'skip';
    requireRule(skip || chapter.status === 'active' && chapter.step === 'frontier',
      'tutorial_incomplete', 'Reach the last lesson before raising your banner.');
    chapter.status = skip ? 'skipped' : 'completed';
    chapter.completedAt = now;
    delete chapter.drill;
    const result = grantFirstBanner(world, city, now);
    return { ...result, onboarding:onboardingSnapshot(city) };
  }

  if (input.action === 'resume' && chapter.status === 'paused') {
    chapter.status = 'active';
    return { onboarding:onboardingSnapshot(city) };
  }
  requireRule(chapter.status === 'active', 'tutorial_paused', 'Resume the chapter before moving to another lesson.');
  const index = lessons.indexOf(chapter.step);
  switch (input.action) {
    case 'pause':
      chapter.status = 'paused';
      break;
    case 'next':
      requireRule(index < lessons.length - 1, 'tutorial_finish', 'Raise your banner to finish the chapter.');
      requireRule(lessonReady(city, chapter), 'tutorial_action_required', requirements[chapter.step]);
      chapter.step = lessons[index + 1];
      break;
    case 'back':
      requireRule(index > 0, 'tutorial_first_lesson', 'This is the first lesson.');
      chapter.step = lessons[index - 1];
      break;
    case 'drill':
      requireRule(chapter.step === 'drill', 'tutorial_wrong_lesson', 'Open the training lesson before running the drill.');
      chapter.drill = runDrill(world, city, now);
      return { onboarding:onboardingSnapshot(city), drill:chapter.drill };
    default:
      requireRule(false, 'tutorial_invalid_action', 'Choose an available chapter action.', 400);
  }
  return { onboarding:onboardingSnapshot(city) };
}
