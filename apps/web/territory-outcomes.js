import { playGameCue } from './game-audio.js';
import { icon } from './icons.js';

const outcomes = [
  [/^Territory claimed:/i, 'Territory claimed', 'flag', 'claim', 'award'],
  [/^(Victory at|Your garrison defended)/i, 'Victory', 'sword', 'victory', 'award'],
  [/^(Defeat at|Your army withdrew from the contest)/i, 'Defeat', 'shield', 'defeat', 'loss'],
  [/^Territory lost:/i, 'Territory lost', 'flag', 'defeat', 'loss'],
  [/^Rare lease awarded at/i, 'Rare lease awarded', 'crystal', 'raffle', 'lease'],
  [/^Lease expired at/i, 'Lease expired', 'crystal', 'lease-end', 'loss'],
];
let timer;

export function presentTerritoryNews(updates, muted) {
  const latest = updates.find(update => update.kind === 'territory');
  if (!latest) return false;
  const result = outcomes.find(([pattern]) => pattern.test(latest.text));
  if (!result) {
    playGameCue(/incoming attack/.test(latest.text.toLowerCase()) ? 'dispatch' :
      /rare territory entry/.test(latest.text.toLowerCase()) ? 'raffle' : 'message', muted);
    return true;
  }
  const [,label,glyph,cue,tone] = result;
  playGameCue(cue, muted);
  const notice = document.getElementById('territory-outcome');
  clearTimeout(timer);
  if (notice.matches(':popover-open')) notice.hidePopover();
  notice.className = 'territory-outcome ' + tone;
  notice.innerHTML = `${icon(glyph)}<strong></strong><small></small>`;
  notice.querySelector('strong').textContent = label;
  notice.querySelector('small').textContent = latest.text;
  notice.showPopover();
  timer = setTimeout(() => notice.hidePopover(), 4100);
  return true;
}
