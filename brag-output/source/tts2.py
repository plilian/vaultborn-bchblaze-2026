"""Narration v2: Kokoro fed with Kokoro's own G2P (misaki US lexicon + spaCy POS), checked word by word.
   tts312/bin/python work/tts2.py <models-dir> <out-dir> <voice>"""
import json
import sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro
from misaki import en, espeak

models, out, voice = sys.argv[1], sys.argv[2], sys.argv[3]
g2p = en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False))

# Pronunciations fixed by hand. VaultBorn is stressed like "newborn": VAULT-born.
OVERRIDE = {"VaultBorn": "vˈɔltbˌɔɹn"}

# (id, start s, latest end s, text, speed)
LINES = [
    ("l01", 4.35, 6.00, "This is VaultBorn.", .95),
    ("l02", 8.40, 11.60, "Start with one castle. Grow it into a kingdom.", .95),
    ("l03", 12.40, 15.30, "Then choose who leads your army.", .95),
    ("l04", 18.70, 21.60, "Replay any raid, exchange by exchange.", .95),
    ("l05", 22.20, 24.95, "Stake BCH. Your rival matches it.", .95),
    ("l06", 25.55, 27.70, "Win, and both stakes are yours.", .95),
    ("l07", 28.30, 31.75, "Sign in with your wallet. Nothing moves until you approve.", .95),
    ("l08", 32.35, 35.80, "Half of every payment lands in your own War Chest.", .95),
    ("l09", 36.25, 39.80, "Forge alliances. Chase the season's prize pool.", .95),
    ("l10", 40.25, 41.60, "And it's already live.", .95),
    ("l11", 42.45, 45.30, "VaultBorn. A kingdom is earned.", .9),
]

k = Kokoro(f"{models}/kokoro-v1.0.onnx", f"{models}/voices-v1.0.bin")
vocab = set(k.tokenizer.vocab)
report = []
for lid, start, end, text, speed in LINES:
    _, tokens = g2p(text)
    parts = []
    for tk in tokens:
        ph = OVERRIDE.get(tk.text, tk.phonemes) or ''
        parts.append(ph + (tk.whitespace or ''))
    phon = ''.join(parts).strip()
    bad = sorted({c for c in phon if c not in vocab})
    assert not bad, (lid, bad)
    s = speed
    for _ in range(6):
        audio, sr = k.create(phon, voice=voice, speed=s, is_phonemes=True, trim=True, sentence_pause=.22, clause_pause=.1)
        audio = np.asarray(audio, dtype=np.float32)
        # trim: keep soft consonant tails (final d, t, s), fade the edges
        env = np.sqrt(np.convolve(audio ** 2, np.ones(240) / 240, mode='same'))
        idx = np.nonzero(env > env.max() * 10 ** (-45 / 20))[0]
        a, b = max(0, idx[0] - int(.03 * sr)), min(len(audio), idx[-1] + int(.18 * sr))
        audio = audio[a:b].copy()
        f = int(.01 * sr); audio[:f] *= np.linspace(0, 1, f); audio[-int(.04 * sr):] *= np.linspace(1, 0, int(.04 * sr))
        dur = len(audio) / sr
        if start + dur <= end + .05 or s >= 1.08:
            break
        s = round(s + .03, 3)
    sf.write(f"{out}/{lid}.wav", audio, sr, subtype='FLOAT')
    report.append({"id": lid, "start": start, "end": round(start + dur, 3), "limit": end, "dur": round(dur, 3), "speed": s,
                   "text": text, "phonemes": phon, "words": len(text.split()), "fits": start + dur <= end + .05,
                   "peak": float(np.max(np.abs(audio)))})
    print(f"{lid} {start:6.2f}-{start + dur:6.2f} (limit {end:5.2f}) speed {s:.2f} peak {np.max(np.abs(audio)):.2f} "
          f"{'OK' if start + dur <= end + .05 else 'OVER'}  {phon}")
json.dump(report, open(f"{out}/lines.json", "w"), indent=1, ensure_ascii=False)
