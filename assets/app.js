(() => {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.endpoint;
  const PAGE = 30;
  const COL = { before: '기존 사진', after: '개선 사진' };
  // 사진을 올리는 항목. 항목마다 기존 사진 한 장, 개선 사진 한 장 (구글 스크립트의 SLOTS 와 키가 같아야 한다)
  const SECTIONS = [
    { title: '매장 외부', items: [
      ['front', '전면', '간판, 키오스크 있으면 포함'],
      ['side1', '측면 1', '코너'],
      ['side2', '측면 2', '코너'],
      ['back', '후면', '출입문 두 개 있는 매장의 경우'],
    ] },
    { title: '매장 내부', items: [
      ['bar', 'BAR 전체사진', ''],
      ['wall1', '벽면 1', ''],
      ['wall2', '벽면 2', ''],
      ['window', '외부 창호', '홀에서 외부 출입문을 바라본 사진'],
      ['kiosk', '키오스크(내부)', ''],
    ] },
  ];
  const SLOT_TOTAL = SECTIONS.reduce((n, s) => n + s.items.length, 0); // 9
  const NEED = SLOT_TOTAL - 1; // 후면은 해당하는 매장만 올리므로, 나머지 8곳이 다 차면 완료

  const $ = (sel, el = document) => el.querySelector(sel);
  const view = $('#view');
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 브라우저 저장소는 막혀 있을 수 있어 항상 감싼다
  const ls = {
    get(k, d = '') { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // 이 파일 안의 고정 아이콘에만 쓴다
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const enc = encodeURIComponent;
  const fmtDate = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ---------- 데이터 ----------
  const data = { stores: [], byCode: new Map(), status: {}, links: {} };
  let me = null;

  function ingest(json) {
    let stores = json.stores || [];
    if (json.rows) stores = json.rows.map((r) => Object.fromEntries(json.cols.map((c, i) => [c, r[i]])));
    data.stores = stores.map((s) => ({ ...s, code: String(s.code || s.name) }));
    data.byCode = new Map(data.stores.map((s) => [s.code, s]));
    data.links = json.links || {};
    me = json.me || null;
  }

  const normCode = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '');

  function fail(code, msg) { return Object.assign(new Error(msg || code), { code }); }

  // 구글 앱스 스크립트에 묻기 (접속 코드를 항상 함께 보낸다)
  async function getJson(params) {
    const q = new URLSearchParams({ code: ls.get('accessCode'), ...params });
    const res = await fetch(`${cfg.endpoint}?${q}`);
    return res.json();
  }

  // ---------- 접속 IP (로그인 기록용) ----------
  // 구글 스크립트는 접속자 IP를 알 수 없어서, 사이트가 무료 IP 조회 서비스에서 IP와 대략의 지역을 받아 로그인 기록으로 보낸다.
  const REGION_KO = {
    Seoul: '서울', Busan: '부산', Incheon: '인천', Daegu: '대구', Daejeon: '대전', Gwangju: '광주', Ulsan: '울산', Sejong: '세종',
    'Gyeonggi-do': '경기', 'Gangwon-do': '강원', 'North Chungcheong': '충북', 'South Chungcheong': '충남', 'North Jeolla': '전북', 'South Jeolla': '전남',
    'North Gyeongsang': '경북', 'South Gyeongsang': '경남', 'Jeju-do': '제주',
  };
  let ipPromise = null;
  function lookupIp() {
    if (ipPromise) return ipPromise;
    const grab = async (url) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3500);
      try { return await (await fetch(url, { signal: ac.signal })).json(); } finally { clearTimeout(timer); }
    };
    ipPromise = (async () => {
      try {
        const j = await grab('https://ipwho.is/');
        if (j && j.success && j.ip) {
          const country = j.country_code === 'KR' ? '' : (j.country || '');
          const loc = [country, REGION_KO[j.region] || j.region || '', j.city || ''].filter(Boolean).join(' ').slice(0, 40);
          return { ip: String(j.ip), loc };
        }
      } catch { /* 다음 서비스로 */ }
      try {
        const j = await grab('https://api.ipify.org?format=json');
        if (j && j.ip) return { ip: String(j.ip), loc: '' };
      } catch { /* 조회하지 못해도 로그인은 그대로 된다 */ }
      return null;
    })();
    return ipPromise;
  }

  // 로그인 기록 남기기. 화면을 기다리게 하지 않고, 실패해도 조용히 넘어간다.
  async function trackLogin(via) {
    if (DEMO) return;
    const info = await lookupIp();
    if (!info) return;
    try { await getJson({ action: 'track', via, ip: info.ip, loc: info.loc }); } catch { /* 무시 */ }
  }

  // 접속코드로 로그인한다. 정상이면 me(이름·팀·구분)와 점포 목록이 채워진다.
  async function loadData() {
    if (!normCode(ls.get('accessCode'))) throw fail('need_code');
    if (DEMO) {
      // 시험 모드: 가짜 명단의 시험용 코드로 로그인 (실제 연동에서는 구글이 코드를 확인한다)
      const res = await fetch('data/stores.json', { cache: 'no-cache' });
      if (!res.ok) throw fail('load', '점포 목록을 불러오지 못했어요.');
      const json = await res.json();
      const p = (json.people || []).find((x) => normCode(x.code) === normCode(ls.get('accessCode')));
      if (!p) throw fail('bad_code');
      ingest({ ...json, me: { name: p.name, team: p.team, role: p.role } });
      return;
    }
    let json;
    try { json = await getJson({ action: 'stores' }); }
    catch {
      // 연결이 안 될 때는, 같은 코드로 마지막에 불러온 목록만 쓴다
      const cached = ls.get('data-cache');
      if (!cached || ls.get('data-cache-for') !== normCode(ls.get('accessCode'))) throw fail('offline');
      ingest(JSON.parse(cached));
      return;
    }
    if (!json.ok) throw fail(json.error || 'load');
    ls.set('data-cache', JSON.stringify(json));
    ls.set('data-cache-for', normCode(ls.get('accessCode')));
    ingest(json);
  }

  const localJson = (key) => { try { return JSON.parse(ls.get(key, '{}')); } catch { return {}; } };

  async function loadStatus() {
    if (DEMO) { data.status = localJson('demo-status'); return; }
    try {
      const json = await getJson({ action: 'status' });
      if (json.ok) { data.status = json.status || {}; ls.set('status-cache', JSON.stringify(data.status)); return; }
    } catch { /* 캐시 사용 */ }
    data.status = localJson('status-cache');
  }

  // ---------- 첫 화면: 저장해 둔 내용을 먼저 보여주고, 뒤에서 새로 받는다 ----------
  // 점포 목록과 현황을 한 번에 받는다. 서버가 아직 옛 버전이면 둘로 나눠 받는다.
  async function fetchInit() {
    let json = await getJson({ action: 'init' });
    if (!json.ok && json.error === 'unknown_action') {
      json = await getJson({ action: 'stores' });
      if (json.ok) { const s = await getJson({ action: 'status' }); json.status = s.ok ? s.status : {}; }
    }
    return json;
  }
  const sigOf = (j) => JSON.stringify([j.me, j.rows || j.stores, j.links, j.status]);
  let lastSig = '';
  function applyInit(json) { ingest(json); data.status = json.status || {}; lastSig = sigOf(json); }
  function saveInit(json) {
    const { status, ...rest } = json;
    ls.set('data-cache', JSON.stringify(rest));
    ls.set('status-cache', JSON.stringify(status || {}));
    ls.set('data-cache-for', normCode(ls.get('accessCode')));
  }
  function savedInit() {
    if (ls.get('data-cache-for') !== normCode(ls.get('accessCode'))) return null; // 같은 코드로 받은 것만
    try {
      const json = JSON.parse(ls.get('data-cache'));
      if (!json || !json.me) return null;
      json.status = JSON.parse(ls.get('status-cache', '{}'));
      return json;
    } catch { return null; }
  }

  const stat = (code) => {
    const v = data.status[code];
    return { before: v ? Number(v[0]) || 0 : 0, after: v ? Number(v[1]) || 0 : 0, folder: v && v[3] ? v[3] : '' };
  };

  // ---------- 볼 수 있는 점포 ----------
  // 직원: 본인 담당 점포만. 관리자: 모든 팀(팀 칸에서 골라 들어간다).
  const isManager = () => !!me && me.role === '관리자';
  const canLog = () => !!me && !!me.canLog; // 로그인 기록은 김규민, 오형철 계정에서만 (구글 스크립트도 같은 규칙으로 막는다)
  const mine = () => data.stores.filter((s) => s.sv === me.name);
  const teamList = () => [...new Set(data.stores.map((s) => s.team).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const searchPool = () => (!me ? [] : (isManager() ? data.stores : mine()));

  function listPool(key) {
    if (!me) return [];
    if (!isManager()) return mine(); // 직원은 어떤 주소로 들어와도 본인 담당만
    if (key === 'all') return data.stores;
    if (key === 'mine') return mine();
    return data.stores.filter((s) => s.team === key);
  }

  const listTitle = (key) => ({ mine: '내 담당 점포', all: '전체 점포' })[key] || key;
  const done = (s) => { const t = stat(s.code); return t.before >= NEED && t.after >= NEED; };

  // ---------- 검색 ----------
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const SINGLE = { ㄲ: 'ㄱ', ㄸ: 'ㄷ', ㅃ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ' }; // 빽 같은 쌍자음은 ㅂ 으로 쳐도 찾는다
  const single = (s) => s.replace(/[ㄲㄸㅃㅆㅉ]/g, (c) => SINGLE[c]);
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const cho = (s) => single([...String(s)].map((ch) => {
    const c = ch.charCodeAt(0) - 0xac00;
    return c >= 0 && c <= 11171 ? CHO[Math.floor(c / 588)] : ch;
  }).join(''));

  function search(pool, query) {
    const q = norm(query);
    const jamo = /^[ㄱ-ㅎ]+$/.test(q);
    const hits = [];
    for (const s of pool) {
      const name = norm(s.name);
      let score = 0;
      if (jamo) { if (cho(name).includes(single(q)) || cho(s.sv || '').includes(single(q))) score = 3; }
      else if (name.startsWith(q)) score = 5;
      else if (name.includes(q)) score = 4;
      else if (norm(s.sv).includes(q) || norm(s.team).includes(q) || norm(s.code).includes(q)) score = 2;
      if (score) hits.push([score, s]);
    }
    hits.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, 'ko'));
    return hits.map((x) => x[1]);
  }

  // 아직 안 올린 점포가 위로 오게
  function byProgress(list) {
    const n = (s) => { const t = stat(s.code); return Math.min(t.before, NEED) + Math.min(t.after, NEED); };
    return [...list].sort((a, b) => n(a) - n(b) || a.name.localeCompare(b.name, 'ko'));
  }

  // ---------- 로그인: 접속 코드 하나로 들어온다 ----------
  let loginSubmitted = false; // 방금 코드를 직접 입력해 로그인했는지(저장된 로그인으로 열린 것과 구분)
  function renderGate(err) {
    document.title = '로그인 | 빽다방 홍보물 취합';
    $('.top .who-wrap')?.remove();
    const note = {
      bad_code: '접속 코드가 맞지 않아요. 다시 확인해 주세요.',
      not_configured: '아직 설정이 끝나지 않았어요. 관리자에게 문의해 주세요.',
      offline: '연결이 되지 않아요. 인터넷을 확인하고 다시 시도해 주세요.',
      load: err && err.message,
    }[err && err.code] || (err && err.code !== 'need_code' ? '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' : '');
    const input = h('input', { type: 'text', name: 'code', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': '접속 코드', placeholder: '접속 코드', required: true, value: err && err.code === 'bad_code' ? ls.get('accessCode') : '' });
    const form = h('form', { class: 'gate-form', onsubmit: (e) => { e.preventDefault(); ls.set('accessCode', input.value.trim()); loginSubmitted = true; lookupIp(); start(); } },
      h('p', { class: 'lead', text: '관리자에게 받은 개인 접속 코드를 입력해 주세요.' }),
      input,
      note ? h('p', { class: 'form-note', role: 'alert', text: note }) : null,
      h('button', { type: 'submit', class: 'btn primary block', text: '로그인' }));
    view.replaceChildren(h('section', { class: 'gate wrap-narrow' }, h('h1', { text: '빽다방 홍보물 취합' }), form));
    input.focus({ preventScroll: true });
  }

  function logout() {
    ['accessCode', 'data-cache', 'data-cache-for', 'status-cache'].forEach((k) => ls.set(k, ''));
    me = null; data.status = {}; photoBook.clear();
    location.hash = '#/';
    start();
  }
  // ---------- 공통 조각 ----------
  function row(s, withTeam) {
    const t = stat(s.code);
    const sub = isManager() ? (withTeam ? [s.team, s.sv] : [s.sv]).filter(Boolean).join(' ') : '';
    return h('li', {}, h('a', { class: 'row', href: `#/store/${enc(s.code)}`, 'aria-label': `${s.name}, 기존 사진 ${t.before}장, 개선 사진 ${t.after}장` },
      h('span', { class: 'name', text: s.name }),
      sub ? h('span', { class: 'sub', text: sub }) : null,
      h('span', { class: 'marks' },
        h('i', { class: t.before >= NEED ? 'mk on' : 'mk', text: `기존 ${t.before}` }),
        h('i', { class: t.after >= NEED ? 'mk on' : 'mk', text: `개선 ${t.after}` }))));
  }

  function externalLink(label, href) {
    return h('a', { class: 'pill', href, target: '_blank', rel: 'noopener' }, label, h('span', { 'aria-hidden': 'true', text: '↗' }));
  }

  // 불러오는 동안 보여주는 스피너
  const spinnerSvg = (size, stroke) => h('span', { class: 'spinbox', 'aria-hidden': 'true',
    html: `<svg class="spinner" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="16" stroke="#e4e4e4" stroke-width="${stroke}"/><path d="M20 4a16 16 0 0 1 16 16" stroke="#000" stroke-width="${stroke}" stroke-linecap="round"/></svg>` });
  const loadingBlock = (text) => h('div', { class: 'loading', role: 'status', 'aria-live': 'polite' }, spinnerSvg(40, 4), h('span', { text }));

  // 저장 완료 같은 짧은 알림(스낵바). 아래에 떴다가 몇 초 뒤 사라진다.
  let snackTimer = null;
  function snack(title, sub) {
    $('.snack')?.remove();
    clearTimeout(snackTimer);
    const el = h('div', { class: 'snack', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'ck', 'aria-hidden': 'true', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' }),
      h('span', { class: 'tx' }, h('b', { text: title }), sub ? h('small', { text: sub }) : null),
      h('button', { type: 'button', onclick: () => close() }, '확인'));
    function close() { clearTimeout(snackTimer); el.classList.add('out'); setTimeout(() => el.remove(), 220); }
    document.body.append(el);
    snackTimer = setTimeout(close, 3400);
  }

  // ---------- 홈: 검색창과 팀 칸만 ----------
  const home = { q: '' };

  function renderHome() {
    document.title = '빽다방 홍보물 취합';
    const resultsHost = h('div', { hidden: true });
    const cardsHost = h('div', {});
    const input = h('input', { type: 'search', id: 'q', placeholder: '점포명이나 담당자로 검색', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': '점포 검색', value: home.q });
    const clear = h('button', { type: 'button', class: 'clear', 'aria-label': '검색어 지우기', hidden: !home.q }, '×');
    let shown = PAGE;

    // 팀 선택: 세그먼트. 팀을 누르면 그 팀의 매장 목록으로 넘어간다.
    function paintCards() {
      const parts = [];
      if (isManager()) {
        const names = [...teamList(), '전체'];
        parts.push(h('div', { class: 'segs', role: 'group', 'aria-label': '팀 선택', style: `--n:${names.length}` },
          names.map((n) => h('a', { class: 'segb', href: `#/list/${enc(n === '전체' ? 'all' : n)}`, 'aria-label': `${n} 매장 목록 보기` },
            n, me.team === n ? h('i', { class: 'own', 'aria-label': '내 팀' }) : null))));
        parts.push(h('p', { class: 'seg-note', text: '팀을 누르면 그 팀의 매장 목록이 나와요 · 점 표시는 내 팀' }));
        const tools = [
          data.links.sheet ? externalLink('취합 시트 열기', data.links.sheet) : null,
          data.links.folder ? externalLink('드라이브 폴더 열기', data.links.folder) : null,
          canLog() ? h('a', { class: 'pill dark', href: '#/log' },
            h('span', { 'aria-hidden': 'true', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/></svg>' }), '로그인 기록') : null,
        ].filter(Boolean);
        if (tools.length) parts.push(h('div', { class: 'admin-tools' }, tools));
      } else {
        parts.push(h('div', { class: 'segs', role: 'group', 'aria-label': '팀 선택', style: '--n:1' },
          h('a', { class: 'segb', href: '#/list/mine', 'aria-label': '내 담당 점포 목록 보기' }, '내 담당 점포')));
        parts.push(h('p', { class: 'seg-note', text: '내 담당 점포를 확인하고 사진을 올려요' }));
      }
      cardsHost.replaceChildren(...parts);
    }

    function paintResults() {
      const q = input.value.trim();
      home.q = q;
      clear.hidden = !q;
      cardsHost.hidden = !!q;
      resultsHost.hidden = !q;
      if (!q) return;
      const found = search(searchPool(), q);
      const list = h('ul', { class: 'rows', 'aria-live': 'polite' });
      if (!found.length) list.append(h('li', { class: 'empty', text: '찾는 점포가 없어요. 점포명 일부나 담당자 이름으로 다시 찾아보세요.' }));
      found.slice(0, shown).forEach((s) => list.append(row(s, true)));
      resultsHost.replaceChildren(
        h('p', { class: 'meta-line', text: `${found.length}곳` }), list,
        found.length > shown ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { shown += PAGE; paintResults(); } }, `더 보기 (${found.length - shown}곳 남음)`) : null);
    }
    input.addEventListener('input', () => { shown = PAGE; paintResults(); });
    clear.addEventListener('click', () => { input.value = ''; shown = PAGE; paintResults(); input.focus(); });

    view.replaceChildren(h('div', { class: 'wrap' },
      h('section', { class: 'hero' },
        h('h1', { text: '홍보물 사진 업로드' }),
        h('label', { class: 'search' }, input, clear)),
      cardsHost, resultsHost));
    paintCards();
    paintResults();
  }

  // ---------- 팀 목록 ----------
  const listState = { key: '', shown: PAGE };

  function renderList(wanted) {
    const key = isManager() ? wanted : 'mine'; // 직원은 어떤 주소로 들어와도 본인 담당 점포만
    document.title = `${listTitle(key)} | 빽다방 홍보물 취합`;
    if (listState.key !== key) { listState.key = key; listState.shown = PAGE; }
    const pool = byProgress(listPool(key));
    const left = pool.filter((s) => !done(s)).length;
    const list = h('ul', { class: 'rows' });
    if (!pool.length) list.append(h('li', { class: 'empty', text: '볼 수 있는 점포가 없어요.' }));
    pool.slice(0, listState.shown).forEach((s) => list.append(row(s, key === 'all')));
    const more = pool.length > listState.shown
      ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { listState.shown += PAGE; renderList(key); } }, `더 보기 (${pool.length - listState.shown}곳 남음)`)
      : null;
    const pct = pool.length ? Math.round(((pool.length - left) / pool.length) * 100) : 0;
    const names = isManager() ? [...teamList(), '전체'] : [];
    const cur = key === 'all' ? '전체' : key;
    view.replaceChildren(h('div', { class: 'wrap' },
      h('a', { class: 'back', href: '#/' }, '‹ 처음'),
      h('h1', { class: 'page-title', text: listTitle(key) }),
      h('p', { class: 'meta-line', text: `${pool.length}곳 중 ${left}곳을 아직 못 올렸어요` }),
      h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${pct}%` })),
      names.length ? h('div', { class: 'segs left', role: 'group', 'aria-label': '팀 바꾸기', style: `--n:${names.length}` },
        names.map((n) => h('a', { class: n === cur ? 'segb on' : 'segb', href: `#/list/${enc(n === '전체' ? 'all' : n)}`, 'aria-current': n === cur ? 'page' : false }, n))) : null,
      list, more));
  }

  // ---------- 올린 사진 (구글 드라이브에서 불러와 계속 보여준다) ----------
  const photoBook = new Map(); // 점포 식별값 -> { before: [], after: [], loaded, loading, failed }  (각 사진: { id, slot, t, by, thumb, full })
  const book = (code) => { if (!photoBook.has(code)) photoBook.set(code, { before: [], after: [], loaded: false, loading: false, failed: false }); return photoBook.get(code); };
  const slotCount = (list) => new Set(list.filter((e) => e.slot).map((e) => e.slot)).size;
  let storeView = null; // 지금 열린 점포 화면이 갱신을 받는 곳

  async function loadPhotos(store) {
    const b = book(store.code);
    if (b.loaded || b.loading) return;
    b.loading = true; b.failed = false;
    try {
      if (DEMO) {
        const all = localJson('demo-photos')[store.code] || {};
        b.before = all.before || []; b.after = all.after || [];
      } else {
        const json = await getJson({ action: 'photos', store: store.code, name: store.name });
        if (!json.ok) throw fail(json.error);
        const th = json.th || {}; // 서버가 이미 기억해 둔 작은 사진은 목록에 같이 온다
        for (const kind of ['before', 'after']) {
          const local = new Map(b[kind].map((e) => [e.id, e]));
          const fresh = (json[kind] || []).map((e) => {
            const x = local.get(e.id) || e;
            if (!x.thumb && th[x.id]) { x.thumb = th[x.id]; thumbDB.put(x.id, x.thumb); }
            return x;
          });
          // 이번 화면에서 방금 올려 아직 목록에 없는 사진은 남기되, 같은 자리의 사진이 목록에 있으면 목록 쪽이 맞다
          const extra = [...local.values()].filter((e) => !fresh.some((x) => x.id === e.id) && !fresh.some((x) => x.slot && x.slot === e.slot && x.t >= e.t));
          b[kind] = [...extra, ...fresh];
        }
      }
      b.loaded = true;
    } catch { b.failed = true; }
    b.loading = false;
    if (storeView && storeView.code === store.code) storeView.paintTable();
    if (b.loaded) fillThumbs(store);
  }

  function fetchImage(entry, action, field) {
    if (entry[field]) return Promise.resolve(entry[field]);
    const pending = `_p_${field}`;
    if (!entry[pending]) {
      entry[pending] = getJson({ action, id: entry.id })
        .then((json) => { if (json.ok) entry[field] = `data:${json.mime};base64,${json.data}`; return entry[field] || ''; })
        .catch(() => '') // 못 불러오면 빈 칸으로 둔다
        .finally(() => { entry[pending] = null; });
    }
    return entry[pending];
  }

  // 작은 사진은 이 기기에 남겨 두고(사진 ID는 바뀌지 않는다) 다음에는 바로 보여준다. 막혀 있으면 그냥 건너뛴다.
  const thumbDB = (() => {
    let opened = null;
    const open = () => opened || (opened = new Promise((resolve) => {
      try {
        const req = indexedDB.open('promo-thumbs', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('t');
        req.onsuccess = () => {
          const db = req.result;
          try { // 너무 쌓이면 비우고 다시 시작한다
            const c = db.transaction('t', 'readonly').objectStore('t').count();
            c.onsuccess = () => { if (c.result > 2500) { try { db.transaction('t', 'readwrite').objectStore('t').clear(); } catch { /* 무시 */ } } };
          } catch { /* 무시 */ }
          resolve(db);
        };
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    }));
    const run = async (mode, fn) => {
      const db = await open();
      if (!db) return undefined;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('t', mode);
          const req = fn(tx.objectStore('t'));
          tx.oncomplete = () => resolve(req && req.result !== undefined ? req.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch { resolve(undefined); }
      });
    };
    return { get: (id) => run('readonly', (s) => s.get(id)), put: (id, url) => run('readwrite', (s) => s.put(url, id)) };
  })();

  // 목록에 같이 오지 않은 작은 사진을 채운다: 이 기기에 남은 것 먼저, 나머지는 6장씩 묶어 한꺼번에(동시에 3묶음)
  async function fillThumbs(store) {
    const b = book(store.code);
    const need = [...b.before, ...b.after].filter((e) => !e.thumb && !e.local);
    if (!need.length) return;
    await Promise.all(need.map(async (e) => { const u = await thumbDB.get(e.id); if (u) e.thumb = u; }));
    if (storeView && storeView.code === store.code) storeView.paintTable();
    const rest = need.filter((e) => !e.thumb);
    const groups = [];
    for (let i = 0; i < rest.length; i += 6) groups.push(rest.slice(i, i + 6));
    let next = 0;
    const worker = async () => {
      while (next < groups.length) {
        const g = groups[next]; next += 1;
        try {
          const json = await getJson({ action: 'thumbs', store: store.code, name: store.name, ids: g.map((e) => e.id).join(',') });
          if (json.ok) for (const e of g) { const u = json.items && json.items[e.id]; if (u) { e.thumb = u; thumbDB.put(e.id, u); } }
        } catch { /* 못 받으면 빈 칸으로 두고, 눌러서 크게 볼 수 있다 */ }
        if (storeView && storeView.code === store.code) storeView.paintTable();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  function queueThumb(entry, img) { if (entry.thumb) img.src = entry.thumb; }

  function lightbox() {
    let dlg = $('#lightbox');
    if (dlg) return dlg;
    dlg = h('dialog', { id: 'lightbox', 'aria-label': '올린 사진' },
      h('button', { type: 'button', class: 'lb-close', 'aria-label': '닫기', onclick: () => dlg.close() }, '×'),
      h('img', { alt: '올린 사진' }), h('p', { class: 'cap' }));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    return dlg;
  }

  async function openPhoto(entry, caption) {
    const dlg = lightbox();
    const img = $('img', dlg);
    img.src = entry.full || entry.thumb || '';
    $('.cap', dlg).textContent = [caption, fmtDate(entry.t), entry.by].filter(Boolean).join('  ');
    dlg.showModal();
    if (!entry.full) { const url = await fetchImage(entry, 'photo', 'full'); if (url && dlg.open) img.src = url; }
  }

  // 방금 올린 사진을 화면에 바로 넣는다 (시험 모드에서는 이 기기에 저장해 새로 열어도 남는다)
  async function smallDataUrl(blob, edge = 720, quality = 0.72) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', quality);
  }

  // 같은 자리에 올리면 이전 사진을 바꾼다. 바꾼 것이면 true
  async function remember(store, kind, slot, blob, res, tiny) {
    const entry = { id: res.fileId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: res.fileName || '', slot, t: new Date().toISOString(), by: me ? me.name : '', local: true };
    const b = book(store.code);
    const replaced = b[kind].some((e) => e.slot === slot);
    if (DEMO) {
      entry.thumb = entry.full = await smallDataUrl(blob);
      const all = localJson('demo-photos');
      const mineList = all[store.code] || { before: [], after: [] };
      mineList[kind] = [{ ...entry, local: false }, ...(mineList[kind] || []).filter((e) => e.slot !== slot)];
      all[store.code] = mineList;
      ls.set('demo-photos', JSON.stringify(all)); // 가득 차면 이번 화면에서만 보인다
    } else {
      entry.thumb = tiny || await smallDataUrl(blob, 360, 0.7); // 작은 사진은 글자(data 주소)라 이 기기에도 남길 수 있다
      entry.full = URL.createObjectURL(blob);
      if (res.fileId) thumbDB.put(entry.id, entry.thumb);
    }
    b[kind] = [entry, ...b[kind].filter((e) => e.slot !== slot)];
    return replaced;
  }

  // 점포 목록의 완료 표시에 쓰는 장수를 맞춘다
  function recount(code, kind, replaced) {
    const b = book(code);
    const cur = data.status[code] || [0, 0, '', ''];
    const next = [cur[0] || 0, cur[1] || 0, new Date().toISOString(), cur[3] || ''];
    if (b.loaded) { next[0] = slotCount(b.before); next[1] = slotCount(b.after); }
    else if (!replaced) next[kind === 'before' ? 0 : 1] += 1;
    data.status[code] = next;
    if (DEMO) ls.set('demo-status', JSON.stringify(data.status));
  }

  // ---------- 점포: 항목마다 기존 사진 / 개선 사진 ----------
  const nav = { back: '#/' };

  function renderStore(code) {
    const store = data.byCode.get(code);
    if (!store) { view.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'empty', text: '없는 점포예요.' }), h('a', { class: 'btn block', href: '#/', text: '처음으로' }))); return; }
    document.title = `${store.name} | 빽다방 홍보물 취합`;

    const working = new Map(); // "before:front" -> { state: 'up' | 'error', file, url }  올리는 중이거나 실패한 칸
    let notice = '';
    const sheetHost = h('div', {});
    const progress = h('p', { class: 'progress' });
    const folder = isManager() ? (stat(code).folder || (DEMO ? data.links.folder : '')) : '';

    function cell(kind, slot, label) {
      const b = book(code);
      const st = working.get(`${kind}:${slot}`);
      const entry = b[kind].find((e) => e.slot === slot);
      const col = COL[kind];
      // 올린 사진 목록을 아직 못 받았어도 바로 올릴 수 있다(같은 자리에 이미 있으면 구글 쪽에서 새 사진으로 바꾼다)
      const pick = h('input', { type: 'file', accept: 'image/*', 'aria-label': `${label} ${col} 고르기`,
        onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) send(kind, slot, f); } });
      if (!entry && !st) {
        return h('label', { class: 'cell blank' }, pick, h('span', { class: 'fill' }, h('b', { text: '+' }), h('small', { text: col })));
      }
      const img = h('img', { alt: `${label} ${col}` });
      if (st) img.src = st.url; else queueThumb(entry, img);
      const shot = st
        ? h('div', { class: 'shot' }, img)
        : h('button', { type: 'button', class: 'shot', 'aria-label': `${label} ${col} 크게 보기`, onclick: () => openPhoto(entry, `${label} ${col}`) }, img);
      return h('div', { class: 'cell filled', 'data-state': st ? st.state : 'ok' }, shot,
        st && st.state === 'up' ? h('div', { class: 'spin-over', role: 'status' }, spinnerSvg(30, 5)) : null,
        st && st.state !== 'error' ? h('span', { class: 'st', text: st.state === 'wait' ? '대기 중' : '올리는 중' }) : null,
        st && st.state === 'error' ? h('button', { type: 'button', class: 'st retry', onclick: () => send(kind, slot, st.file), text: '실패, 다시 시도' }) : null,
        !st ? h('label', { class: 'swap' }, pick, '바꾸기') : null);
    }

    function paintTable() {
      const b = book(code);
      const nb = b.loaded ? slotCount(b.before) : stat(code).before;
      const na = b.loaded ? slotCount(b.after) : stat(code).after;
      progress.textContent = `기존 사진 ${nb}/${SLOT_TOTAL} · 개선 사진 ${na}/${SLOT_TOTAL}`;
      sheetHost.replaceChildren(...[
        notice ? h('p', { class: 'form-note', role: 'alert', text: notice }) : null,
        b.loading ? h('div', { class: 'loadrow', role: 'status', 'aria-live': 'polite' }, spinnerSvg(22, 5), h('span', { text: '올린 사진을 불러오는 중이에요' })) : null,
        b.failed ? h('p', { class: 'hint', text: '올린 사진을 불러오지 못했어요. 새로 올리는 것은 그대로 됩니다.' }) : null,
        h('div', { class: 'sheet' },
          h('div', { class: 'sheet-cols', 'aria-hidden': 'true' }, h('span', { text: '항목' }), h('span', { text: COL.before }), h('span', { text: COL.after })),
          SECTIONS.map((sec) => h('section', { class: 'grp', 'aria-label': sec.title },
            h('h2', { text: sec.title }),
            sec.items.map(([slot, label, desc]) => h('div', { class: 'srow' },
              h('div', { class: 'lbl' }, h('b', { text: label }), desc ? h('small', { text: desc }) : null),
              cell('before', slot, label), cell('after', slot, label))))))].filter(Boolean));
    }

    // 사진을 고르면 그 자리에 바로 올린다
    async function send(kind, slot, file) {
      const key = `${kind}:${slot}`;
      const prev = working.get(key);
      if (prev && (prev.state === 'up' || prev.state === 'wait')) return;
      if (prev && prev.file !== file) URL.revokeObjectURL(prev.url);
      const st = { state: uploadQ.running < UPLOAD_PARALLEL ? 'up' : 'wait', file, url: prev && prev.file === file ? prev.url : URL.createObjectURL(file) };
      working.set(key, st); notice = ''; paintTable();
      try {
        await schedule(async () => {
          st.state = 'up';
          if (storeView && storeView.code === code) storeView.paintTable();
          const blob = await compress(file);
          const tiny = DEMO ? '' : await smallDataUrl(blob, 360, 0.7).catch(() => ''); // 서버가 목록에 바로 쓰도록 작은 사진을 함께 보낸다
          const res = await sendPhoto(store, kind, slot, file.name, blob, tiny);
          const replaced = await remember(store, kind, slot, blob, res || {}, tiny);
          URL.revokeObjectURL(st.url); working.delete(key);
          recount(code, kind, replaced);
          justSaved.push({ label: slotLabel(slot), kind });
        });
        setTimeout(flushSaved, 60); // 줄 서 있던 사진까지 모두 끝났을 때 한 번만 알려 준다
      } catch (err) {
        st.state = 'error';
        if (err && err.code === 'bad_code') notice = '접속 코드가 맞지 않아 올리지 못했어요. 로그아웃한 뒤 코드를 다시 입력해 주세요.';
        setTimeout(flushSaved, 60);
      }
      if (storeView && storeView.code === code) storeView.paintTable(); // 그 사이 다른 화면에 갔다 왔어도 지금 열린 화면에 그린다
    }

    view.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'sgrid' },
      h('div', { class: 'sside' },
        h('a', { class: 'back', href: nav.back }, nav.back === '#/' ? '‹ 처음' : '‹ 목록'),
        h('h1', { class: 'store-name', text: store.name }),
        h('p', { class: 'sub', text: [store.team, store.sv && `${store.sv} 담당`].filter(Boolean).join(' ') }),
        progress,
        folder ? h('div', { class: 'admin-tools left' }, externalLink('이 점포 드라이브 폴더 열기', folder)) : null),
      sheetHost)));
    storeView = { code, paintTable };
    paintTable();
    loadPhotos(store);
  }

  // ---------- 사진 처리·전송 ----------
  async function compress(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      bmp = await new Promise((resolve, reject) => {
        const img = new Image(); const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이 사진은 열 수 없어요.')); };
        img.src = url;
      });
    }
    const scale = Math.min(1, cfg.imageMaxEdge / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('사진을 줄이지 못했어요.'))), 'image/jpeg', cfg.imageQuality));
  }

  const toBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  const NO_RETRY = new Set(['bad_code', 'not_allowed', 'bad_slot', 'bad_kind', 'bad_mime', 'bad_size', 'bad_store_code', 'limit']);

  // 한 번에 보내는 사진은 3장까지만, 나머지는 줄을 선다(구글은 동시에 많이 오면 거절하고, 한꺼번에 보내도 더 빠르지 않다)
  const UPLOAD_PARALLEL = 3;
  const uploadQ = { running: 0, waiting: [] };
  function schedule(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        uploadQ.running += 1;
        task().then(resolve, reject).finally(() => { uploadQ.running -= 1; const next = uploadQ.waiting.shift(); if (next) next(); });
      };
      if (uploadQ.running < UPLOAD_PARALLEL) run(); else uploadQ.waiting.push(run);
    });
  }

  // 저장이 끝난 사진을 모았다가, 올리기가 모두 끝나면 스낵바로 한 번 알린다
  const justSaved = [];
  const slotLabel = (slot) => { for (const sec of SECTIONS) for (const it of sec.items) if (it[0] === slot) return it[1]; return slot; };
  function flushSaved() {
    if (uploadQ.running || uploadQ.waiting.length || !justSaved.length) return;
    const n = justSaved.length, last = justSaved[n - 1];
    justSaved.length = 0;
    snack(n === 1 ? `${last.label} · ${COL[last.kind]}을 저장했어요` : `사진 ${n}장을 저장했어요`, '구글 드라이브에 올라갔어요');
  }

  async function sendPhoto(store, kind, slot, name, blob, tiny) {
    if (DEMO) { await new Promise((r) => setTimeout(r, 350)); return {}; }
    const payload = {
      action: 'upload', code: ls.get('accessCode'), uploader: me ? me.name : '',
      storeCode: store.code, storeName: store.name, kind, slot,
      fileName: name, mime: 'image/jpeg', data: await toBase64(blob), thumb: tiny ? tiny.split(',')[1] || '' : '',
    };
    let lastErr;
    // 구글은 동시에 너무 많은 요청이 오면 일부를 거절한다. 그럴 때는 잠깐씩 점점 더 쉬었다가(1, 2, 4, 8초, 조금씩 어긋나게) 다시 보낸다.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // text/plain 으로 보내면 브라우저 사전 확인 요청 없이 앱스 스크립트가 받는다
        const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        const json = await res.json();
        if (json.ok) return json;
        lastErr = fail(json.error || 'upload_failed');
        if (NO_RETRY.has(json.error)) throw lastErr; // 다시 해도 소용없는 거절은 바로 알린다
      } catch (err) { lastErr = err; if (NO_RETRY.has(err.code)) throw err; }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 600));
    }
    throw lastErr;
  }

  // ---------- 로그인 기록 (김규민, 오형철 계정에서만) ----------
  let logToken = 0;
  async function renderLog() {
    document.title = '로그인 기록 | 빽다방 홍보물 취합';
    const token = ++logToken;
    const back = h('a', { class: 'back', href: '#/' }, '‹ 처음');
    const shell = (...kids) => { if (token === logToken) view.replaceChildren(h('div', { class: 'wrap' }, back, h('h1', { class: 'page-title', text: '로그인 기록' }), ...kids)); };
    const denied = () => {
      if (token !== logToken) return;
      view.replaceChildren(h('div', { class: 'wrap' }, back, h('div', { class: 'denied' },
        h('span', { class: 'lockc', 'aria-hidden': 'true', html: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' }),
        h('h1', { text: '볼 수 없는 화면이에요' }),
        h('p', { text: '로그인 기록은 김규민, 오형철 계정에서만 볼 수 있어요.' }))));
    };
    if (!canLog()) { denied(); return; }
    shell(loadingBlock('로그인 기록을 불러오는 중이에요'));
    let json;
    try { json = await getJson({ action: 'logs' }); }
    catch { shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }
    if (token !== logToken) return;
    if (!json.ok) { if (json.error === 'not_allowed') denied(); else shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }
    const info = await lookupIp(); // 지금 접속한 IP (사내망으로 등록할 때 쓴다)
    if (token !== logToken) return;

    const internal = json.internal || [];
    const registered = !!info && internal.includes(info.ip);
    async function toggleNet() {
      try {
        const r = await getJson({ action: registered ? 'net_remove' : 'net_add', ip: info.ip });
        if (r.ok) { snack(registered ? '사내망에서 뺐어요' : '사내망으로 등록했어요', info.ip); renderLog(); }
      } catch { /* 연결이 안 되면 그대로 둔다 */ }
    }
    const netCard = h('div', { class: 'netcard' },
      h('div', { class: 'nettxt' },
        h('div', {}, h('b', { text: '지금 접속한 IP ' }), h('span', { class: 'ipv', text: info ? info.ip : '확인하지 못했어요' }), info && info.loc ? h('small', { text: ` · ${info.loc}` }) : null),
        h('p', { class: 'fine', text: internal.length ? `사내망으로 등록한 IP: ${internal.join(', ')}` : '아직 사내망 IP를 등록하지 않아 모든 접속이 "미분류"로 보여요. 회사에서 접속한 상태로 오른쪽 버튼을 눌러 등록하세요.' })),
      info ? h('button', { type: 'button', class: 'pill', onclick: toggleNet }, registered ? '사내망에서 빼기' : '이 IP를 사내망으로 등록') : null);

    const logRow = (l) => h('li', { class: 'logrow' },
      h('div', { class: 'lname' }, h('b', { text: l[1] }), l[2] ? h('small', { text: l[2] }) : null),
      h('div', { class: 'ltime', text: fmtDate(new Date(l[0]).toISOString()) }),
      h('div', { class: 'lip', text: l[3] }),
      h('div', { class: 'lnet' }, h('i', { class: `bd ${l[4] === '사내망' ? 'dark' : (l[4] === '외부' ? 'line' : 'soft')}`, text: l[4] })),
      h('div', { class: 'lloc', text: l[5] || '확인 불가' }),
      h('div', { class: 'lres' }, h('i', { class: `bd ${l[6] === '실패' ? 'dark' : 'soft'}`, text: l[6] })));

    let filter = '전체';
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
    function paint() {
      const rows = json.logs.filter((l) => filter === '전체' || l[4] === filter);
      const opts = ['전체', '사내망', '외부', ...(json.logs.some((l) => l[4] === '미분류') ? ['미분류'] : [])];
      shell(
        h('p', { class: 'meta-line', text: '최근 7일 · 김규민, 오형철 계정에서만 보여요' }),
        h('div', { class: 'stats' }, stat('오늘 로그인', json.stats.today), stat('외부 접속', json.stats.outside), stat('로그인 실패', json.stats.failed)),
        netCard,
        h('div', { class: 'segs inline', role: 'group', 'aria-label': '접속 구분', style: `--n:${opts.length}` },
          opts.map((n) => h('button', { type: 'button', class: n === filter ? 'segb on' : 'segb', 'aria-pressed': String(n === filter), onclick: () => { filter = n; paint(); } }, n))),
        h('div', { class: 'loghead', 'aria-hidden': 'true' }, ['이름', '로그인 시각', 'IP', '구분', '대략 위치', '결과'].map((t) => h('span', { text: t }))),
        h('ul', { class: 'loglist' }, rows.length ? rows.map(logRow) : h('li', { class: 'empty', text: '기록이 없어요.' })),
        h('p', { class: 'fine', text: '위치는 접속 IP로 추정한 대략적인 지역이라 실제와 다를 수 있어요. 사내망은 등록한 회사 IP 기준으로 구분해요.' }));
    }
    paint();
  }

  // ---------- 라우터 ----------
  function render() {
    if (!me) return; // 로그인 전에는 로그인 화면만 보인다
    const hash = location.hash || '#/';
    let m = hash.match(/^#\/store\/(.+)$/);
    if (m) { renderStore(decodeURIComponent(m[1])); window.scrollTo(0, 0); return; }
    storeView = null;
    if (hash === '#/log') { renderLog(); window.scrollTo(0, 0); return; }
    m = hash.match(/^#\/list\/(.+)$/);
    if (m) { nav.back = hash; renderList(decodeURIComponent(m[1])); } else { nav.back = '#/'; renderHome(); }
    window.scrollTo(0, 0);
  }

  function mountWho() {
    $('.top .who-wrap')?.remove();
    if (!me) return;
    $('.top').append(h('div', { class: 'who-wrap' },
      h('span', { class: 'who' }, me.name, isManager() ? h('small', { text: '관리자' }) : null),
      h('button', { type: 'button', class: 'link', onclick: logout }, '로그아웃')));
  }

  let routed = false;
  function begin() {
    mountWho();
    if (!routed) { window.addEventListener('hashchange', render); routed = true; }
    render();
  }

  // 이미 받아 둔 내용이 있으면 바로 보여주고, 최신 내용은 뒤에서 받아 바뀐 것만 다시 그린다
  async function refreshInBackground() {
    try {
      const json = await fetchInit();
      if (!json.ok) {
        if (json.error === 'bad_code') { ['data-cache', 'data-cache-for', 'status-cache'].forEach((k) => ls.set(k, '')); me = null; renderGate(fail('bad_code')); }
        return;
      }
      const changed = sigOf(json) !== lastSig;
      saveInit(json);
      applyInit(json);
      if (changed) { mountWho(); if (!/^#\/(store|log)/.test(location.hash)) render(); } // 점포 화면은 올리는 중인 사진이 있을 수 있어 다시 그리지 않는다
      trackOnce();
    } catch { /* 연결이 안 되면 저장해 둔 내용으로 계속 쓴다 */ }
  }

  // 저장된 로그인으로 열 때의 로그인 기록은, 이 탭에서 한 번만 보낸다(새로고침할 때마다 보내지 않는다)
  function trackOnce() {
    try { if (sessionStorage.getItem('tracked')) return; sessionStorage.setItem('tracked', '1'); } catch { /* 저장소가 막혀 있어도 보낸다 */ }
    trackLogin('auto');
  }

  async function start() {
    $('#demo-tag').hidden = !DEMO;
    me = null;
    if (DEMO) {
      view.replaceChildren(h('div', { class: 'wrap' }, loadingBlock('점포 목록을 불러오는 중이에요')));
      try { await loadData(); } catch (err) { me = null; renderGate(err); return; }
      if (!me) { renderGate(fail('bad_code')); return; }
      await loadStatus();
      begin();
      return;
    }
    if (!normCode(ls.get('accessCode'))) { renderGate(fail('need_code')); return; }
    const saved = savedInit();
    if (saved) { applyInit(saved); begin(); refreshInBackground(); return; }
    view.replaceChildren(h('div', { class: 'wrap' }, loadingBlock('점포 목록을 불러오는 중이에요')));
    const direct = loginSubmitted; // 코드를 직접 입력해서 들어온 것인지
    loginSubmitted = false;
    try {
      const json = await fetchInit();
      if (!json.ok) throw fail(json.error || 'load');
      saveInit(json); applyInit(json);
    } catch (err) {
      me = null;
      if (direct && err && err.code === 'bad_code') trackLogin('login'); // 틀린 코드로 로그인하려던 것도 기록된다
      renderGate(err && err.code ? err : fail('offline'));
      return;
    }
    if (!me) { renderGate(fail('bad_code')); return; }
    begin();
    try { sessionStorage.setItem('tracked', '1'); } catch { /* 무시 */ }
    trackLogin(direct ? 'login' : 'auto');
  }
  start();
})();
