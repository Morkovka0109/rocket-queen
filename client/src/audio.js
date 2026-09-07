// Soft, original cues. No propeller loop — it was harsh in the mix.

function noiseBuffer(ctx, seconds = 1.6) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i += 1) {
    last = last * 0.97 + (Math.random() * 2 - 1) * 0.03;
    data[i] = last * 5;
  }
  return buf;
}

function env(g, t, peak, a, hold, rel) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t + a);
  g.gain.setValueAtTime(Math.max(0.001, peak), t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
}

class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.noise = null;
    this.muted = false;
    this.bed = 'off';
    this.musicTimer = 0;
    this.unlocked = false;
    try {
      this.muted = localStorage.getItem('aviator-muted') === '1';
    } catch {
      this.muted = false;
    }
  }

  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.musicBus.gain.value = 0.14;
      this.sfxBus.gain.value = 0.42;
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.noise = noiseBuffer(this.ctx);
      this.applyMute();
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend();
        else if (!this.muted) this.ctx.resume();
      });
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const first = !this.unlocked;
    this.unlocked = true;
    if (first && this.bed === 'off') this.setBed('wait');
    else if (first) this.pumpMusic();
  }

  applyMute() {
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.8;
  }

  setMuted(on) {
    this.muted = Boolean(on);
    try {
      localStorage.setItem('aviator-muted', this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.applyMute();
    if (!this.muted) this.unlock();
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  setRpm() {}

  startEngine() {}

  stopEngine() {}

  setBed(kind) {
    const next = kind === 'fly' ? 'fly' : kind === 'wait' ? 'wait' : 'off';
    if (this.bed === next && this.musicTimer) return;
    this.bed = next;
    window.clearTimeout(this.musicTimer);
    this.musicTimer = 0;
    if (next === 'off' || !this.ctx) return;
    this.pumpMusic();
  }

  pumpMusic() {
    if (!this.ctx || this.bed === 'off') return;
    window.clearTimeout(this.musicTimer);
    const bpm = this.bed === 'fly' ? 88 : 72;
    const stepSec = 60 / bpm;
    const t0 = this.ctx.currentTime + 0.04;
    const fly = this.bed === 'fly';
    const bass = fly ? [98, 0, 73.4, 0] : [73.4, 0, 65.4, 0];
    const pad = fly ? [196, 247, 294, 247] : [147, 175, 196, 175];
    for (let i = 0; i < 4; i += 1) {
      const t = t0 + i * stepSec;
      if (bass[i]) this.tone(this.musicBus, t, bass[i], 'sine', 0.05, 0.08, 0.35, 0.45);
      this.tone(this.musicBus, t, pad[i], 'sine', fly ? 0.028 : 0.022, 0.12, 0.4, 0.55);
      this.tone(this.musicBus, t + 0.02, pad[i] * 1.5, 'sine', fly ? 0.014 : 0.01, 0.16, 0.35, 0.6);
    }
    this.musicTimer = window.setTimeout(() => this.pumpMusic(), stepSec * 4 * 1000 - 50);
  }

  tone(bus, t, freq, type, peak, a, hold, rel) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(2400, freq * 6);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    env(g, t, peak, a, hold, rel);
    osc.connect(lp);
    lp.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + a + hold + rel + 0.05);
  }

  whoosh(t, peak, startHz, endHz, dur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(startHz, t);
    f.frequency.exponentialRampToValueAtTime(endHz, t + dur);
    const g = this.ctx.createGain();
    env(g, t, peak, 0.04, dur * 0.2, dur * 0.75);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  click() {
    this.unlock();
    if (!this.ctx) return;
    this.tone(this.sfxBus, this.ctx.currentTime, 880, 'sine', 0.04, 0.006, 0.02, 0.05);
  }

  catapult() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.whoosh(t, 0.22, 420, 180, 0.55);
    this.tone(this.sfxBus, t, 196, 'sine', 0.08, 0.04, 0.12, 0.35);
  }

  collect() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const det = 0.98 + Math.random() * 0.04;
    this.tone(this.sfxBus, t, 659 * det, 'sine', 0.09, 0.012, 0.05, 0.16);
    this.tone(this.sfxBus, t + 0.06, 880 * det, 'sine', 0.07, 0.014, 0.06, 0.2);
  }

  explode() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.whoosh(t, 0.28, 520, 90, 0.5);
    this.tone(this.sfxBus, t, 78, 'sine', 0.16, 0.02, 0.08, 0.38);
  }

  splash() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.whoosh(t, 0.24, 900, 160, 0.65);
    this.tone(this.sfxBus, t + 0.05, 220, 'sine', 0.07, 0.03, 0.06, 0.28);
    this.tone(this.sfxBus, t + 0.14, 146, 'sine', 0.05, 0.04, 0.08, 0.32);
  }

  land() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(this.sfxBus, t, 165, 'sine', 0.1, 0.01, 0.05, 0.16);
    this.tone(this.sfxBus, t + 0.07, 131, 'sine', 0.07, 0.012, 0.06, 0.18);
  }

  win() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [330, 392, 494, 659].forEach((f, i) => {
      this.tone(this.sfxBus, t + i * 0.13, f, 'sine', 0.09, 0.02, 0.1, 0.28);
    });
  }

  lose() {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [330, 277, 220].forEach((f, i) => {
      this.tone(this.sfxBus, t + i * 0.16, f, 'sine', 0.07, 0.03, 0.12, 0.32);
    });
  }
}

let shared = null;

export function getAudio() {
  if (!shared) shared = new GameAudio();
  return shared;
}
