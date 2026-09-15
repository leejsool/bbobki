/* =========================================================
   sheet.js  -  구글 시트에서 명단을 '그때그때' 읽어온다.

   - 시트 '전체 학생명단' 의 A1:X32 만 읽는다.
   - gviz JSONP 를 쓰기 때문에 서버도, API 키도 필요 없다.
     (브라우저 fetch 는 구글이 CORS 를 막아서 쓸 수 없다)
   - 캐시를 남기지 않는다. 호출할 때마다 새 데이터를 받아온다.
   ========================================================= */

const SHEET = {
  id: '1Ld2kdDc79NnfwsstlZagzibWqX0fMZpnIP8B77PNNA4',
  name: '전체 학생명단',
  range: 'A1:X32',
  timeout: 15000,
};

/* ---- JSONP 한 번 호출 ---- */
function jsonp(url, cbName) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      delete window[cbName];
      tag.remove();
    };
    const timer = setTimeout(() => {
      if (!done) { cleanup(); reject(new Error('시트 응답이 없습니다 (시간 초과).')); }
    }, SHEET.timeout);

    window[cbName] = (payload) => { if (!done) { cleanup(); resolve(payload); } };
    tag.onerror = () => {
      if (!done) {
        cleanup();
        reject(new Error('시트에 연결하지 못했습니다. 인터넷 연결과 시트 공개 설정을 확인해 주세요.'));
      }
    };

    tag.src = url;
    document.head.appendChild(tag);
  });
}

/* ---- 셀 값 꺼내기 ---- */
function cellOf(rows, r, c) {
  const row = rows[r];
  if (!row || !row.c) return '';
  const cell = row.c[c];
  if (!cell || cell.v === null || cell.v === undefined) return '';
  let v = cell.v;
  if (typeof v === 'number') v = Number.isInteger(v) ? String(v) : String(v).replace(/\.0+$/, '');
  return String(v).trim();
}

/* ---- A1:X32 를 학년/반 구조로 ---- */
function parseRoster(table) {
  const rows = table.rows || [];
  const nCols = (table.cols || []).length;
  if (!rows.length) throw new Error('시트에서 읽어온 내용이 비어 있습니다.');

  // 1행에서 '○학년 ○반' 인 열을 찾는다.
  const classCols = [];
  for (let c = 0; c < nCols; c++) {
    const head = cellOf(rows, 0, c);
    const g = head.match(/(\d+)\s*학년/);
    const k = head.match(/(\d+)\s*반/);
    if (g && k) classCols.push({ grade: +g[1], klass: +k[1], col: c });
  }
  if (!classCols.length) throw new Error('머리글에서 학년/반을 찾지 못했습니다.');

  // 학년마다 '번호' 열은 그 학년 첫 반 열 바로 왼쪽.
  const numCol = {};
  for (const { grade, col } of classCols) {
    if (numCol[grade] === undefined || col - 1 < numCol[grade]) numCol[grade] = col - 1;
  }

  const byGrade = new Map();
  for (const { grade, klass, col } of classCols) {
    const members = [];
    for (let r = 2; r < rows.length; r++) {
      const name = cellOf(rows, r, col);
      if (!name) continue;
      const nc = numCol[grade];
      const raw = nc >= 0 ? cellOf(rows, r, nc) : '';
      members.push({ no: /^\d+$/.test(raw) ? +raw : r - 1, name });
    }
    if (!byGrade.has(grade)) byGrade.set(grade, []);
    byGrade.get(grade).push({ klass, teacher: cellOf(rows, 1, col), members });
  }

  return [...byGrade.keys()].sort((a, b) => a - b).map((grade) => ({
    grade,
    classes: byGrade.get(grade).sort((a, b) => a.klass - b.klass),
  }));
}

/* ---- 바깥에서 쓰는 함수 ---- */
async function loadRoster() {
  const cb = '__bbobki_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const q = new URLSearchParams({
    tqx: 'out:json;responseHandler:' + cb,
    sheet: SHEET.name,
    range: SHEET.range,
    headers: '0',
    _: String(Date.now()),             // 캐시 우회
  });
  const url = `https://docs.google.com/spreadsheets/d/${SHEET.id}/gviz/tq?${q}`;

  const payload = await jsonp(url, cb);
  if (!payload || payload.status === 'error') {
    const msg = (payload && payload.errors && payload.errors[0] && payload.errors[0].detailed_message) || '알 수 없는 오류';
    throw new Error('시트를 읽을 수 없습니다: ' + msg.replace(/<[^>]+>/g, ''));
  }

  return {
    fetchedAt: new Date(),
    grades: parseRoster(payload.table),
  };
}
