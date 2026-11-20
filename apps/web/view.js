import { icon } from './icons.js';

export const resources = ['wood', 'stone', 'iron', 'food', 'crystal'];
export const factions = ['emerald', 'azure', 'crimson', 'violet', 'gold'];
export const nav = [
  ['map', 'Map', 'map'], ['city', 'My City', 'city'], ['alliance', 'Alliance', 'alliance'],
  ['war', 'War', 'war'], ['politics', 'Politics', 'flag'], ['vault', 'Vault', 'vault'], ['rankings', 'Rankings', 'trophy'],
];
export const unitIcons = { infantry: 'sword', shields: 'shield', shield: 'shield', archer: 'bow', cavalry: 'horse', siege: 'siege', mage: 'magic' };
export const buildingIcons = { hall: 'city', barracks: 'helmet', walls: 'shield', vault: 'vault', workshop: 'hammer', market: 'market', library: 'book', alliance: 'flag', scout: 'spy', farm: 'food' };
export const factionIcons = { emerald: 'shield', azure: 'water', crimson: 'fire', violet: 'magic', gold: 'crown' };
export const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
export const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export function title(value) {
  return String(value ?? '').replace(/[_-]/g, ' ').replace(/\b[a-z]/g, char => char.toUpperCase());
}

export function list(value) {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}

export function number(value) {
  return value == null ? '—' : format.format(value);
}

export function bch(satoshis) {
  if (satoshis == null) return '—';
  try {
    const cents = BigInt(satoshis);
    const value = cents < 0n ? -cents : cents;
    return (cents < 0n ? '-' : '') + (value / 100_000_000n) + '.' + (value % 100_000_000n).toString().padStart(8, '0');
  } catch {
    return '—';
  }
}

export function duration(ms) {
  if (!(ms > 0)) return 'Ready';
  if (ms > 86_400_000) return Math.floor(ms / 86_400_000) + 'd ' + Math.floor(ms / 3_600_000 % 24) + 'h';
  if (ms > 3_600_000) return Math.floor(ms / 3_600_000) + 'h ' + Math.floor(ms / 60_000 % 60) + 'm';
  return Math.ceil(ms / 60_000) > 1 ? Math.ceil(ms / 60_000) + 'm' : Math.ceil(ms / 1000) + 's';
}

export function faction(city) {
  return factions.includes(city?.faction) ? city.faction : 'gold';
}
export function crest(city) {
  const color = faction(city);
  return `<span class="crest faction ${color}">${icon(factionIcons[color])}</span>`;
}
export function art(city) {
  return '/art/castle-' + faction(city) + '.webp';
}
export function stat(name, value, symbol, className = '') {
  return `<div class="stat">${icon(symbol)}<span>${html(name)}</span><b class="${className}">${html(value)}</b></div>`;
}
export function tag(text, tone = 'quiet') {
  return `<span class="tag ${tone}">${html(text)}</span>`;
}
export function btn(label, glyph, data, type = '', disabled = false) {
  const attrs = Object.entries(data ?? {}).map(([key, value]) => `data-${key}="${html(value)}"`).join(' ');
  return `<button type="button" class="btn ${type}" ${attrs}${disabled ? ' disabled' : ''}>${glyph ? icon(glyph) : ''}${html(label)}</button>`;
}
export function command(label, glyph, payload, type = '', disabled = false) {
  return btn(label, glyph, { command: JSON.stringify(payload) }, type, disabled);
}
// Payments of this kingdom that were sent and are not settled yet. A paid button for the same order shows that it is
// paid and how far its confirmation is, instead of offering the payment again.
const IN_FLIGHT = new Set(['submitted', 'seen_in_mempool', 'confirming', 'confirmed', 'uncertain', 'reorg']);
// Deposits can be repeated; their buttons stay. Everything else is one order per payment.
const REPEATABLE = new Set(['war-chest', 'vault-deposit', 'sponsor-fund']);
let inFlight = [];
export function setPaymentsInFlight(payments) {
  inFlight = (payments ?? []).filter(item => IN_FLIGHT.has(item.state) && item.direction !== 'outgoing' && item.payload && typeof item.payload === 'object');
}
export const paymentsInFlight = () => inFlight;
export function paidFor(payload) {
  if (!payload?.type || REPEATABLE.has(payload.type)) return null;
  return inFlight.find(item => item.payload.type === payload.type &&
    Object.entries(payload).every(([key, value]) => key === 'type' || value == null || typeof value === 'object' || item.payload[key] === value)) ?? null;
}
/** How a sent payment stands, in words: "1 of 2 confirmations · about 10 more minutes". */
export function confirmationText(payment) {
  const needed = payment.appliesAfter ?? payment.minConfirmations ?? 2;
  const got = Math.min(needed, payment.receipt?.confirmations ?? payment.confirmations ?? 0);
  if (payment.state === 'confirmed' || got >= needed) return 'Confirmed · being applied';
  const left = needed - got;
  return got + ' of ' + needed + ' confirmations · about ' + (left * 10) + ' more minutes';
}
export function paidButton(payment) {
  return btn('Paid · ' + confirmationText(payment), 'bch', { modal: 'payment', id: payment.id }, 'paid');
}
export function pay(label, glyph, payload, type = '', disabled = false) {
  const paid = paidFor(payload);
  if (paid) return paidButton(paid);
  return btn(label, glyph, { pay: JSON.stringify(payload) }, type, disabled);
}
export function costs(values) {
  const items = Object.entries(values ?? {}).filter(([, value]) => Number(value) > 0);
  return items.length ? `<div class="costs">${items.map(([id, value]) => `<span>${icon(id)} ${number(value)} ${html(title(id))}</span>`).join('')}</div>` : '';
}
export function tabbar(entries, selected) {
  return `<div class="tabbar" role="tablist">${entries.map(([id, label]) => `<button type="button" role="tab" aria-selected="${id === selected}" data-tab="${id}" class="${id === selected ? 'active' : ''}">${html(label)}</button>`).join('')}</div>`;
}
export function empty(text) {
  return `<div class="empty">${html(text)}</div>`;
}
export function formatDate(ms) {
  if (ms == null) return '—';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle:'short' });
}
export function shortId(value) {
  return value ? value.slice(0, 10) + '…' + value.slice(-7) : '';
}
export function values(name, pairs) {
  return `<div class="well"><h3>${html(name)}</h3><div class="number-blocks">${pairs.map(([label, value]) => `<div><b>${html(value)}</b><small>${html(label)}</small></div>`).join('')}</div></div>`;
}
export function labelOf(definition, fallback) {
  return definition?.name ?? definition?.label ?? title(fallback);
}
