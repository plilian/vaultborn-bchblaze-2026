// Updates an element to new markup in place, touching only what changed. The game redraws its panels whenever the
// kingdom changes (every few seconds while resources accrue); replacing them whole made pictures reload and animations
// restart, so the page flashed. Elements that stay the same keep their state: images, focus, scroll, open sections and
// whatever a player is typing.
const template = document.createElement('template');

export function morph(target, markup) {
  template.innerHTML = markup;
  const wanted = template.content;
  patchChildren(target, wanted);
  template.innerHTML = '';
}

const sameKind = (have, want) => have.nodeType === want.nodeType && (have.nodeType !== 1 ||
  (have.tagName === want.tagName && (have.id || '') === (want.id || '') &&
    (have.getAttribute('data-key') ?? '') === (want.getAttribute('data-key') ?? '')));

function patchChildren(from, to) {
  const current = [...from.childNodes];
  const wanted = [...to.childNodes];
  wanted.forEach((node, index) => {
    const have = current[index];
    if (!have) from.appendChild(node);
    else if (!sameKind(have, node)) from.replaceChild(node, have);
    else patchNode(have, node);
  });
  for (const extra of current.slice(wanted.length)) extra.remove();
}

// What a player changed on the page itself stays: an opened or closed section.
const keep = (element, name) => element.tagName === 'DETAILS' && name === 'open';

function patchNode(have, want) {
  if (have.nodeType !== 1) {
    if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
    return;
  }
  for (const { name } of [...have.attributes]) if (!want.hasAttribute(name) && !keep(have, name)) have.removeAttribute(name);
  for (const { name, value } of [...want.attributes]) if (have.getAttribute(name) !== value && !keep(have, name)) have.setAttribute(name, value);
  // Form fields need nothing more: a field the player has not touched follows its new value attribute by itself, and one
  // the player changed keeps what was typed or chosen.
  patchChildren(have, want);
}
