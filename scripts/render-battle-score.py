"""Render the original Oath at Dusk score. Requires NumPy and local FFmpeg."""
from pathlib import Path
import subprocess

import numpy as np

RATE = 32_000
BEAT = 60 / 116
BARS = 24
LENGTH = round(BARS * 4 * BEAT * RATE)
RNG = np.random.default_rng(17531)
SCORE = np.zeros((LENGTH, 2))


def voice(midi, beat, beats, strength, pan=0, instrument="bow"):
    duration = beats * BEAT
    t = np.arange(round(duration * RATE)) / RATE
    omega = (2 * np.pi * 440 * 2 ** ((midi - 69) / 12)) * t
    if instrument == "drum":
        signal = (np.sin(omega + 5 * (1 - np.exp(-38 * t))) +
                  .32 * np.sin(omega * 2.13) + .28 * RNG.normal(0, 1, len(t)) * np.exp(-16*t))
        signal *= np.exp(-6.5*t)
        onset, tail = .009, .15
    elif instrument == "skin":
        dust = RNG.normal(0, 1, len(t))
        signal = ((dust - np.roll(dust, 1))*.15 + .14*np.sin(omega*3.53) + .49*np.sin(omega))
        signal *= np.exp(-11*t)
        onset, tail = .004, .09
    elif instrument == "horn":
        vibrato = .22 * np.sin(t * 26) * np.minimum(t*3, 1)
        signal = (.64*np.sin(omega + vibrato) + .25*np.sin(2*omega + vibrato) +
                  .15*np.sin(3.001*omega + vibrato) + .06*np.sin(4*omega + 2*vibrato))
        onset, tail = .16, .26
    else:
        drag = .16 * np.sin(t*36)+.11*np.sin(t*27)
        signal = (.48*np.sin(omega + drag) + .23*np.sin(omega*1.004) +
                  .15*np.sin(2*omega + drag) + .08*np.sin(3*omega) + .05*np.sin(4*omega))
        onset, tail = (.035, .10) if beats < 1 else (.19, .22)
    signal *= np.clip(np.minimum(t/onset, (duration-t)/tail), 0, 1) * strength
    position = (np.arange(len(t)) + round(beat*BEAT*RATE)) % LENGTH
    SCORE[position, 0] += signal * np.sqrt(.5*(1-pan))
    SCORE[position, 1] += signal * np.sqrt(.5*(1+pan))


# A low D pulse under rising horn calls. The second act opens into F before the return to D.
harmonies = [
    (38, (50,57,62,65)), (38, (50,57,60,65)), (34, (46,53,58,62)), (36, (48,55,60,64)),
    (38, (50,57,62,65)), (41, (53,57,60,65)), (43, (55,58,62,67)), (45, (52,57,61,64)),
]
for bar in range(BARS):
    beat = bar*4
    root, chord = harmonies[bar//2 % len(harmonies)]
    for n, note in enumerate(chord):
        voice(note, beat-.09, 4.3, .078 + (.045 if n==0 else 0), (n-1.5)*.36)
    voice(root-12, beat-.08, 4.23, .13)
    rhythm=(0,.5,1,1.5,2,2.75,3,3.5) if bar%2==0 else (0,.75,1.25,2,2.5,3,3.5,3.75)
    for n, step in enumerate(rhythm):
        note=chord[(0,1,0,2,0,3,1,2)[n]]
        voice(note, beat+step, .35, .135 if n%2==0 else .082, -.47)
        if bar>2:
            voice(note+12, beat+step+.015, .29, .072 if n%2==0 else .047, .42)
    for n, step in enumerate((0,1.5,2.75) if bar%2==0 else (0,2,3.5)):
        voice(31-(n%2)*4, beat+step, .68, .53 if n==0 else .35, (-1)**n*.21,'drum')
    for step in (1.0,2.0,3.0,3.75) if bar%4==3 else (1.0,3.0):
        voice(61,beat+step,.39,.18,.48 if step<=2 else -.53,'skin')

themes = (
    (2,[(0,62,1.25),(1.5,65,.6),(2.5,67,1.45),(4,69,2.3),(6.5,65,1.15)]),
    (6,[(0,62,1.3),(1.5,62,.6),(2.5,65,1.3),(4,70,2.3),(7,69,.85)]),
    (10,[(0,72,1.4),(1.5,70,.71),(2.5,69,1.3),(4,65,1.25),(5.5,67,1.15),(7,62,.83)]),
    (14,[(0,67,1.25),(1.5,69,.68),(2.45,70,1.25),(4,73,1.55),(5.7,69,.6),(6.5,67,1.28)]),
    (18,[(0,74,2.4),(2.5,72,1.25),(4,69,1.62),(5.75,65,.59),(6.5,62,1.45)]),
    (22,[(0,65,1.4),(1.5,67,.73),(2.5,69,1.3),(4,62,3.57)]),
)
for bar, motif in themes:
    for when, note, beats in motif:
        voice(note,bar*4+when,beats,.14,.16,'horn')
        voice(note-12,bar*4+when+.019,beats*.98,.12,-.22,'horn')

direct=SCORE.copy()
for seconds,gain,swap in ((.048,.16,True),(.105,.16,False),(.176,.12,True),
                          (.295,.08,False),(.461,.065,True),(.752,.038,False)):
    SCORE += gain*np.roll(direct[:,::-1] if swap else direct,round(seconds*RATE),axis=0)
master=np.tanh(SCORE*1.28)
master *= .73/np.max(np.abs(master))
target=Path(__file__).resolve().parents[1]/"packages/assets/battle-score.mp3"
subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y","-f","f32le","-ar",str(RATE),"-ac","2",
                "-i","-","-codec:a","libmp3lame","-b:a","112k","-metadata","title=Oath at Dusk",
                "-metadata","artist=VAULTBORN original score",str(target)],input=master.astype("<f4").tobytes(),check=True)
