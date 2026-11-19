import { html } from './view.js';
import { icon } from './icons.js';
import { playGameCue } from './game-audio.js';

let sequence = 0;
const getParts = node => ({
  trigger: node.querySelector('[data-select-trigger]'),
  list: node.querySelector('[role="listbox"]'),
  input: node.querySelector('input'),
});

export function gameSelect(label, name, entries, preferred) {
  const id = 'royal-choice-' + ++sequence;
  const selected = entries.find(([value]) => value === preferred) ?? entries[0];
  return `<div class="game-select" data-game-select>
    <span id="${id}-label">${html(label)}</span>
    <input type="hidden" name="${html(name)}" value="${html(selected?.[0])}">
    <button type="button" class="select-trigger" data-select-trigger aria-labelledby="${id}-label ${id}-value"
      popovertarget="${id}" aria-haspopup="listbox" aria-expanded="false"${selected ? '' : ' disabled'}>
      <span id="${id}-value" data-select-value>${html(selected?.[1] ?? 'No options available')}</span>${icon('down')}
    </button>
    <div class="select-menu" id="${id}" role="listbox" aria-labelledby="${id}-label" popover="auto">
      ${entries.map(([value, label]) => `<button type="button" role="option" tabindex="-1" aria-selected="${value === selected?.[0]}"
        data-select-option="${html(value)}">${html(label)}</button>`).join('')}
    </div>
  </div>`;
}

function position(trigger, list) {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 160), innerWidth - 16);
  const below = innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const opensUp = below < 175 && above > below;
  const height = Math.min(opensUp ? above : below, 280);
  const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
  list.style.width = width + 'px';
  list.style.left = left + 'px';
  list.style.maxHeight = Math.max(36, height) + 'px';
  list.style.top = (opensUp ? Math.max(8, rect.top - Math.min(list.scrollHeight, height) - 4) : rect.bottom + 4) + 'px';
}

function choose(option) {
  const { list, input, trigger } = getParts(option.closest('[data-game-select]'));
  input.value = option.dataset.selectOption;
  for (const item of list.querySelectorAll('[role="option"]')) item.setAttribute('aria-selected', String(item === option));
  trigger.querySelector('[data-select-value]').textContent = option.textContent.trim();
  list.hidePopover();
  trigger.focus({ preventScroll: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  playGameCue('select');
}

document.addEventListener('toggle', event => {
  const list = event.target;
  const control = list.matches?.('.select-menu') && list.closest('[data-game-select]');
  if (!control) return;
  const { trigger } = getParts(control);
  const open = list.matches(':popover-open');
  trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    position(trigger, list);
    list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  }
}, true);

document.addEventListener('click', event => {
  const option = event.target.closest('[data-select-option]');
  if (option) choose(option);
});

document.addEventListener('keydown', event => {
  const control = event.target.closest?.('[data-game-select]');
  if (!control) return;
  const { trigger, list } = getParts(control);
  const open = list.matches(':popover-open');
  const items = [...list.querySelectorAll('[data-select-option]')];
  if (!open) {
    if (['ArrowDown','ArrowUp'].includes(event.key) && items.length) {
      event.preventDefault();
      list.showPopover();
    }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    list.hidePopover();
    trigger.focus();
    return;
  }
  if (event.key === 'Tab') {
    list.hidePopover();
    trigger.focus();
    return;
  }
  const index = items.indexOf(document.activeElement);
  let next;
  switch (event.key) {
    case 'ArrowDown': next = items[(index + 1) % items.length]; break;
    case 'ArrowUp': next = items[(index - 1 + items.length) % items.length]; break;
    case 'Home': next = items[0]; break;
    case 'End': next = items.at(-1); break;
    default:
      if (event.key.length === 1 && !event.ctrlKey && !event.altKey && event.key !== ' ') {
        const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
        next = ordered.find(item => item.textContent.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      }
  }
  if (next) {
    event.preventDefault();
    next.focus();
  }
});

window.addEventListener('resize', closeMenus);
document.addEventListener('scroll', event => {
  if (event.target.closest?.('.select-menu')) return;
  for (const menu of document.querySelectorAll('.select-menu:popover-open')) {
    const control=menu.closest('[data-game-select]');
    if (!control) continue;
    const {trigger} = getParts(control);
    const box = trigger.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) menu.hidePopover();
    else position(trigger, menu);
  }
}, true);
function closeMenus() {
  for (const menu of document.querySelectorAll('.select-menu:popover-open')) menu.hidePopover();
}
