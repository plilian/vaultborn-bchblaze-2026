let owner;
let tip;

function hide() {
  if (owner?.getAttribute('aria-describedby') === 'game-tooltip') owner.removeAttribute('aria-describedby');
  tip?.remove();
  owner = tip = null;
}

function show(element) {
  if (!element || element === owner) return;
  const value = element.dataset.tooltip;
  if (!value) return;
  hide();
  owner = element;
  tip = document.createElement('div');
  tip.className = 'game-tooltip';
  tip.id = 'game-tooltip';
  tip.setAttribute('role','tooltip');
  tip.textContent = value;
  (element.closest('dialog') ?? document.body).append(tip);
  if (!element.hasAttribute('aria-describedby')) element.setAttribute('aria-describedby','game-tooltip');
  const target = element.getBoundingClientRect();
  const bounds = tip.getBoundingClientRect();
  const left = Math.max(8,Math.min(target.left + (target.width - bounds.width)/2,innerWidth - bounds.width - 8));
  const top = target.top - bounds.height - 8 > 6 ? target.top - bounds.height - 8 : target.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

document.addEventListener('pointerover', event => { if (event.pointerType === 'mouse') show(event.target.closest('[data-tooltip]')); });
document.addEventListener('pointerout', event => {
  if (owner?.contains(event.target) && (!(event.relatedTarget instanceof Node) || !owner.contains(event.relatedTarget))) hide();
});
document.addEventListener('focusin', event => show(event.target.closest('[data-tooltip]')));
document.addEventListener('focusout', event => { if (owner === event.target) hide(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
document.addEventListener('scroll', hide, true);
window.addEventListener('resize', hide);
