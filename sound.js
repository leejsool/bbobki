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
    stomp: 160, lift: 160, throw: 160, thud: 160, growl: 700, gulp: 120, slurp: 200,
    mine: 150, blast: 110, chomp: 200, heart: 300, revive: 300, holy: 1500,
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
    this.preloadMusic();
    this.preloadFx('holy', 'holy.mp3');
  },

  /* ---------- 배경음 (bgm.mp3, 75초) ---------- */
  _bgm: null,        // 풀어 둔 소리
  _bgmLoading: false,
  _bgmSrc: null,
  _bgmGain: null,
  BGM_VOLUME: 0.4,   // 효과음이 묻히지 않게 낮춘다

  /** 레이스가 시작되기 전에 미리 받아 풀어 둔다 (처음 나올 때 끊기지 않게) */
  preloadMusic() {
    if (!this.ctx || this._bgm || this._bgmLoading) return;
    this._bgmLoading = true;
    fetch('bgm.mp3')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this._bgm = buf; })
      .catch(() => { /* 음원이 없거나 file:// 로 열었으면 조용히 건너뛴다 */ })
      .finally(() => { this._bgmLoading = false; });
  },

  /** 파일로 된 효과음을 미리 받아 풀어 둔다 (name -> 풀어 둔 소리) */
  _fx: {},
  _fxLoading: {},
  preloadFx(name, url) {
    if (!this.ctx || this._fx[name] || this._fxLoading[name]) return;
    this._fxLoading[name] = true;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this._fx[name] = buf; })
      .catch(() => { /* 파일이 없거나 file:// 로 열었으면 조용히 건너뛴다 */ })
      .finally(() => { this._fxLoading[name] = false; });
  },

  /** 풀어 둔 효과음 하나를 낸다 */
  playFx(name, gain = 1) {
    const buf = this._fx[name];
    if (!buf) return;
    const c = this.ctx, s = c.createBufferSource(), g = c.createGain();
    s.buffer = buf; g.gain.value = gain;
    s.connect(g); g.connect(this.master);
    s.start();
  },

  startMusic() {
    this.stopMusic();
    if (!this.on || !this.ctx || !this._bgm || this.ctx.state !== 'running') return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._bgm;
    const g = c.createGain();
    g.gain.value = this.BGM_VOLUME;
    src.connect(g); g.connect(c.destination);
    src.onended = () => { if (this._bgmSrc === src) this._bgmSrc = this._bgmGain = null; };
    src.start();
    this._bgmSrc = src;
    this._bgmGain = g;
  },

  /** 서서히 줄이며 끝낸다 */
  fadeMusic(sec = 2.5) {
    const src = this._bgmSrc, g = this._bgmGain;
    if (!src || !g) return;
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + sec);
    try { src.stop(now + sec + 0.05); } catch (e) { /* 이미 끝남 */ }
  },

  /** 바로 끈다 */
  stopMusic() {
    const src = this._bgmSrc;
    this._bgmSrc = this._bgmGain = null;
    if (src) { try { src.stop(); } catch (e) { /* 이미 끝남 */ } }
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
    if (this.on) this.resume(); else this.stopMusic();
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

    stomp() {
      this.tone({ type: 'sine', f0: 260, f1: 90, t: 0.14, gain: 0.8 });
      this.tone({ type: 'triangle', f0: 300, f1: 780, t: 0.22, gain: 0.4, at: 0.07 });
    },

    lift() { this.tone({ type: 'triangle', f0: 300, f1: 580, t: 0.22, gain: 0.4 }); },

    throw() {
      this.hiss({ t: 0.35, gain: 0.5, f0: 500, f1: 3200, type: 'bandpass', q: 0.9 });
      this.tone({ type: 'sine', f0: 200, f1: 520, t: 0.25, gain: 0.3 });
    },

    thud() {
      this.tone({ type: 'sine', f0: 150, f1: 45, t: 0.24, gain: 0.9 });
      this.hiss({ t: 0.12, gain: 0.5, f0: 800, f1: 120 });
    },

    boom() {
      this.tone({ type: 'sine', f0: 130, f1: 36, t: 0.32, gain: 0.72 });
      this.hiss({ t: 0.15, gain: 0.3, f0: 900, f1: 90 });
    },

    /* 지뢰가 드러났다: 삑, 삑, 삑삑삑 (점점 빨라진다. 터지기까지 0.9초쯤) */
    mine() {
      [0, 0.3, 0.52, 0.68, 0.79].forEach((at, i) => {
        this.tone({ type: 'square', f0: 1480 + i * 90, t: 0.06, gain: 0.26, at });
      });
    },

    /* 지뢰 폭발: 묵직한 쿵 + 흩어지는 파편 */
    blast() {
      this.tone({ type: 'sine', f0: 170, f1: 30, t: 0.5, gain: 1.0 });
      this.tone({ type: 'triangle', f0: 90, f1: 34, t: 0.36, gain: 0.5, at: 0.02 });
      this.hiss({ t: 0.42, gain: 0.95, f0: 3200, f1: 110 });
      this.hiss({ t: 0.7, gain: 0.22, f0: 700, f1: 60, at: 0.08 });
    },

    /* 괴물 으르렁: 낮게 떨리는 울림 */
    growl() {
      this.tone({ type: 'sawtooth', f0: 70, f1: 42, t: 0.9, gain: 0.55 });
      this.tone({ type: 'square', f0: 96, f1: 55, t: 0.8, gain: 0.22, at: 0.04 });
      this.tone({ type: 'sawtooth', f0: 74, f1: 46, t: 0.6, gain: 0.3, at: 0.2 });
      this.hiss({ t: 0.85, gain: 0.3, f0: 380, f1: 70, type: 'lowpass', q: 4 });
    },

    /* 꿀꺽: 삼키는 소리 */
    gulp() {
      this.tone({ type: 'sine', f0: 240, f1: 55, t: 0.22, gain: 0.9 });
      this.tone({ type: 'triangle', f0: 150, f1: 62, t: 0.2, gain: 0.5, at: 0.11 });
      this.hiss({ t: 0.14, gain: 0.5, f0: 700, f1: 110 });
    },

    /* 혀가 착 달라붙는 소리 */
    slurp() {
      this.hiss({ t: 0.16, gain: 0.5, f0: 3000, f1: 500, type: 'bandpass', q: 2 });
      this.tone({ type: 'sine', f0: 700, f1: 180, t: 0.2, gain: 0.34 });
    },

    /* 벽 일부가 튀어나와 덥석: 휙 + 딱 */
    chomp() {
      this.hiss({ t: 0.16, gain: 0.6, f0: 600, f1: 2600, type: 'bandpass', q: 1.2 });
      this.tone({ type: 'square', f0: 180, f1: 70, t: 0.12, gain: 0.5, at: 0.13 });
      this.hiss({ t: 0.06, gain: 0.8, f0: 3000, f1: 800, at: 0.14 });
    },

    /* 부활 하트를 먹었다: 반짝이는 하프 */
    heart() {
      [784, 988, 1175, 1568].forEach((f, i) => this.tone({ type: 'sine', f0: f, t: 0.35, gain: 0.28, at: i * 0.06 }));
      this.hiss({ t: 0.5, gain: 0.12, f0: 3000, f1: 8000, type: 'bandpass', q: 0.7 });
    },

    /* 천사가 나타났다: 성스러운 주문 소리 (holy.mp3) */
    holy() { this.playFx('holy', 0.8); },

    /* 천사가 아이를 내려놓았다: 맑은 화음 */
    revive() {
      for (const f of [523, 659, 784]) this.tone({ type: 'triangle', f0: f, t: 0.8, gain: 0.26 });
      this.tone({ type: 'sine', f0: 1047, f1: 1568, t: 0.6, gain: 0.2, at: 0.08 });
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
