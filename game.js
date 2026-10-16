/* =========================================================
   game.js  -  폴가이즈식 생존 레이스

   달리는 아이들이 회전바 / 해머 / 굴러오는 공 / 벽 틈을
   피하면서 전진한다. 부딪히면 그 자리에서 탈락.
   마지막 한 명이 남으면 끝.
   ========================================================= */

/* ---------- 작은 도구들 ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 점 (px,py) 에서 선분 (ax,ay)-(bx,by) 까지 거리 */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 괴물 혀가 닿는 범위(화면 폭 비율)와 끌어당기는 속도(화면 폭/초) */
const HUNT_RANGE = 0.58;
const REEL = 0.40;

/** 뛰어넘을 수 있는 '낮은' 장애물. 벽과 해머는 못 넘는다. */
const LOW = new Set(['spinner', 'ball', 'saw']);

/* ---------- 구간(스테이지) 구성 ---------- */
const STAGES = [
  { at: 0,     label: '출발!',            kinds: ['ball'] },
  { at: 2080,  label: '구간 2 · 회전바',   kinds: ['ball', 'spinner'] },
  { at: 4960,  label: '구간 3 · 해머 지대', kinds: ['spinner', 'hammer', 'ball'] },
  { at: 8400,  label: '구간 4 · 좁은 문',   kinds: ['wall', 'hammer', 'spinner'] },
  { at: 12400, label: '구간 5 · 난장판',    kinds: ['wall', 'hammer', 'spinner', 'ball', 'saw'] },
];

/** 이름에서 생김새를 정한다 - 같은 학생은 늘 같은 모습으로 나온다 */
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
const EARS = ['none', 'dog', 'cat', 'fox', 'panda'];
const MOUTHS = ['none', 'smile', 'open'];
function looksOf(name) {
  const h = hash32(name);
  return {
    ears: EARS[h % EARS.length],
    tail: ((h >>> 3) % 3) === 0,
    tailStripes: ((h >>> 21) % 2) === 0,   // 꼬리가 있는 아이 중 절반은 줄무늬
    spots: ((h >>> 7) % 4) === 0,
    mouth: MOUTHS[(h >>> 11) % MOUTHS.length],
    wink: ((h >>> 17) % 4) === 0,
  };
}

/* ---------- 우승 세레모니 (춤) ----------
   우승하면 아래 춤 가운데 하나를 무작위로 골라 춘다.
   자세 필드 (길이 단위는 캐릭터 반지름)
     h 높이, dx 옆으로 움직인 거리, rot 회전(rad), flipX 좌우 뒤집기(1~-1, 도는 느낌),
     sq 납작, hop 통통, arms 팔 모양, aw 팔 올림 정도(0~1), st 로봇 동작 번호,
     legSw / legAmp+legPh 다리 벌림(없으면 달리기 다리) */
const TAU = Math.PI * 2;
const squashAt = (fr) => 0.45 * Math.max(0, 1 - Math.min(fr, 1 - fr) * 9);   // 뛰기 직전·착지 순간

/* 막춤의 재료: 모든 동작은 땅에서 시작해 땅에서 끝나므로 이어 붙여도 튀지 않는다 */
const CEREMONY = {
  cheer:     { dur: 1.7, f(k, p) { const fr = (k * 3) % 1; p.h = 2.7 * Math.sin(Math.PI * fr); p.sq = squashAt(fr); p.arms = 'up'; } },
  flip:      { dur: 1.2, f(k, p) { p.h = 3.6 * Math.sin(Math.PI * k); p.rot = -TAU * k; p.sq = squashAt(k); } },
  dance:     { dur: 1.9, f(k, p) { const s = Math.sin(k * TAU * 4); p.rot = 0.3 * s; p.hop = 0.5 * Math.abs(s); p.arms = 'pump'; p.bobSpeed = 12; } },
  twirl:     { dur: 1.3, f(k, p) { p.h = 2.3 * Math.sin(Math.PI * k); p.flipX = Math.cos(TAU * 2 * k); p.arms = 'out'; p.sq = squashAt(k); } },
  zoom:      { dur: 1.8, f(k, p) { const ph = k * TAU * 2; p.dx = 1.4 * Math.sin(ph); p.flipX = clamp(Math.cos(ph) * 5, -1, 1); p.hop = 0.55 * Math.abs(Math.sin(k * TAU * 8)); p.arms = 'pump'; p.bobSpeed = 20; } },
  cartwheel: { dur: 1.4, f(k, p) { p.h = 2.1 * Math.sin(Math.PI * k); p.rot = TAU * k; p.dx = 1.2 * Math.sin(Math.PI * k); p.arms = 'out'; p.sq = squashAt(k); } },
  bigjump:   { dur: 1.4, f(k, p) { p.h = 3.9 * Math.sin(Math.PI * k); p.arms = 'up'; p.sq = squashAt(k); } },
};

/* 춤마다 박자에 맞춰 자세를 만든다. t 는 춤을 시작하고 흐른 시간(초) */
const DANCES = {
  // 막춤: 위의 동작을 매번 섞어서 이어 붙인다 (Ceremony 가 따로 처리)
  freestyle: { name: '막춤' },

  // 문워크: 앞을 보고 미끄러지듯 뒤로 간다. 끝에서 휙 돌아 반대쪽으로 또 뒤로.
  moonwalk: {
    name: '문워크',
    f(t, p) {
      const u = t % 4.4, ph = t * 9;
      p.arms = 'moon'; p.rot = -0.1; p.hop = 0.14 * Math.abs(Math.sin(ph));
      p.legAmp = 0.45; p.legPh = ph;
      if (u < 1.9) {                                        // 오른쪽을 보고 왼쪽으로 스르르
        p.dx = 1.4 * Math.cos((Math.PI * u) / 1.9);
      } else if (u < 2.2) {                                 // 휙 돈다
        const k = (u - 1.9) / 0.3;
        p.dx = -1.4; p.flipX = Math.cos(Math.PI * k); p.h = 0.9 * Math.sin(Math.PI * k); p.arms = 'up';
      } else if (u < 4.1) {                                 // 왼쪽을 보고 오른쪽으로 스르르
        p.dx = -1.4 * Math.cos((Math.PI * (u - 2.2)) / 1.9); p.flipX = -1;
      } else {
        const k = (u - 4.1) / 0.3;
        p.dx = 1.4; p.flipX = -Math.cos(Math.PI * k); p.h = 0.9 * Math.sin(Math.PI * k); p.arms = 'up';
      }
    },
  },

  // 삐끼삐끼: 무릎을 튕기며 한 팔은 번쩍, 한 팔은 허리에. 박자마다 바꾼다.
  pikipiki: {
    name: '삐끼삐끼',
    f(t, p) {
      const b = t * Math.PI * 6, s = Math.sin(b / 2);
      p.arms = 'kiki'; p.aw = clamp(s * 3, -1, 1) * 0.5 + 0.5;
      p.hop = 0.42 * Math.abs(Math.sin(b)); p.sq = 0.12 * (1 - Math.abs(Math.sin(b)));
      p.rot = 0.13 * s; p.dx = 0.45 * s; p.bobSpeed = 16;
    },
  },

  // 말춤: 한 손은 머리 위에서 올가미를 돌리고, 다리를 크게 벌려 달리듯 통통.
  horse: {
    name: '말춤',
    f(t, p) {
      const b = t * Math.PI * 4;
      p.arms = 'lasso'; p.hop = 0.5 * Math.abs(Math.sin(b)); p.rot = 0.09 * Math.sin(b);
      p.dx = 0.7 * Math.sin(b / 2); p.sq = 0.1 * Math.abs(Math.cos(b));
      p.legAmp = 1.0; p.legPh = b;
    },
  },

  // 로봇춤: 뚝뚝 끊어서 움직인다.
  robot: {
    name: '로봇춤',
    f(t, p) {
      const st = Math.floor(t * 4);
      p.st = st; p.arms = 'robot';
      p.rot = [0.16, -0.16, 0, 0.1][st % 4];
      p.dx = [-0.8, 0.8, 0, 0.5][st % 4];
      p.legSw = (st % 2 ? 1 : -1) * 0.45;
    },
  },

  // 디스코: 한 팔은 하늘로, 한 팔은 땅으로. 어깨를 흔들며 번갈아.
  disco: {
    name: '디스코',
    f(t, p) {
      const b = t * Math.PI * 2.4, s = Math.sin(b);
      p.arms = 'disco'; p.aw = clamp(s * 3, -1, 1) * 0.5 + 0.5;
      p.rot = 0.14 * s; p.hop = 0.22 * Math.abs(Math.cos(b)); p.dx = 0.3 * s;
      p.legAmp = 0.5; p.legPh = b * 2;
    },
  },
};

/** 춤 팔 모양 -> [팔꿈치x, 팔꿈치y, 손x, 손y]. 팔꿈치가 null 이면 곧게 뻗은 팔. 어깨는 몸 옆. */
function celHands(c, sd, r, sx, y) {
  const p = c.ph + (sd > 0 ? 0 : Math.PI);
  const shx = sx + sd * r * 0.75, shy = y + r * 0.1;
  switch (c.arms) {
    case 'up':
      return [null, null, sx + sd * r * (0.95 + 0.18 * Math.sin(p)), y - r * (1.45 + 0.3 * Math.sin(p * 2))];
    case 'pump':
      return [null, null, sx + sd * r * 1.05, y + r * (0.15 - 0.95 * Math.sin(p))];
    case 'out':
      return [null, null, sx + sd * r * 1.75, y - r * 0.1 + Math.sin(p) * r * 0.2];
    case 'moon':      // 한 손은 모자챙을 잡고, 한 손은 아래로 흔든다
      return sd > 0
        ? [sx + r * 1.15, y - r * 0.45, sx + r * 0.4, y - r * 1.3]
        : [sx - r * 1.0, y + r * 0.55, sx - r * 0.85 + Math.sin(c.ph * 0.6) * r * 0.3, y + r * 0.95];
    case 'kiki': {    // 번쩍 든 팔(곧게) <-> 허리에 짚은 팔(꺾어서)
      const w = sd > 0 ? c.aw : 1 - c.aw;
      return [
        lerp(sx + sd * r * 1.3, sx + sd * r * 1.05, w), lerp(y + r * 0.2, y - r * 0.7, w),
        lerp(sx + sd * r * 0.55, sx + sd * r * 1.35, w), lerp(y + r * 0.45, y - r * 1.55, w),
      ];
    }
    case 'lasso':     // 오른손은 머리 위에서 올가미를 돌리고, 왼손은 고삐를 쥔다
      if (sd > 0) {
        const a = c.ph * 1.1;
        return [sx + r * 1.0, y - r * 0.7, sx + r * 0.5 + Math.cos(a) * r * 0.85, y - r * 1.7 + Math.sin(a) * r * 0.4];
      }
      return [sx - r * 1.25, y + r * 0.4, sx - r * 1.05, y - r * 0.15 + Math.sin(c.ph * 2) * r * 0.15];
    case 'robot': {   // 직각으로 꺾인 팔
      const a1 = (((c.st + (sd > 0 ? 0 : 2)) % 4) * Math.PI) / 2;
      const a2 = (((c.st * 3 + (sd > 0 ? 1 : 3)) % 4) * Math.PI) / 2;
      const ex = shx + Math.cos(a1) * r * 0.75, ey = shy + Math.sin(a1) * r * 0.75;
      return [ex, ey, ex + Math.cos(a2) * r * 0.7, ey + Math.sin(a2) * r * 0.7];
    }
    case 'disco': {   // 한 팔은 하늘, 반대 팔은 땅
      const w = sd > 0 ? c.aw : 1 - c.aw;
      return [
        lerp(sx + sd * r * 0.95, sx + sd * r * 1.0, w), lerp(y + r * 0.55, y - r * 0.75, w),
        lerp(sx + sd * r * 1.15, sx + sd * r * 1.3, w), lerp(y + r * 1.1, y - r * 1.8, w),
      ];
    }
  }
  return [null, null, shx, shy];
}

class Ceremony {
  /** key: 춤 이름(생략하면 무작위) */
  constructor(key) {
    const keys = Object.keys(DANCES);
    this.key = DANCES[key] ? key : keys[(Math.random() * keys.length) | 0];
    this.name = DANCES[this.key].name;
    if (this.key === 'freestyle') {
      // 막춤: 첫 동작은 만세 점프, 나머지는 매번 섞어서
      const rest = Object.keys(CEREMONY).filter((n) => n !== 'cheer');
      for (let i = rest.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      this.order = ['cheer', ...rest];
      this.total = this.order.reduce((sum, n) => sum + CEREMONY[n].dur, 0);
    }
    this.p = {};
  }

  /** t초째의 자세. 같은 객체를 다시 채워 돌려준다 */
  pose(t) {
    const p = this.p;
    p.h = 0; p.rot = 0; p.flipX = 1; p.sq = 0; p.dx = 0; p.hop = 0; p.arms = ''; p.bobSpeed = 9;
    p.aw = 0; p.st = 0; p.legSw = undefined; p.legAmp = undefined; p.legPh = 0;
    p.ph = t * 14;                                      // 팔 흔드는 박자
    if (this.key === 'freestyle') {
      let u = t % this.total, m = CEREMONY[this.order[0]];
      for (const n of this.order) {
        if (u < CEREMONY[n].dur) { m = CEREMONY[n]; break; }
        u -= CEREMONY[n].dur;
      }
      m.f(u / m.dur, p);
    } else {
      DANCES[this.key].f(t, p);
      const ramp = clamp(t / 0.5, 0, 1);                // 춤은 제자리에서 서서히 커진다
      p.dx *= ramp; p.h *= ramp; p.rot *= ramp; p.hop *= ramp;
    }
    return p;
  }
}

class RaceGame {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.raf = 0;
    this.running = false;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  /* ===== 준비 ===== */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.cv.clientWidth || window.innerWidth;
    const h = this.cv.clientHeight || window.innerHeight;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const oldTop = this.top, oldH = this.trackH;
    this.W = w;
    this.H = h;
    this.top = Math.min(96, h * 0.16);
    this.bot = h - Math.min(40, h * 0.07);
    this.trackH = this.bot - this.top;

    // 화면이 바뀌면(창 크기, 태블릿 회전) 달리던 판을 새 트랙에 맞춰 옮긴다
    if (oldH && this.runners) this.rescale(oldTop, oldH);
  }

  /** 트랙 높이가 달라졌을 때 세로 좌표를 비율대로 옮긴다 */
  rescale(oldTop, oldH) {
    const k = this.trackH / oldH;
    const map = (y) => this.top + (y - oldTop) * k;
    this.r = clamp(Math.min(this.trackH / 13, this.W / 40), 10, 30);
    for (const R of this.runners) {
      R.y = map(R.y); R.targetY = map(R.targetY); R.vy *= k;
      if (R.flight) { R.flight.sy = map(R.flight.sy); R.flight.ey = map(R.flight.ey); }
    }
    for (const o of this.obstacles) {
      if (o.y !== undefined) o.y = map(o.y);
      if (o.y0 !== undefined) o.y0 = map(o.y0);
      if (o.gapY !== undefined) o.gapY = map(o.gapY);
      for (const key of ['amp', 'len', 'rad', 'thick', 'gapH']) {
        if (o[key] !== undefined) o[key] *= k;
      }
      if (o.kind === 'wall') o.w *= k;      // 벽은 w 가 두께 (다른 건 회전 속도)
      if (o.vy !== undefined) o.vy *= k;
    }
  }

  start(members, label) {
    this.stop();
    this.runners = null;      // 이전 판이 새 트랙으로 끌려오지 않게
    this.resize();

    this.label = label || '';
    this.dist = 0;
    this.camX = -this.W * 0.25;
    this.time = 0;
    this.stageIdx = -1;
    this.lastElimAt = 0;
    this.finishedAt = 0;
    this.winner = null;
    this._told = false;        // 이걸 안 지우면 두 번째 판이 끝나지 않는다
    this.particles = [];
    this.rings = [];
    this.pows = [];                        // 타격 표시 (뾰족한 별 모양)
    this.later = [];                       // 조금 뒤에 실행할 일 (주먹이 쓸고 지나가는 순서대로 맞게)
    this.shake = 0;                        // 화면 흔들림 남은 시간
    this.shakeAmp = 0;
    this.obstacles = [];
    this.dropCd = rnd(3, 6);
    this.frontier = 620;
    this.order = [];                       // 탈락 역순 = 순위
    this.raceT = 0;                        // 출발하고 흐른 시간
    // 왼쪽 끝에서 다가오는 괴물. f 는 화면 폭에 대한 앞니(앞쪽 끝)의 위치 비율이라 창 크기가 바뀌어도 그대로다.
    this.maw = {
      state: 'sleep',                      // sleep -> creep <-> warn -> snap / hunt
      f: -0.09, t: 0, cd: 0, hcd: 0, hold: 0,
      kind: '', prey: null, rage: 0, look: this.top + this.trackH / 2,
      baseF: 0.03, peakF: 0.2, alarmX: -Infinity,
      tongue: 0, attached: false,          // 혀가 뻗은 정도 0~1 / 먹잇감을 붙잡았나
    };
    this.mawX = this.camX + this.maw.f * this.W;

    const n = members.length;
    this.r = clamp(Math.min(this.trackH / 13, this.W / 40), 10, 30);

    // 출발선에 세로로 줄 세우기.
    // 자리마다 유불리가 있으므로 번호순이 아니라 매번 섞어서 세운다.
    const cols = Math.ceil(n / 8);
    const per = Math.ceil(n / cols);
    const slots = members.map((_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    this.runners = members.map((m, i) => {
      const slot = slots[i];
      const col = Math.floor(slot / per);
      const inCol = slot % per;
      return {
        seq: i,                            // 이름표 자리 다툼을 푸는 고정 순서
        no: m.no,
        name: m.name,
        look: looksOf(m.name),
        x: -col * this.r * 3.2,
        y: this.top + this.trackH * ((inCol + 0.5) / per),
        vy: 0,
        alive: true,
        hue: (i * 360) / n + rnd(-8, 8),
        speed: rnd(0.93, 1.09),            // 타고난 발 빠르기
        skill: rnd(0.74, 1),               // 장애물 감지 능력
        bob: rnd(0, Math.PI * 2),
        targetY: 0,
        think: rnd(0, 0.2),
        stun: 0,
        dash: 0, dashCd: rnd(0.6, 3),      // 치고 나가기
        jump: 0, jumpT: 0.5, jumpCd: 0,    // 뛰어넘기
        nerve: rnd(0.55, 1),               // 점프를 시도하는 배짱
        punch: 0, punchT: 0.4,             // 주먹 휘두르기
        punchCd: rnd(1.5, 5), punchHit: false,
        kx: 0, ky: 0,                      // 주먹에 맞아 밀려나는 힘
        hurt: 0,                           // 맞은 직후 번쩍이는 시간
        dizzy: 0, squash: 0, spin: 0,      // 기절 / 밟혀 납작 / 날아가며 도는 각도
        jumpPow: 1,                        // 점프 높이 배율 (밟고 뛰면 커진다)
        stomp: null,                       // 밟으러 내려앉는 중 { b, t, T }
        carry: null, liftT: 0, liftDur: 0, // 들고 있는 아이
        heldBy: null, flight: null,        // 들려 있다 / 던져져 날아가는 중
        actCd: rnd(8, 20),                 // 밟기·던지기 쿨다운
        fear: 0, cause: '', eaten: false,  // 괴물이 가까울수록 커지는 두려움 / 탈락 이유
      };
    });
    this.runners.forEach((r) => { r.targetY = r.y; });
    this.alive = n;

    this.phase = 'countdown';
    this.cd = 3.6;
    this.running = true;
    this.last = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
  }

  /* ===== 메인 루프 ===== */
  loop() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 1 / 24);
    this.last = now;
    this.update(dt);
    this.draw();
  }

  update(dt) {
    this.time += dt;
    this._dt = dt;

    if (this.phase === 'countdown') {
      const before = Math.ceil(this.cd);
      this.cd -= dt;
      const after = Math.ceil(this.cd);
      if (after !== before && this.opts.onCountdown) {
        this.opts.onCountdown(after > 0 ? String(after) : '출발!');
      }
      if (this.cd <= -0.45) {
        this.phase = 'race';
        if (this.opts.onCountdown) this.opts.onCountdown(null);
      }
      this.stepParticles(dt);
      return;
    }

    if (this.phase === 'done') {
      // 우승자가 제자리에서 세레모니 (만세 점프, 덤블링, 춤...)
      const Wn = this.winner;
      if (Wn) {
        this.celT += dt;
        Wn.cel = this.ceremony.pose(this.celT);
        Wn.bob += dt * Wn.cel.bobSpeed;
        Wn.y = lerp(Wn.y, this.top + this.trackH * 0.58, 1 - Math.pow(0.02, dt));   // 트랙 한가운데로
      }
      this.camX = lerp(this.camX, (Wn ? Wn.x : 0) - this.W * 0.5, 1 - Math.pow(0.001, dt));
      this.maw.f -= 0.4 * dt;                              // 괴물은 슬그머니 물러난다
      this.maw.rage *= Math.pow(0.05, dt);
      this.mawX = this.camX + this.maw.f * this.W;
      this.stepParticles(dt);
      if (this.time - this.finishedAt > 2.4 && !this._told) {
        this._told = true;
        if (this.opts.onWin) this.opts.onWin(this.winner, this.order);
      }
      return;
    }

    /* --- 난이도: 거리 + 안 죽고 버틴 시간 --- */
    const stall = clamp((this.time - this.lastElimAt - 4) / 10, 0, 1);
    const diff = clamp(this.dist / 14000, 0, 1);
    const heat = clamp(diff * 0.75 + stall * 0.6 + (this.alive <= 4 ? 0.45 : 0), 0, 1.35);

    this.raceT += dt;
    this.announceStage();
    this.spawnAhead(heat);
    this.updateMaw(dt, heat);

    /* --- 무리의 선두와 꼬리 --- */
    let leadX = -Infinity, tailX = Infinity;
    for (const R of this.runners) {
      if (!R.alive) continue;
      if (R.x > leadX) leadX = R.x;
      if (R.x < tailX) tailX = R.x;
    }

    /* --- 하늘에서 뚝 떨어지는 공: 무리 한복판을 노린다 --- */
    if (this.stageIdx >= 1 && leadX > -Infinity) {
      this.dropCd -= dt;
      if (this.dropCd <= 0) {
        const many = 1 + (Math.random() < heat * 0.9 ? 1 : 0);
        for (let i = 0; i < many; i++) {
          const rad = this.r * rnd(1.3, 2.3);
          this.obstacles.push({
            kind: 'drop',
            x: rnd(tailX - 40, leadX + 320),
            y: rnd(this.top + rad, this.bot - rad),
            rad, hue: rnd(18, 46),
            t: 0, warn: rnd(0.45, 0.8), fall: 0.28, live: 0.5, landed: false,
          });
        }
        this.dropCd = rnd(1.7, 3.4) / (0.65 + heat);
      }
    }

    /* --- 장애물 움직임 (꼬리가 지나갈 때까지 남겨 둔다) --- */
    for (const o of this.obstacles) this.moveObstacle(o, dt, heat);
    const cullX = Math.min(this.camX, tailX) - 400;
    this.obstacles = this.obstacles.filter((o) =>
      o.x > cullX && !(o.kind === 'drop' && o.t > o.warn + o.fall + o.live));

    /* --- 달리기 --- */
    const baseSpeed = 250 + 70 * diff;
    const band = this.W * 0.40;      // 무리가 벌어질 수 있는 폭
    const hitNow = [];

    for (const R of this.runners) {
      if (!R.alive) continue;

      // 들려 있거나 날아가는 동안은 스스로 움직이지 못한다 (장애물에도 안 맞는다)
      if (R.heldBy) { R.fear = 0; continue; }
      if (R.flight) { R.fear = 0; this.stepFlight(R, dt); continue; }

      const lagRatio = clamp((leadX - R.x) / band, 0, 1);

      // 기절: 비틀비틀 걷는다
      const dizzy = R.dizzy > 0;
      if (dizzy) {
        R.dizzy -= dt;
        R.y += Math.sin(this.time * 7 + R.bob) * 22 * dt;
      }
      if (R.squash > 0) R.squash -= dt;

      /* 괴물: 가까울수록 겁에 질리고 끌려간다. 멀쩡하면 놀라서 대쉬로 도망친다 */
      let pull = 0;
      const maw = this.maw;
      if (maw.state === 'sleep') {
        R.fear = 0;
      } else {
        const zone = this.r * (maw.state === 'creep' ? 4.5 : 8);
        R.fear = clamp(1 - (R.x - this.mawX) / zone, 0, 1);
        pull = R.fear * (dizzy ? 300 : 130);            // 기절하면 버티지 못하고 쑥쑥 끌려간다
        if (maw.attached && maw.prey === R) pull = Math.max(pull, this.W * REEL);   // 혀에 감겨 끌려온다
        if (R.x < maw.alarmX && !dizzy && !R.carry) R.dash = Math.max(R.dash, 0.5);
        if (R.fear > 0.5 && Math.random() < dt * 9) {   // 식은땀
          this.particles.push({
            x: R.x + rnd(-this.r, this.r), y: R.y - this.heightOf(R) - this.r * 0.9,
            vx: rnd(-60, 20), vy: rnd(-120, -50),
            life: 0.32, age: 0, hue: 200, r: rnd(2, 3.2), light: 84,
          });
        }
      }

      /* 점프: 낮은 장애물이 코앞이면 배짱껏 뛰어넘는다 */
      if (R.jump > 0) {
        R.jump -= dt;
        if (R.jump <= 0) {
          R.jump = 0;
          const big = R.jumpPow > 1;                      // 밟고 뛴 큰 점프의 착지
          this.puff(R, big ? 1.4 : 0.8);
          this.sfx('land');
          R.jumpPow = 1;
        }
      } else {
        if (R.jumpCd > 0) R.jumpCd -= dt;
        if (R.jumpCd <= 0 && !dizzy && !R.carry && !R.stomp) {
          const threat = this.threat(R);
          if (threat && LOW.has(threat)) {
            if (Math.random() < R.nerve) {
              R.jumpT = rnd(0.55, 0.72);
              R.jumpPow = 1;
              R.jump = R.jumpT;
              R.jumpCd = rnd(0.55, 1.05);
              this.puff(R, 1);                                // 도약 먼지 + 링
              this.sfx('jump');
            } else {
              R.jumpCd = 0.35;              // 머뭇거렸다
            }
          }
        }
      }

      /* 주먹: 너무 뭉치면 한 명이 휘둘러 주변을 흩뿌린다 */
      if (R.punch > 0) {
        R.punch -= dt;
        if (!R.punchHit && R.punch <= R.punchT * 0.8) { R.punchHit = true; this.shove(R); }
      } else if (R.jump <= 0 && !dizzy && !R.carry && !R.stomp) {
        R.punchCd -= dt;
        if (R.punchCd <= 0) {
          let near = 0;
          for (const O of this.runners) {
            if (O === R || !O.alive) continue;
            if (Math.abs(O.x - R.x) < this.r * 3 && Math.abs(O.y - R.y) < this.r * 3) near++;
          }
          if (near >= 3 && Math.random() < (0.02 + near * 0.015) * dt) {
            R.punchT = rnd(0.34, 0.46);
            R.punch = R.punchT;
            R.punchHit = false;
            R.punchCd = rnd(6, 12);
          }
        }
      }

      /* 밟기 / 들어서 던지기 */
      this.stepActions(R, dt, dizzy);

      /* 대쉬: 뒤처져 있을수록 자주 터진다 */
      if (R.dash > 0) {
        R.dash -= dt;
      } else if (!dizzy && !R.carry) {
        R.dashCd -= dt;
        if (R.dashCd <= 0) {
          const chance = (0.25 + lagRatio * 2.6) * dt;
          if (Math.random() < chance) {
            R.dash = rnd(0.45, 0.9);
            R.dashCd = rnd(1.8, 4.2);
            this.trail(R);
          }
        }
      }

      if (!dizzy) {                                       // 기절하면 생각을 못 한다
        R.think -= dt;
        if (R.think <= 0) {
          R.think = rnd(0.05, 0.12);
          R.targetY = this.chooseY(R, baseSpeed);
        }
      }

      // 세로 이동 (공중에서는 방향을 못 바꾼다)
      const dy = R.targetY - R.y;
      const agility = (360 + 280 * R.skill) * (R.jump > 0 ? 0.25 : 1) * (dizzy ? 0.25 : 1) * (R.carry ? 0.6 : 1);
      R.vy = lerp(R.vy, clamp(dy * 5, -agility, agility), 1 - Math.pow(0.002, dt));
      R.y = clamp(R.y + R.vy * dt, this.top + this.r, this.bot - this.r);

      // 앞으로. 뒤처질수록 빨라지고 앞서면 조금 느려져서
      // 무리가 한 화면에 머문다 -> 모두가 같은 장애물을 만난다.
      if (R.stun > 0) R.stun -= dt;
      const sp = baseSpeed * R.speed
        * (0.80 + lagRatio * 0.44)
        * (R.dash > 0 ? 1.85 : 1)
        * (R.stun > 0 ? 0.35 : 1)
        * (dizzy ? 0.4 : 1)                       // 비틀거린다
        * (R.carry ? 0.6 : 1);                    // 들고 있으면 느리다
      R.x += (sp - pull) * dt;
      R.bob += dt * (7 + sp * 0.02);
      if (R.dash > 0 && Math.random() < 0.5) this.trail(R);

      // 주먹에 맞아 밀려나는 힘 (AI 조종과 별개로 더해진다)
      if (R.kx || R.ky) {
        R.x += R.kx * dt;
        R.y = clamp(R.y + R.ky * dt, this.top + this.r, this.bot - this.r);
        const damp = Math.pow(0.015, dt);
        R.kx *= damp; R.ky *= damp;
        if (Math.abs(R.kx) < 2) R.kx = 0;
        if (Math.abs(R.ky) < 2) R.ky = 0;
        if (R.hurt > 0 && Math.random() < 0.7) this.flyTrail(R);
      }
      if (R.hurt > 0) R.hurt -= dt;

      // 들고 있는 아이는 머리 위에 얹혀 따라온다
      if (R.carry) { R.carry.x = R.x - this.r * 0.9 * this.windup(R); R.carry.y = R.y; }

      // 괴물 입에 닿으면 꿀꺽
      if (maw.state !== 'sleep' && R.x - this.mawX < this.r * 0.5) {
        R.cause = 'maw';
        hitNow.push(R);
        continue;
      }

      // 충돌 (공중이면 낮은 장애물은 넘어간다. 벽과 해머는 못 넘는다)
      for (const o of this.obstacles) {
        if (Math.abs(o.x - R.x) > 260) continue;
        if ((R.jump > 0 || (R.stomp && R.stomp.t >= R.stomp.T1)) && LOW.has(o.kind)) continue;
        if (this.hits(o, R)) { hitNow.push(R); break; }
      }
    }

    /* --- 밟고 있는 동안은 밟힌 아이 머리 위에 얹혀 간다 --- */
    for (const R of this.runners) {
      if (R.alive && R.stomp && R.stomp.t >= R.stomp.T1) { R.x = R.stomp.b.x; R.y = R.stomp.b.y; }
    }

    /* --- 탈락 처리 (마지막 한 명은 지켜준다) --- */
    if (hitNow.length) {
      let victims = hitNow;
      const survivors = this.alive - hitNow.length;
      if (survivors < 1) {
        // 동시에 다 맞으면 한 명은 운 좋게 살아남는다
        const lucky = pick(victims);
        victims = victims.filter((v) => v !== lucky);
      }
      for (const v of victims) this.eliminate(v);
    }

    /* --- 카메라: 무리 전체가 보이도록 선두를 화면 오른쪽에 둔다 --- */
    let nowLead = -Infinity;
    for (const R of this.runners) if (R.alive && R.x > nowLead) nowLead = R.x;
    this.dist = Math.max(this.dist, nowLead);
    const want = nowLead - this.W * 0.58;
    this.camX = lerp(this.camX, want, 1 - Math.pow(0.0015, dt));

    this.stepParticles(dt);

    /* --- 끝 --- */
    if (this.alive <= 1 && this.phase === 'race') {
      this.winner = this.runners.find((r) => r.alive) || null;
      for (const R of this.runners) {                     // 공중에 멈춘 채 끝나지 않게
        R.carry = R.heldBy = R.flight = R.stomp = null;
        R.dizzy = R.squash = R.spin = R.fear = 0;
      }
      if (this.winner) {
        const Wn = this.winner;
        Wn.dash = 0; Wn.jump = 0; Wn.punch = 0; Wn.hurt = 0; Wn.kx = Wn.ky = 0;
        // 우승자 주변에 멈춰 있는 장애물은 치워서 세레모니를 가리지 않게 한다
        this.obstacles = this.obstacles.filter((o) => Math.abs(o.x - Wn.x) > this.W * 0.9);
      }
      this.ceremony = new Ceremony();
      this.celT = 0;
      if (this.winner) { this.winner.dance = this.ceremony.key; }
      this.phase = 'done';
      this.finishedAt = this.time;
      if (this.winner) this.order.unshift(this.winner);
      this.burst(this.winner ? this.winner.x : this.dist, this.winner ? this.winner.y : this.H / 2, 46, 50);
      if (this.opts.onStage) this.opts.onStage('생존!');
    }
  }

  eliminate(R) {
    if (R.carry) this.release(R);                         // 들고 있던 아이를 떨어뜨린다
    R.stomp = null;
    R.alive = false;
    R.deadAt = this.time;
    this.alive--;
    this.lastElimAt = this.time;
    this.order.unshift(R);
    if (R.cause === 'maw') {
      // 꿀꺽: 괴물 쪽으로 빨려 들어가며 작아진다 (그리는 쪽에서 처리)
      R.eaten = true;
      this.sfx('gulp');
      this.burst(R.x, R.y, 285, 14);
      this.pows.push({ x: this.mawX + this.r * 1.6, y: R.y - this.r * 1.2, age: 0, life: 0.5, size: this.r * 1.4, spikes: 9, text: '꿀꺽!', ang: rnd(0, 6.28), hue: 285 });
      this.shakeScreen(0.22, this.r * 0.35);
    } else {
      this.burst(R.x, R.y, R.hue, 16);
    }
    if (this.alive === 3) this.sfx('final');      // 셋 남으면 긴장감
    if (this.opts.onEliminate) this.opts.onEliminate(R, this.alive, R.cause);
  }

  /* ===== 괴물 ===== */

  /** 혀가 낚아챌 수 있는 먹잇감인가: 기절해서 도망치지 못하는 아이 */
  isPrey(R) {
    return R.alive && R.dizzy > 0.3 && !R.heldBy && !R.flight && !R.carry
      && (R.x - this.camX) / this.W < HUNT_RANGE;
  }

  /** 괴물이 노릴 먹잇감: 기절한 아이 중 괴물에 가장 가까운 아이 */
  findPrey() {
    let best = null;
    for (const R of this.runners) {
      if (this.isPrey(R) && (!best || R.x < best.x)) best = R;
    }
    return best;
  }

  /**
   * 화면 왼쪽 끝에서 다가오는 괴물 (꿀꺽이).
   *  - 평소에는 왼쪽 가장자리에 이빨만 내밀고 슬금슬금 압박한다.
   *  - 가끔 으르렁(경고)하며 웅크렸다가 왼쪽 무리를 훑는다 -> 멀쩡한 아이는 놀라 대쉬로 도망친다.
   *  - 누가 기절하면 그 아이를 노리고 달려든다 -> 기절한 아이는 도망치지 못한다.
   * 앞니보다 왼쪽(뒤)에 있는 아이는 탈락.
   */
  updateMaw(dt, heat) {
    const m = this.maw, W = this.W, r = this.r;
    const h1 = clamp(heat, 0, 1);
    m.t += dt;
    m.baseF = 0.025 + 0.04 * h1;
    m.peakF = 0.17 + 0.06 * h1;
    m.alarmX = -Infinity;
    let target = m.baseF, advance = 0.5, retreat = 0.22;

    switch (m.state) {
      case 'sleep':
        target = -0.09;
        if (this.raceT >= 4) {
          m.state = 'creep'; m.t = 0; m.cd = rnd(7, 10); m.hcd = 0;
          this.sfx('growl');
          this.shakeScreen(0.6, r * 0.12);
          if (this.opts.onMaw) this.opts.onMaw('wake');
        }
        break;

      case 'creep': {
        m.hcd -= dt; m.cd -= dt;
        const prey = m.hcd <= 0 ? this.findPrey() : null;
        if (prey) this.mawWarn('hunt', prey);
        else if (m.cd <= 0) this.mawWarn('snap', null);
        break;
      }

      case 'warn': {
        target = Math.max(-0.02, m.baseF - 0.035);        // 뒤로 웅크린다
        retreat = 0.12;
        this.shakeScreen(0.08, r * 0.08);
        if (m.kind === 'hunt') {
          const prey = this.findPrey();
          if (!prey) { m.state = 'creep'; m.t = 0; m.hcd = 0.8; break; }
          m.prey = prey;
        } else {
          m.alarmX = this.camX + m.peakF * W + r * 5;
        }
        if (m.t >= (m.kind === 'hunt' ? 0.35 : 0.95)) {
          m.state = m.kind; m.t = 0; m.hold = 0; m.tongue = 0; m.attached = false;
          this.shakeScreen(0.3, r * 0.3);
        }
        break;
      }

      case 'snap':
        target = m.peakF; advance = 1.0;
        m.alarmX = this.camX + m.peakF * W + r * 5;
        if (m.f >= m.peakF - 0.004) {
          m.hold += dt;
          if (m.hold >= 0.4) { m.state = 'creep'; m.t = 0; m.cd = rnd(8, 13) / (0.7 + 0.5 * heat); m.hcd = 0.8; }
        }
        break;

      case 'hunt': {
        // 혀를 쭉 뻗어 기절한 아이를 낚아채 입으로 끌고 온다. 깨어나면 뿌리치고 도망친다.
        const prey = m.prey && this.isPrey(m.prey) ? m.prey : this.findPrey();
        if (!prey) {
          m.state = 'creep'; m.t = 0; m.hcd = 1.2; m.cd = Math.max(m.cd, 2);
          m.prey = null; m.attached = false;
          break;
        }
        if (prey !== m.prey) { m.prey = prey; m.t = 0; m.attached = false; }
        m.tongue = clamp(m.t / 0.25, 0, 1);
        if (!m.attached && m.tongue >= 1) { m.attached = true; this.sfx('slurp'); }
        target = m.baseF + 0.05;                                // 입도 살짝 벌린다
        m.alarmX = this.mawX + r * 6;
        break;
      }
    }

    // 아직 앞으로 나와 있으면 (물러나는 중) 그 앞도 위험하다
    if (m.alarmX === -Infinity && m.f > m.baseF + 0.025) m.alarmX = this.camX + m.f * W + r * 6;

    m.f += clamp(target - m.f, -retreat * dt, advance * dt);
    this.mawX = this.camX + m.f * W;

    // 화를 낼수록 붉어진다
    const angry = m.state === 'warn' || m.state === 'snap' || m.state === 'hunt';
    m.rage += ((angry ? 1 : 0) - m.rage) * Math.min(1, dt * 6);

    // 눈동자는 가장 뒤처진(또는 노리는) 아이를 쫓는다
    let lookY = this.top + this.trackH / 2, rear = Infinity;
    if (m.state === 'hunt' && m.prey) lookY = m.prey.y;
    else for (const R of this.runners) if (R.alive && R.x < rear) { rear = R.x; lookY = R.y; }
    m.look += (lookY - m.look) * Math.min(1, dt * 8);

    // 앞니 사이로 새어 나오는 보랏빛 연기
    if (m.state !== 'sleep' && Math.random() < dt * 14) {
      this.particles.push({
        x: this.mawX + rnd(0, r), y: rnd(this.top, this.bot),
        vx: rnd(30, 110), vy: rnd(-50, 10),
        life: rnd(0.35, 0.7), age: 0, hue: rnd(270, 300), r: rnd(3, r * 0.5), light: 36,
      });
    }
  }

  /** 으르렁: 곧 덮친다는 경고 */
  mawWarn(kind, prey) {
    const m = this.maw;
    m.state = 'warn'; m.kind = kind; m.t = 0; m.prey = prey;
    this.sfx('growl');
    if (this.opts.onMaw) this.opts.onMaw(kind, prey);
  }

  announceStage() {
    for (let i = STAGES.length - 1; i >= 0; i--) {
      if (this.dist >= STAGES[i].at) {
        if (i !== this.stageIdx) {
          this.stageIdx = i;
          if (this.opts.onStage) this.opts.onStage(STAGES[i].label, i + 1);
        }
        return;
      }
    }
  }

  /* ===== 장애물 ===== */
  spawnAhead(heat) {
    const limit = this.camX + this.W + 700;
    let guard = 0;
    while (this.frontier < limit && guard++ < 12) {
      const kinds = STAGES[Math.max(this.stageIdx, 0)].kinds;
      this.obstacles.push(this.makeObstacle(pick(kinds), this.frontier, heat));
      const gap = lerp(395, 250, clamp(heat, 0, 1)) * rnd(0.8, 1.22);
      this.frontier += gap;
    }
  }

  makeObstacle(kind, x, heat) {
    const T = this.top, B = this.bot, Hh = this.trackH;
    switch (kind) {
      case 'spinner': {
        // 가장자리 바: 축이 트랙 밖(위나 아래)에 있어서 가장자리 쪽을 쓸고 지나간다
        if (Math.random() < 0.4) {
          const side = Math.random() < 0.5 ? -1 : 1;
          const out = Hh * rnd(0.02, 0.1);
          return {
            kind, x, arms: 1, edge: true,
            len: Hh * rnd(0.4, 0.55), thick: this.r * 0.95,
            y: side < 0 ? T - out : B + out,
            ang: rnd(0, Math.PI * 2),
            w: rnd(1.1, 1.9) * (Math.random() < 0.5 ? -1 : 1) * (0.85 + heat * 0.5),
          };
        }
        // 세 종류: 긴 바 / 짧고 빠른 바 / 느린 십자
        const roll = Math.random();
        let arms, len, spin, thick;
        if (roll < 0.42) {
          arms = 1; len = Hh * rnd(0.33, 0.47); spin = rnd(1.4, 2.3); thick = this.r * 0.85;
        } else if (roll < 0.72) {
          arms = 1; len = Hh * rnd(0.13, 0.23); spin = rnd(3.0, 4.5); thick = this.r * 1.05;
        } else {
          arms = 2; len = Hh * rnd(0.24, 0.35); spin = rnd(0.75, 1.35); thick = this.r * 0.8;
        }
        return {
          kind, x, arms, len, thick,
          y: rnd(T + Hh * 0.25, B - Hh * 0.25),
          ang: rnd(0, Math.PI * 2),
          w: spin * (Math.random() < 0.5 ? -1 : 1) * (0.85 + heat * 0.5),
        };
      }
      case 'hammer':
        return {
          kind, x,
          y0: T + Hh * 0.5,
          amp: Hh * rnd(0.3, 0.47),
          rad: this.r * rnd(1.6, 2.3),
          ph: rnd(0, Math.PI * 2),
          w: rnd(1.7, 2.9) * (0.85 + heat * 0.5),
        };
      case 'saw':
        return {
          kind, x,
          y0: T + Hh * 0.5,
          amp: Hh * rnd(0.34, 0.48),
          rad: this.r * rnd(1.1, 1.5),
          ph: rnd(0, Math.PI * 2),
          w: rnd(3.4, 4.8) * (0.85 + heat * 0.4),
          spin: 0,
        };
      case 'ball': {
        // 작을수록 가볍게 위아래로 크게 튕기고, 클수록 묵직하게 직진한다.
        const size = Math.random();
        const rad = this.r * lerp(0.9, 2.5, size);
        return {
          kind, x: x + rnd(0, 220),
          y: rnd(T + rad, B - rad),
          rad,
          vx: -rnd(70, 185) * lerp(2.3, 0.7, size) * (0.8 + heat * 0.7),
          vy: rnd(200, 430) * lerp(1, 0.14, size) * (Math.random() < 0.5 ? -1 : 1),
          roll: 0,
        };
      }
      case 'wall':
      default: {
        const gapH = Math.max(this.r * 3.4, Hh * lerp(0.3, 0.15, clamp(heat, 0, 1)));
        return {
          kind: 'wall', x,
          w: this.r * 1.3,
          gapY: rnd(T + gapH * 0.6, B - gapH * 0.6),
          gapH,
          vy: rnd(-70, 70) * (0.6 + heat),
        };
      }
    }
  }

  moveObstacle(o, dt) {
    switch (o.kind) {
      case 'spinner': o.ang += o.w * dt; break;
      case 'hammer': o.ph += o.w * dt; break;
      case 'saw': o.ph += o.w * dt; o.spin += dt * 14; break;
      case 'ball':
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        o.roll += dt * 6;
        if (o.y < this.top + o.rad) { o.y = this.top + o.rad; o.vy *= -1; }
        if (o.y > this.bot - o.rad) { o.y = this.bot - o.rad; o.vy *= -1; }
        break;
      case 'drop':
        o.t += dt;
        if (!o.landed && o.t >= o.warn + o.fall) {
          o.landed = true;
          this.sfx('boom');
          this.burst(o.x, o.y, o.hue, 18);
          this.rings.push({ x: o.x, y: o.y, age: 0, life: 0.5, hue: o.hue, r0: o.rad });
        }
        break;
      case 'wall':
        o.gapY += o.vy * dt;
        if (o.gapY < this.top + o.gapH * 0.55) { o.gapY = this.top + o.gapH * 0.55; o.vy *= -1; }
        if (o.gapY > this.bot - o.gapH * 0.55) { o.gapY = this.bot - o.gapH * 0.55; o.vy *= -1; }
        break;
    }
  }

  /** 장애물의 현재 위치 기준 충돌 판정 */
  hits(o, R) {
    const pad = this.r;
    switch (o.kind) {
      case 'spinner': {
        for (let k = 0; k < o.arms; k++) {
          const a = o.ang + (k * Math.PI) / o.arms;
          const hx = Math.cos(a) * o.len, hy = Math.sin(a) * o.len;
          if (distToSeg(R.x, R.y, o.x - hx, o.y - hy, o.x + hx, o.y + hy) < o.thick + pad) return true;
        }
        return false;
      }
      case 'hammer':
      case 'saw': {
        const y = o.y0 + Math.sin(o.ph) * o.amp;
        return Math.hypot(R.x - o.x, R.y - y) < o.rad + pad;
      }
      case 'ball':
        return Math.hypot(R.x - o.x, R.y - o.y) < o.rad + pad;
      case 'drop':
        // 떨어지는 막바지부터 착지 직후까지만 위험하다
        if (o.t < o.warn + o.fall * 0.72) return false;
        return Math.hypot(R.x - o.x, R.y - o.y) < o.rad + pad;
      case 'wall':
        if (R.x + pad < o.x || R.x - pad > o.x + o.w) return false;
        return Math.abs(R.y - o.gapY) > o.gapH / 2 - pad * 0.35;
    }
    return false;
  }

  /** t초 뒤 y 위치가 얼마나 위험한지 0~1 */
  danger(o, y, t) {
    const near = (d, safe) => clamp(1 - d / safe, 0, 1);
    switch (o.kind) {
      case 'spinner': {
        let worst = 0;
        for (let k = 0; k < o.arms; k++) {
          const a = o.ang + o.w * t + (k * Math.PI) / o.arms;
          const hx = Math.cos(a) * o.len, hy = Math.sin(a) * o.len;
          const d = near(distToSeg(o.x, y, o.x - hx, o.y - hy, o.x + hx, o.y + hy), o.thick + this.r * 3.4);
          if (d > worst) worst = d;
        }
        return worst;
      }
      case 'hammer':
      case 'saw': {
        const fy = o.y0 + Math.sin(o.ph + o.w * t) * o.amp;
        return near(Math.abs(y - fy), o.rad + this.r * 3.2);
      }
      case 'ball': {
        const fy = o.y + o.vy * t;
        return near(Math.abs(y - fy), o.rad + this.r * 3);
      }
      case 'drop': {
        if (o.t > o.warn + o.fall + o.live * 0.6) return 0;
        return near(Math.abs(y - o.y), o.rad + this.r * 2.2);
      }
      case 'wall': {
        const fy = o.gapY + o.vy * t;
        const edge = Math.abs(y - fy) - (o.gapH / 2 - this.r * 1.3);
        return edge > 0 ? 1 : near(-edge, this.r * 2.2) * 0.55;
      }
    }
    return 0;
  }

  /** 어디로 피할지 고른다 */
  chooseY(R, baseSpeed) {
    const sp = baseSpeed * R.speed;
    const ahead = this.obstacles.filter((o) => o.x > R.x - 170 && o.x < R.x + 600);
    if (!ahead.length) {
      // 장애물이 없으면 살짝 배회
      return clamp(R.y + rnd(-1, 1) * this.trackH * 0.07, this.top + this.r, this.bot - this.r);
    }

    const N = 13;
    let bestY = R.y, best = Infinity;
    for (let i = 0; i < N; i++) {
      const y = this.top + this.r + (this.trackH - this.r * 2) * (i / (N - 1));
      let cost = 0;
      for (const o of ahead) {
        const t = Math.max(0, (o.x - R.x) / sp);
        const w = 1 / (1 + t * 1.5);                 // 가까운 장애물이 더 중요
        // 뛰어넘을 수 있는 건 조금 덜 무서워한다 -> 점프로 돌파하는 그림이 나온다
        cost += this.danger(o, y, t) * w * 3 * (LOW.has(o.kind) ? 0.7 : 1);
      }
      cost += Math.abs(y - R.y) / this.trackH * 0.55;  // 멀리 움직이기 싫어함
      cost += (1 - R.skill) * Math.random() * 1.5;     // 실력 없으면 헷갈림
      if (cost < best) { best = cost; bestY = y; }
    }
    return bestY;
  }

  /** 코앞에 닥친 장애물 종류. 없으면 null */
  threat(R) {
    for (const o of this.obstacles) {
      const dx = o.x - R.x;
      if (dx < -30 || dx > 230) continue;
      if (this.danger(o, R.y, Math.max(0, dx / 280)) > 0.40) return o.kind;
    }
    return null;
  }

  /** 소리 한 번 (실제로 내는 일은 바깥에 맡긴다) */
  sfx(name) {
    if (this.opts.onSfx) this.opts.onSfx(name);
  }

  /* ===== 밟기 / 들어서 던지기 ===== */

  /** 기절. 별이 빙글빙글 돌고 비틀거린다 */
  daze(O, t) {
    O.dizzy = Math.max(O.dizzy, t);
    O.punch = 0; O.dash = 0; O.stomp = null;
    if (O.carry) this.release(O);
  }

  /** 들어 올린 아이를 뒤로 젖히는 정도 0~1 (던지기 직전 0.32초) */
  windup(A) {
    return clamp((A.liftT - (A.liftDur - 0.32)) / 0.32, 0, 1);
  }

  /** 높이 뜰수록 카메라에 가까워지는 느낌으로 커진다 (보통 점프 약 1.4배, 크게 뛰면 1.9배) */
  scaleOf(R) {
    return 1 + 0.42 * clamp(this.heightOf(R) / (this.r * 3.3), 0, 2.2);
  }

  /** 지금 땅에서 떠 있는 높이(px) */
  heightOf(R) {
    const r = this.r;
    if (R.cel) return R.cel.h * r;                        // 세레모니 중
    if (R.heldBy) {
      const A = R.heldBy;
      return r * (2.1 * clamp(A.liftT / 0.4, 0, 1) + 0.45 * this.windup(A));
    }
    if (R.flight) {
      const F = R.flight, k = clamp(F.t / F.T, 0, 1);
      return r * (F.h0 * (1 - k) + Math.sin(Math.PI * k) * F.up);
    }
    if (R.stomp) {
      const S = R.stomp;
      if (S.t < S.T1) return r * 1.5 * Math.sin((Math.PI / 2) * clamp(S.t / S.T1, 0, 1));
      // 꾹 - 살짝 뜸 - 꾹 - 웅크렸다가 도약
      const ph = ((S.t - S.T1) % 0.3) / 0.3;
      return r * (1.5 + 0.65 * Math.sin(Math.PI * ph));
    }
    if (R.jump > 0) {
      const k = 1 - R.jump / R.jumpT;
      // 밟고 뛰면 b 의 머리 높이(1.5r)에서 출발해 훨씬 높이 오른다
      return r * (Math.sin(k * Math.PI) * 3.3 * R.jumpPow + (R.jumpPow > 1 ? 1.5 * Math.max(0, 1 - k * 3) : 0));
    }
    return 0;
  }

  stepActions(R, dt, dizzy) {
    const r = this.r;

    // 밟는 중: 내려앉고 -> 꾹 -> 꾹 -> 도약
    if (R.stomp) {
      const S = R.stomp, B = S.b;
      S.t += dt;
      if (!B.alive || B.heldBy || B.flight) { R.stomp = null; return; }
      if (S.t < S.T1) {
        const pull = Math.min(1, dt * 14);
        R.x += (B.x - R.x) * pull;
        R.y += (B.y - R.y) * pull;
      } else {
        const tp = S.t - S.T1;
        if (S.hits < 2 && tp >= 0.3 * S.hits) this.stompPress(R, B);
        if (tp >= 0.6) this.stompLaunch(R, B);
      }
      return;
    }

    // 들고 있는 중: 버둥거리는 걸 들고 있다가 시간이 차면 던진다
    if (R.carry) {
      const B = R.carry;
      R.liftT += dt;
      if (Math.random() < dt * 14) {                       // 당황해서 식은땀
        this.particles.push({
          x: B.x + rnd(-r, r), y: B.y - this.heightOf(B) - r * 1.1,
          vx: rnd(-90, 90), vy: rnd(-130, -40),
          life: 0.35, age: 0, hue: 200, r: rnd(2, 3.5), light: 82,
        });
      }
      if (R.liftT >= R.liftDur) this.throwIt(R, B);
      return;
    }

    if (dizzy || R.jump > 0 || R.punch > 0) return;
    R.actCd -= dt;
    if (R.actCd > 0) return;

    for (const O of this.runners) {
      if (O === R || !O.alive || O.dizzy > 0 || O.heldBy || O.flight || O.carry || O.stomp || O.jump > 0) continue;
      const dx = O.x - R.x, dy = O.y - R.y;
      if (dx > r * 0.3 && dx < r * 2.4 && Math.abs(dy) < r) {
        // 코앞에 앞서 달리는 아이가 있다 -> 밟고 높이 뛰어오른다 (뛸 높이가 화면 안에 들어올 때만)
        if (R.y - r * 8.2 > 10 && Math.random() < 0.8 * dt) {
          R.stomp = { b: O, t: 0, T1: 0.25, hits: 0 };
          R.actCd = rnd(18, 28);
          this.sfx('jump');
          if (this.opts.onStomp) this.opts.onStomp(R, O);
          return;
        }
      } else if (Math.hypot(dx, dy) < r * 2.4) {
        // 바짝 붙어 있다 -> 들어서 던진다
        if (Math.random() < 0.2 * dt) { this.liftUp(R, O); return; }
      }
    }
  }

  /** 꾹! (밟을 때마다) 밟힌 아이는 납작해지고 기절한다 */
  stompPress(R, B) {
    const S = R.stomp, r = this.r;
    S.hits++;
    if (S.hits === 1) this.daze(B, 0.6 + rnd(1.3, 1.7));   // 다 밟은 뒤에도 잠깐 더 기절
    B.squash = 0.35;
    R.squash = 0.2;
    B.kx = B.ky = 0;
    this.sfx('stomp');
    this.rings.push({ x: B.x, y: B.y + r * 0.4, age: 0, life: 0.32, hue: 28, r0: r * 0.7, grow: 3.2, thick: 3 });
    this.pows.push({ x: B.x, y: B.y - r * 0.2, age: 0, life: 0.28, size: r * 1.0, spikes: 8, text: '', ang: rnd(0, 6.28), hue: 30 });
    this.burst(B.x, B.y, 30, 7);
    this.shakeScreen(0.1, r * 0.16);
  }

  /** 충분히 밟은 뒤 높이 도약 */
  stompLaunch(R, B) {
    const r = this.r;
    R.stomp = null;
    B.squash = 0.35;
    R.jumpPow = 2.4;                        // 평소 점프의 두 배 훨씬 넘게
    R.jumpT = 1.1;
    R.jump = R.jumpT;
    R.jumpCd = 0.6;
    this.sfx('stomp');
    this.sfx('jump');
    this.rings.push({ x: B.x, y: B.y + r * 0.4, age: 0, life: 0.45, hue: 28, r0: r * 0.8, grow: 4.4, thick: 4 });
    this.burst(B.x, B.y, 30, 14);
    this.shakeScreen(0.16, r * 0.26);
  }

  liftUp(A, B) {
    A.carry = B; B.heldBy = A;
    A.liftT = 0; A.liftDur = 1.15;
    A.actCd = rnd(20, 32);
    A.dash = 0;
    B.punch = 0; B.dash = 0; B.stomp = null; B.kx = B.ky = 0; B.vy = 0; B.hurt = 0;
    this.sfx('lift');
    this.puff(A, 0.6);
    if (this.opts.onThrow) this.opts.onThrow(A, B);
  }

  throwIt(A, B) {
    const r = this.r;
    A.carry = null; B.heldBy = null;
    const sx = B.x, sy = B.y, T = rnd(0.75, 0.9);
    // 착지 자리는 몇 군데 던져 보고 덜 위험한 쪽을 고른다
    let ex = sx + 340, ey = sy, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const cx = sx + rnd(300, 440);
      const cy = clamp(sy + rnd(-0.38, 0.38) * this.trackH, this.top + r, this.bot - r);
      let cost = Math.random() * 0.5;
      for (const o of this.obstacles) if (Math.abs(o.x - cx) < 220) cost += this.danger(o, cy, T);
      if (cost < best) { best = cost; ex = cx; ey = cy; }
    }
    B.flight = { t: 0, T, sx, sy, ex, ey, h0: 2.55, up: 3.4, spin: (Math.random() < 0.5 ? -1 : 1) * Math.PI * 4 };
    this.sfx('throw');
    this.rings.push({ x: A.x + r, y: A.y - r, age: 0, life: 0.38, hue: 200, r0: r * 0.8, grow: 4, thick: 4, white: true });
    this.burst(A.x + r, A.y - r * 1.5, 200, 10);
  }

  /** 들고 있던 아이를 떨어뜨린다 (들던 사람이 먼저 탈락했을 때) */
  release(A) {
    const B = A.carry;
    A.carry = null;
    if (!B) return;
    B.heldBy = null;
    B.flight = { t: 0, T: 0.3, sx: B.x, sy: B.y, ex: B.x + rnd(20, 50), ey: B.y, h0: 2.1, up: 0, spin: 0 };
  }

  stepFlight(R, dt) {
    const F = R.flight;
    F.t += dt;
    const k = clamp(F.t / F.T, 0, 1);
    R.x = lerp(F.sx, F.ex, k);
    R.y = lerp(F.sy, F.ey, k);
    R.spin = F.spin * k;
    R.bob += dt * 10;
    if (F.up > 0 && Math.random() < 0.7) {
      this.particles.push({
        x: R.x - this.r * 0.5, y: R.y - this.heightOf(R) + rnd(-this.r * 0.4, this.r * 0.4),
        vx: -rnd(40, 120), vy: rnd(-30, 30),
        life: rnd(0.16, 0.3), age: 0, hue: 200, r: rnd(2.2, this.r * 0.38), light: 90,
      });
    }
    if (F.t < F.T) return;

    // 착지: 쿵! 그리고 기절
    R.flight = null; R.spin = 0;
    R.targetY = R.y; R.vy = 0;
    this.puff(R, 1.2);
    if (F.up > 0) {
      this.daze(R, rnd(1.5, 1.9));
      R.squash = 0.3;
      this.sfx('thud');
      this.rings.push({ x: R.x, y: R.y + this.r * 0.4, age: 0, life: 0.45, hue: 20, r0: this.r * 0.8, grow: 4.6, thick: 5 });
      this.pows.push({ x: R.x, y: R.y - this.r * 2.0, age: 0, life: 0.4, size: this.r * 1.3, spikes: 9, text: '쿵!', ang: rnd(0, 6.28), hue: 20 });
      this.shakeScreen(0.2, this.r * 0.4);
    } else {
      this.daze(R, 0.8);
      this.sfx('land');
    }
  }

  /**
   * 주먹 한 방. 닿는 범위 안의 아이들을 바깥으로 밀어낸다 (탈락은 아니다).
   * 큰 표시 대신, 팔이 위에서 아래로 쓸고 지나가는 순서대로
   * 맞은 아이마다 작은 타격 표시가 뜬다.
   */
  shove(P) {
    const reach = this.r * 6;
    const victims = [];
    this.sfx('punch');
    this.burst(P.x + this.r * 1.5, P.y, 48, 6);

    for (const O of this.runners) {
      if (O === P || !O.alive) continue;
      let dx = O.x - P.x, dy = O.y - P.y;
      const d = Math.hypot(dx, dy);
      if (d > reach) continue;
      if (d < 0.001) { dx = 1; dy = 0; }
      const f = (1 - d / reach) * 1050;
      const ux = dx / (d || 1), uy = dy / (d || 1);
      // 팔의 각도는 -1.15 -> +1.15. 아이가 있는 방향에 팔이 닿는 때가 그 아이가 맞는 때
      const k = clamp((Math.atan2(dy, dx) + 1.15) / 2.3, 0, 1);
      victims.push(O);
      this.later.push({ t: Math.max(0, k - 0.2) * P.punchT, fn: () => this.hitVictim(O, ux * f * 0.5, uy * f) });
    }

    this.shakeScreen(victims.length ? 0.16 : 0.1, this.r * (0.14 + Math.min(victims.length, 6) * 0.03));
    if (this.opts.onShove && victims.length) this.opts.onShove(P, victims);
    return victims;
  }

  /** 주먹에 맞는 순간: 밀려나고, 번쩍이고, 작은 타격 표시가 뜬다 */
  hitVictim(O, kx, ky) {
    if (!O.alive) return;
    O.kx += kx; O.ky += ky;
    O.stun = Math.max(O.stun, 0.2);
    O.hurt = 0.55;
    this.pows.push({ x: O.x, y: O.y - this.r * 0.2, age: 0, life: 0.3, size: this.r * 0.95, spikes: 7, text: '', ang: rnd(0, 6.28), hue: 52 });
    this.burst(O.x, O.y, 52, 6);
  }

  shakeScreen(time, amp) {
    if (time > this.shake) this.shake = time;
    if (amp > this.shakeAmp) this.shakeAmp = amp;
  }

  /* ===== 파티클 ===== */
  /** 도약/착지 먼지와 충격파 링 */
  puff(R, power) {
    this.rings.push({ x: R.x, y: R.y + this.r * 0.7, age: 0, life: 0.42, hue: R.hue, r0: this.r * 0.7 });
    const n = Math.round(7 * power);
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: R.x + rnd(-this.r * 0.5, this.r * 0.5),
        y: R.y + this.r * rnd(0.4, 0.9),
        vx: rnd(-95, 55), vy: rnd(-70, 20),
        life: rnd(0.22, 0.45), age: 0, hue: R.hue, r: rnd(1.8, this.r * 0.35),
      });
    }
  }

  trail(R) {
    this.particles.push({
      x: R.x - this.r * 0.9, y: R.y + rnd(-this.r * 0.4, this.r * 0.5),
      vx: -rnd(40, 130), vy: rnd(-30, 30),
      life: rnd(0.18, 0.34), age: 0, hue: R.hue, r: rnd(2, this.r * 0.4),
    });
  }

  /** 맞고 날아가는 아이가 남기는 흰 줄 */
  flyTrail(R) {
    this.particles.push({
      x: R.x - Math.sign(R.kx || 1) * this.r * 0.6, y: R.y + rnd(-this.r * 0.5, this.r * 0.5),
      vx: -R.kx * 0.12 + rnd(-30, 30), vy: -R.ky * 0.12 + rnd(-30, 30),
      life: rnd(0.16, 0.3), age: 0, hue: 55, r: rnd(2.2, this.r * 0.38), light: 92,
    });
  }

  burst(x, y, hue, n) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2), s = rnd(60, 300);
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: rnd(0.4, 1), age: 0, hue: hue + rnd(-25, 25), r: rnd(2, 6),
      });
    }
  }

  stepParticles(dt) {
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy = p.vy * 0.94 + 220 * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const g of this.rings) g.age += dt;
    this.rings = this.rings.filter((g) => g.age < g.life);
    for (const L of this.later) {
      L.t -= dt;
      if (L.t <= 0) { L.done = true; L.fn(); }
    }
    this.later = this.later.filter((L) => !L.done);
    for (const w of this.pows) w.age += dt;
    this.pows = this.pows.filter((w) => w.age < w.life);
    if (this.shake > 0) {
      this.shake -= dt;
      if (this.shake <= 0) { this.shake = 0; this.shakeAmp = 0; }
    }
  }

  /* ===== 그리기 ===== */
  draw() {
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);

    /* 화면 흔들림 (주먹이 터질 때) */
    c.save();
    if (this.shake > 0) {
      const k = Math.min(this.shake / 0.28, 1);
      c.translate(rnd(-1, 1) * this.shakeAmp * k, rnd(-1, 1) * this.shakeAmp * k);
    }

    /* 배경 */
    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#151d3c');
    sky.addColorStop(1, '#0a0e20');
    c.fillStyle = sky;
    c.fillRect(-30, -30, W + 60, H + 60);

    /* 트랙 */
    c.fillStyle = '#1d2749';
    c.fillRect(-30, this.top, W + 60, this.trackH);

    // 흐르는 줄무늬
    c.fillStyle = 'rgba(255,255,255,.028)';
    const step = 130;
    const off = -(this.camX % step);
    for (let x = off - step; x < W + step; x += step * 2) c.fillRect(x, this.top, step, this.trackH);

    // 가장자리
    c.fillStyle = '#ffd23f';
    c.fillRect(-30, this.top - 4, W + 60, 4);
    c.fillRect(-30, this.bot, W + 60, 4);

    // 거리 표시
    c.font = '600 12px Gothic A1, sans-serif';
    c.fillStyle = 'rgba(255,255,255,.22)';
    c.textAlign = 'center';
    const m0 = Math.floor(this.camX / 1000) * 1000;
    for (let d = m0; d < this.camX + W + 1000; d += 1000) {
      if (d <= 0) continue;
      const sx = d - this.camX;
      c.fillRect(sx, this.top, 1.5, this.trackH);
      c.fillText(d / 100 + 'm', sx, this.top + 16);
    }

    // 출발선
    if (this.camX < 60) {
      const sx = -this.camX;
      c.fillStyle = 'rgba(255,255,255,.5)';
      for (let y = this.top; y < this.bot; y += 18) c.fillRect(sx - 3, y, 6, 9);
    }

    /* 장애물 */
    for (const o of this.obstacles) this.drawObstacle(c, o);

    /* 탈락자 잔상 */
    for (const R of this.runners) {
      if (R.alive) continue;
      const age = this.time - R.deadAt;
      if (age > 1.1) continue;
      if (R.eaten) {
        // 입속으로 빨려 들어가며 빙글빙글 작아진다
        const k = clamp(age / 0.7, 0, 1), e = k * k;
        const gx = R.x, fx = this.mawX - this.r * 0.4;
        R.x = lerp(R.x, fx, e);
        const px = R.x - this.camX;
        c.save();
        c.translate(px, R.y); c.rotate(k * 7); c.scale(1 - 0.8 * e, 1 - 0.8 * e); c.translate(-px, -R.y);
        c.globalAlpha = k < 1 ? 0.9 : 0;
        this.drawRunner(c, R, true);
        c.restore();
        R.x = gx;
        c.globalAlpha = 1;
        continue;
      }
      c.globalAlpha = (1 - age / 1.1) * 0.5;
      this.drawRunner(c, R, true);
      c.globalAlpha = 1;
    }

    /* 달리는 아이들 */
    // 던져진 아이는 위에, 들려 있는 아이는 들고 있는 아이 바로 뒤에 그린다
    const zOf = (r) => r.y + (r.heldBy ? 0.5 : 0) + (r.flight ? 1000 : 0);
    const list = this.runners.filter((r) => r.alive).sort((a, b) => zOf(a) - zOf(b));
    for (const R of list) this.drawRunner(c, R, false);
    this.drawMaw(c);
    this.drawLabels(c, list);

    /* 충격파 링 (도약·착지) */
    for (const g of this.rings) {
      const k = g.age / g.life;
      const ease = g.grow ? 1 - (1 - k) * (1 - k) : k;      // 주먹 링은 확 퍼졌다가 느려진다
      const rr = g.r0 + ease * this.r * (g.grow || 3.4);
      c.globalAlpha = (1 - k) * (g.grow ? 0.95 : 0.75);
      c.strokeStyle = g.white ? '#fff' : `hsl(${g.hue},95%,78%)`;
      c.lineWidth = (g.thick || 3) * (1 - k) + 1;
      c.beginPath();
      c.ellipse(g.x - this.camX, g.y, rr, rr * (g.grow ? 0.7 : 0.36), 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;

    /* 파티클 */
    for (const p of this.particles) {
      c.globalAlpha = 1 - p.age / p.life;
      c.fillStyle = `hsl(${p.hue},90%,${p.light || 64}%)`;
      c.beginPath();
      c.arc(p.x - this.camX, p.y, p.r, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    /* 타격 표시 (만화 같은 뾰족한 별 + 글자) */
    for (const w of this.pows) this.drawPow(c, w);

    c.restore();
  }

  /** 왼쪽 끝에서 밀려오는 괴물. 어두운 몸통 + 이빨 + 번뜩이는 눈 */
  drawMaw(c) {
    const m = this.maw;
    if (!m || m.state === 'sleep' && m.f < -0.085) return;
    const r = this.r, H = this.H;
    const fx = this.mawX - this.camX;                     // 앞니 끝선의 화면 x
    if (fx < -r * 4) return;
    const rage = m.rage;
    const hue = lerp(275, 352, rage);
    const wave = (y) => Math.sin(y * 0.05 + this.time * 3.2) * r * 0.35 + Math.sin(y * 0.021 - this.time * 2.1) * r * 0.6;

    c.save();

    // 앞쪽에 번지는 붉은 위험 구역
    const pulse = m.state === 'warn' ? 0.5 + 0.5 * Math.sin(this.time * 18) : 1;
    const zoneW = r * (m.state === 'creep' ? 4.5 : 8);
    const dz = c.createLinearGradient(fx, 0, fx + zoneW, 0);
    dz.addColorStop(0, `rgba(255,40,80,${(0.1 + 0.32 * rage) * pulse})`);
    dz.addColorStop(1, 'rgba(255,40,80,0)');
    c.fillStyle = dz;
    c.fillRect(Math.max(fx, 0), 0, zoneW + Math.min(fx, 0), H);

    // 몸통
    const g = c.createLinearGradient(fx - r * 9, 0, fx + r * 0.5, 0);
    g.addColorStop(0, '#03010a');
    g.addColorStop(1, `hsl(${hue},62%,${17 + rage * 7}%)`);
    c.beginPath();
    c.moveTo(-40, -20);
    for (let y = -20; y <= H + 20; y += 8) c.lineTo(fx + wave(y), y);
    c.lineTo(-40, H + 20);
    c.closePath();
    c.fillStyle = g;
    c.shadowColor = `hsla(${hue},100%,58%,.9)`;
    c.shadowBlur = 8 + rage * 26;
    c.fill();
    c.shadowBlur = 0;

    // 이빨: 오물오물 씹는다. 화가 날수록 길고 뾰족하다
    const sp = r * 1.55;
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(40,10,40,.55)';
    c.lineWidth = 1.5;
    for (let i = 0; i * sp < H + 30; i++) {
      const y = i * sp, bx = fx + wave(y);
      const chomp = 0.5 + 0.5 * Math.sin(this.time * (5 + rage * 8) + i * 1.3);
      const len = r * ((i % 2 ? 0.8 : 1.15) + rage * 0.55 + chomp * (0.3 + rage * 0.3));
      if (bx + len < -2) continue;
      c.beginPath();
      c.moveTo(bx - 3, y - sp * 0.44);
      c.lineTo(bx + len, y + Math.sin(this.time * 9 + i) * r * 0.06);
      c.lineTo(bx - 3, y + sp * 0.44);
      c.closePath();
      c.fillStyle = rage > 0.5 ? '#fff4e8' : '#efe6cf';
      c.fill(); c.stroke();
    }

    // 눈 (노려보는 아이를 따라간다)
    const er = r * 1.05;
    for (const ey of [this.top + this.trackH * 0.27, this.top + this.trackH * 0.73]) {
      const ex = fx - r * 0.5 + wave(ey);
      if (ex + er * 1.4 < 0) continue;
      c.shadowColor = `hsl(${lerp(48, 0, rage)},100%,55%)`;
      c.shadowBlur = 12 + rage * 14;
      c.fillStyle = `hsl(${lerp(50, 2, rage)},100%,${58 - rage * 6}%)`;
      c.beginPath(); c.ellipse(ex, ey, er * 0.9, er * 1.1, 0, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
      const look = clamp((m.look - ey) / this.trackH, -1, 1);
      c.fillStyle = '#1a0008';
      c.beginPath(); c.ellipse(ex + er * 0.3, ey + look * er * 0.4, er * 0.17, er * 0.82, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = `hsl(${hue},70%,10%)`;               // 성난 눈썹
      c.lineWidth = r * 0.38; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(ex - er * 1.1, ey - er * 1.45);
      c.lineTo(ex + er * 1.0, ey - er * (0.75 - rage * 0.2));
      c.stroke();
    }

    // 혀: 기절한 아이를 낚아채 입으로 끌고 온다
    if (m.state === 'hunt' && m.prey && m.prey.alive) {
      const P = m.prey;
      const x0 = fx - r * 0.3, y0 = this.top + this.trackH * 0.5;
      const px = P.x - this.camX, py = P.y - this.heightOf(P);
      const k = 1 - Math.pow(1 - m.tongue, 3);                       // 확 뻗는다
      const tx = lerp(x0, px, k), ty = lerp(y0, py, k);
      const dx = tx - x0, dy = ty - y0, len = Math.hypot(dx, dy) || 1;
      const wob = Math.sin(this.time * 22) * r * (m.attached ? 0.25 : 0.7);
      const cx = (x0 + tx) / 2 - (dy / len) * (wob + r * 0.4), cy = (y0 + ty) / 2 + (dx / len) * (wob + r * 0.4);
      c.lineCap = 'round';
      for (const [col, w] of [['#b0204f', r * 0.78], ['#ff4f86', r * 0.58], ['#ff9fc0', r * 0.16]]) {
        c.strokeStyle = col; c.lineWidth = w;
        c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo(cx, cy, tx, ty); c.stroke();
      }
      c.fillStyle = '#ff4f86'; c.strokeStyle = '#b0204f'; c.lineWidth = 2;
      c.beginPath(); c.arc(tx, ty, r * (m.attached ? 0.95 : 0.55), 0, Math.PI * 2); c.fill(); c.stroke();
    }

    // 경고 표지: 곧 덮친다
    if (m.state === 'warn' && Math.sin(this.time * 20) > -0.2) {
      const sx = Math.max(fx, 0) + r * 2.4, sy = this.top + this.trackH * 0.5, s = r * 1.5;
      c.fillStyle = '#ff3355';
      c.strokeStyle = '#fff'; c.lineWidth = 3;
      c.beginPath();
      c.moveTo(sx, sy - s); c.lineTo(sx + s * 0.95, sy + s * 0.7); c.lineTo(sx - s * 0.95, sy + s * 0.7);
      c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#fff';
      c.font = `900 ${Math.round(s * 1.1)}px Jua, Gothic A1, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('!', sx, sy + s * 0.18);
      c.textBaseline = 'alphabetic';
    }
    c.restore();
  }

  /** 뾰족한 폭발 모양. 처음에 튀어나왔다가 사라진다 */
  drawPow(c, w) {
    const k = w.age / w.life;
    const pop = k < 0.25 ? 0.4 + (k / 0.25) * 0.75 : 1.15 - (k - 0.25) * 0.2;   // 튀어나온 뒤 살짝 줄어든다
    const R = w.size * pop;
    const sx = w.x - this.camX;
    c.save();
    c.translate(sx, w.y);
    c.rotate(w.ang + k * 0.35);
    c.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    c.beginPath();
    const n = w.spikes * 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = i % 2 ? R * 0.52 : R;
      c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    c.closePath();
    c.fillStyle = `hsl(${w.hue},100%,62%)`;
    c.fill();
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, R * 0.1);
    c.strokeStyle = '#fff';
    c.stroke();
    c.beginPath();                                   // 안쪽 밝은 심
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = (i % 2 ? R * 0.52 : R) * 0.58;
      c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    c.closePath();
    c.fillStyle = 'rgba(255,250,200,.95)';
    c.fill();
    c.restore();

    if (w.text) {
      c.save();
      c.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      c.translate(sx, w.y - R * 0.05);
      c.rotate(-0.12);
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `900 ${Math.round(R * 0.62)}px Jua, Gothic A1, sans-serif`;
      c.lineJoin = 'round';
      c.lineWidth = Math.max(3, R * 0.14);
      c.strokeStyle = '#7a1230';
      c.strokeText(w.text, 0, 0);
      c.fillStyle = '#fff';
      c.fillText(w.text, 0, 0);
      c.restore();
    }
  }

  drawObstacle(c, o) {
    const sx = o.x - this.camX;
    if (sx < -350 || sx > this.W + 350) return;

    switch (o.kind) {
      case 'spinner': {
        c.save();
        if (o.edge) {                       // 트랙 밖에서 도는 바는 트랙 안쪽만 보인다
          c.beginPath(); c.rect(0, this.top, this.W, this.trackH); c.clip();
        }
        c.lineCap = 'round';
        const arm = (k, off) => {
          const a = o.ang + (k * Math.PI) / o.arms;
          const hx = Math.cos(a) * o.len, hy = Math.sin(a) * o.len;
          c.beginPath();
          c.moveTo(sx - hx, o.y - hy + off);
          c.lineTo(sx + hx, o.y + hy + off);
          c.stroke();
        };
        c.strokeStyle = 'rgba(0,0,0,.3)';
        c.lineWidth = o.thick * 2 + 6;
        for (let k = 0; k < o.arms; k++) arm(k, 4);
        c.strokeStyle = o.arms > 1 ? '#ff8c42' : '#ff4d6d';
        c.lineWidth = o.thick * 2;
        for (let k = 0; k < o.arms; k++) arm(k, 0);
        c.fillStyle = '#ffe17a';
        c.beginPath(); c.arc(sx, o.y, o.thick * 0.95, 0, Math.PI * 2); c.fill();
        c.restore();
        if (o.edge) {                       // 가장자리에 박힌 축
          c.fillStyle = '#ffe17a';
          c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2;
          c.beginPath(); c.arc(sx, o.y, o.thick * 1.25, 0, Math.PI * 2); c.fill(); c.stroke();
        }
        break;
      }
      case 'hammer': {
        const y = o.y0 + Math.sin(o.ph) * o.amp;
        c.strokeStyle = 'rgba(255,255,255,.18)';
        c.lineWidth = 3;
        c.beginPath(); c.moveTo(sx, o.y0 - o.amp); c.lineTo(sx, o.y0 + o.amp); c.stroke();
        const g = c.createRadialGradient(sx - o.rad * 0.3, y - o.rad * 0.3, 1, sx, y, o.rad);
        g.addColorStop(0, '#ff9ab0'); g.addColorStop(1, '#e01e4a');
        c.fillStyle = g;
        c.beginPath(); c.arc(sx, y, o.rad, 0, Math.PI * 2); c.fill();
        break;
      }
      case 'saw': {
        const y = o.y0 + Math.sin(o.ph) * o.amp;
        c.save();
        c.translate(sx, y); c.rotate(o.spin);
        c.fillStyle = '#c8d6ff';
        c.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          const rr = i % 2 ? o.rad * 0.62 : o.rad;
          c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        c.closePath(); c.fill();
        c.fillStyle = '#6d7ea8';
        c.beginPath(); c.arc(0, 0, o.rad * 0.3, 0, Math.PI * 2); c.fill();
        c.restore();
        break;
      }
      case 'ball': {
        c.save();
        c.translate(sx, o.y); c.rotate(o.roll);
        const g = c.createRadialGradient(-o.rad * 0.3, -o.rad * 0.3, 1, 0, 0, o.rad);
        g.addColorStop(0, '#7ee8ff'); g.addColorStop(1, '#1b7fa8');
        c.fillStyle = g;
        c.beginPath(); c.arc(0, 0, o.rad, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,.35)';
        c.fillRect(-o.rad, -2.5, o.rad * 2, 5);
        c.restore();
        break;
      }
      case 'drop': {
        const landT = o.warn + o.fall;
        if (o.t < landT) {
          // 경고 그림자 + 떨어지는 공
          const warnK = clamp(o.t / o.warn, 0, 1);
          c.save();
          c.strokeStyle = `hsla(${o.hue},100%,60%,${0.35 + warnK * 0.5})`;
          c.lineWidth = 2.5;
          c.setLineDash([6, 5]);
          c.beginPath(); c.arc(sx, o.y, o.rad * (1.5 - warnK * 0.5), 0, Math.PI * 2); c.stroke();
          c.restore();
          c.fillStyle = 'rgba(0,0,0,.34)';
          c.beginPath(); c.ellipse(sx, o.y, o.rad * 0.85, o.rad * 0.3, 0, 0, Math.PI * 2); c.fill();

          if (o.t > o.warn) {
            const k = (o.t - o.warn) / o.fall;
            const hgt = (1 - k) * this.trackH * 1.15;
            c.fillStyle = `hsl(${o.hue},95%,60%)`;
            c.beginPath(); c.arc(sx, o.y - hgt, o.rad, 0, Math.PI * 2); c.fill();
            c.globalAlpha = 0.35;
            c.fillRect(sx - o.rad * 0.35, o.y - hgt, o.rad * 0.7, hgt);
            c.globalAlpha = 1;
          }
        } else {
          // 착지한 덩어리
          const k = clamp((o.t - landT) / o.live, 0, 1);
          const sq = 1 + Math.sin(k * Math.PI) * 0.22;
          c.globalAlpha = 1 - k * 0.35;
          const g2 = c.createRadialGradient(sx - o.rad * 0.3, o.y - o.rad * 0.3, 1, sx, o.y, o.rad);
          g2.addColorStop(0, `hsl(${o.hue},100%,72%)`);
          g2.addColorStop(1, `hsl(${o.hue},90%,42%)`);
          c.fillStyle = g2;
          c.beginPath(); c.ellipse(sx, o.y, o.rad * sq, o.rad / sq, 0, 0, Math.PI * 2); c.fill();
          c.globalAlpha = 1;
        }
        break;
      }
      case 'wall': {
        c.fillStyle = '#4b5fa8';
        const gTop = o.gapY - o.gapH / 2, gBot = o.gapY + o.gapH / 2;
        c.fillRect(sx, this.top, o.w, gTop - this.top);
        c.fillRect(sx, gBot, o.w, this.bot - gBot);
        c.fillStyle = '#ff4d6d';
        c.fillRect(sx - 2, gTop - 7, o.w + 4, 7);
        c.fillRect(sx - 2, gBot, o.w + 4, 7);
        break;
      }
    }
  }

  drawRunner(c, R, ghost) {
    let sx = R.x - this.camX;
    if (sx < -90 || sx > this.W + 90) return;
    const r = this.r;
    const hurt = !ghost && R.hurt > 0 ? clamp(R.hurt / 0.55, 0, 1) : 0;   // 맞은 직후 1 -> 0
    if (hurt) sx += Math.sin(this.time * 70) * r * 0.14 * hurt;             // 부르르 떤다
    if (!ghost && R.heldBy) sx += Math.sin(this.time * 45) * r * 0.1;       // 버둥버둥
    const cel = !ghost && R.cel ? R.cel : null;                  // 세레모니 자세
    if (cel) sx += cel.dx * r;
    const h = ghost ? 0 : this.heightOf(R);                      // 떠 있는 높이(px)
    const S = ghost ? 1 : this.scaleOf(R);                       // 뜨면 커진다
    const carried = !ghost && !!(R.heldBy || R.flight);          // 들려 있거나 던져진 중
    const air = ghost || carried ? 0 : clamp(h / (r * 3.3), 0, 1); // 점프 느낌(길쭉, 빛남)
    const hs = clamp(h / (r * 3.3), 0, 1);                       // 그림자가 줄어드는 정도
    const dz = !ghost && R.dizzy > 0;
    const scared = !ghost && !R.heldBy && R.fear > 0.45 && R.dizzy <= 0;   // 괴물이 코앞이라 겁먹음
    const strug = !ghost && !!R.heldBy;                          // 들려서 버둥거리는 중
    const sqz = !ghost ? Math.max(clamp(R.squash / 0.35, 0, 1), R.carry ? 0.5 : 0, cel ? cel.sq : 0) : 0;   // 밟혀/무거워 납작
    const hop = ghost || carried ? 0 : cel ? cel.hop * r : Math.abs(Math.sin(R.bob)) * r * 0.42;
    const y = R.y - hop - h + sqz * r * 0.3;

    // 그림자 (뜰수록 작아진다)
    if (!ghost && !R.heldBy) {
      c.fillStyle = `rgba(0,0,0,${0.34 - hs * 0.2})`;
      c.beginPath();
      c.ellipse(sx, R.y + r * 0.82, r * (0.85 - hs * 0.35), r * (0.3 - hs * 0.12), 0, 0, Math.PI * 2);
      c.fill();
    }

    // 던져지면 빙글 돌고, 기절하면 좌우로 휘청인다
    c.save();
    if (S !== 1 || cel) {                                        // 몸 한가운데를 기준으로 키우고(뒤집고, 돌리고)
      c.translate(sx, y);
      c.scale(S * (cel ? cel.flipX : 1), S);
      if (cel && cel.rot) c.rotate(cel.rot);
      c.translate(-sx, -y);
    }
    if (R.flight && !ghost) {
      c.translate(sx, y); c.rotate(R.spin); c.translate(-sx, -y);
    } else if (strug) {
      c.translate(sx, y); c.rotate(Math.sin(this.time * 20 + R.bob) * 0.4); c.translate(-sx, -y);
    } else if (dz) {
      const wob = Math.sin(this.time * 7 + R.bob) * 0.22 * Math.min(R.dizzy / 0.3, 1);
      c.translate(sx, y + r); c.rotate(wob); c.translate(-sx, -(y + r));
    }

    // 대쉬 중이면 뒤로 빛줄기
    if (!ghost && R.dash > 0) {
      c.save();
      c.globalAlpha = 0.5;
      c.fillStyle = `hsl(${R.hue},95%,70%)`;
      c.beginPath();
      c.moveTo(sx - r * 0.6, y - r * 0.55);
      c.lineTo(sx - r * 3.4, y);
      c.lineTo(sx - r * 0.6, y + r * 0.55);
      c.closePath(); c.fill();
      c.restore();
    }

    // 다리 (공중에서는 접는다)
    if (!ghost && air < 0.25) {
      c.strokeStyle = `hsl(${R.hue},55%,38%)`;
      c.lineWidth = r * 0.34; c.lineCap = 'round';
      const sw = strug ? Math.sin(this.time * 30) * r * 0.9
        : cel && cel.legSw !== undefined ? cel.legSw * r
        : cel && cel.legAmp !== undefined ? Math.sin(cel.legPh) * r * cel.legAmp
        : Math.sin(R.bob) * r * 0.55;
      c.beginPath();
      c.moveTo(sx - r * 0.28, y + r * 0.55); c.lineTo(sx - r * 0.28 + sw, y + r * 1.05);
      c.moveTo(sx + r * 0.28, y + r * 0.55); c.lineTo(sx + r * 0.28 - sw, y + r * 1.05);
      c.stroke();
    }

    const L = R.look;
    const dark = `hsl(${R.hue},70%,42%)`;

    // 꼬리 (엉덩이에서 뒤로 뻗어 끝이 살짝 들리고, 물결치듯 살랑거린다)
    if (L.tail) {
      const N = 10, len = r * 1.75, ph = R.bob * 1.7;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const sway = Math.sin(ph - t * 2.4) * r * 0.34 * Math.pow(t, 1.5); // 끝으로 갈수록 크게, 늦게 흔들린다
        pts.push({
          x: sx - r * 0.7 - len * t,
          y: y + r * 0.3 + r * (0.2 * Math.sin(t * Math.PI * 0.9) - 0.55 * t * t) + sway,
          w: r * (0.15 + 0.03 * (1 - t) * (1 - t)),                           // 굵기는 거의 고르게
        });
      }
      const side = [[], []];
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        side[0].push([p.x - dy / d * p.w, p.y + dx / d * p.w]);
        side[1].push([p.x + dy / d * p.w, p.y - dx / d * p.w]);
      });
      c.fillStyle = dark;
      c.beginPath();
      side[0].forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
      const tip = pts[N], th = Math.atan2(tip.y - pts[N - 1].y, tip.x - pts[N - 1].x);
      c.arc(tip.x, tip.y, tip.w, th + Math.PI / 2, th - Math.PI / 2, true);    // 끝은 둥글게 (U자를 눕힌 모양)
      for (let i = N; i >= 0; i--) c.lineTo(side[1][i][0], side[1][i][1]);
      c.closePath(); c.fill();
      // 줄무늬 (꼬리 모양 안쪽으로만 칠한다)
      if (L.tailStripes) {
        c.save();
        c.clip();
        c.strokeStyle = `hsl(${R.hue},85%,78%)`;
        c.lineWidth = r * 0.16; c.lineCap = 'butt';
        c.beginPath();
        for (const i of [3, 5, 7, 9]) {
          const [ax, ay] = side[0][i], [bx, by] = side[1][i];
          const ex = (bx - ax) * 0.6, ey = (by - ay) * 0.6;
          c.moveTo(ax - ex, ay - ey); c.lineTo(bx + ex, by + ey);
        }
        c.stroke();
        c.restore();
      }
    }

    // 귀 (몸 뒤에 먼저 그린다)
    if (L.ears !== 'none') {
      const panda = L.ears === 'panda';
      c.fillStyle = panda ? '#232842' : dark;
      if (L.ears === 'dog') {
        for (const s of [-1, 1]) {
          c.beginPath();
          c.ellipse(sx + s * r * 0.86, y + r * 0.08, r * 0.3, r * 0.66, s * 0.32, 0, Math.PI * 2);
          c.fill();
        }
      } else if (panda) {
        c.strokeStyle = '#fff';                        // 짙은 배경에 묻히지 않게 흰 테두리
        c.lineWidth = Math.max(1.5, r * 0.1);
        for (const s of [-1, 1]) {
          c.beginPath();
          c.arc(sx + s * r * 0.72, y - r * 0.82, r * 0.42, 0, Math.PI * 2);
          c.fill(); c.stroke();
        }
      } else {
        const tall = L.ears === 'fox' ? 1.85 : 1.35;   // 여우 귀가 더 길다
        for (const s of [-1, 1]) {
          c.beginPath();
          c.moveTo(sx + s * r * 0.78, y - r * 0.45);
          c.lineTo(sx + s * r * 0.16, y - r * 0.72);
          c.lineTo(sx + s * r * 0.66, y - r * tall);
          c.closePath(); c.fill();
          if (L.ears === 'fox') {                      // 귀 안쪽
            c.fillStyle = `hsl(${R.hue},90%,80%)`;
            c.beginPath();
            c.moveTo(sx + s * r * 0.66, y - r * 0.58);
            c.lineTo(sx + s * r * 0.36, y - r * 0.72);
            c.lineTo(sx + s * r * 0.62, y - r * 1.45);
            c.closePath(); c.fill();
            c.fillStyle = dark;
          }
        }
      }
    }

    // 몸 (공중이면 길쭉하게 늘어나고 하얗게 빛난다)
    // 커지는 것(S)이 점프의 주된 표현이라 길쭉하게 늘이는 건 조금만
    const rx = r * (1 - air * 0.07 + sqz * 0.35), ry = r * (1 + air * 0.1 - sqz * 0.35);
    const g = c.createRadialGradient(sx - r * 0.35, y - r * 0.4, 1, sx, y, r * 1.25);
    g.addColorStop(0, `hsl(${R.hue},95%,${76 + air * 18}%)`);
    g.addColorStop(1, `hsl(${R.hue},80%,${48 + air * 22}%)`);
    if (air > 0) { c.shadowColor = `hsl(${R.hue},100%,72%)`; c.shadowBlur = 18 * air; }
    c.fillStyle = g;
    c.beginPath(); c.ellipse(sx, y, rx, ry, 0, 0, Math.PI * 2); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = air > 0.15 ? `rgba(255,255,255,${0.35 + air * 0.55})` : 'rgba(0,0,0,.28)';
    c.lineWidth = air > 0.15 ? 2.4 : 1.6;
    c.stroke();
    if (hurt > 0) {                                  // 하얗게 번쩍
      c.fillStyle = `rgba(255,255,255,${Math.min(hurt * 1.2, 1) * 0.75})`;
      c.beginPath(); c.ellipse(sx, y, rx, ry, 0, 0, Math.PI * 2); c.fill();
    }

    // 점박이 무늬
    if (L.spots) {
      c.fillStyle = `hsla(${R.hue},65%,30%,.5)`;
      c.beginPath(); c.arc(sx - r * 0.44, y + r * 0.34, r * 0.23, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(sx + r * 0.42, y + r * 0.46, r * 0.16, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(sx + r * 0.52, y - r * 0.44, r * 0.12, 0, Math.PI * 2); c.fill();
    }

    // 눈 (뛸 때는 질끈 감는다. 윙크하는 아이도 있다)
    const shutLine = (x0, x1) => {
      c.beginPath(); c.moveTo(x0, y - r * 0.18); c.lineTo(x1, y - r * 0.18); c.stroke();
    };
    c.fillStyle = '#16203c';
    c.strokeStyle = '#16203c';
    c.lineWidth = Math.max(1.5, r * 0.13);
    c.lineCap = 'round';
    if (cel) {                                       // 신나서 ^ ^
      c.lineWidth = Math.max(2, r * 0.15);
      for (const ex of [sx + r * 0.27, sx - r * 0.27]) {
        c.beginPath(); c.arc(ex, y - r * 0.08, r * 0.17, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
      }
    } else if (strug || scared) {                    // 당황: 휘둥그레진 눈
      c.fillStyle = '#fff';
      for (const ex of [sx + r * 0.26, sx - r * 0.26]) {
        c.beginPath(); c.arc(ex, y - r * 0.18, r * 0.22, 0, Math.PI * 2); c.fill(); c.stroke();
      }
      c.fillStyle = '#16203c';
      const jit = Math.sin(this.time * 31) * r * 0.05;
      for (const ex of [sx + r * 0.26, sx - r * 0.26]) {
        c.beginPath(); c.arc(ex + jit, y - r * 0.18, r * 0.09, 0, Math.PI * 2); c.fill();
      }
    } else if (dz) {                                 // 기절: X 눈
      const xEye = (ex, ey) => {
        const q = r * 0.13;
        c.beginPath();
        c.moveTo(ex - q, ey - q); c.lineTo(ex + q, ey + q);
        c.moveTo(ex + q, ey - q); c.lineTo(ex - q, ey + q);
        c.stroke();
      };
      xEye(sx + r * 0.24, y - r * 0.12);
      xEye(sx - r * 0.24, y - r * 0.12);
    } else if (air > 0.45 || hurt > 0.2) {
      shutLine(sx + r * 0.08, sx + r * 0.36);
      shutLine(sx - r * 0.38, sx - r * 0.1);
    } else {
      c.beginPath(); c.arc(sx + r * 0.22, y - r * 0.16, r * 0.15, 0, Math.PI * 2); c.fill();
      if (L.wink) shutLine(sx - r * 0.38, sx - r * 0.1);
      else { c.beginPath(); c.arc(sx - r * 0.24, y - r * 0.16, r * 0.15, 0, Math.PI * 2); c.fill(); }
    }

    // 입
    if (cel) {                                       // 활짝 웃는 입
      c.fillStyle = '#16203c';
      c.beginPath(); c.arc(sx, y + r * 0.12, r * 0.34, 0, Math.PI); c.closePath(); c.fill();
      c.fillStyle = '#ff7a8a';
      c.beginPath(); c.ellipse(sx, y + r * 0.42, r * 0.17, r * 0.1, 0, 0, Math.PI * 2); c.fill();
    } else if (L.mouth === 'smile' && air < 0.45 && !dz && !strug && !scared) {
      c.lineWidth = Math.max(1.3, r * 0.11);
      c.beginPath(); c.arc(sx, y + r * 0.1, r * 0.3, 0.18 * Math.PI, 0.82 * Math.PI); c.stroke();
    } else if (L.mouth === 'open' || hurt > 0.2 || dz || strug || scared) {
      c.fillStyle = '#16203c';
      c.beginPath();
      c.ellipse(sx, y + r * 0.3, r * 0.18, r * (air > 0.3 ? 0.3 : 0.2), 0, 0, Math.PI * 2);
      c.fill();
    }

    // 맞거나 기절하면 머리 위로 별이 빙글빙글
    const starK = Math.max(hurt > 0.1 ? Math.min(hurt * 2, 1) : 0, dz ? Math.min(R.dizzy / 0.35, 1) : 0);
    if (starK > 0) {
      const n = dz ? 4 : 3;
      c.fillStyle = '#ffe14a';
      c.strokeStyle = 'rgba(120,70,0,.8)';
      c.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const a = this.time * (dz ? 6.5 : 9) + (i * Math.PI * 2) / n;
        const stx = sx + Math.cos(a) * r * (dz ? 1.2 : 0.95);
        const sty = y - r * (dz ? 1.1 : 1.4) + Math.sin(a) * r * (dz ? 0.34 : 0.32);
        const sr = r * (dz ? 0.46 : 0.3) * starK;
        c.save();
        c.translate(stx, sty); c.rotate(a * 1.3);
        c.beginPath();
        for (let j = 0; j < 10; j++) {
          const aa = (j / 10) * Math.PI * 2;
          const rr = j % 2 ? sr * 0.45 : sr;
          c.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
        }
        c.closePath(); c.fill(); c.stroke();
        c.restore();
      }
    }

    // 휘두르는 팔
    if (!ghost && R.punch > 0) {
      const k = 1 - R.punch / R.punchT;                 // 0 -> 1
      const ang = -1.15 + k * 2.3;
      const len = r * (1.05 + Math.sin(k * Math.PI) * 1.15);
      const ax = sx + Math.cos(ang) * len, ay = y + Math.sin(ang) * len;
      c.strokeStyle = 'rgba(255,255,255,.4)';           // 쓸고 지나간 자리
      c.lineWidth = r * 0.26; c.lineCap = 'round';
      c.beginPath(); c.arc(sx, y + r * 0.1, r * 1.9, -1.15, ang); c.stroke();
      c.strokeStyle = dark;
      c.lineWidth = r * 0.36; c.lineCap = 'round';
      c.beginPath(); c.moveTo(sx, y + r * 0.1); c.lineTo(ax, ay); c.stroke();
      c.fillStyle = `hsl(${R.hue},95%,66%)`;
      c.beginPath(); c.arc(ax, ay, r * 0.44, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.5; c.stroke();
    }

    // 들려서 허공에 휘젓는 팔
    if (strug) {
      c.strokeStyle = dark;
      c.lineWidth = r * 0.32; c.lineCap = 'round';
      for (const sd of [-1, 1]) {
        const a = this.time * 26 + (sd > 0 ? 0 : 2.2);
        const hx = sx + sd * r * 0.8 + sd * Math.cos(a) * r * 0.85, hy = y + r * 0.1 + Math.sin(a) * r * 0.85;
        c.beginPath(); c.moveTo(sx + sd * r * 0.75, y + r * 0.1); c.lineTo(hx, hy); c.stroke();
        c.fillStyle = `hsl(${R.hue},95%,66%)`;
        c.beginPath(); c.arc(hx, hy, r * 0.26, 0, Math.PI * 2); c.fill();
      }
    }

    // 머리 위로 번쩍 든 두 팔 (던지기 직전엔 뒤로 젖힌다)
    if (!ghost && R.carry) {
      const up = clamp(R.liftT / 0.4, 0, 1), wk = this.windup(R);
      c.strokeStyle = dark;
      c.lineWidth = r * 0.36; c.lineCap = 'round';
      for (const sd of [-1, 1]) {
        const hx = sx + sd * r * (0.85 - 0.25 * up) - r * 0.6 * wk, hy = y - r * (0.2 + 1.1 * up);
        c.beginPath(); c.moveTo(sx + sd * r * 0.7, y + r * 0.1); c.lineTo(hx, hy); c.stroke();
        c.fillStyle = `hsl(${R.hue},95%,66%)`;
        c.beginPath(); c.arc(hx, hy, r * 0.3, 0, Math.PI * 2); c.fill();
      }
    }
    // 세레모니 팔 (춤마다 모양이 다르다)
    if (cel && cel.arms) {
      c.strokeStyle = dark;
      c.lineWidth = r * 0.36; c.lineCap = 'round'; c.lineJoin = 'round';
      for (const sd of [-1, 1]) {
        const [ex, ey, hx, hy] = celHands(cel, sd, r, sx, y);
        c.beginPath(); c.moveTo(sx + sd * r * 0.75, y + r * 0.1);
        if (ex !== null) c.lineTo(ex, ey);
        c.lineTo(hx, hy); c.stroke();
        c.fillStyle = `hsl(${R.hue},95%,66%)`;
        c.beginPath(); c.arc(hx, hy, r * 0.3, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
  }

  /**
   * 이름표는 몸을 다 그린 뒤 한꺼번에 그린다.
   *
   * 뭉쳐 있을 때 이름표가 정신없이 튀지 않도록 세 가지를 지킨다.
   *  - 달릴 때의 통통거림(bob)은 빼고 지면 기준으로 붙인다.
   *  - 자리 다툼은 늘 같은 순서(seq)로, 흔들리지 않는 '목표 위치'만 보고 푼다.
   *  - 자리가 바뀌면 순간이동하지 않고 스르르 옮긴다.
   */
  drawLabels(c, list) {
    const boxes = [];
    c.textAlign = 'center';
    const ease = 1 - Math.pow(0.002, this._dt || 1 / 60);
    const ordered = list.slice().sort((a, b) => a.seq - b.seq);

    for (const R of ordered) {
      const sx = R.x - this.camX + (R.cel ? R.cel.dx * this.r : 0);
      if (sx < -90 || sx > this.W + 90) continue;
      const r = this.r;
      const big = this.phase === 'done' && R === this.winner;
      const fs = big ? Math.max(24, r * 1.5) : Math.max(13, r * 0.8);
      c.font = `700 ${fs}px Gothic A1, sans-serif`;
      const w = c.measureText(R.name).width;

      // 점프는 완만한 곡선이라 따라가도 되지만, bob 은 너무 빨라 뺀다.
      // 아이를 들고 있으면 이름표는 머리 위 아이보다 더 위로
      const headY = R.y - this.heightOf(R) - r * this.scaleOf(R) - (R.carry ? r * 2.1 * clamp(R.liftT / 0.4, 0, 1) : 0);
      const baseTy = headY - fs * 0.5;

      // 빈 칸 찾기. 위로만 쌓으면 탑이 되므로 옆으로 비키는 쪽을 먼저 본다.
      // 판단은 흔들리지 않는 '목표 위치'로만 한다.
      const lane = w * 0.6 + 12;
      let bestX = sx, bestY = baseTy, bestCost = Infinity;
      for (let s = 0; s < 6; s++) {
        for (const d of [0, 1, -1, 2, -2]) {
          const cost = s + Math.abs(d) * 0.75;
          if (cost >= bestCost) continue;
          const x = sx + d * lane;
          const y = baseTy - s * fs * 1.06;
          const clash = boxes.some((b) =>
            Math.abs(b.x - x) < (b.w + w) / 2 + 5 && Math.abs(b.y - y) < fs * 0.98);
          if (!clash) { bestCost = cost; bestX = x; bestY = y; }
        }
      }
      boxes.push({ x: bestX, y: bestY, w });

      // 실제로 그리는 자리는 부드럽게 따라간다
      if (R.labelOX === undefined) { R.labelOX = bestX - sx; R.labelOY = bestY - baseTy; }
      R.labelOX += (bestX - sx - R.labelOX) * ease;
      R.labelOY += (bestY - baseTy - R.labelOY) * ease;
      const lx = sx + R.labelOX, ly = baseTy + R.labelOY;

      // 몸에서 떨어졌으면 가는 선으로 이어 준다
      if (headY - ly > fs * 1.15 || Math.abs(R.labelOX) > w * 0.3) {
        c.strokeStyle = `hsla(${R.hue},90%,72%,.5)`;
        c.lineWidth = Math.max(1, r * 0.07);
        c.beginPath();
        c.moveTo(lx, ly + fs * 0.22);
        c.lineTo(sx, headY - r * 0.1);
        c.stroke();
      }

      c.lineWidth = Math.max(3, fs * 0.26);
      c.strokeStyle = 'rgba(6,9,20,.85)';
      c.strokeText(R.name, lx, ly);
      c.fillStyle = big ? '#ffd23f' : '#fff';
      c.fillText(R.name, lx, ly);
    }
  }
}

/**
 * 당첨 화면에서 이름 위에 서서 세레모니를 계속하는 우승자.
 * 레이스 화면의 그리기 코드를 그대로 빌려 쓰므로 생김새가 똑같다.
 */
class WinHero {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.raf = 0;
    this.running = false;
  }

  start(runner) {
    this.stop();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const S = this.cv.clientWidth || 240;
    this.cv.width = this.cv.height = Math.round(S * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const view = Object.create(RaceGame.prototype);       // 그리기 도구만 빌린다
    view.r = S * 0.11; view.W = view.H = S; view.camX = 0; view.time = 0;
    this.view = view;
    this.R = Object.assign({}, runner, {
      x: S / 2, y: S * 0.8, cel: null,
      dash: 0, jump: 0, stomp: null, heldBy: null, flight: null, carry: null,
      punch: 0, hurt: 0, dizzy: 0, squash: 0, fear: 0, spin: 0,
    });
    this.cer = new Ceremony(runner.dance);              // 레이스 끝에서 추던 그 춤
    this.t = 0;
    this.last = performance.now();
    this.running = true;
    const tick = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min((now - this.last) / 1000, 1 / 24);
      this.last = now;
      this.t += dt;
      view.time += dt;
      const R = this.R;
      R.cel = this.cer.pose(this.t);
      R.bob += dt * R.cel.bobSpeed;
      this.ctx.clearRect(0, 0, S, S);
      view.drawRunner(this.ctx, R, false);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

window.RaceGame = RaceGame;
window.WinHero = WinHero;
