const cues = {
  'political-coup': [[73,0,.32],[110,.15,.3],[147,.33,.58],[196,.53,.3]],
  'political-war': [[62,0,.4],[73,.14,.31],[92,.31,.51],[131,.55,.56]],
  'political-peace': [[174,0,.3],[261,.14,.4],[349,.32,.74],[523,.44,.58]],
  'political-independence': [[147,0,.37],[247,.14,.43],[294,.32,.55],[440,.51,.65]],
  select: [[196, 0, 0.08], [294, 0.025, 0.12]],
  dispatch: [[147, 0, 0.12], [220, 0.12, 0.17]],
  build: [[92, 0, .16], [168, .13, .12], [248, .25, .22]],
  upgrade: [[147, 0, .25], [220, .11, .31], [294, .23, .46], [440, .31, .44]],
  impact: [[54, 0, .25], [78, .05, .12]],
  reward: [[349, 0, .16], [440, .1, .22], [587, .19, .44]],
  message: [[311, 0, .19], [392, .13, .26]],
  victory: [[147, 0, .38], [196, 0, .3], [247, .14, .3], [294, .26, .6], [392, .27, .44]],
  defeat: [[196, 0, .21], [147, .17, .32], [98, .29, .61]],
  claim: [[196, 0, .2], [294, .12, .26], [392, .23, .52], [494, .38, .44]],
  raffle: [[294, 0, .18], [415, .13, .23], [523, .25, .39], [622, .34, .45]],
  'lease-end': [[440, 0, .28], [330, .17, .28], [220, .32, .49]],
  'battle-march': [[62,0,.28,.08,'sine'],[49,.22,.35,.09,'sine'],[92,.48,.43,.055,'triangle']],
  'battle-volley': [[448,0,.16,.026,'sine'],[323,.075,.17,.022,'triangle']],
  'battle-spell': [[329,0,.37,.047,'sine'],[494,.035,.56,.042,'sine'],[741,.11,.29,.025,'triangle']],
  'battle-clash': [[61,0,.21,.075,'sine'],[263,0,.12,.026,'triangle'],[571,.01,.2,.024,'triangle'],[894,.019,.27,.013,'sine']],
  'battle-heavy': [[39,0,.34,.095,'sine'],[66,.035,.24,.075,'sine'],[289,.008,.23,.025,'triangle'],[731,.035,.32,.019,'sine']],
  'battle-victory': [[146,0,.63,.085,'triangle'],[220,.04,.7,.062,'triangle'],[293,.19,.78,.07,'triangle'],
    [369,.39,.92,.057,'triangle'],[440,.56,1.07,.059,'triangle'],[587,.7,1.6,.058,'sine'],[880,.76,1.26,.021,'sine']],
  'battle-defeat': [[147,0,.52,.07,'triangle'],[138,.17,.65,.037,'triangle'],[110,.44,.94,.062,'triangle'],
    [73,.66,1.24,.084,'sine'],[82,.75,1.37,.038,'triangle'],[196,.81,1.12,.026,'sine']],
  'battle-result': [[110,0,.45,.055,'triangle'],[164,.19,.54,.05,'triangle'],[220,.33,.82,.048,'sine']],
};
let context;
const tracks=new Map();
let playingTrack;
let desiredTrack;
let epoch=0;
let fadeFrame;
let fadeInProgress=false;
let battleMode='idle';
let battleOffset=0;
let sfxBus;
let sentries;
let interacted = false;
let settings = { muted: true, musicVolume: .42, sfxVolume: .65 };
const clamp = value => Math.max(0, Math.min(1, value));

export function configureGameAudio(next = {}) {
  settings = { muted: next.muted ?? false, musicVolume: clamp((next.musicVolume ?? 42) / 100),
    sfxVolume: clamp((next.sfxVolume ?? 65) / 100) };
  synchronizeMusic();
  if(sfxBus) sfxBus.gain.value=settings.muted?0:settings.sfxVolume;
}

const source={frontier:'/art/frontier-saga.mp3',battle:'/art/battle-score.mp3'};
function getTrack(name) {
  if(!tracks.has(name)) {
    const track=new Audio(source[name]);
    track.loop=true;
    track.preload='none';
    tracks.set(name,track);
  }
  return tracks.get(name);
}

function fade(track,to,duration,version,done=()=>{}) {
  fadeInProgress=true;
  const started=performance.now(), from=track.volume;
  function tick(now) {
    if(version!==epoch)return;
    const progress=clamp((now-started)/duration);
    track.volume=clamp(from+(to-from)*progress);
    if(progress<1) fadeFrame=requestAnimationFrame(tick);
    else {fadeInProgress=false;done();}
  }
  fadeFrame=requestAnimationFrame(tick);
}

function synchronizeMusic() {
  const allowed=interacted&&!settings.muted&&settings.musicVolume>0&&!document.hidden;
  const target=allowed?(battleMode==='playing'?'battle':battleMode==='idle'?'frontier':null):null;
  if(!allowed) {
    cancelAnimationFrame(fadeFrame);++epoch;fadeInProgress=false;
    playingTrack=null;desiredTrack=null;
    for(const track of tracks.values()) track.pause();
    return;
  }
  if(target===desiredTrack) {
    if(!fadeInProgress&&playingTrack) getTrack(playingTrack).volume=settings.musicVolume;
    return;
  }
  desiredTrack=target;
  cancelAnimationFrame(fadeFrame);
  const version=++epoch;
  const prior=playingTrack&&getTrack(playingTrack);
  const start=()=>{
    if(version!==epoch)return;
    prior?.pause();
    playingTrack=target;
    if(!target)return;
    const next=getTrack(target);
    if(target==='battle') {
      const seek=()=>{if(version===epoch&&Number.isFinite(next.duration)&&next.duration>0) next.currentTime=(battleOffset/1000)%next.duration;};
      if(next.readyState) seek();else next.addEventListener('loadedmetadata',seek,{once:true});
    }
    next.volume=0;
    void next.play().catch(()=>{if(version===epoch){playingTrack=null;desiredTrack=null;}});
    fade(next,settings.musicVolume,target==='battle'?350:520,version,()=>{next.volume=settings.musicVolume;});
  };
  if(prior&&!prior.paused&&prior.volume>.01) fade(prior,0,battleMode==='ending'?620:290,version,start);
  else start();
}

export function setBattleAudio(mode,offset=0) {
  battleMode=mode;
  battleOffset=offset;
  synchronizeMusic();
}

export function activateGameAudio(muted = settings.muted) {
  interacted = true;
  if (muted) return;
  synchronizeMusic();
  const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Context) return;
  context ??= new Context();
  if(!sfxBus) {
    sfxBus=context.createGain();
    sfxBus.gain.value=settings.sfxVolume;
    sfxBus.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume().catch(() => {});
}

document.addEventListener('visibilitychange', synchronizeMusic);

export function playGameCue(name, muted = settings.muted) {
  if (muted || settings.sfxVolume === 0 || document.hidden || context?.state !== 'running') return;
  const start = context.currentTime;
  if (['battle-heavy','battle-clash','battle-volley','battle-march','battle-spell'].includes(name)) {
    if(!sentries) {
      sentries=context.createBuffer(1,Math.floor(context.sampleRate*.72),context.sampleRate);
      const samples=sentries.getChannelData(0);
      let seed=371;
      for(let i=0;i<samples.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;samples[i]=seed/2147483648;}
    }
    const noise=context.createBufferSource(), tone=context.createBiquadFilter(), gate=context.createGain();
    const heavy=name==='battle-heavy', clash=name==='battle-clash', step=name==='battle-march';
    const length=heavy?.31:clash?.19:step?.36:.19;
    noise.buffer=sentries;tone.type='bandpass';tone.frequency.value=heavy?790:clash?2650:step?180:1900;
    tone.Q.value=heavy?.55:clash?1.6:.9;gate.gain.setValueAtTime(.0001,start);
    gate.gain.exponentialRampToValueAtTime(heavy?.23:clash?.17:step?.095:.065,start+.016);
    gate.gain.exponentialRampToValueAtTime(.0001,start+length);
    noise.connect(tone).connect(gate).connect(sfxBus);
    noise.start(start);noise.stop(start+length);
    noise.onended=()=>{noise.disconnect();tone.disconnect();gate.disconnect();};
  }
  for (const [pitch, delay, length,volume=.075,wave='triangle'] of cues[name] ?? []) {
    const voice = context.createOscillator();
    const envelope = context.createGain();
    const attack = start + delay;
    voice.type = wave;
    voice.frequency.value = pitch;
    envelope.gain.setValueAtTime(0.0001, attack);
    envelope.gain.exponentialRampToValueAtTime(volume, attack + 0.016);
    envelope.gain.exponentialRampToValueAtTime(0.0001, attack + length);
    voice.connect(envelope).connect(sfxBus);
    voice.start(attack);
    voice.stop(attack + length);
    voice.onended=()=>{voice.disconnect();envelope.disconnect();};
  }
}
