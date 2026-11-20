"""Original score + SFX for the VaultBorn brag video.
D minor, 120 BPM (1 beat = 0.5 s = 15 frames), 46.0 s. Everything sits on one beat grid counted from frame 0.
The horn theme is the opening phrase of the game's own campaign score, "March of the Riverwardens"
(scripts/render-score.py): A-G-F-G-F-D.
"""
import numpy as np
from scipy import signal
from scipy.io import wavfile
import sys

SR = 48000
DUR = 46.0
N = int(DUR * SR)
BEAT = 0.5
BAR = 2.0
rng = np.random.default_rng(20261119)

dry = np.zeros((N, 2))
send = np.zeros((N, 2))      # reverb send
duck_src = np.zeros(N)       # sidechain key (booms, braams)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def place(sig, t0, pan=0.0, gain=1.0, rev=0.25, bus=None, key=0.0):
    i0 = int(round(t0 * SR))
    if i0 >= N:
        return
    s = sig
    if i0 < 0:
        s = s[-i0:]
        i0 = 0
    n = min(len(s), N - i0)
    s = s[:n] * gain
    l, r = np.sqrt((1 - pan) / 2), np.sqrt((1 + pan) / 2)
    target = dry if bus is None else bus
    target[i0:i0 + n, 0] += s * l
    target[i0:i0 + n, 1] += s * r
    if rev:
        send[i0:i0 + n, 0] += s * l * rev
        send[i0:i0 + n, 1] += s * r * rev
    if key:
        duck_src[i0:i0 + n] += np.abs(s) * key


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def adsr(n, a, d, s, r, sr=SR):
    t = np.arange(n) / sr
    dur = n / sr
    env = np.where(t < a, t / max(a, 1e-6), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-6)))
    rel = np.clip((dur - t) / max(r, 1e-6), 0, 1)
    return env * rel


def saw(freq, n, phase=0.0):
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    dt = f / SR
    ph = (phase + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    m1 = ph < dt
    x = ph[m1] / dt[m1]
    y[m1] -= x + x - x * x - 1
    m2 = ph > 1 - dt
    x = (ph[m2] - 1) / dt[m2]
    y[m2] -= x * x + x + x + 1
    return y


def lp_tv(x, fc, block=128):
    """Two cascaded one-pole lowpasses with a time-varying cutoff (array or scalar)."""
    fc = np.broadcast_to(np.asarray(fc, dtype=float), x.shape)
    y = np.empty_like(x)
    z1 = np.zeros(1)
    z2 = np.zeros(1)
    for i in range(0, len(x), block):
        c = float(np.mean(fc[i:i + block]))
        a = np.exp(-2 * np.pi * min(c, SR * 0.45) / SR)
        b = [1 - a]
        aa = [1, -a]
        seg, z1 = signal.lfilter(b, aa, x[i:i + block], zi=z1)
        seg, z2 = signal.lfilter(b, aa, seg, zi=z2)
        y[i:i + block] = seg
    return y


def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, hi], btype='band', fs=SR, output='sos')
    return signal.sosfilt(sos, x)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype='high', fs=SR, output='sos'), x)


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, btype='low', fs=SR, output='sos'), x)


# ---------------- instruments ----------------
def taiko(gain=1.0, pitch=1.0, dur=1.4):
    t = tt(dur)
    f = 70 * pitch * (1 + 1.6 * np.exp(-t * 28))
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 4.2) + .35 * np.sin(1.52 * ph) * np.exp(-t * 9)
    skin = bp(rng.normal(0, 1, len(t)), 180, 3200) * np.exp(-t * 30) * 1.3
    click = hp(rng.normal(0, 1, len(t)), 2500) * np.exp(-t * 160) * .25
    return np.tanh((body + skin + click) * 1.4) * gain


def boom(gain=1.0, dur=3.2):
    t = tt(dur)
    f = 30 + 70 * np.exp(-t * 4.5)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.3) * .65
    hit = bp(rng.normal(0, 1, len(t)), 90, 2500) * np.exp(-t * 9) * .9
    air = hp(rng.normal(0, 1, len(t)), 3000) * np.exp(-t * 3.5) * .08
    return np.tanh((sub * 1.2 + hit + air) * 1.3) * gain


def snare(gain=1.0):
    t = tt(.5)
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t * 22)
    nz = bp(rng.normal(0, 1, len(t)), 900, 7000) * np.exp(-t * 14)
    return (body * .6 + nz * .9) * gain


def crash(gain=1.0, dur=2.6):
    t = tt(dur)
    nz = hp(rng.normal(0, 1, len(t)), 4200, 3) * (np.exp(-t * 1.6) * .8 + np.exp(-t * 14) * .6)
    return nz * gain


def tick(gain=1.0, f=7000):
    t = tt(.05)
    return hp(rng.normal(0, 1, len(t)), f, 2) * np.exp(-t * 120) * gain


def brass_voice(m, dur, bright=2600, attack=.05, detune=(-9, 0, 8)):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for c in detune:
        x += saw(hz(m) * 2 ** (c / 1200) * (1 + .002 * np.sin(2 * np.pi * 5.1 * t)), n, rng.random())
    x /= len(detune)
    fc = 260 + bright * (1 - np.exp(-t / attack)) * (.55 + .45 * np.exp(-t * 1.6))
    y = lp_tv(x, fc)
    return np.tanh(y * 2.2) * adsr(n, attack, .8, .7, .35)


def braam(notes, dur, gain=1.0):
    out = None
    for m in notes:
        v = brass_voice(m, dur, bright=3200, attack=.06)
        out = v if out is None else out + v
    return out / len(notes) ** .5 * gain


def horn(m, dur, gain=1.0):
    """The game's own horn timbre (render-battle-score.py) layered over a soft brass body."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    w = 2 * np.pi * hz(m) * t
    vib = .22 * np.sin(t * 26) * np.minimum(t * 3, 1) * .6
    game = (.64 * np.sin(w + vib) + .25 * np.sin(2 * w + vib) + .15 * np.sin(3.001 * w + vib) + .06 * np.sin(4 * w + 2 * vib))
    body = brass_voice(m, dur, bright=2600, attack=.12, detune=(-6, 5))
    env = adsr(n, .1, .6, .82, .28)
    return (game * env * .75 + body * .7) * gain


def string_pad(notes, dur, gain=1.0, cutoff=1500, attack=.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for m in notes:
        for c in (-11, -3, 6, 12):
            out += saw(hz(m) * 2 ** (c / 1200) * (1 + .003 * np.sin(2 * np.pi * (4.7 + c * .03) * t + c)), n, rng.random())
    out = lp(out, cutoff, 2) / (len(notes) * 4) ** .5
    return out * adsr(n, attack, 1.0, 1.0, .6) * gain


def choir(notes, dur, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    src = np.zeros(n)
    for m in notes:
        for c in (-8, 0, 9):
            src += saw(hz(m) * 2 ** (c / 1200) * (1 + .004 * np.sin(2 * np.pi * 5.3 * t + m)), n, rng.random())
    y = bp(src, 650, 950) * 1.0 + bp(src, 1050, 1300) * .6 + bp(src, 2600, 3100) * .25
    return y / (len(notes) * 3) ** .5 * adsr(n, .6, 1, 1, .8) * gain * 2.2


def pluck(m, dur=.22, gain=1.0, cutoff=2400):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = saw(hz(m), n, rng.random()) * .6 + saw(hz(m) * 1.004, n, rng.random()) * .4
    y = lp_tv(x, cutoff * np.exp(-t * 9) + 300)
    return y * adsr(n, .004, .09, .25, .06) * gain


def bell(m, dur=2.2, gain=1.0):
    t = tt(dur)
    f = hz(m)
    y = (np.sin(2 * np.pi * f * t) * np.exp(-t * 2.2) + .45 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 4) +
         .25 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 7) + .12 * np.sin(2 * np.pi * f * 8.93 * t) * np.exp(-t * 11))
    return y * np.minimum(t / .002, 1) * gain


def coin(m, gain=1.0):
    t = tt(.9)
    f = hz(m)
    y = (np.sin(2 * np.pi * f * t) + .7 * np.sin(2 * np.pi * f * 2.41 * t) + .5 * np.sin(2 * np.pi * f * 3.93 * t) +
         .35 * np.sin(2 * np.pi * f * 5.47 * t)) * np.exp(-t * 7)
    clk = hp(rng.normal(0, 1, len(t)), 5000) * np.exp(-t * 300) * .5
    return (y * .5 + clk) * gain


def clang(gain=1.0):
    t = tt(1.6)
    parts = [(587, 1), (1415, .7), (2350, .5), (3520, .35), (4810, .2)]
    y = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * (3 + f / 900)) for f, a in parts)
    nz = bp(rng.normal(0, 1, len(t)), 1500, 9000) * np.exp(-t * 18)
    return (y * .5 + nz * .7) * gain


def riser(dur, gain=1.0, f0=250, f1=7000):
    n = int(dur * SR)
    t = np.arange(n) / SR
    p = t / dur
    nz = rng.normal(0, 1, n)
    fc = f0 * (f1 / f0) ** (p ** 1.6)
    y = lp_tv(hp(nz, 150), fc) * .9
    sweep = np.sin(2 * np.pi * np.cumsum(180 * (1 + 3 * p ** 2)) / SR) * .12
    return (y + sweep) * (p ** 2.2) * gain


def whoosh(dur=.45, gain=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    p = t / dur
    y = lp_tv(rng.normal(0, 1, n), 400 + 5000 * np.sin(np.pi * p) ** 2)
    return y * np.sin(np.pi * p) ** 2 * gain


def shimmer(dur, gain=1.0):
    t = tt(dur)
    y = sum(np.sin(2 * np.pi * hz(m) * t + m) for m in (86, 93, 98)) / 3
    trem = .6 + .4 * np.sin(2 * np.pi * 12 * t)
    env = np.sin(np.pi * t / dur) ** 1.5
    return y * trem * env * gain


# ---------------- harmony ----------------
# (start, end, root midi in octave 2, quality)
CH = [(0, 4, 38, 'm'), (4, 6, 38, 'm'), (6, 8, 34, 'M'), (8, 10, 38, 'm'), (10, 12, 34, 'M'), (12, 14, 41, 'M'), (14, 16, 36, 'M'),
      (16, 18, 38, 'm'), (18, 20, 34, 'M'), (20, 22, 33, 'M'), (22, 25, 38, 'm'), (25, 28, 34, 'M'), (28, 30, 41, 'M'), (30, 32, 36, 'M'),
      (32, 34, 38, 'm'), (34, 36, 34, 'M'), (36, 38, 38, 'm'), (38, 40, 34, 'M'), (40, 42, 33, 'M'), (42, 46, 38, 'M')]


def triad(root, q):
    return [root, root + (3 if q == 'm' else 4), root + 7]


def chord_at(t):
    for a, b, r, q in CH:
        if a <= t < b:
            return r, q
    return CH[-1][2], CH[-1][3]


def voicing(root, q, base=55):
    """Close-position triad near `base`."""
    tones = triad(root, q)
    out = []
    for x in tones:
        while x < base:
            x += 12
        while x >= base + 12:
            x -= 12
        out.append(x)
    return sorted(out)


# ---------------- arrangement ----------------
# Low drone + pads
for a, b, r, q in CH:
    if a >= 41.75:
        a = 42.0
    dur = b - a + .5
    lvl = {0: .5, 4: .55}.get(a, .6)
    if 28 <= a < 32:
        lvl = .55
    if a < 41:
        place(string_pad(voicing(r, q, 55) + [r + 24], dur, gain=.16 * lvl / .6, cutoff=2600), a - .1, pan=0, rev=.5)
        place(string_pad([x + 12 for x in voicing(r, q, 67)], dur, gain=.07 * lvl / .6, cutoff=5200, attack=.7), a - .1, pan=0, rev=.6)
        place(string_pad([r + 12], dur, gain=.08, cutoff=500), a - .05, pan=0, rev=.25)
# drone under the hook
place(string_pad([38, 50], 4.2, gain=.13, cutoff=420, attack=.3), 0.0, rev=.4)
place(string_pad([62, 69, 74], 3.8, gain=.07, cutoff=2200, attack=2.0), 0.2, rev=.6)   # rising tremolo-ish swell

# Hook hits: 0.0, 1.0, 2.0 (cards land on these)
place(boom(.9), 0.0, rev=.35, key=1)
for t0, g in [(0.0, .9), (1.0, .8), (2.0, .95), (3.0, .6), (3.5, .65), (3.75, .7)]:
    place(taiko(g), t0, pan=0, rev=.3, key=.4)
for k in range(8):  # roll into the reveal
    place(taiko(.25 + k * .05, pitch=1.3), 3.0 + k * .125, pan=(-.3 if k % 2 else .3), rev=.3)
place(riser(1.5, .45), 2.5, rev=.4)

# Reveal 4.0: braam on Dm + boom + crash
BR = lambda root, q: [root, root + 7, root + 12, root + 12 + (3 if q == 'm' else 4), root + 19]
place(braam(BR(38, 'm'), 3.6, .55), 4.0, rev=.45, key=1)
place(boom(1.0), 4.0, rev=.35, key=1)
place(crash(.35), 4.0, pan=.2, rev=.4)
place(whoosh(.5, .25), 3.55, pan=-.2, rev=.3)

# Ostinato (16ths) bars 3-11 and 17-21; 8ths in 3-4
OST = [0, 0, 7, 0, 12, 0, 7, 0, 0, 0, 7, 0, 12, 7, 0, 7]
def ostinato(a, b, step=.125, gain=.18, octave=12):
    t = a
    i = 0
    while t < b - 1e-6:
        r, q = chord_at(t + 1e-4)
        m = r + octave + OST[i % 16]
        acc = 1.0 if i % 4 == 0 else .72
        place(pluck(m, dur=step * 1.6, gain=gain * acc, cutoff=3400), t, pan=(-.35 if i % 2 else .35), rev=.18)
        place(pluck(m + 12, dur=step * 1.2, gain=gain * acc * .35, cutoff=5000), t, pan=(.35 if i % 2 else -.35), rev=.25)
        t += step
        i += 1
ostinato(4.0, 8.0, step=.25, gain=.16)
ostinato(8.0, 16.0, step=.125, gain=.15)
ostinato(16.0, 22.0, step=.125, gain=.17)
ostinato(32.0, 36.0, step=.25, gain=.14)
ostinato(36.0, 41.75, step=.125, gain=.17)

# Stakes: tense low 8ths on D pedal + clock ticks
t = 22.0
while t < 28.0 - 1e-6:
    r, q = chord_at(t + 1e-4)
    place(pluck(r + 12, dur=.2, gain=.2, cutoff=900), t, rev=.15)
    t += .25
for k in range(int(6 / .125)):
    tk = 22.0 + k * .125
    place(tick(.05 if k % 2 else .08), tk, pan=(.5 if k % 2 else -.5), rev=.1)

# Drums: groove bars 5-8, battle bars 9-11, stakes light, payments half-time, climax 19-20, roll 21
def groove(a, b, pattern, gain=.6):
    bar = a
    while bar < b - 1e-6:
        for off, g, p in pattern:
            place(taiko(gain * g, pitch=p), bar + off, pan=(.15 if p > 1.1 else -.1), rev=.28, key=.25)
        bar += BAR
GROOVE = [(0, 1, 1), (.75, .55, 1.25), (1.0, .8, 1), (1.5, .55, 1.25), (1.75, .5, 1.4)]
BATTLE = [(0, 1, 1), (.25, .5, 1.3), (.5, .7, 1.15), (.75, .5, 1.3), (1.0, .9, 1), (1.25, .5, 1.3), (1.5, .75, 1.15), (1.75, .6, 1.4)]
groove(8.0, 16.0, GROOVE, .62)
groove(16.0, 22.0, BATTLE, .7)
groove(22.0, 28.0, [(0, .8, 1), (1.0, .55, 1)], .55)
groove(32.0, 36.0, [(0, .9, 1), (1.0, .7, 1.2)], .6)
groove(36.0, 40.0, BATTLE, .75)
for bar in (8.0, 10.0, 12.0, 14.0):
    place(snare(.22), bar + .5, pan=.1, rev=.35); place(snare(.22), bar + 1.5, pan=.1, rev=.35)
for bar in (16.0, 18.0, 20.0, 36.0, 38.0):
    place(snare(.3), bar + .5, rev=.35); place(snare(.3), bar + 1.5, rev=.35)
# bar 21 roll: 16ths crescendo 40.0 -> 41.75, then silence
for k in range(14):
    place(taiko(.3 + .5 * k / 13, pitch=1.1 + .2 * (k % 2)), 40.0 + k * .125, pan=(.25 if k % 2 else -.25), rev=.3)
for k in range(8):
    place(snare(.12 + .25 * k / 7), 40.75 + k * .125, rev=.25)

# Shaker 16ths for air in the driving sections
def shaker(a, b, gain=.05):
    k = 0
    t = a
    while t < b - 1e-6:
        g = gain * (1.0 if k % 4 == 2 else .55 if k % 2 == 0 else .4)
        place(hp(rng.normal(0, 1, int(.08 * SR)), 6500, 2) * np.exp(-np.arange(int(.08 * SR)) / SR * 55) * g, t, pan=(.45 if k % 2 else -.45), rev=.12)
        t += .125
        k += 1
shaker(8.0, 16.0, .07); shaker(16.0, 22.0, .09); shaker(32.0, 36.0, .05); shaker(36.0, 41.75, .09)

# Horn theme: March of the Riverwardens (A-G-F-G-F-D) and its answer
THEME = [(0, 69, 1.55), (1.75, 67, .7), (2.5, 65, 1.25), (4.0, 67, 1.05), (5.25, 65, .65), (6.0, 62, 1.6)]
ANSWER = [(.25, 65, 1.0), (1.5, 62, .7), (2.5, 64, .65), (3.25, 65, 1.3), (4.75, 69, 1.25), (6.25, 67, 1.5)]
def phrase(start, notes, shift=0, gain=.25, octave_below=True, pan=.12):
    for b, m, beats in notes:
        d = beats * BEAT
        place(horn(m + shift, d + .15, gain), start + b * BEAT, pan=pan, rev=.42)
        if octave_below:
            place(horn(m + shift - 12, d + .15, gain * .8), start + b * BEAT + .01, pan=-pan, rev=.42)
phrase(4.0, THEME, shift=-12, gain=.2, octave_below=False)
phrase(8.0, THEME, gain=.22)
phrase(12.0, ANSWER, gain=.22)
phrase(16.0, THEME, shift=12, gain=.2)
place(horn(69, 2.0, .2), 20.0, pan=.1, rev=.45); place(horn(73, 2.0, .16), 20.0, pan=-.1, rev=.45); place(horn(76, 2.0, .12), 20.5, rev=.45)
phrase(36.0, THEME, shift=12, gain=.22)
place(horn(69, 1.7, .22), 40.0, rev=.45); place(horn(73, 1.7, .18), 40.0, pan=-.15, rev=.45); place(horn(64, 1.7, .2), 40.0, pan=.15, rev=.45)

# Battle: boom 16.0, clash 18.0
place(boom(1.0), 16.0, rev=.35, key=1)
place(crash(.3), 16.0, pan=-.2, rev=.4)
place(braam(BR(38, 'm'), 1.8, .38), 16.0, rev=.4, key=.6)
place(riser(1.5, .5), 14.5, rev=.4)
place(whoosh(.5, .3), 15.6, pan=.2)
place(boom(1.0), 18.0, rev=.4, key=1)
place(clang(.7), 18.0, pan=-.1, rev=.45)
place(clang(.45), 18.04, pan=.25, rev=.45)
place(crash(.45), 18.0, pan=.1, rev=.45)
place(braam(BR(34, 'M'), 2.0, .42), 18.0, rev=.45, key=.6)

# Command cards: soft fwips on each 8th as cards are dealt (12.0 .. 13.75) and unit marching steps
for i in range(8):
    place(whoosh(.18, .12), 12.0 + i * .25 - .06, pan=-.4 + i * .1, rev=.15)
    place(tick(.06, 3000), 12.0 + i * .25 + .12, pan=-.4 + i * .1, rev=.15)
for i in range(6):
    place(taiko(.12, pitch=1.6, dur=.4), 13.0 + i * .125 + .5, pan=-.5 + i * .2, rev=.15)

# Build: building pops on 8ths 10.0..11.0, chips on 9.0/9.5/10.0
for i, m in enumerate([74, 77, 81, 86, 89]):
    place(pluck(m, .3, .12, 3500), 10.0 + i * .25, pan=-.5 + i * .25, rev=.35)
for i, t0 in enumerate([9.0, 9.5, 10.0]):
    place(tick(.08, 2500), t0, rev=.2)

# Stakes: coins land on 23.0 (attacker) and 24.0 (defender); strike 24.5; winner 25.0; coins land 25.5
for k in range(4):
    place(coin(86 + (k % 2) * 5, .22), 23.0 + k * .06, pan=-.3, rev=.35)
    place(coin(86 + (k % 2) * 5, .22), 24.0 + k * .06, pan=.3, rev=.35)
    place(whoosh(.35, .08), 22.55 + k * .06, pan=-.4); place(whoosh(.35, .08), 23.55 + k * .06, pan=.4)
place(clang(.35), 24.5, rev=.5)
place(taiko(.7), 24.5, rev=.3, key=.5)
place(boom(.85), 25.0, rev=.4, key=1)
place(braam(BR(34, 'M'), 2.8, .45), 25.0, rev=.45, key=.6)
place(crash(.3), 25.0, rev=.4)
for k in range(8):
    place(coin(86 + (k % 3) * 3, .14), 25.5 + k * .03, pan=-.4, rev=.4)
place(bell(86, 2.0, .12), 25.5, pan=-.3, rev=.5); place(bell(93, 2.0, .08), 25.5, pan=-.3, rev=.5)

# Wallet breakdown 28-32: celesta-like arpeggio, scan shimmer, paired chime on 30.0
ARP = {41: [65, 69, 72, 77], 36: [64, 67, 72, 76]}
t = 28.0
i = 0
while t < 32.0 - 1e-6:
    r, q = chord_at(t + 1e-4)
    seq = ARP.get(r, [62, 65, 69, 74])
    place(bell(seq[(0, 1, 2, 3, 2, 1, 2, 3)[i % 8]] + 12, 1.2, .07), t, pan=(-.4 if i % 2 else .4), rev=.55)
    t += .25
    i += 1
place(shimmer(1.0, .05), 28.8, rev=.6)
place(bell(84, 2.5, .16), 30.0, pan=.2, rev=.6); place(bell(91, 2.5, .11), 30.0, pan=.2, rev=.6)
place(taiko(.35, pitch=1.2), 30.0, rev=.4)
place(riser(1.8, .3), 30.2, rev=.4)
place(whoosh(.5, .2), 31.6)

# Payments: segment plucks on 33.0/33.5/34.0/34.5 rising
for t0, m in [(33.0, 74), (33.5, 77), (34.0, 82), (34.5, 86)]:
    place(pluck(m, .5, .22, 4200), t0, rev=.4); place(bell(m + 12, 1.2, .06), t0, rev=.5)
    place(tick(.08, 2500), t0)
place(riser(1.0, .35), 35.0, rev=.4)
place(crash(.3), 36.0, rev=.4)
place(boom(.8), 36.0, rev=.35, key=1)
place(taiko(.8), 38.0, rev=.3, key=.4); place(crash(.22), 38.0, pan=-.2, rev=.4)

# Climax choir 36-41.75
place(choir([62, 69, 74], 2.1, .1), 36.0, rev=.6)
place(choir([62, 65, 70], 2.1, .1), 38.0, rev=.6)
place(choir([61, 64, 69], 1.8, .11), 40.0, rev=.6)

# Proof: typing ticks on 32nd grid 40.4375.. , block stamp on 41.25
for k in range(14):
    place(tick(.05, 5000), 40.4375 + k * .0625, pan=(-.2 if k % 2 else .2), rev=.05)
place(taiko(.5, pitch=.9), 41.25, rev=.3); place(coin(81, .1), 41.25, rev=.4)
place(riser(1.75, .45), 40.0, rev=.35)

# Outro 42.0: D major braam, boom, crash, choir and long ring
place(boom(1.1, 4.0), 42.0, rev=.4, key=1)
place(braam([38, 45, 50, 54, 57, 62], 3.8, .6), 42.0, rev=.5, key=1)
place(crash(.45, 3.5), 42.0, rev=.5)
place(choir([62, 66, 69, 74], 3.8, .12), 42.05, rev=.7)
place(string_pad([50, 57, 62, 66, 69], 3.9, .16, cutoff=1800, attack=.25), 42.0, rev=.6)
place(horn(74, 1.0, .2), 42.5, rev=.5); place(horn(69, .6, .17), 43.0, rev=.5); place(horn(74, 2.4, .2), 43.5, rev=.55)
place(horn(62, 2.9, .16), 43.0, pan=-.15, rev=.55)
place(bell(86, 3.0, .1), 44.0, rev=.6)

# ---------------- mix ----------------
# Reverb: stereo decaying noise IR (RT60 ~2.4 s), darkened tail
tir = np.arange(int(2.8 * SR)) / SR
ir = np.zeros((len(tir), 2))
for ch in range(2):
    nz = rng.normal(0, 1, len(tir)) * np.exp(-tir * 6.9 / 2.4)
    nz = lp(nz, 5200)
    nz[:int(.018 * SR)] = 0
    ir[:, ch] = nz / np.sqrt(np.sum(nz ** 2))
wet = np.zeros_like(dry)
for ch in range(2):
    wet[:, ch] = signal.fftconvolve(send[:, ch], ir[:, ch])[:N]

# Sidechain duck the pads/reverb under big hits a little
env = signal.lfilter([1 - np.exp(-1 / (SR * .12))], [1, -np.exp(-1 / (SR * .12))], duck_src)
env = env / (env.max() + 1e-9)
duck = 1 - .25 * np.clip(env, 0, 1)
mix = dry + wet * .55 * duck[:, None]

# silence gap 41.76-42.0 (short fades) for the drop
g = np.ones(N)
a, b = int(41.74 * SR), int(41.99 * SR)
g[a:b] = 0
fade = int(.012 * SR)
g[a - fade:a] = np.linspace(1, 0, fade)
mix *= g[:, None]
# the outro was placed after the gap, so re-add nothing; final fade in last 0.5 s
tail = int(.6 * SR)
mix[-tail:] *= np.linspace(1, 0, tail)[:, None] ** 1.5
# master EQ: high-pass, low shelf -3 dB @ 90 Hz, high shelf +4 dB @ 2.8 kHz (RBJ biquads)
def shelf(x, f0, gdb, kind):
    A = 10 ** (gdb / 40); w = 2 * np.pi * f0 / SR; cw, sw = np.cos(w), np.sin(w); al = sw / 2 * np.sqrt(2)
    if kind == 'low':
        b = [A * ((A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * al), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * al)]
        a = [(A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * al, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * al]
    else:
        b = [A * ((A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * al)]
        a = [(A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * al]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x)
for ch in range(2):
    mix[:, ch] = shelf(shelf(hp(mix[:, ch], 30), 90, -3, 'low'), 2800, 4, 'high')
mix /= np.max(np.abs(mix))
mix = np.tanh(mix * 1.6) / np.tanh(1.6)
wavfile.write(sys.argv[1] if len(sys.argv) > 1 else 'audio/score.wav', SR, mix.astype(np.float32))
print('written', mix.shape, 'peak', np.max(np.abs(mix)))
