import { icon } from './icons.js';
import { domesticFormAnswer, domesticViews } from './political-domestic.js';
import { diplomaticFormAnswer, diplomacyViews } from './political-diplomacy.js';
import { art, btn, crest, empty, faction, html, list, tabbar } from './view.js';

const tabs = [
  ['government', 'Government'], ['treaties', 'Treaties'], ['conflicts', 'Conflicts'],
  ['trade', 'Trade & Sanctions'], ['council', 'Council & Federations'],
  ['history', 'Chronicle'],
];
const indicators = [
  ['legitimacy', 'Legitimacy', 'crown'], ['loyalty', 'Public Loyalty', 'shield'],
  ['influence', 'Diplomatic Influence', 'flag'], ['unrest', 'Political Unrest', 'fire'],
];
const useful = (value) => Number.isFinite(value);
const input = (label, name, options = {}) => `<label>${html(label)}<input name="${html(name)}" type="${options.type ?? 'text'}" value="${html(options.value ?? '')}" ${options.min == null ? '' : 'min="' + options.min + '"'} ${options.max == null ? '' : 'max="' + options.max + '"'} ${options.maxlength == null ? '' : 'maxlength="' + options.maxlength + '"'} ${options.optional ? '' : 'required'}></label>`;
const section = (heading, content, note = '') => `<section class="politics-section"><h2>${html(heading)}</h2>${note ? '<p class="politics-note">' + html(note) + '</p>' : ''}${content}</section>`;
const row = (heading, detail, actions = '', badge = '') => `<article class="politics-row"><div><h3>${html(heading)}${badge}</h3>${detail}</div>${actions ? '<div class="buttons">' + actions + '</div>' : ''}</article>`;
function form(name, content, label, glyph = 'flag', disabled = false) {
  return `<form class="stack politics-form" data-form="political-${name}">${content}<p class="form-error" aria-live="polite"></p><div class="buttons"><button class="btn primary" type="submit"${disabled ? ' disabled' : ''}>${icon(glyph)}${html(label)}</button></div></form>`;
}
function model(ctx) {
  const state = ctx.ui.state;
  const government = state.government ?? {};
  const diplomacy = state.diplomacy ?? {};
  const find = id => ctx.cities.find(city => city.id === id);
  const kingdom = id => find(id)?.name ?? id;
  const entities = list(government.kingdoms);
  const markers = ctx.cities.filter(city => useful(city.x) && useful(city.y));
  const focused = find(ctx.ui.politicalFocus) ?? ctx.own;
  return {...ctx, government, diplomacy, kingdom, focused, entities, markers};
}
function politicalRecord(ctx, city) {
  return (city.id === ctx.own.id ? ctx.government.kingdom : null) ??
    ctx.entities.find(entry => (entry.id ?? entry.cityId ?? entry.kingdomId) === city.id) ?? {};
}
function pressure(record) {
  return Number(record.stats?.unrest ?? record.indicators?.unrest ?? record.unrest ?? 0);
}
function scoreBoard(ctx, city) {
  const record = politicalRecord(ctx, city);
  const values = record.stats ?? record.indicators ?? record;
  return `<div class="politics-indicators">${indicators.map(([key, label, glyph]) => {
    const value = values[key] ?? (key === 'loyalty' ? values.publicLoyalty : key === 'influence' ? values.diplomaticInfluence : null);
    const displayed = useful(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
    return `<div class="politics-indicator ${key}"><div>${icon(glyph)}<span>${label}</span><b>${displayed ?? '—'}</b></div><meter min="0" max="100" value="${displayed ?? 0}" aria-label="${label}"></meter></div>`;
  }).join('')}</div>`;
}

function parties(item) {
  return list(item.participants ?? item.parties ?? [item.from ?? item.proposerId, item.to ?? item.targetId]).filter(Boolean);
}

function mapLink(a, b, className) {
  const aspect = 2.7;
  const dx = (b.x - a.x) * aspect;
  const dy = b.y - a.y;
  return `<i aria-hidden="true" class="political-link ${className}" style="left:${100 * a.x}%;top:${100 * a.y}%;width:${100 * Math.hypot(dx, dy) / aspect}%;transform:rotate(${Math.atan2(dy, dx)}rad)"></i>`;
}
function renderAtlas(ctx) {
  const focus = ctx.focused;
  const treaties = list(ctx.diplomacy.treaties ?? ctx.diplomacy.agreements).filter(item => item.status === 'active' && parties(item).includes(focus.id));
  const edges = treaties.map(treaty => ctx.markers.find(city => city.id !== focus.id && parties(treaty).includes(city.id))).filter(Boolean);
  const relations = [...new Set(edges)].map(city => ctx.kingdom(city.id));
  return `<section class="politics-atlas">
    <div class="political-chart" role="region" aria-label="Political map of the shared world">
      ${useful(focus.x) && useful(focus.y) ? [...new Set(edges)].map(city => mapLink(focus, city, 'allied')).join('') : ''}
      ${ctx.markers.map(city => {
        const selected = focus.id === city.id;
        const record = politicalRecord(ctx, city);
        const unrest = pressure(record);
        const influence = Math.min(100, Math.max(0, Number(record.influence) || 0));
        return `<button type="button" class="political-marker faction ${faction(city)}${selected ? ' selected' : ''}${unrest >= 60 ? ' unstable' : ''}" data-political-focus="${html(city.id)}" aria-label="${html(city.name)}" aria-pressed="${selected}" style="left:${100 * city.x}%;top:${100 * city.y}%;--influence:${Math.round(10 + influence / 4)}px"><i aria-hidden="true"></i><span>${icon(city.id === ctx.own.id ? 'crown' : 'flag')}</span><b>${html(city.name)}</b></button>`;
      }).join('')}
      <div class="political-legend"><span>◌ Diplomatic influence</span><span class="political-unrest-key">● High unrest</span><span class="political-treaty-key">━ Active treaty</span></div>
    </div>
    <aside class="political-inspector" aria-label="Selected kingdom">
      <div class="political-capital" style="--political-capital:url('${art(focus)}')">${crest(focus)}<div><span class="kicker">${focus.id === ctx.own.id ? 'Your kingdom' : 'Foreign kingdom'}</span><h2>${html(focus.name)}</h2></div></div>
      ${scoreBoard(ctx, focus)}
      <p class="political-relationships">${relations.length ? 'Active agreements with ' + html(relations.join(', ')) : 'No active kingdom treaties'}</p>
      ${btn('View on world map', 'map', { page:'map', 'map-focus':focus.id })}
    </aside>
  </section>`;
}

export function renderPolitics(ctx) {
  const view = model(ctx);
  const selected = tabs.some(([id]) => id === ctx.ui.tabs.politics) ? ctx.ui.tabs.politics : 'government';
  const views = { government: governmentView, treaties: treatiesView, conflicts: conflictsView, trade: tradeView, council: councilView, history: historyView };
  return `<div class="politics">
    <header class="page-heading">${icon('flag')}<div><h1>Politics &amp; Diplomacy</h1></div></header>
    <div class="page-body">${renderAtlas(view)}
    ${tabbar(tabs, selected)}
    <div class="politics-workspace" role="tabpanel" aria-label="${tabs.find(([id]) => id === selected)[1]}">${views[selected](view)}</div></div>
  </div>`;
}

const {governmentView, conflictsView, renderConflictDialog} = domesticViews({section, row, form, input, record:politicalRecord});
const {treatiesView, tradeView, councilView, historyView, renderDiplomaticDialog} = diplomacyViews({section, row, form, input, parties});

export function syncPoliticalFields(container) {
  for (const form of container.querySelectorAll('.politics-form')) {
    for (const group of form.querySelectorAll('[data-political-group]')) {
      const value = form.elements.namedItem(group.dataset.politicalGroup)?.value;
      group.hidden = !group.dataset.politicalValues.split(' ').includes(value);
      for (const field of group.querySelectorAll('input, button')) {
        if (field.dataset.politicalHolding !== undefined) continue;
        if (field.hasAttribute('data-select-trigger') && !field.closest('[data-game-select]')?.querySelector('[role="option"]')) continue;
        field.disabled = group.hidden;
      }
    }
    const self = form.elements.namedItem('self')?.value;
    const target = form.elements.namedItem('target')?.value;
    for (const field of form.querySelectorAll('[data-political-holding]')) {
      field.disabled = field.closest('[data-political-group]').hidden || ![self,target].includes(field.dataset.owner);
      field.closest('label').hidden = field.disabled;
      if (field.disabled) field.checked = false;
    }
  }
}

export function renderPoliticalDialog(ctx) {
  const [mode,id] = String(ctx.ui.dialog.id ?? '').split(':');
  const view = model(ctx);
  const [heading, body] = renderConflictDialog(view, mode, id) ?? renderDiplomaticDialog(view, mode, id) ?? ['Political orders',empty('This political order is unavailable.')];
  return `<button type="button" class="dialog-close" aria-label="Close dialog" data-dismiss>${icon('x')}</button><h2 id="dialog-title">${html(heading)}</h2>${body}`;
}

export function politicalFormAnswer(mode, data) {
  if (!mode.startsWith('political-')) return null;
  if (mode === 'political-escrow') return {payment:{type:'political-escrow', treaty:data.id, consent:data.consent === 'true'}};
  if (mode === 'political-attest') return {payment:{type:'political-operation', operation:'attest', treaty:data.id, consent:data.consent === 'true'}};
  if (mode === 'political-paid-support') return {payment:{type:'political-operation', operation:'support', conflict:data.id, side:data.side, consent:data.consent === 'true'}};
  const action = mode.slice('political-'.length);
  const command = domesticFormAnswer(action,data) ?? diplomaticFormAnswer(action,data);
  return command ? {command} : null;
}

export function paintPoliticalOverlay(ctx, canvas, width, height) {
  const view = model(ctx);
  const chart = new Map(view.markers.map(city => [city.id, city]));
  const focused = ctx.city?.id ?? ctx.own.id;
  const treaties = list(view.diplomacy.treaties ?? view.diplomacy.agreements).filter(item => item.status === 'active' && parties(item).includes(focused));
  canvas.save();
  canvas.setLineDash([8, 4]);
  const animate = !ctx.ui.state?.player?.settings?.reducedMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  canvas.lineDashOffset = animate ? -Math.floor(ctx.gameNow / 85) % 12 : 0;
  canvas.strokeStyle = '#a1ffbc';
  canvas.lineWidth = 2.4;
  canvas.shadowBlur = 9;
  canvas.shadowColor = '#6eff9c';
  for (const treaty of treaties) {
    const [a, b] = parties(treaty).map(id => chart.get(id));
    if (!a || !b) continue;
    canvas.beginPath();
    canvas.moveTo(a.x * width, a.y * height);
    canvas.lineTo(b.x * width, b.y * height);
    canvas.stroke();
  }
  for (const city of view.markers) {
    const unrest = pressure(politicalRecord(view, city));
    if (unrest < 60) continue;
    const phase = animate ? (ctx.gameNow % 2000) / 2000 : .3;
    canvas.setLineDash([]);
    canvas.strokeStyle = 'rgba(255,145,100,' + (.82 - .6 * phase) + ')';
    canvas.shadowColor = '#ff9164';
    canvas.beginPath();
    canvas.ellipse(city.x * width, city.y * height, 22 + phase * 25, 12 + phase * 20, 0, 0, Math.PI * 2);
    canvas.stroke();
  }
  canvas.restore();
}
