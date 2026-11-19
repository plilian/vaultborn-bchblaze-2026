import { playGameCue } from './game-audio.js';
import { icon } from './icons.js';
import { list } from './view.js';

const outcomes = {
  coup: ['COUP SUCCESSFUL', 'war', 'rebellion', 'political-coup'],
  'civil-war': ['CIVIL WAR', 'war', 'rebellion', 'political-war'],
  peace: ['PEACE SIGNED', 'flag', 'protectorate', 'political-peace'],
  alliance: ['ALLIANCE FORMED', 'alliance', 'protectorate', 'political-peace'],
  rebellion: ['REBELLION SUCCESSFUL', 'horn', 'rebellion', 'political-coup'],
  independence: ['INDEPENDENCE DECLARED', 'crown', 'victory', 'political-independence'],
};

let timer;
let outcomePage = 'history';
export const politicalOutcomePage = () => outcomePage;

function inferPoliticalOutcome(entry) {
  const text = entry.text ?? entry.message ?? '';
  if (entry.result === 'coup-successful' || /coup (?:was )?(?:successful|succeeded)|coup.+(?:resolved for the challenger|challenger prevailed|won the conflict)/i.test(text)) return 'coup';
  if (entry.kind === 'conflict-opened' && entry.category === 'civil-war' || /civil war (?:has begun|began|mobilization|declared|erupted)/i.test(text)) return 'civil-war';
  if (/peace (?:treaty|signed|ratified)/i.test(text) && !/propos|declin|reject|breach|expir/i.test(text)) return 'peace';
  if (/(?:defensive )?alliance (?:formed|founded|ratified)|founded .+ alliance/i.test(text)) return 'alliance';
  if (entry.result === 'independence-declared' || entry.result === 'independence-restoration' || /independence (?:declared|recognized|movement resolved for the challenger)/i.test(text)) return 'independence';
  if (/rebellion (?:successful|succeeded)|protectorate.+is liberated/i.test(text)) return 'rebellion';
  return null;
}

function candidate(event) {
  const kind = inferPoliticalOutcome(event);
  const summaries = {coup:'The challenger took control of the government.', 'civil-war':'The factions have begun mobilizing.',
    peace:'The parties ratified the terms.', alliance:'The parties formed an alliance.', rebellion:'The rebellion secured its objective.',
    independence:'The independence movement prevailed.'};
  return kind ? {kind, text:event.text ?? event.message ?? summaries[kind], at:event.at ?? 0} : null;
}

export function presentPoliticalNews(previous, next, dispatches, muted) {
  const own = next.player.city?.id ?? next.player.id;
  const publicEntries = (state) => [...list(state.government?.history), ...list(state.diplomacy?.history), ...list(state.activity)];
  const seen = new Set(publicEntries(previous).map(entry => entry.id));
  const related = publicEntries(next).filter(entry => !seen.has(entry.id) &&
    ([entry.actor, entry.target, entry.initiator, entry.kingdomId, entry.proposerId, entry.idFrom, entry.idTo].includes(own) || list(entry.participants).includes(own)));
  const oldTreaties = list(previous.diplomacy?.treaties);
  const ratified = list(next.diplomacy?.treaties).filter(item => item.status === 'active' &&
    list(item.participants ?? [item.from,item.to]).includes(own) && oldTreaties.find(old=>old.id===item.id)?.status !== 'active');
  const treatyNews = ratified.flatMap(treaty => {
    const kind = ['peace','ceasefire'].includes(treaty.kind) ? 'peace' :
      ['defensive-alliance','defense','federation'].includes(treaty.kind) ? 'alliance' : null;
    return kind ? [{kind,text:kind === 'peace' ? 'The parties ratified the terms.' : 'The parties formed an alliance.',
      at:treaty.acceptedAt ?? treaty.activatedAt ?? next.now ?? 0}] : [];
  });
  if (next.alliance?.id && next.alliance.leader === own && next.alliance.id !== previous.alliance?.id) {
    treatyNews.push({kind:'alliance',text:next.alliance.name + ' has been founded.',at:next.now ?? 0});
  }
  const update = [...dispatches.map(candidate), ...related.map(candidate), ...treatyNews].filter(Boolean).sort((a, b) => b.at - a.at)[0];
  if (!update) return false;
  const [title, glyph, image, cue] = outcomes[update.kind];
  outcomePage = ['peace', 'alliance'].includes(update.kind) ? 'treaties' : 'conflicts';
  const viewer = document.getElementById('political-outcome');
  clearTimeout(timer);
  if (viewer.matches(':popover-open')) viewer.hidePopover();
  viewer.style.setProperty('--outcome-art', `url('/art/event-${image}.webp')`);
  viewer.classList.toggle('political-peace', outcomePage === 'treaties');
  viewer.innerHTML = `<div class="political-banner-content">${icon(glyph)}<strong></strong><p></p><div class="buttons"><button class="btn primary" type="button" data-political-review>Review dispatch</button><button class="btn" type="button" data-political-dismiss>Dismiss</button></div></div>`;
  viewer.querySelector('strong').textContent = title;
  viewer.querySelector('p').textContent = update.text;
  viewer.showPopover();
  playGameCue(cue, muted);
  timer = setTimeout(() => { if (viewer.matches(':popover-open')) viewer.hidePopover(); }, 10500);
  return true;
}
