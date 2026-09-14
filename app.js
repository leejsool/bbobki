/* =========================================================
   app.js  -  화면 흐름
   1) 시트 읽기 → 학년/반 고르기
   2) '레이스 시작' 누르면 시트를 다시 읽어 최신 명단으로 달린다
   3) 마지막 한 명 → 당첨 화면
   ========================================================= */

const $ = (id) => document.getElementById(id);

const el = {
  screens: { pick: $('screen-pick'), race: $('screen-race'), win: $('screen-win') },
  loadState: $('load-state'), pickBody: $('pick-body'),
  loadError: $('load-error'), loadErrorMsg: $('load-error-msg'), btnRetry: $('btn-retry'),
  gradeRow: $('grade-row'), classRow: $('class-row'),
  rosterBox: $('roster-box'), rosterTitle: $('roster-title'),
  rosterCount: $('roster-count'), rosterList: $('roster-list'),
  btnStart: $('btn-start'), fetchedAt: $('fetched-at'),
  stage: $('stage'), hudClass: $('hud-class'), hudAlive: $('hud-alive'),
  hudLap: $('hud-lap'), btnQuit: $('btn-quit'),
  killFeed: $('kill-feed'), banner: $('stage-banner'), countdown: $('countdown'),
  confetti: $('confetti'),
  winMeta: $('win-meta'), winName: $('win-name'), winSub: $('win-sub'),
  btnAgain: $('btn-again'), btnHome: $('btn-home'),
  sndPick: $('snd-pick'), sndRace: $('snd-race'),
};

let roster = null;        // { fetchedAt, grades:[...] }
let selGrade = null;
let selClass = null;
let game = null;
let busy = false;

/* ---------- 소리 ---------- */
function renderSound() {
  el.sndPick.textContent = Sound.on ? '🔊 소리 켜짐' : '🔇 소리 꺼짐';
  el.sndPick.classList.toggle('off', !Sound.on);
  el.sndRace.textContent = Sound.on ? '🔊' : '🔇';
}

function toggleSound() {
  Sound.setOn(!Sound.on);
  renderSound();
  if (Sound.on) Sound.play('countdown');   // 켰으면 들려 준다
}

/* ---------- 화면 전환 ---------- */
function show(which) {
  for (const [k, node] of Object.entries(el.screens)) node.classList.toggle('is-on', k === which);
}

/* ---------- 시트 읽기 ---------- */
async function fetchRoster() {
  const data = await loadRoster();
  roster = data;
  el.fetchedAt.textContent = '마지막으로 읽은 시각 ' + data.fetchedAt.toLocaleTimeString('ko-KR');
  return data;
}

function findClass(grade, klass) {
  const g = roster.grades.find((x) => x.grade === grade);
  return g ? g.classes.find((c) => c.klass === klass) : null;
}

/* ---------- 첫 로딩 ---------- */
async function boot() {
  el.loadState.hidden = false;
  el.pickBody.hidden = true;
  el.loadError.hidden = true;
  try {
    await fetchRoster();
    renderGrades();
    el.loadState.hidden = true;
    el.pickBody.hidden = false;
  } catch (e) {
    el.loadState.hidden = true;
    el.loadError.hidden = false;
    el.loadErrorMsg.textContent = e.message || String(e);
  }
}

/* ---------- 학년 / 반 버튼 ---------- */
function renderGrades() {
  el.gradeRow.innerHTML = '';
  for (const g of roster.grades) {
    const total = g.classes.reduce((s, c) => s + c.members.length, 0);
    const b = document.createElement('button');
    b.className = 'chip' + (g.grade === selGrade ? ' on' : '');
    b.innerHTML = `${g.grade}학년<small>${total}명</small>`;
    b.onclick = () => { selGrade = g.grade; selClass = null; renderGrades(); renderClasses(); renderRoster(); };
    el.gradeRow.appendChild(b);
  }
  if (selGrade === null) renderClasses();
}

function renderClasses() {
  el.classRow.innerHTML = '';
  if (selGrade === null) {
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--dim);font-size:14px;margin:0';
    hint.textContent = '학년을 먼저 고르세요.';
    el.classRow.appendChild(hint);
    return;
  }
  const g = roster.grades.find((x) => x.grade === selGrade);
  for (const c of g.classes) {
    const b = document.createElement('button');
    b.className = 'chip' + (c.klass === selClass ? ' on' : '');
    b.innerHTML = `${c.klass}반<small>${c.members.length}명</small>`;
    b.disabled = c.members.length < 2;
    b.onclick = () => { selClass = c.klass; renderClasses(); renderRoster(); };
    el.classRow.appendChild(b);
  }
}

function renderRoster() {
  const c = selGrade !== null && selClass !== null ? findClass(selGrade, selClass) : null;
  if (!c) {
    el.rosterBox.hidden = true;
    el.btnStart.disabled = true;
    return;
  }
  el.rosterBox.hidden = false;
  el.rosterTitle.textContent = `${selGrade}학년 ${selClass}반` + (c.teacher ? ` · 담임 ${c.teacher}` : '');
  el.rosterCount.textContent = c.members.length + '명';
  el.rosterList.innerHTML = c.members
    .map((m) => `<li><i>${m.no}</i><b>${escapeHtml(m.name)}</b></li>`)
    .join('');
  el.btnStart.disabled = c.members.length < 2;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------- 레이스 시작 ---------- */
async function startRace() {
  if (busy || selGrade === null || selClass === null) return;
  Sound.resume();          // 브라우저는 누른 직후에만 소리를 허락한다
  busy = true;
  const label = el.btnStart.textContent;
  el.btnStart.textContent = '최신 명단 확인 중…';
  el.btnStart.disabled = true;

  try {
    // 요구사항: 뽑을 때마다 시트를 새로 읽는다.
    await fetchRoster();
  } catch (e) {
    alert('시트를 다시 읽지 못했습니다.\n\n' + (e.message || e));
    el.btnStart.textContent = label;
    el.btnStart.disabled = false;
    busy = false;
    return;
  }

  const cls = findClass(selGrade, selClass);
  el.btnStart.textContent = label;
  el.btnStart.disabled = false;
  busy = false;

  if (!cls || cls.members.length < 2) {
    alert('그 반의 명단을 찾지 못했거나 인원이 2명 미만입니다.');
    renderGrades(); renderClasses(); renderRoster();
    return;
  }

  runGame(cls);
}

function runGame(cls) {
  const title = `${selGrade}학년 ${selClass}반`;
  el.hudClass.textContent = title;
  el.hudAlive.textContent = cls.members.length;
  el.hudLap.textContent = '구간 1';
  el.killFeed.innerHTML = '';
  show('race');

  if (!game) {
    game = new RaceGame(el.stage, {
      onSfx(name) { Sound.play(name); },
      onCountdown(text) {
        if (text === null) { el.countdown.hidden = true; return; }
        Sound.play(text === '출발!' ? 'go' : 'countdown');
        el.countdown.hidden = false;
        const span = el.countdown.firstElementChild;
        span.textContent = text;
        // 애니메이션 재시작
        span.style.animation = 'none';
        void span.offsetWidth;
        span.style.animation = '';
      },
      onStage(text, n) {
        if (n && n > 1) Sound.play('stage');
        if (n) el.hudLap.textContent = '구간 ' + n;
        el.banner.textContent = text;
        el.banner.classList.remove('show');
        void el.banner.offsetWidth;
        el.banner.classList.add('show');
      },
      onEliminate(R, alive) {
        Sound.play('out');
        el.hudAlive.textContent = alive;
        const d = document.createElement('div');
        d.textContent = `${R.name} 탈락`;
        el.killFeed.appendChild(d);
        setTimeout(() => d.remove(), 3000);
        while (el.killFeed.children.length > 6) el.killFeed.firstChild.remove();
      },
      onWin(R, order) { showWin(R, order, cls); },
    });
  } else {
    game.opts.onWin = (R, order) => showWin(R, order, cls);
  }

  game.start(cls.members, title);
}

/* ---------- 당첨 ---------- */
function showWin(R, order, cls) {
  game.stop();
  el.countdown.hidden = true;
  if (!R) { show('pick'); return; }

  el.winMeta.textContent = `${selGrade}학년 ${selClass}반 ${R.no}번`;
  el.winName.textContent = R.name;
  el.winSub.textContent = `${cls.members.length}명 중 마지막까지 살아남았습니다`;
  show('win');
  Sound.play('win');
  confettiRun();
}

/* ---------- 폭죽 ---------- */
let confettiRaf = 0;
function confettiRun() {
  const cv = el.confetti, c = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bits = Array.from({ length: 170 }, () => ({
    x: Math.random() * W, y: -Math.random() * H,
    vx: (Math.random() - 0.5) * 70, vy: 90 + Math.random() * 190,
    w: 5 + Math.random() * 8, h: 8 + Math.random() * 12,
    rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 9,
    hue: Math.random() * 360,
  }));

  let last = performance.now();
  cancelAnimationFrame(confettiRaf);
  const tick = (now) => {
    const dt = Math.min((now - last) / 1000, 1 / 24); last = now;
    c.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.rot += b.vr * dt;
      if (b.y > H + 20) { b.y = -20; b.x = Math.random() * W; }
      c.save();
      c.translate(b.x, b.y); c.rotate(b.rot);
      c.fillStyle = `hsl(${b.hue},90%,62%)`;
      c.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      c.restore();
    }
    confettiRaf = requestAnimationFrame(tick);
  };
  confettiRaf = requestAnimationFrame(tick);
}
function confettiStop() { cancelAnimationFrame(confettiRaf); confettiRaf = 0; }

/* ---------- 버튼 ---------- */
el.btnRetry.onclick = boot;
el.btnStart.onclick = startRace;
el.sndPick.onclick = toggleSound;
el.sndRace.onclick = toggleSound;
el.btnQuit.onclick = () => { game && game.stop(); el.countdown.hidden = true; show('pick'); };
el.btnAgain.onclick = () => { confettiStop(); startRace(); };
el.btnHome.onclick = () => { confettiStop(); show('pick'); };

Sound.load();
renderSound();
boot();
