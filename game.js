/* =========================================================
   game.js  -  폴가이즈식 생존 레이스

   달리는 아이들이 회전바 / 해머 / 굴러오는 공 / 벽 틈 / 지뢰를
   피하면서 전진한다. 부딪히면 그 자리에서 탈락.
   뒤에서는 괴물 벽이 꼬리를 바짝 쫓아온다.
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
/** 벽(앞니)의 자리(화면 폭 비율): 출발 직후 -> 마지막 한 명이 남을 무렵. 탈락이 진행되는 만큼 꾸준히 나온다 */
const WALL_FROM = 0.03, WALL_TO = 0.40;
/** 벽이 나오는 가장 빠른 속도 (화면 폭/초) - 한꺼번에 여럿이 탈락해도 쑥 튀어나오지 않게 */
const WALL_SPEED = 0.025;
/** 벽 일부가 튀어나와 무는 공격: 뻗는 거리(화면 폭 비율) / 굵기의 절반(반지름의 몇 배) / 예고 시간(초) */
const STRIKE_REACH = [0.2, 0.3];
const STRIKE_HALF = 1.35;
const STRIKE_WARN = [1.0, 0.7];
/** 부활 하트: 한 판에 나오는 개수 후보 (평균 2) */
const REVIVES = [1, 2, 2, 2, 3];

/** 뛰어넘을 수 있는 '낮은' 장애물. 벽과 해머는 못 넘는다. */
const LOW = new Set(['spinner', 'ball', 'saw']);

/* ---------- 구간(스테이지) 구성 ---------- */
const STAGES = [
  { at: 0,     label: '출발!',            kinds: ['ball'] },
  { at: 1300,  label: '구간 2 · 회전바',   kinds: ['ball', 'spinner'] },
  { at: 3000,  label: '구간 3 · 해머 지대', kinds: ['spinner', 'hammer', 'ball'] },
  { at: 4800,  label: '구간 4 · 좁은 문',   kinds: ['wall', 'hammer', 'spinner', 'ball'] },
  { at: 6800,  label: '구간 5 · 난장판',    kinds: ['wall', 'hammer', 'spinner', 'ball', 'saw'] },
];

/** 이름에서 생김새를 정한다 - 같은 학생은 늘 같은 모습으로 나온다 */
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
// 몸 옆에 늘어지던 강아지 귀는 팔다리를 단 뒤로 옛 팔처럼 보여서 뺐다 (칸 수는 그대로 두어 다른 아이 생김새는 안 바뀐다)
const EARS = ['none', 'none', 'cat', 'fox', 'panda'];
const MOUTHS = ['none', 'smile', 'open'];
const EYES = ['dot', 'big', 'oval', 'dot'];
/* 꾸밈: 귀가 있는 아이는 귀를 가리는 모자를 쓰지 않는다 */
/* 남학교라 리본 자리에 넥타이를 둔다 (칸 위치는 그대로라 다른 아이 꾸밈은 안 바뀐다) */
const ACCS_BARE = ['none', 'cap', 'beanie', 'glasses', 'scarf', 'headband', 'tie', 'cap', 'scarf'];
const ACCS_EARS = ['none', 'glasses', 'scarf', 'tie', 'headband', 'scarf'];
function looksOf(name) {
  const h = hash32(name);
  const h2 = hash32(name + '#');           // 꾸밈은 따로 섞어서 귀·꼬리와 짝지어지지 않게 한다
  const ears = EARS[h % EARS.length];
  const accs = ears === 'none' ? ACCS_BARE : ACCS_EARS;
  const spots = ((h >>> 7) % 4) === 0;
  return {
    ears,
    tail: ((h >>> 3) % 3) === 0,
    tailStripes: ((h >>> 21) % 2) === 0,   // 꼬리가 있는 아이 중 절반은 줄무늬
    spots,
    mouth: MOUTHS[(h >>> 11) % MOUTHS.length],
    wink: ((h >>> 17) % 4) === 0,
    acc: accs[h2 % accs.length],
    accHue: ((h2 >>> 5) % 12) * 30,
    eyes: EYES[(h2 >>> 9) % EYES.length],
    blush: ((h2 >>> 12) % 2) === 0,
    belly: ((h2 >>> 14) % 3) !== 0,
    stripes: !spots && ((h2 >>> 17) % 4) === 0,
  };
}

/* ---------- 팔다리 ----------
   몸은 공 하나지만 팔(어깨-팔꿈치-손)과 다리(엉덩이-무릎-발)는 두 마디로 꺾인다.
   자세는 '손과 발을 어디에 둘지'만 정하고, 팔꿈치와 무릎은 아래 함수가 알아서 꺾는다. */
const BODY = 0.84;                // 몸통은 부딪히는 크기보다 조금 작게 그리고, 그만큼 팔다리를 길게 뺀다
const GROUND = 1.7;               // 몸 중심에서 발바닥(땅)까지 (아래 길이는 모두 '그린 몸통 반지름'의 몇 배)
const LIFT = GROUND * BODY - 1.05; // 그래서 몸통이 땅에서 뜨는 높이 (부딪히는 반지름의 몇 배)
const HIP_Y = 0.62, LEG = 0.56;   // 엉덩이 높이, 허벅지·종아리 길이
const SHO_X = 0.96, SHO_Y = 0.1, ARM = 0.62;   // 어깨: 몸통(얼굴) 가장자리에 붙는다 / 위팔·아래팔 길이
const INK = 'rgba(8,11,28,.6)';   // 팔다리 테두리 (몸 앞에 겹쳐도 또렷하게)

/** 두 마디 관절: (ax,ay)에서 (bx,by)까지 잇되, 꺾이는 마디가 (hx,hy) 쪽을 향한다. 닿지 않으면 쭉 늘어난다 */
function bend2(ax, ay, bx, by, l1, l2, hx, hy) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1e-6;
  if (d >= l1 + l2) { const k = l1 / (l1 + l2); return [ax + dx * k, ay + dy * k]; }
  const dd = Math.max(d, Math.abs(l1 - l2) + 1e-6);
  const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
  const hgt = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mx = ax + (dx / d) * a, my = ay + (dy / d) * a;
  const nx = -dy / d, ny = dx / d;
  const s = nx * hx + ny * hy >= 0 ? 1 : -1;
  return [mx + nx * hgt * s, my + ny * hgt * s];
}

/* ---------- 우승 세레모니 (춤) ----------
   우승하면 아래 춤 가운데 하나를 무작위로 골라 춘다.
   자세 필드 (길이 단위는 캐릭터 반지름, +x 오른쪽 / +y 아래)
     dx 선 자리가 옆으로 움직인 거리, h 뛰어오른 높이, rot 몸 기울기(rad), flipX 보는 방향(1~-1, 도는 느낌), sq 납작
     bx/by 발은 그대로 두고 몸통만 옮긴 거리 (by>0 이면 무릎을 굽혀 앉는다 -> 발이 땅에 붙은 채 몸이 튕긴다)
     fl/fr 왼발·오른발 [선 자리에서 옆으로, 든 높이, 뒤꿈치를 든 정도 0~1]
     al/ar 왼손·오른손 [몸 중심에서 x, y],  el/er 팔꿈치가 향하는 쪽
     kn 무릎 방향 (0 바깥으로 = 정면, 1 앞으로 = 옆모습),  hip/sh 엉덩이·어깨 너비 (옆모습이면 좁게)
     hl/hr 손 모양 ('thumb' 엄지척, 'L' 검지는 위·엄지는 몸 중심 쪽, 'point' 검지, 'glove' 흰 장갑),  prop 소품 ('shades', 'fedora')
     look 얼굴을 돌린 정도 (-1~1),  face 표정 ('smug' 메롱) */
const TAU = Math.PI * 2;
const squashAt = (fr) => 0.45 * Math.max(0, 1 - Math.min(fr, 1 - fr) * 9);   // 뛰기 직전·착지 순간
const smooth01 = (k) => { const c = clamp(k, 0, 1); return c * c * (3 - 2 * c); };

function poseReset(p) {
  p.dx = 0; p.h = 0; p.rot = 0; p.flipX = 1; p.sq = 0; p.bx = 0; p.by = 0;
  p.fl = [-0.34, 0, 0]; p.fr = [0.34, 0, 0];
  p.al = [-1.12, 0.7]; p.ar = [1.12, 0.7];
  p.el = [-1, 0.35]; p.er = [1, 0.35];
  p.kn = 0; p.hip = 0.3; p.sh = SHO_X; p.look = 0;
  p.hl = ''; p.hr = ''; p.prop = ''; p.face = ''; p.bobSpeed = 9;
  return p;
}
const POSE_NUM = ['dx', 'h', 'rot', 'flipX', 'sq', 'bx', 'by', 'kn', 'hip', 'sh', 'look'];
const POSE_VEC = ['fl', 'fr', 'al', 'ar', 'el', 'er'];
const POSE_TAG = ['hl', 'hr', 'prop', 'face', 'bobSpeed'];

/* 자주 쓰는 팔 모양 */
const armsUp = (p, ph) => {                     // 만세 (살짝 흔든다)
  p.al = [-1.15 - 0.16 * Math.sin(ph), -1.4 - 0.2 * Math.sin(ph * 2)]; p.el = [-1, -0.2];
  p.ar = [1.15 + 0.16 * Math.sin(ph), -1.4 - 0.2 * Math.sin(ph * 2 + 1)]; p.er = [1, -0.2];
};
const armsOut = (p, ph) => {                    // 양팔 벌리기
  p.al = [-2.05, -0.1 + 0.18 * Math.sin(ph)]; p.ar = [2.05, -0.1 - 0.18 * Math.sin(ph)];
};
const armsPump = (p, ph) => {                   // 주먹을 번갈아 치켜든다
  p.al = [-1.25, 0.0 - 0.95 * Math.sin(ph)]; p.el = [-1, 0.5];
  p.ar = [1.25, 0.0 + 0.95 * Math.sin(ph)]; p.er = [1, 0.5];
};

/* 막춤의 재료: 모든 동작은 땅에서 시작해 땅에서 끝나므로 이어 붙여도 튀지 않는다. k 는 동작 진행도 0~1 */
const CEREMONY = {
  cheer:     { dur: 1.7, f(k, p) { const fr = (k * 3) % 1; p.h = 2.7 * Math.sin(Math.PI * fr); p.sq = squashAt(fr); armsUp(p, k * 40); } },
  flip:      { dur: 1.2, f(k, p) { p.h = 3.6 * Math.sin(Math.PI * k); p.rot = -TAU * k; p.sq = squashAt(k); armsUp(p, 0); } },
  dance:     { dur: 1.9, f(k, p) {
    const b = k * TAU * 4, s = Math.sin(b);
    p.rot = 0.2 * s; p.bx = 0.22 * s; p.by = 0.1 + 0.1 * Math.cos(b * 2); armsPump(p, b); p.bobSpeed = 12;
    (s > 0 ? p.fl : p.fr)[1] = 0.25 * Math.abs(s);
  } },
  twirl:     { dur: 1.3, f(k, p) { p.h = 2.3 * Math.sin(Math.PI * k); p.flipX = Math.cos(TAU * 2 * k); armsOut(p, k * 20); p.sq = squashAt(k); } },
  zoom:      { dur: 1.8, f(k, p) {
    const ph = k * TAU * 2, st = k * TAU * 8;
    p.dx = 1.4 * Math.sin(ph); p.flipX = clamp(Math.cos(ph) * 5, -1, 1); p.kn = 1; p.hip = 0.16; p.look = 0.6;
    p.fl = [0.4 * Math.sin(st), 0.3 * Math.max(0, Math.cos(st)), 0]; p.fr = [-0.4 * Math.sin(st), 0.3 * Math.max(0, -Math.cos(st)), 0];
    p.by = 0.05 * Math.cos(st * 2); armsPump(p, st); p.bobSpeed = 20;
  } },
  cartwheel: { dur: 1.4, f(k, p) {
    p.h = 2.1 * Math.sin(Math.PI * k); p.rot = TAU * k; p.dx = 1.2 * Math.sin(Math.PI * k); p.sq = squashAt(k);
    armsOut(p, 0); p.fl[0] = -0.55; p.fr[0] = 0.55;
  } },
  bigjump:   { dur: 1.4, f(k, p) { p.h = 3.9 * Math.sin(Math.PI * k); p.sq = squashAt(k); armsUp(p, k * 30); p.fl[0] = -0.5; p.fr[0] = 0.5; } },
};

/* 춤마다 박자에 맞춰 자세를 만든다. t 는 춤을 시작하고 흐른 시간(초) */
const DANCES = {
  // 막춤: 위의 동작을 매번 섞어서 이어 붙인다 (Ceremony 가 따로 처리)
  freestyle: { name: '막춤' },

  // 문워크: 옆모습. 한 발은 발끝으로 서서 버티고, 다른 발은 바닥에 붙인 채 뒤로 쭉 민다. 번갈아 하면 몸이 뒤로 흘러간다.
  // 끝에서 한 바퀴 휙 돌고 발끝으로 서서 멈춘 뒤, 반대쪽으로 또 뒤로.
  moonwalk: {
    name: '문워크',
    f(t, p) {
      const T = 5.6, GL = 2.0, STEP = 0.469;                // STEP: 버티는 발이 땅에 박혀 보이는 보폭 시간
      const u = t % T, back = u >= T / 2, v = back ? u - T / 2 : u;
      const face = back ? -1 : 1;
      p.prop = 'fedora'; p.flipX = face; p.look = 0.85; p.kn = 1; p.hip = 0.12;
      p.hr = 'glove';                                                             // 한 손에만 낀 흰 장갑
      if (v < GL) {
        const s = v / STEP, i = Math.floor(s), f = s - i;
        const toe = [-0.34 + 0.68 * f, 0, 1];                                     // 발끝으로 버티는 발 (몸이 뒤로 가니 앞으로 온다)
        const flat = [0.34 - 0.68 * f, 0, 0];                                     // 바닥을 쓸며 뒤로 미는 발
        if (i % 2) { p.fl = flat; p.fr = toe; } else { p.fl = toe; p.fr = flat; }
        p.dx = face * (1.45 - 2.9 * (v / GL));
        p.rot = 0.08; p.by = 0.05 + 0.03 * Math.sin(Math.PI * f);
        const sw = Math.cos(Math.PI * s);                                         // 팔은 몸 옆에서 앞뒤로, 다리와 엇갈려
        p.al = [-1.12 + 0.3 * sw, 0.62 - 0.12 * Math.abs(sw)]; p.el = [-1, 0.2];
        p.ar = [1.12 - 0.3 * sw, 0.62 - 0.12 * Math.abs(sw)]; p.er = [1, 0.2];
      } else if (v < GL + 0.4) {                                                   // 제자리에서 한 바퀴
        const k = (v - GL) / 0.4;
        p.dx = -face * 1.45; p.flipX = face * Math.cos(TAU * k);
        p.fl = [-0.1, 0, 1]; p.fr = [0.1, 0, 1]; p.by = -0.1; p.look = 0;
        p.al = [-1.05, 0.62]; p.ar = [1.05, 0.62];                                 // 팔을 몸에 붙이고 돈다
      } else {                                                                     // 발끝으로 서서 딱 멈춘다
        const k = (v - GL - 0.4) / (T / 2 - GL - 0.4);
        p.dx = -face * 1.45;
        p.fl = [-0.16, 0, 1]; p.fr = [0.14, 0, 1];
        p.by = -0.17 + 0.05 * smooth01((k - 0.7) / 0.3); p.rot = -0.07;
        p.ar = [1.12, -0.74]; p.er = [1, 0.2];                                     // 모자챙을 바깥쪽에서 잡는다 (얼굴을 가리지 않게)
        p.al = [-1.75, 0.5]; p.el = [-1, 0.3]; p.hl = 'point';                     // 반대 팔은 뒤 아래로 쭉
      }
    },
  },

  // 삐끼삐끼: 양손 엄지척을 가슴 앞에서 번갈아 올렸다 내리며 골반을 좌우로 튕긴다.
  // 여덟 박자 뒤에는 몸을 틀어 한 손은 허리에, 한 손은 귀 옆에서 까딱까딱.
  pikipiki: {
    name: '삐끼삐끼',
    f(t, p) {
      const u = t * 2.3, i = Math.floor(u), c = i % 24;
      const sway = Math.sin(Math.PI * u);
      p.bx = 0.17 * sway; p.rot = -0.07 * sway; p.by = 0.05 + 0.07 * Math.abs(Math.cos(Math.PI * u));
      p.bobSpeed = 14;
      if (c < 8 || (c >= 12 && c < 20)) {
        const a = Math.cos(Math.PI * u);
        p.hl = p.hr = 'thumb';
        p.al = [-1.3, 0.05 + 0.36 * a]; p.el = [-1, 0.8];
        p.ar = [1.3, 0.05 - 0.36 * a]; p.er = [1, 0.8];
      } else {
        const d = c < 12 ? 1 : -1;
        const flick = [d * (1.3 + 0.16 * Math.sin(TAU * 2 * u)), -0.62 + 0.1 * Math.cos(TAU * 2 * u)];
        const hipHand = [-d * 1.0, 0.56];
        p.look = 0.6 * d; p.bx = 0.2 * d + 0.06 * sway;
        if (d > 0) { p.ar = flick; p.hr = 'thumb'; p.er = [1, 0.1]; p.al = hipHand; p.el = [-1, -0.1]; p.fl[2] = 1; }
        else { p.al = flick; p.hl = 'thumb'; p.el = [-1, 0.1]; p.ar = hipHand; p.er = [1, -0.1]; p.fr[2] = 1; }
      }
    },
  },

  // 말춤: 다리를 넓게 벌리고 말 타듯 통통. 발은 오-왼-오-오 / 왼-오-왼-왼 으로 구른다.
  // 앞 여덟 박자는 손목을 겹쳐 고삐를 쥐고, 뒤 여덟 박자는 머리 위로 올가미를 돌리며 옆으로 달린다.
  horse: {
    name: '말춤',
    f(t, p) {
      const u = t * 2.2, i = Math.floor(u), f = u - i;
      const side = [1, -1, 1, 1, -1, 1, -1, -1][i % 8];
      const k = Math.sin(Math.PI * f);
      p.prop = 'shades'; p.bobSpeed = 13;
      p.fl[0] = -0.54; p.fr[0] = 0.54;
      (side < 0 ? p.fl : p.fr)[1] = 0.42 * k;                // 구르는 발: 박자 사이에 들었다가 박자에 쿵
      p.by = 0.1 + 0.07 * (1 + Math.cos(TAU * f));           // 박자마다 푹 꺼진다
      p.bx = -0.1 * side * k; p.rot = -0.05 * side * k;
      const bob = 0.13 * Math.cos(TAU * f);
      if (Math.floor(i / 8) % 2 === 0) {                     // 고삐: 겹친 손목을 위아래로 까딱
        p.al = [0.14, 0.66 + bob]; p.el = [-1, 0.6];
        p.ar = [-0.14, 0.74 + bob]; p.er = [1, 0.6];
      } else {                                               // 올가미
        const a = TAU * u;
        p.ar = [0.85 + 0.5 * Math.cos(a), -1.5 + 0.2 * Math.sin(a)]; p.er = [1, 0];
        p.al = [-0.1, 0.7 + bob]; p.el = [-1, 0.6];
        p.dx = 0.9 * Math.sin(((u % 8) / 8) * TAU);
      }
    },
  },

  // L을 가져가: 한 손은 이마에 L, 한 손은 배를 잡고, 한 발로 콩콩 뛰며 다리를 양옆으로 번갈아 찬다.
  takel: {
    name: 'L을 가져가',
    f(t, p) {
      const u = t * 2.5, i = Math.floor(u), f = u - i, s = i % 2 ? 1 : -1;      // s: 이번에 차는 다리 쪽
      const k = Math.sin(Math.PI * f);
      p.face = 'smug'; p.bobSpeed = 16;
      p.ar = [0.42, -0.6]; p.er = [1, -0.3]; p.hr = 'L';                        // 이마에 붙인 L (검지는 위로, 엄지는 이마를 가로질러 안쪽으로)
      p.al = [-0.1, 0.74]; p.el = [-1, 0.6];                                    // 배를 잡은 손
      const stand = s < 0 ? p.fr : p.fl, kick = s < 0 ? p.fl : p.fr;
      stand[0] = -s * 0.1;
      kick[0] = s * (0.36 + 0.95 * k); kick[1] = 0.05 + 0.78 * k;          // 옆으로 쭉 뻗어 찬다
      p.h = 0.2 * k; p.by = 0.1 * (1 - k);
      p.bx = -s * 0.16 * k; p.rot = -s * 0.17 * k;
      p.dx = 0.55 * Math.sin((u * Math.PI) / 4);
    },
  },

  // 로봇춤: 팔을 직각으로 꺾은 자세를 뚝뚝 끊어서 바꾼다.
  robot: {
    name: '로봇춤',
    f(t, p) {
      const u = t * 3.2, st = Math.floor(u) % 6, f = u - Math.floor(u);
      const UP = (sd) => [sd * 1.58, -0.52], DN = (sd) => [sd * 1.58, 0.72], IN = (sd) => [sd * 0.34, 0.72], FW = (sd) => [sd * 0.96, -1.14];
      const POSES = [
        [DN(-1), UP(1), 0.1, -0.12], [UP(-1), DN(1), -0.1, 0.12], [UP(-1), UP(1), 0, 0],
        [IN(-1), UP(1), 0.08, 0.1], [DN(-1), IN(1), -0.08, -0.1], [FW(-1), DN(1), 0, 0.14],
      ];
      const P = POSES[st];
      p.al = P[0]; p.ar = P[1]; p.rot = P[2]; p.bx = P[3];
      p.el = [-1, 0]; p.er = [1, 0];
      p.by = 0.09 * Math.max(0, 1 - f * 5);                  // 자세가 바뀌는 순간 덜컥
      if (st % 3 === 1) p.fl[0] = -0.56; else if (st % 3 === 2) p.fr[0] = 0.56;
      p.look = [0.5, -0.5, 0, 0.5, -0.5, 0][st];
    },
  },

  // 디스코: 한 손은 허리에, 한 손은 하늘을 찔렀다가 반대쪽 허리로 내리꽂는다. 그다음엔 두 손을 굴리며 스텝.
  disco: {
    name: '디스코',
    f(t, p) {
      const u = t * 2, i = Math.floor(u), f = u - i, c = i % 8;
      p.by = 0.07 + 0.06 * Math.cos(TAU * f); p.bobSpeed = 12;
      if (c < 4) {
        const up = c % 2 === 0;
        p.ar = up ? [1.3, -1.5] : [-0.5, 0.92]; p.er = up ? [1, 0.3] : [0.6, 1]; p.hr = 'point';
        p.al = [-1.0, 0.56]; p.el = [-1, -0.1];
        p.bx = up ? -0.2 : 0.2; p.rot = up ? 0.1 : -0.1; p.look = up ? 0.5 : -0.4;
        (up ? p.fr : p.fl)[2] = 0.9;
      } else {
        const a = TAU * u, s = c % 2 ? 1 : -1, k = Math.sin(Math.PI * f);
        p.al = [-0.22 + 0.28 * Math.cos(a), 0.68 + 0.2 * Math.sin(a)]; p.el = [-1, 0.6];
        p.ar = [0.22 - 0.28 * Math.cos(a), 0.68 - 0.2 * Math.sin(a)]; p.er = [1, 0.6];
        p.bx = 0.22 * s * k; p.rot = -0.08 * s * k;
        (s > 0 ? p.fl : p.fr)[1] = 0.22 * k;
      }
    },
  },
};

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
    this.raw = poseReset({});
    this.p = poseReset({});             // 가만히 선 자세에서 춤으로 스르르 넘어간다
    this.lastT = 0;
  }

  /** t초째의 자세. 같은 객체를 다시 채워 돌려준다 */
  pose(t) {
    t = Math.max(0, t);                 // 첫 프레임의 시각이 살짝 앞설 때가 있다
    const q = poseReset(this.raw), p = this.p;
    if (this.key === 'freestyle') {
      let u = t % this.total, m = CEREMONY[this.order[0]];
      for (const n of this.order) {
        if (u < CEREMONY[n].dur) { m = CEREMONY[n]; break; }
        u -= CEREMONY[n].dur;
      }
      m.f(u / m.dur, q);
    } else {
      DANCES[this.key].f(t, q);
    }
    // 자세가 바뀌는 순간 뚝 끊기지 않게 아주 짧게 이어 준다 (크게 도는 동작은 그대로 따른다)
    const a = 1 - Math.exp(-Math.max(0, t - this.lastT) / 0.045);
    this.lastT = t;
    for (const key of POSE_NUM) {
      const d = q[key] - p[key];
      p[key] = key === 'rot' && Math.abs(d) > 2 ? q[key] : p[key] + d * a;
    }
    for (const key of POSE_VEC) {
      const s = q[key], d = p[key];
      for (let i = 0; i < d.length; i++) d[i] += ((s[i] || 0) - d[i]) * a;
    }
    for (const key of POSE_TAG) p[key] = q[key];
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
    this.speed = 1;                        // 진행 배속 (1 또는 2)
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
    this.mineFrontier = 760;               // 다음 지뢰를 묻을 자리
    this.mineSeen = false;                 // 이번 판에 지뢰가 한 번이라도 드러났나
    this.order = [];                       // 탈락 역순 = 순위
    this.raceT = 0;                        // 출발하고 흐른 시간
    // 왼쪽 끝에서 다가오는 괴물. f 는 화면 폭에 대한 앞니(앞쪽 끝)의 위치 비율이라 창 크기가 바뀌어도 그대로다.
    this.maw = {
      state: 'sleep',                      // sleep -> creep <-> warn -> strike(일부가 튀어나와 문다) / hunt(혀)
      f: -0.09, t: 0, cd: 0, hcd: 0, hold: 0,
      kind: '', prey: null, rage: 0, look: this.top + this.trackH / 2,
      baseF: 0.03, alarmX: -Infinity, warnT: 1,
      full: 0, bite: false,                // 방금 한 입 물었다 (입이 차서 잠깐은 더 못 문다)
      prog: 0,                             // 벽이 나온 정도 0~1 (탈락 진행을 천천히 따라간다)
      tongue: 0, attached: false,          // 혀가 뻗은 정도 0~1 / 먹잇감을 붙잡았나
      lane: 0, reach: 0, ext: 0,           // 튀어나와 무는 줄(y) / 뻗을 거리(px) / 지금 뻗은 정도 0~1
    };
    // 부활 하트: 탈락이 이만큼(비율) 진행될 때마다 하나씩 나온다
    const nRev = pick(REVIVES);
    this.reviveAt = Array.from({ length: nRev }, (_, i) => rnd(0.08, 0.5) * 0.6 + ((i + 0.5) / nRev) * 0.35).sort((a, b) => a - b);
    this.hearts = [];                      // 트랙 위에 떠 있는 부활 하트
    this.angels = [];                      // 내려오는 / 올라가는 천사
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
        x: -col * this.r * 4.2 + rnd(-0.6, 0.6) * this.r,
        y: this.top + this.trackH * ((inCol + 0.5) / per),
        vy: 0,
        alive: true,
        hue: (i * 360) / n + rnd(-8, 8),
        speed: rnd(0.99, 1.01),              // 타고난 발 빠르기 (거의 같다. 앞뒤는 컨디션이 가른다)
        pace: 1, paceTo: rnd(0.9, 1.1), paceCd: rnd(0.5, 3),   // 그때그때 달라지는 컨디션 (앞뒤가 계속 뒤바뀐다)
        alarm: 0, react: rnd(0.15, 1.0),    // 괴물 경고를 듣고 도망치기까지 걸리는 시간
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
        shield: 0, angel: null,            // 부활 직후 잠깐 무적 / 데리고 내려오는 천사
        slot: Math.random(), slotCd: rnd(2, 6),   // 무리 안에서 좋아하는 앞뒤 자리 (0 앞 ~ 1 뒤)
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
    // 배속: 한 번에 크게 건너뛰면 장애물을 뚫고 지나가므로, 같은 걸음을 여러 번 밟는다
    for (let i = 0; i < this.speed && this.running; i++) this.update(dt);
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
    // 넷 이하로 줄면 막판 스퍼트. 처음부터 인원이 적은 반은 출발하자마자 끝나지 않게 서서히 올린다
    const finale = this.alive <= 4 ? 0.45 * clamp(this.raceT / 10, 0, 1) : 0;
    const heat = clamp(diff * 0.75 + stall * 0.6 + finale, 0, 1.35);

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
          const rad = this.r * rnd(1.2, 1.9);
          this.obstacles.push({
            kind: 'drop',
            x: rnd(tailX - 40, leadX + 320),
            y: rnd(this.top + rad, this.bot - rad),
            rad, hue: rnd(18, 46),
            t: 0, warn: rnd(0.45, 0.8), fall: 0.28, live: 0.5, landed: false,
          });
        }
        this.dropCd = rnd(1.3, 2.6) / (0.65 + heat);
      }
    }

    /* --- 부활 하트와 천사 --- */
    this.stepRevive(dt, leadX);

    /* --- 장애물 움직임 (꼬리가 지나갈 때까지 남겨 둔다) --- */
    for (const o of this.obstacles) this.moveObstacle(o, dt, heat);
    const cullX = Math.min(this.camX, tailX) - 400;
    this.obstacles = this.obstacles.filter((o) =>
      o.x > cullX && !o.popped && !(o.kind === 'drop' && o.t > o.warn + o.fall + o.live));

    /* --- 달리기 --- */
    const baseSpeed = 250 + 70 * diff;
    const band = this.W * 0.62;      // 무리가 벌어질 수 있는 폭 (화면이 가로로 긴 만큼 넓게 퍼진다)
    // 무리가 퍼질 폭: 괴물 벽 앞에서 화면 오른쪽 끝 가까이까지
    const span = this.W * clamp(0.8 - Math.max(this.maw.f, 0), 0.3, 0.72);
    let meanX = 0, cnt = 0;
    for (const R of this.runners) if (R.alive && !R.heldBy && !R.flight) { meanX += R.x; cnt++; }
    meanX = cnt ? meanX / cnt : 0;
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
        pull = R.fear * (dizzy ? 300 : 60);             // 기절하면 버티지 못하고 쑥쑥 끌려간다
        if (maw.attached && maw.prey === R) pull = Math.max(pull, this.W * REEL);   // 혀에 감겨 끌려온다
        // 경고를 듣고 도망친다. 알아채는 데 걸리는 시간은 그때그때 달라서, 굼뜨면 덮칠 때 잡힌다
        const lane = this.striking() && this.inStrike(R, 1.2);     // 튀어나와 무는 줄에 서 있다
        if ((R.x < maw.alarmX || lane) && !dizzy && !R.carry) {
          R.alarm += dt;
          if (R.alarm >= R.react) R.dash = Math.max(R.dash, 0.5);
        } else if (R.alarm > 0) {
          R.alarm = 0; R.react = rnd(0.15, 1.0);
        }
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
          const chance = (0.3 + lagRatio * 0.7) * dt;
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
      R.paceCd -= dt;
      if (R.paceCd <= 0) { R.paceCd = rnd(1.2, 3.5); R.paceTo = rnd(0.9, 1.1); }
      R.pace += (R.paceTo - R.pace) * Math.min(1, dt * 1.5);
      // 무리 안에서 저마다 좋아하는 앞뒤 자리가 있다 (가끔 바꾼다) -> 가로로 넓게 퍼지고 순서도 계속 뒤바뀐다
      R.slotCd -= dt;
      if (R.slotCd <= 0) { R.slotCd = rnd(5, 10); R.slot = Math.random(); }
      const steer = clamp((meanX + (0.5 - R.slot) * span - R.x) / (span * 0.4), -0.5, 0.5);
      const sp = baseSpeed * R.speed * R.pace
        * (1 + 0.7 * steer + 0.1 * lagRatio)
        * (R.dash > 0 ? 1.85 : 1)
        * (R.stun > 0 ? 0.35 : 1)
        * (dizzy ? 0.4 : 1)                       // 비틀거린다
        * (R.carry ? 0.6 : 1);                    // 들고 있으면 느리다
      // 앞뒤로 너무 붙은 아이끼리는 서로 밀어낸다 -> 같은 줄에 뭉치지 않고 가로로 퍼진다
      let sep = 0;
      for (const O of this.runners) {
        if (O === R || !O.alive || O.heldBy || O.flight) continue;
        const ddx = R.x - O.x, ddy = Math.abs(R.y - O.y);
        if (ddy > this.r * 2.6 || Math.abs(ddx) > this.r * 3.6) continue;
        sep += (ddx > 0 ? 1 : ddx < 0 ? -1 : R.seq < O.seq ? 1 : -1) * (1 - Math.abs(ddx) / (this.r * 3.6)) * (1 - ddy / (this.r * 2.6));
      }
      R.x += (sp - pull + clamp(sep, -1.5, 1.5) * baseSpeed * 0.3) * dt;
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

      if (R.shield > 0) { R.shield -= dt; continue; }            // 부활 직후에는 아무것도 못 건드린다

      // 튀어나온 괴물 입에 걸리면 꿀꺽
      if (maw.state === 'strike' && maw.ext > 0.3 && R.x - this.r * 0.4 < this.mawX + maw.reach * maw.ext
          && Math.abs(R.y - maw.lane) < this.r * (STRIKE_HALF + 0.5)) {
        R.cause = 'maw';
        hitNow.push(R);
        continue;
      }

      // 괴물 입에 닿으면 꿀꺽
      if (maw.state !== 'sleep' && R.x - this.mawX < this.r * 0.5) {
        if (maw.full > 0 && !dizzy && maw.prey !== R) {
          // 입이 찼다: 이빨에 떠밀려 앞으로 튕겨 나간다
          R.x = this.mawX + this.r * 0.5;
          R.dash = Math.max(R.dash, 0.4);
        } else {
          R.cause = 'maw';
          maw.full = 0.7; maw.bite = true;
          hitNow.push(R);
          continue;
        }
      }

      // 충돌 (공중이면 낮은 장애물은 넘어간다. 벽과 해머는 못 넘는다)
      for (const o of this.obstacles) {
        if (o.popped || Math.abs(o.x - R.x) > 260) continue;
        if ((R.jump > 0 || (R.stomp && R.stomp.t >= R.stomp.T1)) && LOW.has(o.kind)) continue;
        if (this.hits(o, R)) {
          R.cause = o.kind;
          hitNow.push(R);
          if (o.kind === 'ball') { o.popped = true; this.burst(o.x, o.y, 195, 12); }   // 공은 한 명을 맞히면 터진다
          else if (o.kind === 'spinner' || o.kind === 'hammer') { o.cool = 0.5; o.w = -o.w; }   // 맞히면 반대로 튕긴다
          break;
        }
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
    const want = nowLead - this.W * 0.8;                   // 선두를 오른쪽 끝 가까이 두어 무리가 넓게 퍼질 자리를 준다
    this.camX = lerp(this.camX, want, 1 - Math.pow(0.0015, dt));

    this.stepParticles(dt);

    /* --- 끝 --- */
    // 천사가 누구를 데리고 내려오는 중이면 끝내지 않는다 (마지막 한 명과 다시 겨룬다)
    if (this.alive <= 1 && this.phase === 'race' && !this.angels.some((A) => !A.landed)) {
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

  /* ===== 부활 ===== */

  /**
   * 부활 하트 (날개 달린 금빛 하트).
   * 탈락이 정해진 만큼 진행되면 무리 앞쪽에 하나 띄운다. 누가 먹으면 천사가 내려와
   * 탈락한 아이 하나를 무리 한가운데에 되살려 놓는다. 아무도 못 먹고 지나치면 조금 뒤 다시 띄운다.
   */
  stepRevive(dt, leadX) {
    const r = this.r, n = this.runners.length;
    const gone = n > 1 ? 1 - (this.alive - 1) / (n - 1) : 1;
    const dead = this.runners.filter((R) => !R.alive && !R.angel);

    // 띄우기
    if (this.reviveAt.length && !this.hearts.length && gone >= this.reviveAt[0] && dead.length && this.alive >= 3 && leadX > -Infinity) {
      this.reviveAt.shift();
      const ys = this.runners.filter((R) => R.alive).map((R) => R.y);
      const y = clamp(pick(ys) + rnd(-1, 1) * r * 2, this.top + r * 1.5, this.bot - r * 1.5);
      this.hearts.push({ x: leadX + this.W * rnd(0.12, 0.2), y, t: 0 });
      if (this.opts.onHeart) this.opts.onHeart(null);
    }

    for (const h of this.hearts) {
      h.t += dt;
      if (Math.random() < dt * 10) {                                    // 반짝이 가루
        this.particles.push({ x: h.x + rnd(-r, r), y: h.y + rnd(-r, r) * 0.8, vx: rnd(-20, 20), vy: rnd(-60, -20),
          life: rnd(0.4, 0.8), age: 0, hue: 48, r: rnd(1.5, 3), light: 75 });
      }
      for (const R of this.runners) {
        if (!R.alive || R.heldBy || R.flight) continue;
        if (Math.hypot(R.x - h.x, R.y - h.y) > r * 1.6) continue;
        h.taken = true;
        const D = this.runners.filter((O) => !O.alive && !O.angel);
        if (D.length) this.sendAngel(pick(D), R);
        this.burst(h.x, h.y, 48, 22);
        this.rings.push({ x: h.x, y: h.y, r0: r * 0.6, age: 0, life: 0.5, hue: 48, grow: 5, thick: 5 });
        break;
      }
      // 아무도 못 먹고 화면 뒤로 사라졌다: 조금 뒤 다시 띄운다
      if (!h.taken && h.x < this.camX - r * 3) { h.taken = true; this.reviveAt.unshift(gone + 0.04); }
    }
    this.hearts = this.hearts.filter((h) => !h.taken);

    // 천사: 하늘에서 내려와 아이를 내려놓고 다시 올라간다
    for (const A of this.angels) {
      A.t += dt;
      const R = A.R;
      if (!A.landed) {
        R.x = this.camX + A.sx * this.W;                               // 화면 안 같은 자리에 내려온다
        R.bob += dt * 3;
        if (A.t >= A.T) { A.landed = true; A.t = 0; A.x = R.x; A.y = R.y; this.revive(R); }
      }
    }
    this.angels = this.angels.filter((A) => !A.landed || A.t < 1.1);
  }

  /** 천사를 내려보낸다 (R: 되살릴 아이, by: 하트를 먹은 아이) */
  sendAngel(R, by) {
    const r = this.r;
    // 상태를 깨끗이 비우고, 무리 한가운데쯤 빈 줄에 내려놓는다
    Object.assign(R, {
      carry: null, heldBy: null, flight: null, stomp: null, cel: null,
      dash: 0, jump: 0, jumpPow: 1, punch: 0, hurt: 0, dizzy: 0, squash: 0, spin: 0, fear: 0,
      kx: 0, ky: 0, vy: 0, stun: 0, alarm: 0, liftT: 0, cause: '', eaten: false, deadAt: -99,
    });
    let y = rnd(this.top + r * 2, this.bot - r * 2);
    for (let k = 0; k < 8; k++) {                                       // 남들과 겹치지 않는 줄
      const yy = rnd(this.top + r * 2, this.bot - r * 2);
      if (!this.runners.some((O) => O.alive && Math.abs(O.y - yy) < r * 2)) { y = yy; break; }
    }
    R.y = R.targetY = y;
    const A = { R, sx: rnd(0.52, 0.66), t: 0, T: 1.5, landed: false };
    R.angel = A;
    R.x = this.camX + A.sx * this.W;
    this.angels.push(A);
    this.sfx('heart');
    if (this.opts.onHeart) this.opts.onHeart(by, R);
  }

  /** 천사가 내려놓은 아이가 다시 달린다 */
  revive(R) {
    R.angel = null;
    R.alive = true;
    R.shield = 2.2;                                      // 잠깐은 아무것도 못 건드린다
    R.dash = 0.5;
    this.alive++;
    this.order = this.order.filter((O) => O !== R);
    this.burst(R.x, R.y, 48, 26);
    this.puff(R, 1.3);
    this.sfx('revive');
    if (this.opts.onRevive) this.opts.onRevive(R, this.alive);
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
    if (m.full > 0) m.full -= dt;
    m.bite = false;
    // 벽(앞니)은 탈락이 진행되는 만큼 꾸준히 나온다 -> 마지막 한 명이 남을 무렵 화면의 40%쯤.
    // 한꺼번에 여럿이 탈락해도 천천히 따라가고, 부활해도 물러나지 않는다.
    const n = this.runners.length;
    const gone = n > 1 ? 1 - (this.alive - 1) / (n - 1) : 1;           // 0(시작) ~ 1(한 명 남음)
    if (m.state !== 'sleep') m.prog = Math.min(1, m.prog + clamp(gone - m.prog, 0, (WALL_SPEED / (WALL_TO - WALL_FROM)) * dt));
    m.baseF = lerp(WALL_FROM, WALL_TO, m.prog);
    m.alarmX = -Infinity;
    // 벽은 천천히 다가오고 천천히 물러난다
    let target = m.baseF, advance = 0.1, retreat = m.f > m.baseF + 0.03 ? 0.12 : 0.05;

    switch (m.state) {
      case 'sleep':
        target = -0.09;
        if (this.raceT >= 4) {
          m.state = 'creep'; m.t = 0; m.cd = rnd(3, 4.5); m.hcd = 0;
          this.sfx('growl');
          this.shakeScreen(0.6, r * 0.12);
          if (this.opts.onMaw) this.opts.onMaw('wake');
        }
        break;

      case 'creep': {
        m.hcd -= dt; m.cd -= dt;
        const prey = m.hcd <= 0 ? this.findPrey() : null;
        if (prey) this.mawWarn('hunt', prey);
        else if (m.cd <= 0) {
          // 벽의 한 부분만 튀어나와 문다: 닿을 거리 안의 아이 하나를 골라 그 줄을 노린다 (벽에 가까울수록 잘 걸린다)
          const reach = W * lerp(STRIKE_REACH[0], STRIKE_REACH[1], h1);
          let pickR = null, best = -Infinity;
          for (const R of this.runners) {
            if (!R.alive || R.heldBy || R.flight || R.shield > 0) continue;
            const d = R.x - this.mawX;
            if (d < 0 || d > reach * 0.9) continue;
            const score = Math.random() - d / reach;
            if (score > best) { best = score; pickR = R; }
          }
          if (pickR) {
            m.lane = clamp(pickR.y, this.top + r, this.bot - r); m.reach = reach; m.ext = 0;
            m.warnT = lerp(STRIKE_WARN[0], STRIKE_WARN[1], h1);
            this.mawWarn('strike', pickR);
          } else {
            m.cd = 0.5;                                    // 닿을 데 아무도 없다: 잠시 뒤 다시 본다
          }
        }
        break;
      }

      case 'warn': {
        if (m.kind === 'hunt') {
          target = Math.max(-0.02, m.baseF - 0.035);      // 뒤로 웅크린다
          retreat = 0.12;
          this.shakeScreen(0.08, r * 0.08);
          const prey = this.findPrey();
          if (!prey) { m.state = 'creep'; m.t = 0; m.hcd = 0.8; break; }
          m.prey = prey;
        }
        if (m.t >= (m.kind === 'hunt' ? 0.35 : m.warnT)) {
          m.state = m.kind; m.t = 0; m.hold = 0; m.tongue = 0; m.attached = false;
          this.shakeScreen(m.kind === 'hunt' ? 0.3 : 0.18, r * (m.kind === 'hunt' ? 0.3 : 0.18));
          if (m.kind === 'strike') this.sfx('chomp');
        }
        break;
      }

      case 'strike': {
        // 확 뻗었다가(0.18초) 잠깐 머물고(0.22초) 천천히 거둬들인다(0.4초)
        const T1 = 0.18, T2 = 0.4, T3 = 0.8;
        m.ext = m.t < T1 ? 1 - Math.pow(1 - m.t / T1, 3) : m.t < T2 ? 1 : 1 - clamp((m.t - T2) / (T3 - T2), 0, 1);
        if (m.t >= T3) { m.state = 'creep'; m.t = 0; m.ext = 0; m.cd = rnd(1.2, 2.4) / (0.7 + 0.5 * heat); m.hcd = 0.6; }
        break;
      }

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
    const angry = (m.state === 'warn' && m.kind === 'hunt') || m.state === 'hunt';   // 무는 공격은 그 부분만 붉어진다
    m.rage += ((angry ? 1 : 0) - m.rage) * Math.min(1, dt * 6);

    // 눈동자는 가장 뒤처진(또는 노리는) 아이를 쫓는다
    let lookY = this.top + this.trackH / 2, rear = Infinity;
    if (m.state === 'hunt' && m.prey) lookY = m.prey.y;
    else if (this.striking()) lookY = m.lane;
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

  /** 벽 일부가 튀어나와 무는 공격을 예고하거나 하는 중인가 */
  striking() {
    const m = this.maw;
    return (m.state === 'warn' && m.kind === 'strike') || m.state === 'strike';
  }

  /** 이 아이가 무는 공격의 줄 안에 있나 (pad: 반지름 몇 배만큼 넉넉히 볼지) */
  inStrike(R, pad) {
    const m = this.maw, r = this.r;
    return R.x < this.mawX + m.reach + r * pad && Math.abs(R.y - m.lane) < r * (STRIKE_HALF + 0.55 + pad * 0.6);
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
    const h1 = clamp(heat, 0, 1);
    while (this.frontier < limit && guard++ < 16) {
      const kinds = STAGES[Math.max(this.stageIdx, 0)].kinds;
      this.obstacles.push(this.makeObstacle(pick(kinds), this.frontier, heat));
      // 장애물 하나하나는 작게, 대신 촘촘하게 놓는다
      const gap = lerp(225, 135, h1) * rnd(0.8, 1.22);
      this.frontier += gap;
    }
    // 지뢰: 바닥에 숨어 있다가 누가 다가오면 드러난다
    guard = 0;
    while (this.mineFrontier < limit && guard++ < 8) {
      const rad = this.r * rnd(2.3, 3.0);
      this.obstacles.push({
        kind: 'mine',
        x: this.mineFrontier + rnd(-70, 70),
        y: rnd(this.top + rad * 0.5, this.bot - rad * 0.5),
        rad, state: 'hidden', t: 0, fuse: rnd(0.85, 1.05),
      });
      this.mineFrontier += lerp(760, 340, h1) * rnd(0.6, 1.4);
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
            len: Hh * rnd(0.26, 0.38), thick: this.r * 0.9,
            y: side < 0 ? T - out : B + out,
            ang: rnd(0, Math.PI * 2),
            w: rnd(1.1, 1.9) * (Math.random() < 0.5 ? -1 : 1) * (0.85 + heat * 0.5),
          };
        }
        // 세 종류: 긴 바 / 짧고 빠른 바 / 느린 십자
        const roll = Math.random();
        let arms, len, spin, thick;
        if (roll < 0.42) {
          arms = 1; len = Hh * rnd(0.15, 0.23); spin = rnd(1.5, 2.4); thick = this.r * 0.8;
        } else if (roll < 0.72) {
          arms = 1; len = Hh * rnd(0.09, 0.14); spin = rnd(3.0, 4.5); thick = this.r * 0.95;
        } else {
          arms = 2; len = Hh * rnd(0.12, 0.18); spin = rnd(0.8, 1.4); thick = this.r * 0.75;
        }
        return {
          kind, x, arms, len, thick,
          y: rnd(T + Hh * 0.14, B - Hh * 0.14),
          ang: rnd(0, Math.PI * 2),
          w: spin * (Math.random() < 0.5 ? -1 : 1) * (0.85 + heat * 0.5),
        };
      }
      case 'hammer':
        return {
          kind, x,
          y0: T + Hh * 0.5,
          amp: Hh * rnd(0.3, 0.47),
          rad: this.r * rnd(1.2, 1.7),
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
        const rad = this.r * lerp(0.8, 1.7, size);
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
        // 사람이 많이 남았을수록 문을 넓게 낸다 (문 앞에서 한꺼번에 탈락하지 않게)
        const crowd = 1 + 0.6 * clamp((this.alive - 4) / 10, 0, 1);
        const gapH = Math.max(this.r * 3.4, Hh * lerp(0.3, 0.15, clamp(heat, 0, 1))) * crowd;
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
    if (o.cool > 0) o.cool -= dt;
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
      case 'mine':
        this.stepMine(o, dt);
        break;
      case 'wall':
        o.gapY += o.vy * dt;
        if (o.gapY < this.top + o.gapH * 0.55) { o.gapY = this.top + o.gapH * 0.55; o.vy *= -1; }
        if (o.gapY > this.bot - o.gapH * 0.55) { o.gapY = this.bot - o.gapH * 0.55; o.vy *= -1; }
        break;
    }
  }

  /** 지뢰: 숨어 있다가 -> 누가 다가오면 드러나 깜빡이고 -> 잠시 뒤 터진다 */
  stepMine(o, dt) {
    const r = this.r;
    if (o.state === 'hidden') {
      const trig = o.rad + r * 1.8;
      for (const R of this.runners) {
        if (!R.alive || R.heldBy || R.flight) continue;
        if (Math.abs(R.x - o.x) > trig || Math.hypot(R.x - o.x, R.y - o.y) > trig) continue;
        o.state = 'armed'; o.t = 0;
        this.sfx('mine');
        if (!this.mineSeen) { this.mineSeen = true; if (this.opts.onMine) this.opts.onMine(); }
        // 이미 원 안에 들어선 아이는 놀라서 내달린다
        for (const O of this.runners) {
          if (!O.alive || O.dizzy > 0 || O.carry || O.heldBy || O.flight) continue;
          if (O.x > o.x - r && Math.hypot(O.x - o.x, O.y - o.y) < o.rad + r && Math.random() < 0.6) {
            O.dash = Math.max(O.dash, 0.35);
          }
        }
        break;
      }
      return;
    }
    o.t += dt;
    if (o.state !== 'armed' || o.t < o.fuse) return;

    // 쾅!
    o.state = 'boom'; o.t = 0;
    this.sfx('blast');
    this.burst(o.x, o.y, 22, 26);
    this.burst(o.x, o.y, 48, 12);
    this.rings.push({ x: o.x, y: o.y, age: 0, life: 0.5, hue: 18, r0: o.rad * 0.5, grow: (o.rad / r) * 1.1, thick: 6 });
    this.rings.push({ x: o.x, y: o.y, age: 0, life: 0.34, hue: 50, r0: r * 0.6, grow: (o.rad / r) * 0.8, thick: 4, white: true });
    this.pows.push({ x: o.x, y: o.y - r * 0.6, age: 0, life: 0.5, size: r * 1.7, spikes: 11, text: '쾅!', ang: rnd(0, 6.28), hue: 22 });
    this.shakeScreen(0.3, r * 0.45);
    // 원 바로 밖에 있던 아이는 폭풍에 밀려난다 (탈락은 아니다)
    for (const O of this.runners) {
      if (!O.alive || O.heldBy || O.flight) continue;
      const dx = O.x - o.x, dy = O.y - o.y, d = Math.hypot(dx, dy) || 1;
      if (d < o.rad || d > o.rad * 1.8) continue;
      const f = (1 - (d - o.rad) / (o.rad * 0.8)) * 520;
      O.kx += (dx / d) * f * 0.6; O.ky += (dy / d) * f;
      O.hurt = 0.4; O.stun = Math.max(O.stun, 0.15);
    }
  }

  /** 장애물의 현재 위치 기준 충돌 판정 */
  hits(o, R) {
    const pad = this.r;
    if (o.cool > 0) return false;                       // 방금 누군가를 맞히고 튕겨 나가는 중
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
      case 'mine':
        // 터지는 순간, 빨간 원 안에 있던 아이만 맞는다
        return o.state === 'boom' && o.t < 0.1 && Math.hypot(R.x - o.x, R.y - o.y) < o.rad;
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
      case 'mine': {
        // 드러난 지뢰만 보인다. 터질 때 내가 어디쯤 있을지를 따져 원 밖으로 비킨다
        if (o.state !== 'armed') return 0;
        const dxAt = (t - (o.fuse - o.t)) * 280;            // 터지는 순간 지뢰와의 가로 거리(대략)
        const reach = o.rad + this.r * 1.5;
        if (Math.abs(dxAt) >= reach) return 0;
        const half = Math.sqrt(reach * reach - dxAt * dxAt);
        return clamp(1.7 * (1 - Math.abs(y - o.y) / half), 0, 1);
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
    // 괴물이 튀어나올 줄 (예고를 알아챈 아이만 피한다. 굼뜨면 늦는다)
    const m = this.maw;
    const dodge = this.striking() && this.inStrike(R, 2) && (m.state === 'strike' || m.t > R.react);
    // 부활 하트: 앞에 보이면 그쪽으로 간다
    const heart = this.hearts.find((h) => h.x > R.x - this.r && h.x < R.x + 520);
    if (!ahead.length && !dodge && !heart) {
      // 장애물이 없으면 살짝 배회
      return clamp(R.y + rnd(-1, 1) * this.trackH * 0.07, this.top + this.r, this.bot - this.r);
    }

    const N = 15;
    const personal = this.r * 2.1;
    const crowd = this.runners.filter((O) => O !== R && O.alive && !O.heldBy && !O.flight && Math.abs(O.x - R.x) < this.r * 3.4);
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
      for (const O of crowd) {                         // 남들이 몰린 줄은 꺼린다 -> 한 방에 여럿이 쓸려 나가지 않는다
        const d = Math.abs(y - O.targetY);
        if (d < personal) cost += 0.42 * (1 - d / personal);
      }
      if (dodge) {
        const d = Math.abs(y - m.lane), band = this.r * (STRIKE_HALF + 1.6);
        if (d < band) cost += 4 * (1 - d / band) * (0.6 + 0.4 * R.skill);
      }
      if (heart) {
        const d = Math.abs(y - heart.y);
        if (d < this.trackH * 0.3) cost -= 0.9 * (1 - d / (this.trackH * 0.3));
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
      if (dx < -30 || dx > 230 || o.kind === 'mine') continue;
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

    /* 부활 하트 */
    for (const h of this.hearts) this.drawHeart(c, h);

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
    for (const A of this.angels) this.drawAngel(c, A);
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

    // 벽의 한 부분이 튀어나와 문다 (예고: 그 부분만 달아오르고 느낌표)
    if (this.striking()) this.drawStrike(c, fx, wave);

    // 경고 표지: 곧 덮친다 (혀로 낚아채기 전)
    if (m.state === 'warn' && m.kind === 'hunt' && Math.sin(this.time * 20) > -0.2) {
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

  /** 느낌표 표지 (빨간 세모 + 흰 !) */
  drawAlert(c, sx, sy, s) {
    c.fillStyle = '#ff3355';
    c.strokeStyle = '#fff'; c.lineWidth = 3; c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(sx, sy - s); c.lineTo(sx + s * 0.95, sy + s * 0.7); c.lineTo(sx - s * 0.95, sy + s * 0.7);
    c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#fff';
    c.font = `900 ${Math.round(s * 1.1)}px Jua, Gothic A1, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('!', sx, sy + s * 0.18);
    c.textBaseline = 'alphabetic';
  }

  /**
   * 벽의 한 줄이 튀어나와 무는 공격.
   * 예고: 그 줄의 벽만 주황-빨강으로 달아오르며 꿈틀대고, 앞에 느낌표, 바닥엔 닿을 거리까지 옅은 빨간 띠.
   * 공격: 그 부분이 굵은 목처럼 쭉 뻗고, 끝의 입이 쩍 벌어졌다 닫힌다.
   */
  drawStrike(c, fx, wave) {
    const m = this.maw, r = this.r;
    const warn = m.state === 'warn';
    const ly = m.lane, hh = r * STRIKE_HALF;
    const k = warn ? clamp(m.t / m.warnT, 0, 1) : 1;                 // 예고가 무르익는 정도
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (10 + k * 14));

    // 닿을 거리까지 바닥에 옅은 빨간 띠
    if (warn) {
      const g = c.createLinearGradient(fx, 0, fx + m.reach, 0);
      g.addColorStop(0, `rgba(255,60,60,${0.1 + 0.16 * k * pulse})`);
      g.addColorStop(1, 'rgba(255,60,60,0)');
      c.fillStyle = g;
      c.fillRect(fx, ly - hh, m.reach, hh * 2);
    }

    // 그 줄의 벽이 달아오른다
    c.save();
    c.beginPath();
    c.moveTo(-40, ly - hh * 1.5);
    for (let y = ly - hh * 1.5; y <= ly + hh * 1.5; y += 4) c.lineTo(fx + wave(y) + r * 0.3, y);
    c.lineTo(-40, ly + hh * 1.5);
    c.closePath();
    const hot = c.createLinearGradient(fx - r * 6, 0, fx + r, 0);
    hot.addColorStop(0, 'rgba(255,80,40,0)');
    hot.addColorStop(1, `hsla(${lerp(28, 2, k)},100%,${52 + pulse * 10}%,${0.55 + 0.35 * k})`);
    c.fillStyle = hot;
    c.shadowColor = '#ff3b2f'; c.shadowBlur = 14 + 16 * pulse;
    c.fill();
    c.restore();

    // 튀어나온 목과 머리 (예고 중에는 살짝 꿈틀거리며 비어져 나온다)
    const ext = warn ? (0.03 + 0.03 * pulse) * k : m.ext;
    const len = Math.max(r * 0.6, m.reach * ext);
    const x0 = fx - r, tip = fx + len;
    const hx = tip - hh * 0.9;                                          // 머리 중심
    const body = c.createLinearGradient(x0, 0, tip, 0);
    body.addColorStop(0, '#1a0410');
    body.addColorStop(1, `hsl(${lerp(330, 356, k)},70%,${26 + 8 * pulse * (warn ? 1 : 0)}%)`);
    c.fillStyle = body;
    c.shadowColor = 'rgba(255,40,60,.9)'; c.shadowBlur = 12;
    c.beginPath();                                                       // 목 (위아래가 꿈틀댄다)
    const wig = (x) => Math.sin(x * 0.06 - this.time * 14) * r * 0.12;
    c.moveTo(x0, ly - hh * 0.8);
    for (let x = x0; x <= hx; x += 6) c.lineTo(x, ly - hh * 0.72 + wig(x));
    for (let x = hx; x >= x0; x -= 6) c.lineTo(x, ly + hh * 0.72 - wig(x));
    c.closePath(); c.fill();
    c.beginPath(); c.ellipse(hx, ly, hh * 1.05, hh * 1.1, 0, 0, Math.PI * 2); c.fill();
    c.shadowBlur = 0;

    // 입: 뻗을수록 쩍 벌어진다
    const open = warn ? 0.15 : Math.sin(Math.PI * clamp(m.t / 0.4, 0, 1)) * 0.9 + 0.1;
    const mo = hh * 0.85 * open;
    c.fillStyle = '#2a0006';
    c.beginPath();
    c.moveTo(hx - hh * 0.1, ly);
    c.lineTo(tip + hh * 0.25, ly - mo); c.lineTo(tip + hh * 0.25, ly + mo);
    c.closePath(); c.fill();
    c.fillStyle = '#fff4e8'; c.strokeStyle = 'rgba(40,10,40,.6)'; c.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {                                       // 윗니, 아랫니
      const tx = hx + hh * (0.15 + i * 0.32);
      for (const s of [-1, 1]) {
        const ty = ly + s * (mo * (0.55 + i * 0.18) + hh * 0.08);
        c.beginPath();
        c.moveTo(tx - hh * 0.14, ty); c.lineTo(tx + hh * 0.14, ty); c.lineTo(tx, ty - s * hh * 0.42);
        c.closePath(); c.fill(); c.stroke();
      }
    }
    // 눈
    c.fillStyle = `hsl(${lerp(50, 8, k)},100%,58%)`;
    c.shadowColor = '#ffcc33'; c.shadowBlur = 10;
    c.beginPath(); c.ellipse(hx - hh * 0.2, ly - hh * 0.62, hh * 0.26, hh * 0.2, 0, 0, Math.PI * 2); c.fill();
    c.shadowBlur = 0;
    c.fillStyle = '#1a0008';
    c.beginPath(); c.ellipse(hx - hh * 0.12, ly - hh * 0.62, hh * 0.07, hh * 0.17, 0, 0, Math.PI * 2); c.fill();

    // 느낌표 (깜빡이며 커진다)
    if (warn && Math.sin(this.time * 20) > -0.3) {
      this.drawAlert(c, Math.max(tip, 0) + r * 1.7, ly - r * 0.2, r * (1.05 + 0.3 * k));
    }
  }

  /** 하트 모양 경로 (가운데 x,y / 크기 s) */
  heartPath(c, x, y, s) {
    c.beginPath();
    c.moveTo(x, y + s * 0.9);
    c.bezierCurveTo(x - s * 1.35, y + s * 0.05, x - s * 0.95, y - s * 1.0, x, y - s * 0.38);
    c.bezierCurveTo(x + s * 0.95, y - s * 1.0, x + s * 1.35, y + s * 0.05, x, y + s * 0.9);
    c.closePath();
  }

  /** 날개 한 쪽 (s: -1 왼쪽, 1 오른쪽 / flap: 펄럭이는 각도) */
  drawWing(c, x, y, s, size, flap, fill) {
    c.save();
    c.translate(x, y); c.scale(s, 1); c.rotate(-0.25 - flap);
    c.fillStyle = fill;
    c.strokeStyle = 'rgba(150,170,210,.8)'; c.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {                                       // 깃털 네 장 (안쪽이 길다)
      c.beginPath();
      c.ellipse(size * (0.35 + i * 0.22), -size * (0.12 + i * 0.1), size * (0.55 - i * 0.07), size * 0.2, -0.35 - i * 0.18, 0, Math.PI * 2);
      c.fill(); c.stroke();
    }
    c.restore();
  }

  /** 부활 하트: 금빛 하트에 흰 날개, 둥실둥실 떠서 반짝인다 */
  drawHeart(c, h) {
    const r = this.r, x = h.x - this.camX;
    if (x < -r * 3 || x > this.W + r * 3) return;
    const y = h.y - r * 0.4 + Math.sin(h.t * 3) * r * 0.25, s = r * 0.85;
    const glow = c.createRadialGradient(x, y, 1, x, y, r * 2.6);
    glow.addColorStop(0, 'rgba(255,225,120,.55)');
    glow.addColorStop(1, 'rgba(255,225,120,0)');
    c.fillStyle = glow;
    c.beginPath(); c.arc(x, y, r * 2.6, 0, Math.PI * 2); c.fill();
    const flap = Math.sin(h.t * 9) * 0.35;
    for (const sd of [-1, 1]) this.drawWing(c, x + sd * s * 0.7, y - s * 0.15, sd, s * 1.15, flap, '#ffffff');
    const g = c.createLinearGradient(x - s, y - s, x + s, y + s);
    g.addColorStop(0, '#fff3a6'); g.addColorStop(0.45, '#ffc824'); g.addColorStop(1, '#c98400');
    this.heartPath(c, x, y, s);
    c.fillStyle = g;
    c.shadowColor = '#ffd84a'; c.shadowBlur = 14;
    c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = '#8a5a00'; c.lineWidth = 2; c.stroke();
    c.fillStyle = 'rgba(255,255,255,.75)';                              // 반짝
    c.beginPath(); c.ellipse(x - s * 0.42, y - s * 0.3, s * 0.18, s * 0.11, -0.6, 0, Math.PI * 2); c.fill();
    // 금 테두리 장식 (작은 구슬)
    c.fillStyle = '#fff6c8';
    for (const [dx, dy] of [[0, 0.62], [-0.55, 0.05], [0.55, 0.05]]) {
      c.beginPath(); c.arc(x + dx * s, y + dy * s, s * 0.09, 0, Math.PI * 2); c.fill();
    }
  }

  /** 천사: 빛기둥을 타고 내려와 아이를 내려놓고, 다시 올라가며 사라진다 */
  drawAngel(c, A) {
    const r = this.r, R = A.R;
    const x = (A.landed ? A.x : R.x) - this.camX;
    const gy = A.landed ? A.y : R.y;                                    // 내려놓을 땅
    let lift, alpha = 1;
    if (!A.landed) {
      const k = clamp(A.t / A.T, 0, 1), e = 1 - Math.pow(1 - k, 3);
      lift = (1 - e) * (gy + r * 4);
    } else {
      const k = clamp(A.t / 1.1, 0, 1);
      lift = k * k * (gy + r * 6);
      alpha = 1 - k;
    }
    const kidY = -lift - r * 0.25;                                      // 아이를 들어 올린 만큼

    c.save();
    c.globalAlpha = alpha;
    // 빛기둥
    const beam = c.createLinearGradient(0, 0, 0, gy + r);
    beam.addColorStop(0, 'rgba(255,240,170,0)');
    beam.addColorStop(0.3, 'rgba(255,240,170,.28)');
    beam.addColorStop(1, 'rgba(255,240,170,.12)');
    c.fillStyle = beam;
    c.beginPath();
    c.moveTo(x - r * 1.2, -10); c.lineTo(x + r * 1.2, -10); c.lineTo(x + r * 2.2, gy + r); c.lineTo(x - r * 2.2, gy + r);
    c.closePath(); c.fill();

    // 데리고 내려오는 아이 (금빛으로 감싼다)
    if (!A.landed) {
      c.save();
      c.translate(0, kidY);
      const halo = c.createRadialGradient(x, gy - r * 0.6, 1, x, gy - r * 0.6, r * 2.2);
      halo.addColorStop(0, 'rgba(255,230,140,.6)'); halo.addColorStop(1, 'rgba(255,230,140,0)');
      c.fillStyle = halo;
      c.beginPath(); c.arc(x, gy - r * 0.6, r * 2.2, 0, Math.PI * 2); c.fill();
      this.drawRunner(c, R, false);
      c.restore();
    }

    // 천사 (아이 머리 위에서 두 손으로 붙잡고 있다)
    const ay = gy + kidY - r * 3.1;
    const flap = Math.sin(this.time * 8) * 0.4;
    for (const sd of [-1, 1]) this.drawWing(c, x + sd * r * 0.45, ay - r * 0.1, sd, r * 1.5, flap, '#f8fbff');
    // 옷
    const robe = c.createLinearGradient(x, ay - r * 0.6, x, ay + r * 1.3);
    robe.addColorStop(0, '#ffffff'); robe.addColorStop(1, '#cfe0ff');
    c.fillStyle = robe;
    c.beginPath();
    c.moveTo(x - r * 0.35, ay - r * 0.4); c.lineTo(x + r * 0.35, ay - r * 0.4);
    c.quadraticCurveTo(x + r * 0.7, ay + r * 0.6, x + r * 0.75, ay + r * 1.25);
    c.lineTo(x - r * 0.75, ay + r * 1.25);
    c.quadraticCurveTo(x - r * 0.7, ay + r * 0.6, x - r * 0.35, ay - r * 0.4);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(120,140,190,.6)'; c.lineWidth = 1.2; c.stroke();
    c.strokeStyle = '#ffcf3d'; c.lineWidth = r * 0.12;                  // 금 허리띠
    c.beginPath(); c.moveTo(x - r * 0.5, ay + r * 0.3); c.lineTo(x + r * 0.5, ay + r * 0.3); c.stroke();
    // 두 팔: 아이 어깨를 잡는다
    c.strokeStyle = '#ffe2c4'; c.lineWidth = r * 0.2; c.lineCap = 'round';
    for (const sd of [-1, 1]) {
      c.beginPath(); c.moveTo(x + sd * r * 0.4, ay - r * 0.1);
      c.quadraticCurveTo(x + sd * r * 1.0, ay + r * 0.8, x + sd * r * 0.85, ay + r * 1.6); c.stroke();
    }
    // 얼굴 + 머리카락
    c.fillStyle = '#ffe2c4';
    c.beginPath(); c.arc(x, ay - r * 0.85, r * 0.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ffd36b';
    c.beginPath(); c.arc(x, ay - r * 1.0, r * 0.52, Math.PI * 1.05, Math.PI * 1.95); c.fill();
    c.strokeStyle = '#4a3a2a'; c.lineWidth = Math.max(1.3, r * 0.08);   // 웃는 눈
    for (const sd of [-1, 1]) {
      c.beginPath(); c.arc(x + sd * r * 0.18, ay - r * 0.82, r * 0.1, Math.PI * 1.1, Math.PI * 1.9); c.stroke();
    }
    c.beginPath(); c.arc(x, ay - r * 0.68, r * 0.13, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
    // 후광
    c.strokeStyle = '#ffd84a'; c.lineWidth = r * 0.14;
    c.shadowColor = '#ffe680'; c.shadowBlur = 12;
    c.beginPath(); c.ellipse(x, ay - r * 1.55, r * 0.5, r * 0.15, 0, 0, Math.PI * 2); c.stroke();
    c.shadowBlur = 0;
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

    if (o.cool > 0) c.globalAlpha = 0.45 + 0.3 * Math.sin(this.time * 40);
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
      case 'mine': {
        if (o.state === 'hidden') break;                 // 드러나기 전에는 바닥과 구분되지 않는다
        const r = this.r;
        if (o.state === 'armed') {
          const k = clamp(o.t / o.fuse, 0, 1);
          const pop = Math.min(1, o.t / 0.12);           // 툭 튀어나온다
          const blink = Math.sin(o.t * o.t * 34 + o.t * 10) > 0;   // 갈수록 빨리 깜빡인다
          // 폭파 범위: 빨간 원
          c.save();
          c.fillStyle = `rgba(255,40,48,${(0.12 + 0.2 * k) * (blink ? 1.35 : 1)})`;
          c.beginPath(); c.arc(sx, o.y, o.rad * pop, 0, Math.PI * 2); c.fill();
          c.strokeStyle = `rgba(255,${blink ? 120 : 60},${blink ? 110 : 70},${0.75 + 0.25 * k})`;
          c.lineWidth = 3 + 2 * k;
          c.setLineDash([12, 7]); c.lineDashOffset = -this.time * 60;
          c.beginPath(); c.arc(sx, o.y, o.rad * pop, 0, Math.PI * 2); c.stroke();
          c.setLineDash([]);
          // 안쪽으로 조여드는 원 = 남은 시간
          c.strokeStyle = 'rgba(255,225,200,.9)';
          c.lineWidth = 2.5;
          c.beginPath(); c.arc(sx, o.y, Math.max(r * 0.55, o.rad * (1 - k)), 0, Math.PI * 2); c.stroke();
          c.restore();
          // 지뢰 몸통
          const mr = r * 0.62 * pop;
          c.fillStyle = 'rgba(0,0,0,.4)';
          c.beginPath(); c.ellipse(sx, o.y + mr * 0.5, mr * 1.15, mr * 0.5, 0, 0, Math.PI * 2); c.fill();
          c.strokeStyle = '#11141f'; c.lineWidth = mr * 0.34; c.lineCap = 'round';
          c.beginPath();
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2 + 0.39;
            c.moveTo(sx + Math.cos(a) * mr * 0.8, o.y + Math.sin(a) * mr * 0.8);
            c.lineTo(sx + Math.cos(a) * mr * 1.3, o.y + Math.sin(a) * mr * 1.3);
          }
          c.stroke();
          const g = c.createRadialGradient(sx - mr * 0.3, o.y - mr * 0.35, 1, sx, o.y, mr);
          g.addColorStop(0, '#5d6480'); g.addColorStop(1, '#1b1f30');
          c.fillStyle = g;
          c.beginPath(); c.arc(sx, o.y, mr, 0, Math.PI * 2); c.fill();
          c.fillStyle = blink ? '#ff3040' : '#6a0f18';
          if (blink) { c.shadowColor = '#ff2a3a'; c.shadowBlur = 16; }
          c.beginPath(); c.arc(sx, o.y, mr * 0.42, 0, Math.PI * 2); c.fill();
          c.shadowBlur = 0;
        } else {
          // 그을린 자국은 남고, 불덩이는 금세 사라진다
          const fade = clamp(1 - (o.t - 0.5) / 2.5, 0, 1);
          c.fillStyle = `rgba(8,6,10,${0.42 * fade})`;
          c.beginPath(); c.arc(sx, o.y, o.rad * 0.72, 0, Math.PI * 2); c.fill();
          c.fillStyle = `rgba(8,6,10,${0.3 * fade})`;
          c.beginPath(); c.arc(sx, o.y, o.rad * 0.4, 0, Math.PI * 2); c.fill();
          if (o.t < 0.42) {
            const k = o.t / 0.42, e = 1 - (1 - k) * (1 - k);
            const fr = o.rad * (0.45 + 0.7 * e);
            const g = c.createRadialGradient(sx, o.y, 0, sx, o.y, fr);
            g.addColorStop(0, `rgba(255,255,235,${1 - k})`);
            g.addColorStop(0.35, `rgba(255,214,90,${0.95 * (1 - k)})`);
            g.addColorStop(0.75, `rgba(255,96,40,${0.8 * (1 - k)})`);
            g.addColorStop(1, 'rgba(255,60,30,0)');
            c.fillStyle = g;
            c.beginPath(); c.arc(sx, o.y, fr, 0, Math.PI * 2); c.fill();
          }
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
    c.globalAlpha = 1;
  }

  /**
   * 팔다리 자세 (몸 중심 기준, 단위는 반지름).
   * 춤출 때는 발이 땅에 붙어 있도록, 선 자리 기준으로 적힌 춤 자세를 몸 기준으로 옮긴다.
   */
  limbsOf(R, cel, st) {
    const q = this._limb || (this._limb = { fl: [0, 0, 0], fr: [0, 0, 0], al: [0, 0], ar: [0, 0], el: [0, 0], er: [0, 0] });
    q.kn = 0; q.hip = 0.3; q.sh = SHO_X; q.hl = ''; q.hr = '';
    q.el[0] = -1; q.el[1] = 0.35; q.er[0] = 1; q.er[1] = 0.35;

    if (cel) {
      const airK = clamp(cel.h / 0.5, 0, 1);                              // 공중에서는 발이 몸을 따라온다
      const gy = GROUND - cel.by - st.sqz * 0.3 - Math.min(0.3, cel.h * 0.25);
      const a = -cel.rot * (1 - airK), ca = Math.cos(a), sa = Math.sin(a);
      for (const sd of [-1, 1]) {
        const src = sd < 0 ? cel.fl : cel.fr, dst = sd < 0 ? q.fl : q.fr;
        const x = src[0] - cel.bx, y = gy - src[1];
        dst[0] = x * ca - y * sa; dst[1] = x * sa + y * ca; dst[2] = src[2];
      }
      q.al[0] = cel.al[0]; q.al[1] = cel.al[1]; q.ar[0] = cel.ar[0]; q.ar[1] = cel.ar[1];
      q.el[0] = cel.el[0]; q.el[1] = cel.el[1]; q.er[0] = cel.er[0]; q.er[1] = cel.er[1];
      q.kn = cel.kn; q.hip = cel.hip; q.sh = cel.sh; q.hl = cel.hl; q.hr = cel.hr;
      return q;
    }

    const t = this.time, ph = R.bob;
    const set = (v, x, y) => { v[0] = x; v[1] = y; v[2] = 0; };
    if (st.strug) {                                                       // 들려서 버둥버둥
      const k = Math.sin(t * 30), a = t * 26;
      set(q.fl, -0.28 + 0.7 * k, 1.45); set(q.fr, 0.28 - 0.7 * k, 1.45);
      set(q.al, -1.1 - Math.cos(a + 2.2) * 0.8, 0.1 + Math.sin(a + 2.2) * 0.8);
      set(q.ar, 1.1 + Math.cos(a) * 0.8, 0.1 + Math.sin(a) * 0.8);
    } else if (R.carry) {                                                 // 머리 위로 번쩍 든다 (던지기 직전엔 뒤로 젖힌다)
      const up = clamp(R.liftT / 0.4, 0, 1), wk = this.windup(R);
      set(q.fl, -0.34 + 0.2 * Math.sin(ph), GROUND); set(q.fr, 0.34 - 0.2 * Math.sin(ph), GROUND);
      set(q.al, -(1.1 - 0.3 * up) - 0.6 * wk, -(0.1 + 1.2 * up)); set(q.ar, 1.1 - 0.3 * up - 0.6 * wk, -(0.1 + 1.2 * up));
      q.el[1] = -0.2; q.er[1] = -0.2;
    } else if (st.dz) {                                                   // 기절: 팔을 늘어뜨리고 휘청
      const w = Math.sin(t * 7 + ph);
      set(q.fl, -0.36 + 0.14 * w, GROUND); set(q.fr, 0.36 + 0.14 * w, GROUND);
      set(q.al, -1.1 + 0.14 * w, 0.9); set(q.ar, 1.1 + 0.14 * w, 0.9);
    } else if (st.air > 0.25) {                                           // 점프: 다리를 접고 두 팔을 번쩍
      set(q.fl, -0.34, 1.15); set(q.fr, 0.34, 1.15);
      set(q.al, -1.15, -1.0 - 0.2 * st.air); set(q.ar, 1.15, -1.0 - 0.2 * st.air);
      q.el[1] = -0.2; q.er[1] = -0.2;
    } else {                                                              // 달리기: 팔과 다리를 엇갈려 젓는다
      const s = Math.sin(ph), cs = Math.cos(ph);
      q.kn = 1; q.hip = 0.2;
      set(q.fl, -0.12 + 0.6 * s, GROUND - 0.45 * Math.max(0, cs));
      set(q.fr, 0.12 - 0.6 * s, GROUND - 0.45 * Math.max(0, -cs));
      if (st.scared) {                                                    // 괴물이 코앞: 두 팔을 들고 허둥지둥
        set(q.al, -1.15 + 0.2 * Math.sin(t * 28), -0.95 + 0.16 * Math.cos(t * 28));
        set(q.ar, 1.15 + 0.2 * Math.sin(t * 28 + 2), -0.95 + 0.16 * Math.cos(t * 28 + 2));
        q.el[1] = -0.2; q.er[1] = -0.2;
      } else if (R.dash > 0) {                                            // 대쉬: 두 팔을 뒤로 쭉
        set(q.al, -1.95, 0.4 + 0.06 * s); set(q.ar, 0.55, 0.98 + 0.04 * s);
        q.er[0] = 0.2; q.er[1] = 1;
      } else {
        set(q.al, -1.08 - 0.34 * s, 0.7 - 0.14 * Math.abs(s));
        set(q.ar, 1.08 + 0.34 * s, 0.7 - 0.14 * Math.abs(s));
      }
    }
    if (R.punch > 0 && !st.ghost) {                                       // 주먹: 오른팔을 어깨에서 위->아래로 크게 휘두른다
      const k = 1 - R.punch / R.punchT;                                   // 0 -> 1
      const ang = -1.15 + k * 2.3, reach = 0.8 + 0.42 * Math.sin(k * Math.PI);
      set(q.ar, SHO_X + Math.cos(ang) * reach, SHO_Y + Math.sin(ang) * reach);
      q.er[0] = 1; q.er[1] = 0.6; q.hr = 'fist';
    }
    return q;
  }

  /** 다리와 신발 (몸보다 먼저 그려서 허벅지 위쪽은 몸에 가린다) */
  drawLegs(c, R, q, sx, y, r, moon) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const sd of [-1, 1]) {
      const f = sd < 0 ? q.fl : q.fr, tip = f[2] || 0;
      const side = q.kn > 0.5;                                            // 옆모습인가
      const hx = sd * q.hip;
      const ax = f[0] - (side ? tip * 0.12 : 0), ay = f[1] - 0.14 - tip * 0.24;   // 발목 (뒤꿈치를 들면 올라간다)
      const [kx, ky] = bend2(hx, HIP_Y, ax, ay, LEG, LEG, lerp(sd, 1, q.kn), -0.1);
      c.beginPath();
      c.moveTo(sx + hx * r, y + HIP_Y * r); c.lineTo(sx + kx * r, y + ky * r); c.lineTo(sx + ax * r, y + ay * r);
      c.strokeStyle = INK; c.lineWidth = r * 0.3 + 3; c.stroke();
      c.strokeStyle = `hsl(${R.hue},60%,36%)`; c.lineWidth = r * 0.3; c.stroke();
      if (moon) {                                                         // 반짝이는 흰 양말
        const dx = kx - ax, dy = ky - ay, d = Math.hypot(dx, dy) || 1;
        c.strokeStyle = '#fff'; c.lineWidth = r * 0.3; c.lineCap = 'butt';
        c.beginPath();
        c.moveTo(sx + ax * r, y + ay * r); c.lineTo(sx + (ax + (dx / d) * 0.26) * r, y + (ay + (dy / d) * 0.26) * r);
        c.stroke();
        c.lineCap = 'round';
      }
      const fwd = side ? 0.13 : sd * 0.07;
      c.fillStyle = moon ? '#0c0d12' : `hsl(${R.hue},65%,24%)`;
      c.beginPath();
      c.ellipse(sx + (ax + fwd) * r, y + (ay + 0.05 + tip * 0.07) * r, r * (side ? 0.3 : 0.24), r * 0.15,
        tip * (side ? 0.85 : sd * 0.5), 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = moon ? 'rgba(255,255,255,.75)' : INK; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = 'rgba(255,255,255,.3)';                                // 신발 코
      c.beginPath();
      c.arc(sx + (ax + fwd * 1.9) * r, y + (ay + 0.04 + tip * 0.14) * r, r * 0.055, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** 팔과 손 (몸 앞에 그린다) */
  drawArms(c, R, q, sx, y, r) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const sd of [-1, 1]) {
      const t = sd < 0 ? q.al : q.ar, hint = sd < 0 ? q.el : q.er, shape = sd < 0 ? q.hl : q.hr;
      const shx = sd * q.sh;
      const [ex, ey] = bend2(shx, SHO_Y, t[0], t[1], ARM, ARM, hint[0], hint[1]);
      c.beginPath();
      c.moveTo(sx + shx * r, y + SHO_Y * r); c.lineTo(sx + ex * r, y + ey * r); c.lineTo(sx + t[0] * r, y + t[1] * r);
      c.strokeStyle = INK; c.lineWidth = r * 0.3 + 3; c.stroke();
      c.strokeStyle = `hsl(${R.hue},68%,38%)`; c.lineWidth = r * 0.3; c.stroke();
      const hx = sx + t[0] * r, hy = y + t[1] * r;
      const skin = shape === 'glove' ? '#fff' : `hsl(${R.hue},95%,${shape ? 74 : 66}%)`;
      if (shape === 'thumb' || shape === 'L' || shape === 'point') {      // 손가락
        c.beginPath();
        if (shape === 'point') {
          const dx = t[0] - ex, dy = t[1] - ey, d = Math.hypot(dx, dy) || 1;
          c.moveTo(hx, hy); c.lineTo(hx + (dx / d) * r * 0.55, hy + (dy / d) * r * 0.55);
        } else {
          c.moveTo(hx, hy); c.lineTo(hx, hy - r * (shape === 'L' ? 0.82 : 0.5));
          if (shape === 'L') { c.moveTo(hx, hy); c.lineTo(hx - sd * r * 0.7, hy); }   // 엄지는 어느 손이든 몸 중심 쪽을 향한다
        }
        c.strokeStyle = INK; c.lineWidth = r * 0.2 + 3; c.stroke();
        c.strokeStyle = skin; c.lineWidth = r * 0.2; c.stroke();
      }
      c.fillStyle = skin;
      c.beginPath(); c.arc(hx, hy, r * (shape === 'fist' ? 0.4 : 0.3), 0, Math.PI * 2); c.fill();
      c.strokeStyle = INK; c.lineWidth = 1.6; c.stroke();
    }
  }

  /** 모자·목도리 같은 꾸밈 (이름에서 정해진다). 춤 소품이 있으면 모자 자리는 소품이 차지한다 */
  drawGear(c, R, sx, y, r, prop) {
    const L = R.look;
    const A = `hsl(${L.accHue},85%,60%)`, A2 = `hsl(${L.accHue},75%,40%)`;
    const acc = prop === 'fedora' && (L.acc === 'cap' || L.acc === 'beanie' || L.acc === 'headband') ? 'none' : L.acc;
    c.lineCap = 'round'; c.lineJoin = 'round';
    switch (acc) {
      case 'cap':
        c.fillStyle = A2;                                                 // 챙
        c.beginPath(); c.ellipse(sx + r * 0.66, y - r * 0.6, r * 0.5, r * 0.13, 0.1, 0, Math.PI * 2); c.fill();
        c.fillStyle = A;
        c.beginPath(); c.ellipse(sx, y - r * 0.6, r * 0.8, r * 0.52, 0, Math.PI, 0); c.closePath(); c.fill();
        c.fillStyle = A2;
        c.beginPath(); c.arc(sx, y - r * 1.12, r * 0.08, 0, Math.PI * 2); c.fill();
        break;
      case 'beanie':
        c.fillStyle = A;
        c.beginPath(); c.ellipse(sx, y - r * 0.62, r * 0.78, r * 0.6, 0, Math.PI, 0); c.closePath(); c.fill();
        c.strokeStyle = A2; c.lineWidth = r * 0.2;
        c.beginPath(); c.moveTo(sx - r * 0.74, y - r * 0.62); c.lineTo(sx + r * 0.74, y - r * 0.62); c.stroke();
        c.fillStyle = '#fff';
        c.beginPath(); c.arc(sx, y - r * 1.26, r * 0.19, 0, Math.PI * 2); c.fill();
        break;
      case 'headband': {
        const fl = Math.sin(R.bob * 1.7) * r * 0.12;
        c.strokeStyle = A; c.lineWidth = r * 0.17;
        c.beginPath(); c.moveTo(sx - r * 0.84, y - r * 0.5); c.quadraticCurveTo(sx, y - r * 0.68, sx + r * 0.84, y - r * 0.5); c.stroke();
        c.lineWidth = r * 0.12;                                           // 뒤로 날리는 매듭
        c.beginPath();
        c.moveTo(sx - r * 0.86, y - r * 0.5); c.lineTo(sx - r * 1.3, y - r * 0.62 + fl);
        c.moveTo(sx - r * 0.86, y - r * 0.5); c.lineTo(sx - r * 1.25, y - r * 0.34 - fl);
        c.stroke();
        break;
      }
      case 'tie': {                                                       // 넥타이 (흰 깃 + 매듭 + 달릴 때 살랑이는 끝)
        const tx = sx + r * 0.06, ty = y + r * 0.7;                     // 입과 떨어지게 몸 아래쪽에 맨다
        const sw = Math.sin(R.bob * 1.7) * r * 0.08;
        c.fillStyle = '#f4f6ff';                                          // 셔츠 깃
        c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1;
        for (const s of [-1, 1]) {
          c.beginPath();
          c.moveTo(tx, ty + r * 0.06); c.lineTo(tx + s * r * 0.42, ty - r * 0.14); c.lineTo(tx + s * r * 0.34, ty + r * 0.2);
          c.closePath(); c.fill(); c.stroke();
        }
        c.fillStyle = A;                                                  // 넥타이 몸
        c.beginPath();
        c.moveTo(tx - r * 0.12, ty + r * 0.1); c.lineTo(tx + r * 0.12, ty + r * 0.1);
        c.lineTo(tx + r * 0.22 + sw, ty + r * 0.56); c.lineTo(tx + sw, ty + r * 0.74); c.lineTo(tx - r * 0.22 + sw, ty + r * 0.56);
        c.closePath(); c.fill();
        c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.2; c.stroke();
        c.save(); c.clip();                                               // 사선 줄무늬
        c.strokeStyle = A2; c.lineWidth = r * 0.09; c.lineCap = 'butt';
        c.beginPath();
        for (const k of [0.28, 0.46, 0.64]) { c.moveTo(tx - r * 0.35, ty + r * k); c.lineTo(tx + r * 0.35, ty + r * (k - 0.2)); }
        c.stroke();
        c.restore();
        c.fillStyle = A2;                                                 // 매듭
        c.beginPath();
        c.moveTo(tx - r * 0.17, ty - r * 0.06); c.lineTo(tx + r * 0.17, ty - r * 0.06); c.lineTo(tx + r * 0.11, ty + r * 0.16); c.lineTo(tx - r * 0.11, ty + r * 0.16);
        c.closePath(); c.fill();
        break;
      }
      case 'scarf': {
        const fl = Math.sin(R.bob * 1.7) * r * 0.16;
        c.strokeStyle = A2; c.lineWidth = r * 0.2;                        // 뒤로 날리는 자락
        c.beginPath(); c.moveTo(sx - r * 0.7, y + r * 0.56); c.quadraticCurveTo(sx - r * 1.1, y + r * 0.5 - fl, sx - r * 1.45, y + r * 0.62 + fl); c.stroke();
        c.strokeStyle = A; c.lineWidth = r * 0.24;
        c.beginPath(); c.moveTo(sx - r * 0.8, y + r * 0.5); c.quadraticCurveTo(sx, y + r * 0.86, sx + r * 0.8, y + r * 0.5); c.stroke();
        break;
      }
    }
    if (prop === 'fedora') {                                              // 문워크의 중절모 (살짝 눌러쓴다)
      c.save();
      c.translate(sx + r * 0.12, y - r * 0.72); c.rotate(0.12);
      c.fillStyle = '#0d0e14';
      c.beginPath(); c.ellipse(0, 0, r * 1.12, r * 0.2, 0, 0, Math.PI * 2); c.fill();
      c.beginPath();
      c.moveTo(-r * 0.66, 0); c.lineTo(-r * 0.56, -r * 0.6); c.quadraticCurveTo(0, -r * 0.78, r * 0.56, -r * 0.6); c.lineTo(r * 0.66, 0);
      c.closePath(); c.fill();
      c.strokeStyle = '#f4f4f8'; c.lineWidth = r * 0.14; c.lineCap = 'butt';
      c.beginPath(); c.moveTo(-r * 0.63, -r * 0.14); c.lineTo(r * 0.63, -r * 0.14); c.stroke();
      c.restore();
    }
  }

  drawRunner(c, R, ghost) {
    let sx = R.x - this.camX;
    if (sx < -90 || sx > this.W + 90) return;
    const r0 = this.r;                                           // 부딪히는 반지름
    const r = r0 * BODY;                                         // 그리는 몸통 반지름 (얼굴·팔다리는 모두 이 크기 기준)
    const hurt = !ghost && R.hurt > 0 ? clamp(R.hurt / 0.55, 0, 1) : 0;   // 맞은 직후 1 -> 0
    if (hurt) sx += Math.sin(this.time * 70) * r * 0.14 * hurt;             // 부르르 떤다
    if (!ghost && R.heldBy) sx += Math.sin(this.time * 45) * r * 0.1;       // 버둥버둥
    const cel = !ghost && R.cel ? R.cel : null;                  // 세레모니 자세
    const footX = sx + (cel ? cel.dx * r0 : 0);                  // 발 딛고 선 자리
    if (cel) sx = footX + cel.bx * cel.flipX * r;
    const h = ghost ? 0 : this.heightOf(R);                      // 떠 있는 높이(px)
    const S = ghost ? 1 : this.scaleOf(R);                       // 뜨면 커진다
    const carried = !ghost && !!(R.heldBy || R.flight);          // 들려 있거나 던져진 중
    const air = ghost || carried ? 0 : clamp(h / (r0 * 3.3), 0, 1); // 점프 느낌(길쭉, 빛남)
    const hs = clamp(h / (r0 * 3.3), 0, 1);                      // 그림자가 줄어드는 정도
    const dz = !ghost && R.dizzy > 0;
    const scared = !ghost && !R.heldBy && R.fear > 0.45 && R.dizzy <= 0;   // 괴물이 코앞이라 겁먹음
    const strug = !ghost && !!R.heldBy;                          // 들려서 버둥거리는 중
    const sqz = !ghost ? Math.max(clamp(R.squash / 0.35, 0, 1), R.carry ? 0.5 : 0, cel ? cel.sq : 0) : 0;   // 밟혀/무거워 납작
    const hop = ghost || carried || cel ? 0 : Math.abs(Math.sin(R.bob)) * r0 * 0.36;
    // 몸통은 땅에서 띄워 다리가 보이게 한다. 춤출 때는 발은 그대로 두고 몸만 오르내린다
    const y = R.y - hop - h + sqz * r * 0.3 + (cel ? cel.by : 0) * r - LIFT * r0;

    // 그림자 (뜰수록 작아진다)
    if (!ghost && !R.heldBy) {
      c.fillStyle = `rgba(0,0,0,${0.34 - hs * 0.2})`;
      c.beginPath();
      c.ellipse(footX, R.y + r0 * 0.9, r0 * (0.85 - hs * 0.35), r0 * (0.28 - hs * 0.12), 0, 0, Math.PI * 2);
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

    // 부활 직후: 금빛 보호막
    if (!ghost && R.shield > 0) {
      const a = Math.min(1, R.shield / 0.5) * (0.55 + 0.25 * Math.sin(this.time * 14));
      c.strokeStyle = `rgba(255,215,90,${a})`; c.lineWidth = 3;
      c.fillStyle = `rgba(255,235,150,${a * 0.25})`;
      c.beginPath(); c.arc(sx, y + r * 0.3, r * 1.9, 0, Math.PI * 2); c.fill(); c.stroke();
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

    const L = R.look;
    const dark = `hsl(${R.hue},70%,42%)`;
    const prop = cel ? cel.prop : '';
    // 탈락해 사라지는 아이도 같은 몸으로 그린다 (팔다리는 기절한 듯 축 늘어뜨린다)
    const limb = this.limbsOf(R, cel, { air, dz: dz || ghost, scared, strug, sqz, ghost });

    // 다리
    if (limb) this.drawLegs(c, R, limb, sx, y, r, prop === 'fedora');

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
      if (panda) {
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

    // 배 (밝은 색 배)
    if (L.belly) {
      c.fillStyle = `hsla(${R.hue},100%,90%,.42)`;
      c.beginPath(); c.ellipse(sx + r * 0.05, y + ry * 0.42, rx * 0.5, ry * 0.4, 0, 0, Math.PI * 2); c.fill();
    }
    // 줄무늬 옷 (몸 모양 안쪽으로만 칠한다)
    if (L.stripes) {
      c.save();
      c.beginPath(); c.ellipse(sx, y, rx, ry, 0, 0, Math.PI * 2); c.clip();
      c.strokeStyle = `hsla(${R.hue},70%,30%,.42)`;
      c.lineWidth = r * 0.17; c.lineCap = 'butt';
      c.beginPath();
      for (const k of [0.36, 0.7]) {
        c.moveTo(sx - r * 1.1, y + ry * k); c.quadraticCurveTo(sx, y + ry * (k + 0.16), sx + r * 1.1, y + ry * k);
      }
      c.stroke();
      c.restore();
    }
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

    /* 얼굴: 달릴 때는 가는 쪽으로, 춤출 때는 보는 쪽으로 살짝 돌린다 */
    c.save();
    c.translate((cel ? cel.look * 0.3 : ghost ? 0 : 0.1) * r, 0);

    // 볼 터치
    if (L.blush) {
      c.fillStyle = 'rgba(255,110,140,.36)';
      for (const s of [-1, 1]) {
        c.beginPath(); c.ellipse(sx + s * r * 0.5, y + r * 0.14, r * 0.15, r * 0.09, 0, 0, Math.PI * 2); c.fill();
      }
    }

    // 눈 (뛸 때는 질끈 감는다. 윙크하는 아이도 있다)
    const shutLine = (x0, x1) => {
      c.beginPath(); c.moveTo(x0, y - r * 0.18); c.lineTo(x1, y - r * 0.18); c.stroke();
    };
    c.fillStyle = '#16203c';
    c.strokeStyle = '#16203c';
    c.lineWidth = Math.max(1.5, r * 0.13);
    c.lineCap = 'round';
    if (prop === 'shades') {                         // 말춤의 선글라스
      c.fillStyle = '#0b0d16';
      for (const s of [-1, 1]) {
        c.beginPath(); c.ellipse(sx + s * r * 0.3, y - r * 0.14, r * 0.27, r * 0.2, 0, 0, Math.PI * 2); c.fill();
      }
      c.lineWidth = Math.max(1.5, r * 0.1); c.strokeStyle = '#0b0d16';
      c.beginPath(); c.moveTo(sx - r * 0.1, y - r * 0.18); c.lineTo(sx + r * 0.1, y - r * 0.18);
      c.moveTo(sx - r * 0.55, y - r * 0.2); c.lineTo(sx - r * 0.86, y - r * 0.3);
      c.moveTo(sx + r * 0.55, y - r * 0.2); c.lineTo(sx + r * 0.86, y - r * 0.3);
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = Math.max(1, r * 0.06);
      for (const s of [-1, 1]) {
        c.beginPath(); c.moveTo(sx + s * r * 0.3 - r * 0.14, y - r * 0.12); c.lineTo(sx + s * r * 0.3 - r * 0.02, y - r * 0.24); c.stroke();
      }
    } else if (cel && cel.face === 'smug') {         // 약 올리는 눈: 한쪽은 윙크
      c.lineWidth = Math.max(2, r * 0.15);
      c.beginPath(); c.arc(sx + r * 0.27, y - r * 0.08, r * 0.17, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
      c.beginPath(); c.moveTo(sx - r * 0.42, y - r * 0.24); c.lineTo(sx - r * 0.2, y - r * 0.14); c.lineTo(sx - r * 0.42, y - r * 0.04); c.stroke();
    } else if (cel) {                                // 신나서 ^ ^
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
      // 눈 모양은 아이마다 다르다: 점 / 큰 눈 / 길쭉한 눈. 눈동자에 반짝이는 점 하나
      const ew = r * (L.eyes === 'big' ? 0.2 : L.eyes === 'oval' ? 0.12 : 0.15);
      const eh = r * (L.eyes === 'big' ? 0.2 : L.eyes === 'oval' ? 0.2 : 0.15);
      const eye = (ex) => {
        c.fillStyle = '#16203c';
        c.beginPath(); c.ellipse(ex, y - r * 0.16, ew, eh, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,.9)';
        c.beginPath(); c.arc(ex + ew * 0.3, y - r * 0.16 - eh * 0.35, Math.max(1, ew * 0.34), 0, Math.PI * 2); c.fill();
      };
      eye(sx + r * 0.22);
      if (L.wink) shutLine(sx - r * 0.38, sx - r * 0.1);
      else eye(sx - r * 0.24);
      c.fillStyle = '#16203c';
    }

    // 안경
    if (L.acc === 'glasses' && prop !== 'shades') {
      c.strokeStyle = '#141a33'; c.lineWidth = Math.max(1.2, r * 0.07);
      for (const s of [-1, 1]) {
        c.beginPath(); c.arc(sx + s * r * 0.26, y - r * 0.15, r * 0.25, 0, Math.PI * 2); c.stroke();
      }
      c.beginPath(); c.moveTo(sx - r * 0.02, y - r * 0.15); c.lineTo(sx + r * 0.02, y - r * 0.15); c.stroke();
      c.strokeStyle = '#16203c';
    }

    // 입
    if (cel && cel.face === 'smug') {                // 메롱
      c.lineWidth = Math.max(1.5, r * 0.12);
      c.beginPath(); c.arc(sx, y + r * 0.12, r * 0.3, 0.1 * Math.PI, 0.9 * Math.PI); c.stroke();
      c.fillStyle = '#ff6f86';
      c.beginPath(); c.ellipse(sx + r * 0.08, y + r * 0.5, r * 0.15, r * 0.2, 0, 0, Math.PI * 2); c.fill();
    } else if (cel) {                                // 활짝 웃는 입
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
    c.restore();

    // 모자·목도리, 춤 소품
    this.drawGear(c, R, sx, y, r, prop);

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

    // 주먹이 쓸고 지나간 자리 (팔은 아래 drawArms 에서 어깨에 붙여 그린다)
    if (!ghost && R.punch > 0) {
      const k = 1 - R.punch / R.punchT;                 // 0 -> 1
      c.strokeStyle = 'rgba(255,255,255,.4)';
      c.lineWidth = r * 0.26; c.lineCap = 'round';
      c.beginPath(); c.arc(sx + SHO_X * r, y + SHO_Y * r, r * 1.35, -1.15, -1.15 + k * 2.3); c.stroke();
    }

    // 팔과 손 (달리기, 점프, 버둥거림, 들어 올리기, 춤 모두 여기서 그린다)
    if (limb) this.drawArms(c, R, limb, sx, y, r);
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
      const sx = R.x - this.camX + (R.cel ? (R.cel.dx + R.cel.bx * R.cel.flipX) * this.r : 0);
      if (sx < -90 || sx > this.W + 90) continue;
      const r = this.r;
      const big = this.phase === 'done' && R === this.winner;
      const fs = big ? Math.max(24, r * 1.5) : Math.max(13, r * 0.8);
      c.font = `700 ${fs}px Gothic A1, sans-serif`;
      const w = c.measureText(R.name).width;

      // 점프는 완만한 곡선이라 따라가도 되지만, bob 은 너무 빨라 뺀다.
      // 아이를 들고 있으면 이름표는 머리 위 아이보다 더 위로
      const headY = R.y - this.heightOf(R) - r * (this.scaleOf(R) * (BODY + LIFT) + (R.look.acc === 'cap' || R.look.acc === 'beanie' ? 0.15 : 0)) - (R.carry ? r * 2.1 * clamp(R.liftT / 0.4, 0, 1) : 0);
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
    view.r = S * 0.115; view.W = view.H = S; view.camX = 0; view.time = 0;
    this.view = view;
    this.R = Object.assign({}, runner, {
      x: S / 2, y: S * 0.84, cel: null,
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
      const dt = clamp((now - this.last) / 1000, 0, 1 / 24);
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
