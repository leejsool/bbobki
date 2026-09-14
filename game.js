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
    spots: ((h >>> 7) % 4) === 0,
    mouth: MOUTHS[(h >>> 11) % MOUTHS.length],
    wink: ((h >>> 17) % 4) === 0,
  };
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
    for (const R of this.runners) { R.y = map(R.y); R.targetY = map(R.targetY); R.vy *= k; }
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
    this.particles = [];
    this.rings = [];
    this.obstacles = [];
    this.dropCd = rnd(3, 6);
    this.frontier = 620;
    this.order = [];                       // 탈락 역순 = 순위

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
        no: m.no,
        name: m.name,
        look: looksOf(m.name),
        x: -col * this.r * 3.2,
        y: this.top + this.trackH * ((inCol + 0.5) / per),
        vy: 0,
        alive: true,
        hue: (i * 360) / n + rnd(-8, 8),
        speed: rnd(0.93, 1.09),            // 타고난 발 빠르기
        skill: rnd(0.35, 1),               // 장애물 감지 능력
        bob: rnd(0, Math.PI * 2),
        targetY: 0,
        think: rnd(0, 0.2),
        stun: 0,
        dash: 0, dashCd: rnd(0.6, 3),      // 치고 나가기
        jump: 0, jumpT: 0.5, jumpCd: 0,    // 뛰어넘기
        nerve: rnd(0.3, 0.95),             // 점프를 시도하는 배짱
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
      // 우승자가 혼자 달려나가는 연출
      if (this.winner) {
        this.winner.x += 190 * dt;
        this.winner.bob += dt * 12;
      }
      this.camX = lerp(this.camX, (this.winner ? this.winner.x : 0) - this.W * 0.4, 1 - Math.pow(0.001, dt));
      this.stepParticles(dt);
      if (this.time - this.finishedAt > 1.7 && !this._told) {
        this._told = true;
        if (this.opts.onWin) this.opts.onWin(this.winner, this.order);
      }
      return;
    }

    /* --- 난이도: 거리 + 안 죽고 버틴 시간 --- */
    const stall = clamp((this.time - this.lastElimAt - 4) / 10, 0, 1);
    const diff = clamp(this.dist / 14000, 0, 1);
    const heat = clamp(diff * 0.75 + stall * 0.6 + (this.alive <= 4 ? 0.45 : 0), 0, 1.35);

    this.announceStage();
    this.spawnAhead(heat);

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
        this.dropCd = rnd(2.2, 4.6) / (0.65 + heat);
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

      const lagRatio = clamp((leadX - R.x) / band, 0, 1);

      /* 점프: 낮은 장애물이 코앞이면 배짱껏 뛰어넘는다 */
      if (R.jump > 0) {
        R.jump -= dt;
        if (R.jump <= 0) { R.jump = 0; this.puff(R, 0.8); }   // 착지 먼지
      } else {
        if (R.jumpCd > 0) R.jumpCd -= dt;
        if (R.jumpCd <= 0) {
          const threat = this.threat(R);
          if (threat && LOW.has(threat)) {
            if (Math.random() < R.nerve) {
              R.jumpT = rnd(0.55, 0.72);
              R.jump = R.jumpT;
              R.jumpCd = rnd(0.55, 1.05);
              this.puff(R, 1);                                // 도약 먼지 + 링
            } else {
              R.jumpCd = 0.35;              // 머뭇거렸다
            }
          }
        }
      }

      /* 대쉬: 뒤처져 있을수록 자주 터진다 */
      if (R.dash > 0) {
        R.dash -= dt;
      } else {
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

      R.think -= dt;
      if (R.think <= 0) {
        R.think = rnd(0.09, 0.2);
        R.targetY = this.chooseY(R, baseSpeed);
      }

      // 세로 이동 (공중에서는 방향을 못 바꾼다)
      const dy = R.targetY - R.y;
      const agility = (260 + 200 * R.skill) * (R.jump > 0 ? 0.25 : 1);
      R.vy = lerp(R.vy, clamp(dy * 5, -agility, agility), 1 - Math.pow(0.002, dt));
      R.y = clamp(R.y + R.vy * dt, this.top + this.r, this.bot - this.r);

      // 앞으로. 뒤처질수록 빨라지고 앞서면 조금 느려져서
      // 무리가 한 화면에 머문다 -> 모두가 같은 장애물을 만난다.
      if (R.stun > 0) R.stun -= dt;
      const sp = baseSpeed * R.speed
        * (0.80 + lagRatio * 0.44)
        * (R.dash > 0 ? 1.85 : 1)
        * (R.stun > 0 ? 0.35 : 1);
      R.x += sp * dt;
      R.bob += dt * (7 + sp * 0.02);
      if (R.dash > 0 && Math.random() < 0.5) this.trail(R);

      // 충돌 (공중이면 낮은 장애물은 넘어간다. 벽과 해머는 못 넘는다)
      for (const o of this.obstacles) {
        if (Math.abs(o.x - R.x) > 260) continue;
        if (R.jump > 0 && LOW.has(o.kind)) continue;
        if (this.hits(o, R)) { hitNow.push(R); break; }
      }
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
      this.phase = 'done';
      this.finishedAt = this.time;
      if (this.winner) this.order.unshift(this.winner);
      this.burst(this.winner ? this.winner.x : this.dist, this.winner ? this.winner.y : this.H / 2, 46, 50);
      if (this.opts.onStage) this.opts.onStage('생존!');
    }
  }

  eliminate(R) {
    R.alive = false;
    R.deadAt = this.time;
    this.alive--;
    this.lastElimAt = this.time;
    this.order.unshift(R);
    this.burst(R.x, R.y, R.hue, 16);
    if (this.opts.onEliminate) this.opts.onEliminate(R, this.alive);
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
      const gap = lerp(540, 265, clamp(heat, 0, 1)) * rnd(0.82, 1.24);
      this.frontier += gap;
    }
  }

  makeObstacle(kind, x, heat) {
    const T = this.top, B = this.bot, Hh = this.trackH;
    switch (kind) {
      case 'spinner': {
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
    const ahead = this.obstacles.filter((o) => o.x > R.x - 170 && o.x < R.x + 520);
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
  }

  /* ===== 그리기 ===== */
  draw() {
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);

    /* 배경 */
    const sky = c.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#151d3c');
    sky.addColorStop(1, '#0a0e20');
    c.fillStyle = sky;
    c.fillRect(0, 0, W, H);

    /* 트랙 */
    c.fillStyle = '#1d2749';
    c.fillRect(0, this.top, W, this.trackH);

    // 흐르는 줄무늬
    c.fillStyle = 'rgba(255,255,255,.028)';
    const step = 130;
    const off = -(this.camX % step);
    for (let x = off - step; x < W + step; x += step * 2) c.fillRect(x, this.top, step, this.trackH);

    // 가장자리
    c.fillStyle = '#ffd23f';
    c.fillRect(0, this.top - 4, W, 4);
    c.fillRect(0, this.bot, W, 4);

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
      c.globalAlpha = (1 - age / 1.1) * 0.5;
      this.drawRunner(c, R, true);
      c.globalAlpha = 1;
    }

    /* 달리는 아이들 */
    const list = this.runners.filter((r) => r.alive).sort((a, b) => a.y - b.y);
    for (const R of list) this.drawRunner(c, R, false);
    this.drawLabels(c, list);

    /* 충격파 링 (도약·착지) */
    for (const g of this.rings) {
      const k = g.age / g.life;
      c.globalAlpha = (1 - k) * 0.75;
      c.strokeStyle = `hsl(${g.hue},95%,78%)`;
      c.lineWidth = 3 * (1 - k) + 1;
      c.beginPath();
      c.ellipse(g.x - this.camX, g.y, g.r0 + k * this.r * 3.4, (g.r0 + k * this.r * 3.4) * 0.36, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;

    /* 파티클 */
    for (const p of this.particles) {
      c.globalAlpha = 1 - p.age / p.life;
      c.fillStyle = `hsl(${p.hue},90%,64%)`;
      c.beginPath();
      c.arc(p.x - this.camX, p.y, p.r, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  drawObstacle(c, o) {
    const sx = o.x - this.camX;
    if (sx < -350 || sx > this.W + 350) return;

    switch (o.kind) {
      case 'spinner': {
        c.save();
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
    const sx = R.x - this.camX;
    if (sx < -90 || sx > this.W + 90) return;
    const r = this.r;
    const air = !ghost && R.jump > 0 ? Math.sin((1 - R.jump / R.jumpT) * Math.PI) : 0;
    const hop = ghost ? 0 : Math.abs(Math.sin(R.bob)) * r * 0.42 + air * r * 3.3;
    const y = R.y - hop;

    // 그림자 (뜰수록 작아진다)
    if (!ghost) {
      c.fillStyle = `rgba(0,0,0,${0.34 - air * 0.2})`;
      c.beginPath();
      c.ellipse(sx, R.y + r * 0.82, r * (0.85 - air * 0.35), r * (0.3 - air * 0.12), 0, 0, Math.PI * 2);
      c.fill();
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
      const sw = Math.sin(R.bob) * r * 0.55;
      c.beginPath();
      c.moveTo(sx - r * 0.28, y + r * 0.55); c.lineTo(sx - r * 0.28 + sw, y + r * 1.05);
      c.moveTo(sx + r * 0.28, y + r * 0.55); c.lineTo(sx + r * 0.28 - sw, y + r * 1.05);
      c.stroke();
    }

    const L = R.look;
    const dark = `hsl(${R.hue},70%,42%)`;

    // 꼬리 (몸 뒤에서 살랑거린다)
    if (L.tail) {
      const wag = Math.sin(R.bob * 1.7) * r * 0.4;
      c.strokeStyle = dark;
      c.lineWidth = r * 0.3; c.lineCap = 'round';
      c.beginPath();
      c.moveTo(sx - r * 0.75, y + r * 0.25);
      c.quadraticCurveTo(sx - r * 1.8, y + r * 0.2 + wag, sx - r * 1.45, y - r * 0.55 + wag);
      c.stroke();
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
        for (const s of [-1, 1]) {
          c.beginPath();
          c.arc(sx + s * r * 0.72, y - r * 0.82, r * 0.42, 0, Math.PI * 2);
          c.fill();
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
    const rx = r * (1 - air * 0.2), ry = r * (1 + air * 0.3);
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
    if (air > 0.45) {
      shutLine(sx + r * 0.08, sx + r * 0.36);
      shutLine(sx - r * 0.38, sx - r * 0.1);
    } else {
      c.beginPath(); c.arc(sx + r * 0.22, y - r * 0.16, r * 0.15, 0, Math.PI * 2); c.fill();
      if (L.wink) shutLine(sx - r * 0.38, sx - r * 0.1);
      else { c.beginPath(); c.arc(sx - r * 0.24, y - r * 0.16, r * 0.15, 0, Math.PI * 2); c.fill(); }
    }

    // 입
    if (L.mouth === 'smile' && air < 0.45) {
      c.lineWidth = Math.max(1.3, r * 0.11);
      c.beginPath(); c.arc(sx, y + r * 0.1, r * 0.3, 0.18 * Math.PI, 0.82 * Math.PI); c.stroke();
    } else if (L.mouth === 'open') {
      c.fillStyle = '#16203c';
      c.beginPath();
      c.ellipse(sx, y + r * 0.3, r * 0.18, r * (air > 0.3 ? 0.3 : 0.2), 0, 0, Math.PI * 2);
      c.fill();
    }

  }

  /** 이름표는 몸을 다 그린 뒤 한꺼번에. 겹치면 위로 밀어 올린다. */
  drawLabels(c, list) {
    const boxes = [];
    c.textAlign = 'center';
    for (const R of list) {
      const sx = R.x - this.camX;
      if (sx < -90 || sx > this.W + 90) continue;
      const r = this.r;
      const air = R.jump > 0 ? Math.sin((1 - R.jump / R.jumpT) * Math.PI) : 0;
      const hop = Math.abs(Math.sin(R.bob)) * r * 0.42 + air * r * 3.3;
      const big = this.phase === 'done' && R === this.winner;
      const fs = big ? Math.max(24, r * 1.5) : Math.max(13, r * 0.8);

      c.font = `700 ${fs}px Gothic A1, sans-serif`;
      const w = c.measureText(R.name).width;
      let ty = R.y - hop - r - fs * 0.5;
      for (let k = 0; k < 9; k++) {
        const clash = boxes.some((b) =>
          Math.abs(b.x - sx) < (b.w + w) / 2 + 5 && Math.abs(b.y - ty) < fs * 0.98);
        if (!clash) break;
        ty -= fs * 1.04;
      }
      boxes.push({ x: sx, y: ty, w });

      c.lineWidth = Math.max(3, fs * 0.26);
      c.strokeStyle = 'rgba(6,9,20,.85)';
      c.strokeText(R.name, sx, ty);
      c.fillStyle = big ? '#ffd23f' : '#fff';
      c.fillText(R.name, sx, ty);
    }
  }
}

window.RaceGame = RaceGame;
