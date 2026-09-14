/* =========================================================
   sound.js  -  소리

   파일을 받아오지 않고 그 자리에서 만들어 낸다(Web Audio).
   받을 것이 없으니 느려지지도, 끊기지도 않는다.

   브라우저는 사용자가 무언가를 누르기 전에는 소리를 막으므로
   버튼을 누를 때 resume() 을 불러 깨운다.
   ========================================================= */

const Sound = {
  ctx: null,
  master: null,
  on: true,
  _last: {},
  _noiseBuf: null,
  _noiseFor: null,

  /* 같은 소리가 몰아쳐 시끄러워지지 않게 최소 간격(ms)을 둔다 */
  GAP: {
    jump: 70, land: 90, out: 70, punch: 180, boom: 140, countdown: 120,
  },

  /* ---------- 준비 ---------- */
  /**
   * 소리가 지나는 길: 넣는 곳 -> 음량 -> 리미터 -> 스피커.
   * 여러 소리가 한꺼번에 터져도 리미터가 눌러 주므로 찌그러지지 않는다.
   */
  _chain(ctx) {
    const g = ctx.createGain();
    g.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    g.connect(comp);
    comp.connect(ctx.destination);
    return g;
  },

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this._chain(this.ctx);
    } catch (e) {
      this.ctx = null;
    }
  },

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  },

  load() {
    try {
      const v = localStorage.getItem('bbobki.sound');
      if (v !== null) this.on = v === '1';
    } catch (e) { /* 사생활 보호 모드 등 */ }
    return this.on;
  },

  setOn(v) {
    this.on = !!v;
    try { localStorage.setItem('bbobki.sound', this.on ? '1' : '0'); } catch (e) { /* 무시 */ }
    if (this.on) this.resume();
  },

  /* ---------- 재료 ---------- */
  _noise() {
    if (this._noiseFor !== this.ctx) {
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noiseBuf = buf;
      this._noiseFor = this.ctx;
    }
    return this._noiseBuf;
  },

  /** 음 하나 */
  tone({ type = 'sine', f0, f1, t = 0.15, gain = 0.1, at = 0 }) {
    const c = this.ctx, now = c.currentTime + at;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, now);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), now + t);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + Math.min(0.015, t * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, now + t);
    o.connect(g); g.connect(this.master);
    o.start(now); o.stop(now + t + 0.03);
  },

  /** 잡음 한 줌 (퍽, 쿵, 휙) */
  hiss({ t = 0.12, gain = 0.1, f0 = 1800, f1 = 200, type = 'lowpass', q = 1, at = 0 }) {
    const c = this.ctx, now = c.currentTime + at;
    const s = c.createBufferSource();
    s.buffer = this._noise();
    const bq = c.createBiquadFilter();
    bq.type = type; bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, now);
    bq.frequency.exponentialRampToValueAtTime(Math.max(40, f1), now + t);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t);
    s.connect(bq); bq.connect(g); g.connect(this.master);
    s.start(now); s.stop(now + t + 0.03);
  },

  /* ---------- 소리들 ---------- */
  VOICES: {
    countdown() { this.tone({ type: 'triangle', f0: 620, t: 0.13, gain: 0.8 }); },

    go() {
      this.tone({ type: 'triangle', f0: 880, t: 0.12, gain: 0.5 });
      this.tone({ type: 'triangle', f0: 1320, t: 0.3, gain: 0.5, at: 0.1 });
      this.hiss({ t: 0.3, gain: 0.22, f0: 400, f1: 4000, type: 'bandpass', q: 0.8 });
    },

    jump() { this.tone({ type: 'sine', f0: 370, f1: 900, t: 0.15, gain: 0.34 }); },

    land() { this.hiss({ t: 0.1, gain: 0.9, f0: 900, f1: 160 }); },

    punch() {
      this.hiss({ t: 0.14, gain: 0.95, f0: 2400, f1: 170 });
      this.tone({ type: 'sine', f0: 190, f1: 48, t: 0.19, gain: 0.8 });
    },

    boom() {
      this.tone({ type: 'sine', f0: 130, f1: 36, t: 0.32, gain: 0.72 });
      this.hiss({ t: 0.15, gain: 0.3, f0: 900, f1: 90 });
    },

    out() {
      this.tone({ type: 'square', f0: 430, f1: 105, t: 0.22, gain: 0.55 });
    },

    stage() {
      this.hiss({ t: 0.34, gain: 0.22, f0: 300, f1: 3600, type: 'bandpass', q: 0.7 });
      this.tone({ type: 'triangle', f0: 520, t: 0.13, gain: 0.34 });
      this.tone({ type: 'triangle', f0: 784, t: 0.22, gain: 0.34, at: 0.11 });
    },

    final() {
      this.tone({ type: 'sawtooth', f0: 70, f1: 290, t: 1.0, gain: 0.3 });
    },

    win() {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => {
        this.tone({ type: 'triangle', f0: f, t: i === 3 ? 0.75 : 0.2, gain: 0.5, at: i * 0.11 });
      });
      this.tone({ type: 'sine', f0: 1568, t: 0.55, gain: 0.24, at: 0.33 });
      this.hiss({ t: 0.6, gain: 0.16, f0: 2000, f1: 7000, type: 'bandpass', q: 0.6, at: 0.3 });
    },
  },

  /* ---------- 바깥에서 쓰는 것 ---------- */
  play(name) {
    if (!this.on) return;
    this.init();
    if (!this.ctx || this.ctx.state !== 'running') return;
    const gap = this.GAP[name];
    if (gap) {
      const now = performance.now();
      if (now - (this._last[name] || 0) < gap) return;
      this._last[name] = now;
    }
    const v = this.VOICES[name];
    if (v) { try { v.call(this); } catch (e) { /* 소리 때문에 게임이 멈추면 안 된다 */ } }
  },
};

window.Sound = Sound;
