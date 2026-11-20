"""Mix the Kokoro narration over the score: voice EQ + compression + a little room, music ducked under each line.
   python3 mix_vo.py <score_raw.wav> <vo-dir> <out_raw.wav> <out.srt>"""
import json
import sys
import numpy as np
from scipy import signal
from scipy.io import wavfile

score_path, vo_dir, out_path, srt_path = sys.argv[1:5]
SR = 48000
sr, music = wavfile.read(score_path)
music = music.astype(np.float64)
assert sr == SR
N = len(music)
lines = json.load(open(f"{vo_dir}/lines.json"))
rng = np.random.default_rng(5)


def peaking(x, f0, gdb, q):
    A = 10 ** (gdb / 40); w = 2 * np.pi * f0 / SR; al = np.sin(w) / (2 * q); c = np.cos(w)
    b = np.array([1 + al * A, -2 * c, 1 - al * A]); a = np.array([1 + al / A, -2 * c, 1 - al / A])
    return signal.lfilter(b / a[0], a / a[0], x)


def compress(x, thr_db=-20, ratio=3.0):
    # RMS envelope over 15 ms, smoothed; static 3:1 above threshold
    win = int(.015 * SR)
    env = np.sqrt(np.convolve(x ** 2, np.ones(win) / win, mode='same'))
    env = signal.lfilter([1 - np.exp(-1 / (SR * .03))], [1, -np.exp(-1 / (SR * .03))], env)
    edb = 20 * np.log10(env + 1e-9)
    gr = np.where(edb > thr_db, (thr_db - edb) * (1 - 1 / ratio), 0.0)
    return x * 10 ** (gr / 20)


def read_line(path):
    r, raw = wavfile.read(path)
    v = raw.astype(np.float64)
    if raw.dtype == np.int16:
        v = v / 32768.0
    elif raw.dtype == np.int32:
        v = v / 2147483648.0
    if v.ndim > 1:
        v = v.mean(1)
    g = np.gcd(SR, r)
    return signal.resample_poly(v, SR // g, r // g)


voice = np.zeros(N)
spans = []
for ln in lines:
    v = read_line(f"{vo_dir}/{ln['id']}.wav")
    v = signal.sosfilt(signal.butter(2, 90, 'high', fs=SR, output='sos'), v)
    v = peaking(v, 280, -2.0, 1.0)
    v = peaking(v, 3200, 2.5, 0.9)
    v = peaking(v, 7500, -1.5, 1.2)        # soften sibilance a little
    # level each line to the same speech RMS before compression
    act = np.abs(v) > .02 * np.max(np.abs(v))
    v = v / (np.sqrt(np.mean(v[act] ** 2)) + 1e-9) * 0.1
    v = compress(v, thr_db=-20, ratio=3.0)
    i0 = int(round(ln['start'] * SR))
    n = min(len(v), N - i0)
    voice[i0:i0 + n] += v[:n]
    spans.append((ln['start'], ln['start'] + n / SR, ln['id'], ln['text']))

# small room for the voice (same kind of space as the score's reverb, shorter)
tir = np.arange(int(.9 * SR)) / SR
ir = rng.normal(0, 1, len(tir)) * np.exp(-tir * 6.9 / .7)
ir = signal.sosfilt(signal.butter(2, 4500, 'low', fs=SR, output='sos'), ir)
ir[:int(.012 * SR)] = 0
ir /= np.sqrt(np.sum(ir ** 2))
room = signal.fftconvolve(voice, ir)[:N]
vL = voice + room * .16 * np.array([1.0])
vR = voice + np.roll(room, int(.007 * SR)) * .16
VO_GAIN = 1.0

# duck curve: down to `depth` from 0.18 s before each line, back up over 0.45 s after it
duck = np.ones(N)
t = np.arange(N) / SR
bp0 = signal.butter(4, [300, 4000], 'band', fs=SR, output='sos')
vm0 = signal.sosfilt(bp0, voice)
mm0 = signal.sosfilt(bp0, music.mean(1))
TARGET = 14.0
depths = {}
for s, e, lid, _ in spans:
    a_, b_ = int(s * SR), int(e * SR)
    act = np.abs(vm0[a_:b_]) > .05 * np.max(np.abs(vm0[a_:b_]))
    snr0 = 10 * np.log10(np.mean(vm0[a_:b_][act] ** 2) / (np.mean(mm0[a_:b_] ** 2) + 1e-12))
    depths[lid] = float(np.clip(10 ** ((snr0 - TARGET) / 20), .15, .45))
print('duck depths', {k: round(v, 2) for k, v in depths.items()})
for s, e, lid, _ in spans:
    depth = depths[lid]
    a0, a1, b0, b1 = s - .18, s - .02, e + .05, e + .5
    seg = np.ones(N)
    seg = np.where((t >= a0) & (t < a1), 1 - (1 - depth) * (t - a0) / (a1 - a0), seg)
    seg = np.where((t >= a1) & (t < b0), depth, seg)
    seg = np.where((t >= b0) & (t < b1), depth + (1 - depth) * (t - b0) / (b1 - b0), seg)
    duck = np.minimum(duck, seg)

mix = music * duck[:, None]
mix[:, 0] += vL * VO_GAIN
mix[:, 1] += vR * VO_GAIN

# report the speech-band voice-over-music ratio for each line
bp = signal.butter(4, [300, 4000], 'band', fs=SR, output='sos')
vm = signal.sosfilt(bp, voice)
mm = signal.sosfilt(bp, (music * duck[:, None]).mean(1))
print("line   start   end    voice/music (speech band)")
for s, e, lid, text in spans:
    a, b = int(s * SR), int(e * SR)
    act = np.abs(vm[a:b]) > .05 * np.max(np.abs(vm[a:b]))
    r = 10 * np.log10(np.mean(vm[a:b][act] ** 2) / (np.mean(mm[a:b] ** 2) + 1e-12))
    print(f"{lid}  {s:6.2f} {e:6.2f}   {r:+5.1f} dB   {text}")

mix /= np.max(np.abs(mix)) / .98
wavfile.write(out_path, SR, mix.astype(np.float32))


def ts(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


with open(srt_path, 'w') as f:
    for i, (s, e, lid, text) in enumerate(spans, 1):
        f.write(f"{i}\n{ts(s)} --> {ts(e + .2)}\n{text.replace('B C H', 'BCH').replace('Vaultborn', 'VaultBorn')}\n\n")
print("written", out_path, srt_path)
