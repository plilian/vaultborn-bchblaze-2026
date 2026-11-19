"""Render the original VAULTBORN campaign score with NumPy and FFmpeg."""

from pathlib import Path
import subprocess

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RATE = 44100
BEAT = 60 / 92
BARS = 32
LENGTH = round(BARS * 4 * BEAT * RATE)
RNG = np.random.default_rng(31097)
score = np.zeros((LENGTH, 2), dtype=np.float64)


def note(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def envelope(t, duration, attack, release):
    return np.minimum(np.minimum(t / attack, 1), np.maximum((duration - t) / release, 0))


def add(signal, beat, pan, volume):
    frames = (np.arange(len(signal)) + round(beat * BEAT * RATE)) % LENGTH
    score[frames, 0] += signal * volume * np.sqrt((1 - pan) / 2)
    score[frames, 1] += signal * volume * np.sqrt((1 + pan) / 2)


def voice(midi, beat, beats, instrument, pan, volume):
    duration = beats * BEAT
    t = np.arange(round(duration * RATE)) / RATE
    f = note(midi)
    wave = 2 * np.pi * f * t
    if instrument == "bow":
        signal = (.59 * np.sin(wave + .15 * np.sin(t * 29)) + .26 * np.sin(wave * 1.002) +
                  .10 * np.sin(2 * wave + .38 * np.sin(t * 31)) + .05 * np.sin(3 * wave))
        signal *= envelope(t, duration, .44, .65) * (.9 + .1 * np.sin(t * 4 + midi))
    elif instrument == "lute":
        signal = (.63 * np.sin(wave) + .20 * np.exp(-t * 3) * np.sin(wave * 2.004) +
                  .12 * np.exp(-t * 8) * np.sin(3 * wave) + .05 * np.exp(-t * 14) * np.sin(5 * wave))
        signal *= envelope(t, duration, .009, .28) * np.exp(-t * 2.0)
    elif instrument == "pipe":
        vibrato = np.sin(t * 31.4) * np.clip(t * 0.36, 0, .17)
        noise = RNG.normal(0, .06, len(t))
        breath = np.convolve(noise, np.hanning(11) / 5, mode="same")
        signal = (.78 * np.sin(wave + vibrato) + .16 * np.sin(2 * (wave + vibrato)) +
                  .045 * np.sin(3 * (wave + vibrato)) + breath)
        signal *= envelope(t, duration, .10, .23)
    elif instrument == "bell":
        signal = (.50 * np.sin(wave) + .25 * np.exp(-3 * t) * np.sin(wave * 2.01) +
                  .16 * np.exp(-5 * t) * np.sin(wave * 3.92) + .09 * np.exp(-8 * t) * np.sin(wave * 5.2))
        signal *= envelope(t, duration, .005, .3) * np.exp(-t * 1.9)
    else:
        noise = RNG.normal(0, .1, len(t))
        signal = np.sin(wave + 3 * np.exp(-24 * t)) * np.exp(-t * 9) + noise * np.exp(-20 * t)
        signal *= envelope(t, duration, .007, .32)
    add(signal, beat, pan, volume)


# Dorian colors over a D pedal, with eight double-bar phrases and a softened reprise.
harmony = [
    (38, [50, 57, 62, 65]), (36, [48, 55, 60, 64]), (43, [50, 55, 59, 62]), (41, [48, 53, 57, 60]),
    (38, [50, 57, 62, 65]), (46, [53, 58, 62, 65]), (43, [50, 55, 59, 62]), (45, [52, 57, 60, 64]),
]
for bar in range(BARS):
    beat = 4 * bar
    root, chord = harmony[(bar // 2) % len(harmony)]
    voice(root, beat - .18, 4.36, "bow", 0, .39)
    for index, tone in enumerate(chord):
        voice(tone, beat + .03 * index - .14, 4.32, "bow", (index - 1.5) * .34, .12)
    pattern = (0, 1, 2, 1, 3, 2) if bar % 2 == 0 else (0, 2, 1, 3, 1, 2)
    for index, step in enumerate((0, .75, 1.5, 2.25, 3, 3.5)):
        if bar in (14, 30) and index > 2:
            break
        voice(chord[pattern[index]] + 12, beat + step, 1.5, "lute", (-.38 if index % 2 == 0 else .36),
              .15 if index in (0, 3) else .115)
    if bar % 2 == 0:
        voice(35, beat, 1.1, "drum", -.14, .28)
        if 7 < bar < 29:
            voice(31, beat + 2.5, .74, "drum", .18, .16)
    if bar in (3, 7, 11, 19, 23, 27):
        voice(chord[2] + 24, beat + 2.25, 3.2, "bell", .52, .10)

phrases = [
    (2, [(0, 69, 1.55), (1.75, 67, .7), (2.5, 65, 1.25), (4.0, 67, 1.05), (5.25, 65, .65), (6.0, 62, 1.6)]),
    (6, [(.25, 65, 1.0), (1.5, 62, .7), (2.5, 64, .65), (3.25, 65, 1.3), (4.75, 69, 1.25), (6.25, 67, 1.5)]),
    (10, [(0, 74, 1.05), (1.25, 72, .65), (2.0, 69, 1.6), (4.0, 71, 1.35), (5.5, 67, .8), (6.5, 65, 1.2)]),
    (17, [(0, 62, 1.1), (1.5, 65, .8), (2.5, 69, 1.4), (4.25, 67, 1.2), (5.75, 64, .65), (6.5, 62, 1.4)]),
    (22, [(.5, 74, 1.4), (2, 72, .8), (3, 69, 1.4), (4.75, 65, 1.25), (6.25, 67, 1.35)]),
    (27, [(0, 69, 1.4), (1.5, 67, .7), (2.25, 65, 1.1), (3.5, 64, 1.7), (5.5, 62, 2.2)]),
]
for start, phrase in phrases:
    for beat, midi, hold in phrase:
        voice(midi, start * 4 + beat, hold, "pipe", -.05, .18)

dry = score.copy()
for seconds, gain, swap in [(.069, .12, True), (.128, .15, False), (.231, .14, True), (.373, .09, True),
                             (.491, .07, False), (.681, .045, True), (.961, .025, False)]:
    score += gain * np.roll(dry[:, ::-1] if swap else dry, round(seconds * RATE), axis=0)
score = np.tanh(score * .88)
score *= .63 / np.max(np.abs(score))
subprocess.run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(RATE), "-ac", "2", "-i", "-",
    "-codec:a", "libmp3lame", "-b:a", "112k", "-metadata", "title=March of the Riverwardens",
    "-metadata", "artist=VAULTBORN original score", str(ROOT / "packages/assets/frontier-score.mp3"),
], input=score.astype("<f4").tobytes(), check=True)
