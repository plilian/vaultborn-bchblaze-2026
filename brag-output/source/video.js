// VaultBorn brag video: every frame is a pure function of time t (seconds).
'use strict';
const DUR = 46;
const A = '../assets/';
const $ = (s, r = document) => r.querySelector(s);
const C = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const P = (t, a, d) => C((t - a) / d);
const L = (a, b, x) => a + (b - a) * x;
const E = {
  o3: x => 1 - Math.pow(1 - x, 3),
  o5: x => 1 - Math.pow(1 - x, 5),
  i2: x => x * x,
  i3: x => x * x * x,
  io: x => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  back: x => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
};
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function el(tag, cls, parent, attrs = {}) {
  const e = document.createElement(tag); if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e); return e;
}
function tf(e, { x = 0, y = 0, s = 1, sx = 1, r = 0, o = 1, b = 0, extra = '' } = {}) {
  e.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) rotate(${r.toFixed(3)}deg) scale(${(s * sx).toFixed(4)},${s.toFixed(4)}) ${extra}`;
  e.style.opacity = C(o).toFixed(3);
  e.style.filter = b > 0.05 ? `blur(${b.toFixed(2)}px)` : '';
}
// Trailer text: in = blur/scale settle over 0.4 s, settled by tin + 0.4; out = quick fade.
function txt(e, t, tin, tout, { dy = 26, ds = .06, dur = .4, outDur = .25, keepFilter = false } = {}) {
  const p = E.o3(P(t, tin, dur));
  const q = tout == null ? 0 : P(t, tout - outDur, outDur);
  const o = p * (1 - q);
  e.style.opacity = o.toFixed(3);
  e.style.transform = `translateY(${((1 - p) * dy).toFixed(2)}px) scale(${(1 + (1 - p) * ds + q * .03).toFixed(4)})`;
  if (!keepFilter) e.style.filter = (1 - p) > .02 ? `blur(${((1 - p) * 12).toFixed(2)}px)` : '';
}
function show(id, t, a, b) { const s = document.getElementById(id); const on = t >= a && t < b; s.style.display = on ? 'block' : 'none'; return on; }

// ---------- build dynamic DOM ----------
const UNIT = { infantry: [320, 308], shield: [301, 320], archer: [318, 320], cavalry: [317, 320], siege: [320, 317], mage: [282, 320] };
function unitImg(parent, kind, crimson) {
  const i = el('img', 'unit', parent, { src: A + 'unit-' + kind + (crimson ? '-crimson' : '') + '.webp' });
  return i;
}
// S1 armies: [kind, x, bottom, height]
const S1L = [['mage', 60, 820, 250], ['archer', 300, 800, 250], ['infantry', 520, 880, 270], ['shield', 270, 1010, 330], ['cavalry', -10, 1085, 420]];
const s1 = [];
{
  const box = $('#s1 .armies');
  for (const crimson of [false, true]) for (const [k, x, bot, h] of S1L) {
    const [w0, h0] = UNIT[k]; const w = h * w0 / h0;
    const img = unitImg(box, k, crimson);
    img.style.height = h + 'px'; img.style.width = w + 'px'; img.style.top = (bot - h) + 'px';
    img.style.left = (crimson ? 1920 - x - w : x) + 'px';
    s1.push({ img, crimson, z: bot });
  }
}
// S3 buildings
const s3b = [];
{
  const box = $('#s3 .bldgs');
  ['hall-3', 'walls-3', 'barracks-3', 'vault-3', 'market-3'].forEach((n, i) => {
    const img = el('img', '', box, { src: A + n + '.webp' }); img.style.left = (i * 136) + 'px'; s3b.push(img);
  });
}
// S4 cards and units
const CMD = [['warden', 'Warden<br>King'], ['engineer', 'Castle<br>Engineer'], ['keeper', 'Vault<br>Keeper'], ['commander', 'Battle<br>Commander'],
  ['ranger', 'Scout<br>Ranger'], ['queen', 'Rebel<br>Queen'], ['merchant', 'Merchant<br>Prince'], ['scholar', 'Oracle<br>Scholar']];
const s4c = [], s4u = [];
{
  const box = $('#s4 .cards');
  CMD.forEach(([f, n], i) => {
    const c = el('div', 'card', box); el('img', '', c, { src: A + 'hero-' + f + '.webp' });
    const nm = el('div', 'nm', c); nm.innerHTML = n;
    c.style.left = (106 + i * 216) + 'px'; c.style.top = '238px'; s4c.push(c);
  });
  const ub = $('#s4 .units');
  [['infantry', 'Infantry'], ['shield', 'Shields'], ['archer', 'Archers'], ['cavalry', 'Cavalry'], ['siege', 'Siege'], ['mage', 'Mages']].forEach(([k, lab], i) => {
    const [w0, h0] = UNIT[k]; const h = 262, w = h * w0 / h0; const cx = 170 + i * 316;
    const img = unitImg(ub, k, false); img.style.height = h + 'px'; img.style.width = w + 'px';
    img.style.left = (cx - w / 2) + 'px'; img.style.top = (930 - h) + 'px';
    const l = el('div', 'ulabel', ub); l.textContent = lab; l.style.left = (cx - 150) + 'px'; l.style.top = '938px';
    s4u.push({ img, l });
  });
}
// S5 battle formations
const s5 = [];
{
  const rows = [[640, 150, ['archer', 'mage', 'archer', 'siege']], [790, 200, ['infantry', 'shield', 'infantry', 'shield']], [985, 270, ['cavalry', 'shield', 'cavalry']]];
  const R = rng(9);
  for (const crimson of [false, true]) {
    const box = crimson ? $('#s5 .armyB') : $('#s5 .armyA');
    rows.forEach(([bot, h, kinds], ri) => {
      kinds.forEach((k, ki) => {
        const [w0, h0] = UNIT[k]; const w = h * w0 / h0;
        const x = 40 + ki * (ri === 2 ? 250 : 175) + ri * 30 + R() * 30;
        const img = unitImg(box, k, crimson);
        img.style.height = h + 'px'; img.style.width = w + 'px'; img.style.top = (bot - h) + 'px';
        img.style.left = (crimson ? 1920 - x - w : x) + 'px';
        s5.push({ img, crimson, ri, ph: R() * 6.28 });
      });
    });
  }
}
// S6 coins
const s6c = [];
{
  const box = $('#s6 .coins');
  for (let i = 0; i < 8; i++) { const c = el('div', 'coin', box); c.innerHTML = '<span>₿</span>'; s6c.push(c); }
}
// S8 split
const SPLIT = [[50, 'your War Chest', '#1f8f68', '#61e4b2', '#7ff0c6'], [20, 'season prizes', '#a37b3c', '#f1d298', '#f6dca6'],
  [20, 'development', '#2d6a94', '#72c8fa', '#9ad8ff'], [10, 'burned', '#9c3427', '#e37d6f', '#ff9a86']];
const s8 = [];
{
  const bar = $('#s8 .bar'), labs = $('#s8 .labs'); let acc = 0;
  SPLIT.forEach(([pct, what, c1, c2, tc]) => {
    const seg = el('div', 'seg', bar); seg.style.left = (acc * 15) + 'px'; seg.style.background = `linear-gradient(90deg, ${c1}, ${c2})`;
    const lab = el('div', 'lab', labs); lab.style.left = (210 + (acc + pct / 2) * 15) + 'px';
    lab.innerHTML = `<div class="pct" style="color:${tc}">${pct}%</div><div class="what">${what}</div>`;
    s8.push({ seg, lab, pct, x0: acc * 15 }); acc += pct;
  });
  // keep the narrow 10% label clear of the 20% label: nudge it right of the bar's end if needed
  s8[3].lab.style.left = (210 + 1500 - 40) + 'px';
}
// S9 containers
for (const c of document.querySelectorAll('#s9 .pa, #s9 .pb')) { c.style.position = 'absolute'; c.style.inset = '0'; }
// S10 hex texture + tx
const TX = '7e5d53bbf8586c6474982f1e6c1e11a26d5444e607c0221c85a7cf1ea74db7cc';
{
  const hex = $('#s10 .hex'); const R = rng(77); let lines = [];
  for (let l = 0; l < 34; l++) { let s = ''; for (let i = 0; i < 150; i++) s += '0123456789abcdef'[Math.floor(R() * 16)]; lines.push(s); }
  hex.innerHTML = lines.join('<br>');
}
// S11 guards
const s11g = [];
{
  const box = $('#s11 .guards');
  [['archer', 1180, 1000, 300], ['cavalry', 1380, 1040, 440], ['shield', 1640, 1050, 380]].forEach(([k, x, bot, h], i) => {
    const [w0, h0] = UNIT[k]; const w = h * w0 / h0; const img = unitImg(box, k, false);
    img.style.height = h + 'px'; img.style.width = w + 'px'; img.style.left = x + 'px'; img.style.top = (bot - h) + 'px';
    s11g.push(img);
  });
}

// ---------- FX canvas: embers + sparks ----------
const fx = document.getElementById('fx'); const ctx = fx.getContext('2d');
const EMB = []; { const R = rng(4242); for (let i = 0; i < 90; i++) EMB.push({ x: R() * 1920, sp: 40 + R() * 90, off: R() * 1400, sz: 1.2 + R() * 3.2, ph: R() * 6.28, sw: 10 + R() * 40, f: .3 + R() * .8, hue: R() }); }
const SPK = []; { const R = rng(99); for (let i = 0; i < 70; i++) { const a = -Math.PI * (0.05 + R() * .9); const v = 300 + R() * 900; SPK.push({ vx: Math.cos(a) * v * (R() < .5 ? -1 : 1), vy: Math.sin(a) * v, sz: 1.5 + R() * 3, life: .35 + R() * .6 }); } }
function emberLevel(t) {
  const k = [[0, .7], [4, 1], [8, .35], [12, .45], [16, 1], [22, .45], [28, .2], [32, .3], [36, .35], [40, .1], [42, 1], [46, 1]];
  for (let i = 0; i < k.length - 1; i++) if (t >= k[i][0] && t < k[i + 1][0]) return k[i][1];
  return 1;
}
function drawFx(t) {
  ctx.clearRect(0, 0, 1920, 1080);
  const lv = emberLevel(t);
  ctx.globalCompositeOperation = 'lighter';
  const n = Math.round(EMB.length * lv);
  for (let i = 0; i < n; i++) {
    const p = EMB[i];
    const y = 1100 - ((t * p.sp + p.off) % 1300);
    const x = p.x + Math.sin(t * p.f + p.ph) * p.sw;
    const fl = .55 + .45 * Math.sin(t * 7 * p.f + p.ph * 3);
    const a = .55 * fl * C((1100 - y) / 200) * C(y / 300);
    const g = ctx.createRadialGradient(x, y, 0, x, y, p.sz * 3.2);
    const col = p.hue < .7 ? '255,190,110' : '255,236,170';
    g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, p.sz * 3.2, 0, 6.283); ctx.fill();
  }
  // clash sparks at 18.0 and the escrow strike at 24.5
  for (const [t0, cx, cy, scale] of [[18.0, 960, 760, 1], [24.5, 960, 500, .6]]) {
    const dt = t - t0; if (dt < 0 || dt > 1.1) continue;
    for (const s of SPK) {
      if (dt > s.life) continue;
      const x = cx + s.vx * dt * scale, y = cy + (s.vy * dt + 900 * dt * dt) * scale;
      const a = 1 - dt / s.life;
      ctx.strokeStyle = `rgba(255,${200 + 40 * a | 0},${120 + 80 * a | 0},${a})`; ctx.lineWidth = s.sz;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s.vx * .025 * scale, y - (s.vy + 1800 * dt) * .025 * scale); ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ---------- global overlays ----------
const FLASH = [[4.0, .85, .32], [16.0, .8, .28], [18.0, .95, .22], [24.5, .35, .2], [25.0, .45, .25], [36.0, .5, .2], [38.0, .45, .18], [42.0, .9, .4]];
const DIP = [[8.0, .2, .2], [12.0, .2, .2], [22.0, .22, .22], [28.0, .3, .28], [32.0, .22, .22], [40.0, .2, .14]];
function overlays(t) {
  let f = 0; for (const [t0, s, d] of FLASH) if (t >= t0) f = Math.max(f, s * Math.exp(-(t - t0) / d));
  $('#flash').style.opacity = C(f).toFixed(3);
  let k = 0;
  for (const [t0, a, b] of DIP) { if (t >= t0 - a && t < t0) k = Math.max(k, (t - (t0 - a)) / a); else if (t >= t0 && t < t0 + b) k = Math.max(k, 1 - (t - t0) / b); }
  if (t >= 41.72 && t < 42) k = Math.max(k, P(t, 41.72, .12));          // silence-gap blackout before the outro
  if (t < 0.25) k = Math.max(k, 1 - t / .25);                              // open from black (frame 0 becomes the poster)
  $('#dark').style.opacity = C(k * .97).toFixed(3);
  // camera shake (clash and big hits) applied to the world
  let sh = 0; for (const [t0, amp, d] of [[18.0, 22, .32], [16.0, 8, .25], [42.0, 6, .3], [25.0, 6, .2]]) if (t >= t0) sh += amp * Math.exp(-(t - t0) / d);
  const sx = sh * Math.sin(t * 91.3) * Math.cos(t * 37.1), sy = sh * Math.sin(t * 73.7 + 1.3);
  $('#world').style.transform = sh > .2 ? `translate(${sx.toFixed(2)}px,${sy.toFixed(2)}px)` : '';
  const fr = Math.round(t * 30); const R = rng(fr * 7919 + 13);
  $('#grain').style.transform = `translate(${(R() * 64 - 32).toFixed(1)}px,${(R() * 64 - 32).toFixed(1)}px)`;
}

// ---------- scenes ----------
function scene1(t) {
  if (!show('s1', t, 0, 4.0)) return;
  tf($('#s1 .bg'), { s: 1.04 + t * .022, y: -t * 4 });
  s1.forEach((u, i) => {
    const k = i % 5; const st = .05 + k * .1 + (u.crimson ? .05 : 0);
    const p = E.o5(P(t, st, .8));
    const bob = Math.sin(t * 3.1 + i) * 3;
    const push = t > 3.4 ? E.i2(P(t, 3.4, .6)) * 40 : 0;
    tf(u.img, { y: (1 - p) * 280 + bob, sx: u.crimson ? -1 : 1, o: p, s: 1 + push / 1000, x: (u.crimson ? 1 : -1) * -push });
  });
  const out = 3.62;
  txt($('#s1 .l1'), t, .15, null); txt($('#s1 .l2'), t, 1.0, null); txt($('#s1 .l3'), t, 2.0, null, { ds: .12 });
  const q = E.i2(P(t, out, .38));
  tf($('#s1 .hook'), { s: 1 + q * .12, o: 1 - q, y: q * -20 });
}
function scene2(t) {
  if (!show('s2', t, 4.0, 8.0)) return;
  const u = t - 4;
  tf($('#s2 .bg'), { s: 1.12 + u * .02, r: u * .4 });
  tf($('#s2 .rays'), { r: u * 6, o: .9 });
  tf($('#s2 .glow'), { s: 1 + Math.sin(u * 2) * .04, o: .9 });
  const lp = P(t, 4.0, .45);
  tf($('#s2 .logo'), { s: L(1.7, 1, E.back(lp)), o: C(lp * 3), y: Math.sin(u * 1.6) * 4 });
  txt($('#s2 .eyebrow'), t, 4.55, 7.95);
  // wordmark wipe
  const wp = E.io(P(t, 4.2, .6));
  const wm = $('#s2 .wordmark');
  wm.style.clipPath = `inset(-20% ${((1 - wp) * 100).toFixed(2)}% -20% 0)`;
  const wq = P(t, 7.7, .25);
  tf(wm, { s: 1 + u * .008, o: 1 - wq });
  txt($('#s2 .s2a'), t, 5.4, 7.95);
  const cp = E.o3(P(t, 6.0, .4)), cq = P(t, 7.7, .25);
  $('#s2 .s2b').style.transform = `translateX(-50%) translateY(${((1 - cp) * 20).toFixed(1)}px)`;
  $('#s2 .s2b').style.opacity = (cp * (1 - cq)).toFixed(3);
  const lq = P(t, 7.7, .25); $('#s2 .logo').style.opacity = (C(lp * 3) * (1 - lq)).toFixed(3);
}
function scene3(t) {
  if (!show('s3', t, 7.98, 12.0)) return;
  const u = t - 8;
  tf($('#s3 .bg'), { s: 1.1 + u * .015, x: -u * 8 });
  const fp = E.o5(P(t, 8.0, .7)), fq = P(t, 11.75, .25);
  const fr = $('#s3 .frame');
  fr.style.transform = `translateX(${((1 - fp) * 160).toFixed(1)}px) rotateY(${(-14 + fp * 4).toFixed(2)}deg) rotateX(3deg)`;
  fr.style.opacity = (fp * (1 - fq)).toFixed(3);
  tf($('#s3 .frame img'), { s: 1.0 + E.io(P(t, 8.2, 3.8)) * .22 });
  txt($('#s3 .eyebrow'), t, 8.1, 11.95); txt($('#s3 .head'), t, 8.3, 11.95);
  [['.c1', 9.0], ['.c2', 9.5], ['.c3', 10.0]].forEach(([s, a]) => {
    const p = E.back(P(t, a, .35)); const q = P(t, 11.75, .25);
    tf($('#s3 ' + s), { s: L(.6, 1, p), o: C(P(t, a, .15)) * (1 - q) });
  });
  s3b.forEach((b, i) => {
    const a = 10.0 + i * .25; const p = E.back(P(t, a, .35)); const q = P(t, 11.75, .25);
    tf(b, { y: (1 - C(p)) * 60, s: L(.4, 1, p), o: C(P(t, a, .12)) * (1 - q) });
  });
}
function scene4(t) {
  if (!show('s4', t, 11.98, 16.0)) return;
  const u = t - 12;
  tf($('#s4 .bg'), { s: 1.08 + u * .02 });
  const q = E.i2(P(t, 15.62, .38));
  txt($('#s4 .eyebrow'), t, 12.1, null); txt($('#s4 .head'), t, 12.3, null);
  s4c.forEach((c, i) => {
    const a = 12.0 + i * .25; const p = P(t, a, .38); const e = E.back(p);
    tf(c, { x: (1 - E.o3(p)) * 380, y: (1 - E.o3(p)) * 520 + Math.sin(t * 2 + i) * 2, r: (1 - E.o3(p)) * 22, s: L(.7, 1, e), o: C(p * 4) });
  });
  s4u.forEach(({ img, l }, i) => {
    const a = 13.0 + i * .12; const p = E.o3(P(t, a, .6));
    const step = Math.abs(Math.sin((t - a) * 9)) * 8 * (1 - P(t, a + .6, .3));
    tf(img, { x: (1 - p) * -420, y: -step, o: C(P(t, a, .2)) });
    txt(l, t, a + .25, null, { dy: 12 });
  });
  tf($('#s4 .cards'), { s: 1 + q * .08, o: 1 - q }); tf($('#s4 .units'), { s: 1 + q * .08, o: 1 - q });
  $('#s4 .head').style.opacity = (C(P(t, 12.3, .4)) * (1 - q)).toFixed(3);
  $('#s4 .eyebrow').style.opacity = (C(P(t, 12.1, .4)) * (1 - q)).toFixed(3);
}
function scene5(t) {
  if (!show('s5', t, 16.0, 22.0)) return;
  const u = t - 16;
  const charge = E.i3(P(t, 16.15, 1.85));
  const cam = 1.08 + E.io(P(t, 16, 2.4)) * .12;
  tf($('#s5 .field'), { s: cam, y: 30 });
  s5.forEach((m, i) => {
    const dist = (m.ri === 2 ? 300 : m.ri === 1 ? 260 : 200) * charge + (t > 18 ? 60 * E.o3(P(t, 18, .5)) : 0);
    const gallop = Math.abs(Math.sin(t * 13 + m.ph)) * (m.ri === 2 ? 14 : 8) * (t < 18.4 ? 1 : 0);
    const recoil = t > 18 ? Math.sin(P(t, 18, .6) * Math.PI) * 18 : 0;
    tf(m.img, { x: (m.crimson ? -1 : 1) * (dist - recoil), y: -gallop, sx: m.crimson ? -1 : 1, r: (m.crimson ? -1 : 1) * Math.sin(t * 13 + m.ph) * 1.5 });
  });
  txt($('#s5 .raid'), t, 16.25, 18.15);
  const dk = E.io(P(t, 18.35, .5));
  $('#s5 .darken').style.opacity = (dk * .92).toFixed(3);
  const fp = E.o5(P(t, 18.5, .6));
  const fr = $('#s5 .frame'); fr.style.transform = `translateY(${((1 - fp) * 70).toFixed(1)}px) scale(${(0.94 + fp * .06 + P(t, 19, 3) * .02).toFixed(4)})`;
  fr.style.opacity = (fp * (1 - P(t, 21.75, .25))).toFixed(3);
  const pr = E.io(P(t, 19.1, 2.7)); const W = 528;
  $('#s5 .fill').style.width = (pr * W).toFixed(1) + 'px';
  $('#s5 .knob').style.left = (182 + pr * W).toFixed(1) + 'px';
  txt($('#s5 .col .eyebrow'), t, 18.55, 21.95); txt($('#s5 .col .head'), t, 18.7, 21.95); txt($('#s5 .col .sub'), t, 19.4, 21.95);
}
function arc(p, x0, y0, x1, y1, h) { return [L(x0, x1, p), L(y0, y1, p) - Math.sin(p * Math.PI) * h]; }
function scene6(t) {
  if (!show('s6', t, 21.98, 28.0)) return;
  const u = t - 22;
  tf($('#s6 .bg'), { s: 1.1 + u * .012 });
  const q = P(t, 27.75, .25);
  txt($('#s6 .head6'), t, 22.15, 24.95);
  const wp = E.back(P(t, 25.0, .4));
  tf($('#s6 .win'), { s: L(1.5, 1, wp), o: C(P(t, 25.0, .15)) * (1 - q), b: (1 - C(P(t, 25, .3))) * 10 });
  const ca = E.o5(P(t, 22.0, .6)), cb = E.o5(P(t, 22.1, .6));
  const dim = E.io(P(t, 25.3, .5));
  tf($('#castA'), { x: (1 - ca) * -200, o: ca * (1 - q), s: 1 + (t > 25.4 ? Math.sin(P(t, 25.4, .4) * Math.PI) * .05 : 0) });
  tf($('#castB'), { x: (1 - cb) * 200, o: cb * (1 - q) * (1 - dim * .55) });
  $('#castB').style.filter = `drop-shadow(0 24px 24px rgba(0,0,0,.6)) saturate(${(1 - dim * .7).toFixed(2)})`;
  const ep = E.back(P(t, 22.3, .5));
  tf($('#s6 .escrow'), { s: L(.5, 1, ep), o: C(P(t, 22.3, .2)) * (1 - q) * (1 - E.io(P(t, 25.0, .3)) * .6) });
  txt($('#s6 .elabel'), t, 22.5, 25.1);
  // ring around the winner
  const rp = E.o3(P(t, 25.4, .5)); const ring = $('#ringA');
  ring.style.left = (360 - 235) + 'px'; ring.style.top = (505 - 235) + 'px'; ring.style.width = '470px'; ring.style.height = '470px';
  tf(ring, { s: L(.6, 1, rp) + Math.sin(t * 4) * .01, o: rp * (1 - q) * .9 });
  // swords strike
  const sp = P(t, 24.2, .3), sq = P(t, 24.75, .25);
  tf($('#s6 .swords'), { s: L(1.8, 1, E.back(sp)), o: C(sp * 2) * (1 - sq), r: (1 - sp) * -30 });
  // coins: 0-3 attacker, 4-7 defender
  const PA = [360, 540], PB = [1560, 540], PE = [960, 450];
  s6c.forEach((c, i) => {
    const att = i < 4; const k = i % 4;
    const launch = (att ? 22.5 : 23.5) + k * .06;
    const p1 = E.io(P(t, launch, .5));
    const src = att ? PA : PB;
    const stackY = -k * 14;
    let [x, y] = arc(p1, src[0] + (att ? 30 : -30), src[1] - 60 + stackY, PE[0] + (att ? -34 : 34), PE[1] + stackY, 160);
    let o = C(P(t, launch - .25, .2));
    if (t >= 25.0) { // all to the winner
      const p2 = E.io(P(t, 25.0 + i * .03, .5));
      const [x2, y2] = arc(p2, PE[0] + (att ? -34 : 34), PE[1] + stackY, PA[0] - 40 + (i % 2) * 70, PA[1] - 70 - Math.floor(i / 2) * 14, 180);
      x = x2; y = y2;
    }
    c.style.left = x.toFixed(1) + 'px'; c.style.top = y.toFixed(1) + 'px';
    tf(c, { o: o * (1 - q), r: Math.sin(t * 9 + i) * 8 });
  });
  const tp = E.back(P(t, 25.5, .35));
  tf($('#s6 .twox'), { s: L(.5, 1, tp), o: C(P(t, 25.5, .15)) * (1 - q), y: -Math.sin(t * 3) * 4 });
  txt($('#capA'), t, 22.65, 27.95); txt($('#capB'), t, 23.6, 27.95);
  txt($('#s6 .foot'), t, 26.0, 27.95);
}
function scene7(t) {
  if (!show('s7', t, 27.98, 32.0)) return;
  const u = t - 28;
  tf($('#s7 .bg'), { s: 1.12 + u * .015, x: u * 6 });
  const fp = E.o5(P(t, 28.0, .7)), q = P(t, 31.75, .25);
  tf($('#s7 .frame'), { y: (1 - fp) * 60, o: fp * (1 - q), s: 1 + u * .006 });
  const sp = P(t, 28.8, 1.0);
  const scan = $('#s7 .scan'); scan.style.top = (337 + sp * 314).toFixed(1) + 'px'; scan.style.opacity = (C(sp * 6) * (1 - P(t, 29.7, .2))).toFixed(3);
  $('#s7 .qrglow').style.opacity = (C(P(t, 28.8, .2)) * (1 - P(t, 30.2, .5)) * (.6 + .4 * Math.sin(t * 12))).toFixed(3);
  const sl = E.back(P(t, 30.0, .32));
  tf($('#s7 .seal'), { s: L(1.9, 1, sl), o: C(P(t, 30.0, .1)) * (1 - q), r: L(-25, -8, sl) });
  txt($('#s7 .eyebrow'), t, 28.1, 31.95); txt($('#s7 .head'), t, 28.2, 31.95); txt($('#s7 .sub'), t, 28.8, 31.95); txt($('#s7 .nb'), t, 30.15, 31.95);
}
function scene8(t) {
  if (!show('s8', t, 31.98, 36.0)) return;
  const u = t - 32;
  tf($('#s8 .bg'), { s: 1.12 + u * .015 });
  const q = P(t, 35.8, .2);
  txt($('#s8 .eyebrow'), t, 32.05, 35.98); txt($('#s8 .head'), t, 32.2, 35.98); txt($('#s8 .sub'), t, 32.6, 35.98);
  const bp = E.o3(P(t, 32.4, .4));
  tf($('#s8 .bar'), { o: bp * (1 - q), s: L(.96, 1, bp) });
  s8.forEach((s, i) => {
    const a = 33.0 + i * .5; const p = E.o5(P(t, a, .3));
    s.seg.style.width = (p * s.pct * 15).toFixed(1) + 'px';
    const lp = E.back(P(t, a + .05, .35));
    s.lab.style.opacity = (C(P(t, a + .05, .15)) * (1 - q)).toFixed(3);
    s.lab.style.transform = `translateY(${((1 - C(lp)) * 24).toFixed(1)}px) scale(${L(.7, 1, lp).toFixed(3)})`;
  });
}
function scene9(t) {
  if (!show('s9', t, 36.0, 40.0)) return;
  const a = t < 38;
  $('#s9 .pa').style.display = a ? 'block' : 'none'; $('#s9 .pb').style.display = a ? 'none' : 'block';
  if (a) {
    const u = t - 36; tf($('#s9 .pa .shot'), { s: 1.04 + u * .035, x: -u * 10 });
    txt($('#s9 .pa .eyebrow'), t, 36.08, null); txt($('#s9 .pa .head'), t, 36.18, null);
  } else {
    const u = t - 38; tf($('#s9 .pb .shot'), { s: 1.04 + u * .035, x: u * 10 });
    txt($('#s9 .pb .eyebrow'), t, 38.08, 39.9); txt($('#s9 .pb .head'), t, 38.18, 39.9);
  }
}
function scene10(t) {
  if (!show('s10', t, 40.0, 42.0)) return;
  const u = t - 40;
  $('#s10 .hex').style.transform = `translateY(${(-u * 60).toFixed(1)}px)`;
  txt($('#s10 .eyebrow'), t, 40.05, null); txt($('#s10 .head'), t, 40.12, null, { ds: .1 });
  const n = Math.round(C(P(t, 40.45, .85)) * TX.length);
  $('#s10 .tx').textContent = 'tx ' + TX.slice(0, n) + (n < TX.length && Math.floor(t * 12) % 2 ? '▌' : '');
  $('#s10 .tx').style.opacity = C(P(t, 40.4, .1)).toFixed(3);
  const bp = E.back(P(t, 41.25, .3));
  const b = $('#s10 .blk'); b.style.opacity = C(P(t, 41.25, .08)).toFixed(3);
  b.style.transform = `translateX(-50%) scale(${L(1.8, 1, bp).toFixed(3)})`;
}
function scene11(t) {
  if (!show('s11', t, 42.0, 46.01)) return;
  const u = t - 42;
  tf($('#s11 .bg'), { s: 1.03 + u * .018, x: -u * 6 });
  s11g.forEach((g, i) => { const p = E.o5(P(t, 42.0 + i * .08, .8)); tf(g, { y: (1 - p) * 220 + Math.sin(t * 2.2 + i) * 3, o: p }); });
  const lp = E.back(P(t, 42.0, .45));
  tf($('#s11 .logo'), { s: L(1.5, 1, lp), o: C(P(t, 42, .1)) });
  txt($('#s11 .eyebrow'), t, 42.15, null);
  const wm = $('#s11 .wordmark'); const wp = E.io(P(t, 42.05, .5));
  wm.style.clipPath = `inset(-20% ${((1 - wp) * 100).toFixed(2)}% -20% 0)`;
  txt($('#s11 .tag'), t, 42.3, null, { ds: .1 });
  txt($('#s11 .url'), t, 42.8, null);
  document.querySelectorAll('#s11 .badge').forEach((b, i) => {
    const a = 43.3 + i * .125; const p = E.back(P(t, a, .35));
    tf(b, { s: L(.6, 1, p), o: C(P(t, a, .12)) });
  });
}

function renderAt(t) {
  scene1(t); scene2(t); scene3(t); scene4(t); scene5(t); scene6(t); scene7(t); scene8(t); scene9(t); scene10(t); scene11(t);
  drawFx(t); overlays(t);
}
window.renderAt = renderAt;
window.DUR = DUR;
window.ready = (async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(i => i.decode().catch(() => null)));
  renderAt(0);
  return true;
})();
