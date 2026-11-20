// The BCH BLAZE 2026 bar, shared by the home page and the game page, and the trailer player.
// The trailer costs nothing until it is played: the page holds only a small poster, and the video file is requested
// (in byte ranges) the moment the player presses play. Built with DOM calls, never with markup from values.
import { BLAZE } from './blaze.js';

export const TRAILER = Object.freeze({ src: '/media/vaultborn-trailer.mp4', poster: '/media/vaultborn-trailer.webp',
  captions: '/media/vaultborn-trailer.vtt', title: 'VaultBorn trailer' });

const make = (tag, attributes = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), attributes);
  node.append(...children);
  return node;
};

// A <video> for the trailer, created only when it is wanted.
export function trailerVideo({ autoplay = true } = {}) {
  const video = make('video', { controls: true, playsInline: true, preload: autoplay ? 'auto' : 'none', poster: TRAILER.poster, src: TRAILER.src });
  video.setAttribute('aria-label', TRAILER.title);
  video.append(make('track', { kind: 'captions', srclang: 'en', label: 'English', src: TRAILER.captions, default: true }));
  video.addEventListener('error', () => {
    video.replaceWith(make('p', { className: 'trailer-missing', textContent: 'The trailer is not available on this server right now.' }));
  }, { once: true });
  if (autoplay) queueMicrotask(() => video.play().catch(() => { /* The player shows its own play button. */ }));
  return video;
}

// The trailer in a dialog of its own, for pages that have no room for it (the game page).
export function openTrailerDialog() {
  let dialog = document.getElementById('trailer-dialog');
  if (!dialog) {
    const close = make('button', { type: 'button', className: 'trailer-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close the trailer');
    dialog = make('dialog', { id: 'trailer-dialog', className: 'trailer-dialog' }, [close, make('div', { className: 'trailer-frame' })]);
    dialog.setAttribute('aria-label', TRAILER.title);
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => dialog.querySelector('video')?.pause());
    document.body.append(dialog);
  }
  const frame = dialog.querySelector('.trailer-frame');
  if (!frame.querySelector('video')) frame.replaceChildren(trailerVideo());
  else void frame.querySelector('video').play().catch(() => {});
  dialog.showModal();
}

// Fills the bar. `onTrailer` decides how the trailer opens on this page.
export function mountBlazeBar(banner, { onTrailer = openTrailerDialog, compact = false } = {}) {
  if (!banner || !BLAZE.enabled) return false;
  banner.replaceChildren();
  const add = (tag, text, attributes = {}) => { const node = make(tag, { textContent: text, ...attributes }); banner.append(node); return node; };
  const anchor = (text, href) => href && add('a', text, { href, target: '_blank', rel: 'noopener' });
  add('strong', BLAZE.event + ' entry');
  const watch = add('button', '▶ Watch the trailer', { type: 'button', className: 'blaze-trailer' });
  watch.addEventListener('click', () => onTrailer());
  anchor('Presentation', BLAZE.presentation);
  anchor('Source code', BLAZE.repository);
  if (!compact) {
    anchor('Repository before the hackathon', BLAZE.oldRepository);
    anchor('Demo before the hackathon', BLAZE.earlierDemo);
  }
  if (BLAZE.emberAddress) {
    const vote = add('span', compact ? 'EMBER2026 vote: ' : 'Community Choice: send EMBER2026 to ', { className: 'blaze-vote' });
    vote.append(make('code', { textContent: BLAZE.emberAddress }));
    const copy = add('button', 'Copy', { type: 'button' });
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(BLAZE.emberAddress); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select the address to copy'; } });
  }
  banner.hidden = false;
  document.documentElement.classList.add('blaze-on');
  return true;
}
