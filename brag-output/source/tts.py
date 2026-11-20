"""Generate the narration lines with Kokoro (kokoro-onnx). Run with the tts venv:
   tts-venv/bin/python work/tts.py <models-dir> <out-dir> <voice> [speed]"""
import json
import sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

models, out, voice = sys.argv[1], sys.argv[2], sys.argv[3]
speed = float(sys.argv[4]) if len(sys.argv) > 4 else 0.95

# (id, start s, latest end s, text, speed tweak)
LINES = [
    ("l01", 4.35, 6.00, "This is Vaultborn.", 1.0),
    ("l02", 8.40, 11.60, "Start with one castle. Grow it into a kingdom.", 1.0),
    ("l03", 12.40, 15.30, "Then choose who leads your army.", 1.0),
    ("l04", 18.70, 21.60, "Replay any raid, exchange by exchange.", 1.0),
    ("l05", 22.20, 24.95, "Stake B C H. Your rival matches it.", 1.0),
    ("l06", 25.55, 27.70, "Win, and both stakes are yours.", 1.0),
    ("l07", 28.30, 31.75, "Sign in with your wallet. Nothing moves until you approve.", 1.0),
    ("l08", 32.35, 35.80, "Half of every payment lands in your own War Chest.", 1.0),
    ("l09", 36.25, 39.80, "Forge alliances. Chase the season's prize pool.", 1.0),
    ("l10", 40.25, 41.60, "And it's already live.", 1.0),
    ("l11", 42.45, 45.30, "Vaultborn. A kingdom is earned.", 0.92),
]

k = Kokoro(f"{models}/kokoro-v1.0.onnx", f"{models}/voices-v1.0.bin")
report = []
for lid, start, end, text, tweak in LINES:
    s = speed * tweak
    for attempt in range(6):
        audio, sr = k.create(text, voice=voice, speed=s, lang="en-us")
        audio = np.asarray(audio, dtype=np.float32)
        # trim silence
        thr = 0.02 * np.max(np.abs(audio))
        idx = np.nonzero(np.abs(audio) > thr)[0]
        a, b = max(0, idx[0] - int(.02 * sr)), min(len(audio), idx[-1] + int(.08 * sr))
        audio = audio[a:b]
        dur = len(audio) / sr
        if start + dur <= end or s >= 1.12:
            break
        s = round(s + 0.04, 3)
    sf.write(f"{out}/{lid}.wav", audio, sr)
    report.append({"id": lid, "start": start, "end": start + dur, "limit": end, "dur": round(dur, 3), "speed": s, "text": text,
                   "words": len(text.split()), "fits": start + dur <= end})
    print(f"{lid} {start:6.2f}-{start + dur:6.2f} (limit {end:5.2f}) speed {s:.2f} {'OK' if start + dur <= end else 'OVER'}  {text}")
json.dump(report, open(f"{out}/lines.json", "w"), indent=1)
print("phonemes check:", k.tokenizer.phonemize("This is Vaultborn. Stake real B C H.", "en-us"))
