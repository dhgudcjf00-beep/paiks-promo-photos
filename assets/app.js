(() => {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.endpoint;
  const PAGE = 30;
  const LOG_PAGE = 10; // 로그인 기록·활동 기록은 10건씩 보여 주고 더 보기로 늘린다
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
  // 완료 표시의 체크: 선이 그려지듯 나타난다(CSS .ck). 움직임을 줄인 설정이면 바로 보인다.
  const CK_SVG = '<svg class="ck" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.2 8.6l3.1 3.1 6.5-6.7" pathLength="1"/></svg>';
  const ckIcon = () => h('span', { class: 'ckw', 'aria-hidden': 'true', html: CK_SVG });
  const ALL_SLOTS = SECTIONS.flatMap((sec) => sec.items.map((it) => it[0]));
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
    // 검색에 쓸 글자는 점포마다 한 번만 미리 만들어 둔다(점포가 1,800곳이어도 글자를 칠 때마다 다시 계산하지 않게)
    data.stores = stores.map((s) => {
      const o = { ...s, code: String(s.code || s.name) };
      o._n = norm(o.name); o._c = cho(o.name); o._svn = norm(o.sv); o._svc = cho(o.sv || ''); o._tn = norm(o.team); o._kn = norm(o.code);
      return o;
    });
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
  // 구글 스크립트는 접속자 IP를 알 수 없어서, 사이트가 무료 IP 확인 서비스(ipify)에서 IP만 받아 로그인 기록으로 보낸다. 위치는 조회하지도 저장하지도 않는다.
  let ipPromise = null;
  function lookupIp() {
    if (ipPromise) return ipPromise;
    const grab = async (url) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 3500);
      try { return await (await fetch(url, { signal: ac.signal })).json(); } finally { clearTimeout(timer); }
    };
    ipPromise = (async () => {
      for (const url of ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json']) {
        try { const j = await grab(url); if (j && j.ip) return { ip: String(j.ip) }; } catch { /* 다음 주소로 */ }
      }
      return null; // 조회하지 못해도 로그인은 그대로 된다
    })();
    return ipPromise;
  }

  // 로그인 기록 남기기. 화면을 기다리게 하지 않고, 실패해도 조용히 넘어간다.
  async function trackLogin(via) {
    if (DEMO) return;
    const info = await lookupIp();
    if (!info) return;
    try { await getJson({ action: 'track', via, ip: info.ip }); } catch { /* 무시 */ }
  }

  // 구글 스크립트로 값을 보낸다(사진처럼 큰 값은 주소가 아니라 본문에 담는다)
  async function postJson(payload) {
    const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ code: ls.get('accessCode'), ...payload }) });
    return res.json();
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
    return { before: v ? Number(v[0]) || 0 : 0, after: v ? Number(v[1]) || 0 : 0, folder: v && v[3] ? v[3] : '', confirmed: !!(v && v[4]), improved: !!(v && v[5]), comments: v ? Number(v[6]) || 0 : 0, backNa: !!(v && v[7]), complete: !!(v && v[8]) };
  };
  // 현황 한 칸: [기존수, 개선수, 시각, 폴더, 확인완료, 개선완료 직접, 코멘트수, 후면 미해당, 업로드 완료]
  const mkStatus = (c) => { c = c || []; return [c[0] || 0, c[1] || 0, c[2] || '', c[3] || '', c[4] ? 1 : 0, c[5] ? 1 : 0, c[6] || 0, c[7] ? 1 : 0, c[8] ? 1 : 0]; };
  // 업로드 완료: 9개 항목마다 기존·개선 사진이 다 있으면(후면은 '미해당'이면 건너뜀). 올린 사진 목록을 아직 못 받았으면 서버가 알려 준 값을 쓴다.
  function completeOf(code, backNa, fallback) {
    const b = book(code);
    if (!b.loaded) return fallback ? 1 : 0;
    return ALL_SLOTS.every((sl) => (sl === 'back' && backNa) || (b.before.some((e) => e.slot === sl) && b.after.some((e) => e.slot === sl))) ? 1 : 0;
  }

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
  const done = (s) => { const t = stat(s.code); return t.confirmed || t.improved || (t.before >= NEED && t.after >= NEED); }; // 확인완료·개선 완료 버튼을 누른 점포는 사진이 다 없어도 끝난 것으로 본다

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
    const sq = jamo ? single(q) : '';
    for (const s of pool) {
      const name = s._n;
      let score = 0;
      if (jamo) { if (s._c.includes(sq) || s._svc.includes(sq)) score = 3; }
      else if (name.startsWith(q)) score = 5;
      else if (name.includes(q)) score = 4;
      else if (s._svn.includes(q) || s._tn.includes(q) || s._kn.includes(q)) score = 2;
      if (score) hits.push([score, s]);
    }
    hits.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, 'ko'));
    return hits.map((x) => x[1]);
  }

  // 아직 안 올린 점포가 위로 오게
  function byProgress(list) {
    const n = (s) => { const t = stat(s.code); return t.confirmed || t.improved ? 1000 : Math.min(t.before, NEED) + Math.min(t.after, NEED); };
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
      h('span', { class: 'name' }, s.name, t.complete ? h('span', { class: 'okmark', title: '업로드 완료' }, ckIcon()) : null),
      sub ? h('span', { class: 'sub', text: sub }) : null,
      h('span', { class: 'marks' },
        t.comments ? h('i', { class: 'mk cm', text: `코멘트 ${t.comments}` }) : null,
        t.complete ? h('i', { class: 'mk up' }, ckIcon(), '업로드 완료') : null,
        t.confirmed ? h('i', { class: 'mk on', text: '확인완료' }) : (t.improved ? h('i', { class: 'mk on', text: '개선완료' }) : null),
        h('i', { class: t.before >= NEED ? 'mk on' : 'mk', text: `기존 ${t.before}` }),
        h('i', { class: t.after >= NEED ? 'mk on' : 'mk', text: `개선 ${t.after}` }))));
  }

  function externalLink(label, href) {
    return h('a', { class: 'pill', href, target: '_blank', rel: 'noopener' }, label, h('span', { 'aria-hidden': 'true', text: '↗' }));
  }

  // 불러오는 동안 보여주는 스피너
  const spinnerSvg = (size, stroke, onDark) => h('span', { class: 'spinbox', 'aria-hidden': 'true',
    html: `<svg class="spinner" width="${size}" height="${size}" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="16" stroke="${onDark ? '#555' : '#e4e4e4'}" stroke-width="${stroke}"/><path d="M20 4a16 16 0 0 1 16 16" stroke="${onDark ? '#fff' : '#000'}" stroke-width="${stroke}" stroke-linecap="round"/></svg>` });
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
        parts.push(h('a', { class: 'cardlink', href: '#/progress' },
          h('span', { class: 'ct' }, h('b', { text: '팀별 진행율' }), h('small', { text: '미진행 · 개선중 · 개선완료 · 확인완료 매장 수와 비율' })),
          h('span', { class: 'arr', 'aria-hidden': 'true', text: '›' })));
        const tools = [
          data.links.sheet ? externalLink('취합 시트 열기', data.links.sheet) : null,
          data.links.folder ? externalLink('드라이브 폴더 열기', data.links.folder) : null,
          canLog() ? h('a', { class: 'pill dark', href: '#/log' },
            h('span', { 'aria-hidden': 'true', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/></svg>' }), '로그인 기록') : null,
          canLog() ? h('a', { class: 'pill dark', href: '#/activity' },
            h('span', { 'aria-hidden': 'true', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14"/></svg>' }), '활동 기록') : null,
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
      // 비어 있는 값(null)을 그대로 넘기면 화면에 "null" 글자가 찍히므로 걸러서 넘긴다
      resultsHost.replaceChildren(...[
        h('p', { class: 'meta-line', text: `${found.length}곳` }), list,
        found.length > shown ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { shown += PAGE; paintResults(); } }, `더 보기 (${found.length - shown}곳 남음)`) : null,
      ].filter(Boolean));
    }
    let typing = null; // 글자를 치는 동안에는 잠깐 모았다가 한 번만 찾는다
    input.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { shown = PAGE; paintResults(); }, 90); });
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
      h('a', { class: 'back', href: '#/', onclick: () => { home.q = ''; } }, '‹ 처음'),
      // 관리자는 제목 오른쪽에서 이 팀의 미진행 매장(사진이 한 장도 없는 매장)만 바로 모아 볼 수 있다
      h('div', { class: 'titlerow' },
        h('h1', { class: 'page-title', text: listTitle(key) }),
        isManager() && key !== 'mine' ? h('a', { class: 'pill', id: 'none-link', href: progHref(key, 'none') }, '미진행 매장 보기', h('span', { 'aria-hidden': 'true', text: '›' })) : null),
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
    if (storeView && storeView.code === store.code) storeView.paintTable(); // 받는 중이라는 스피너를 바로 보여준다
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
            if (th[x.id] && !x.local && (!x.thumb || th[x.id].length > x.thumb.length * 1.25)) { x.thumb = th[x.id]; x.upTried = false; thumbDB.put(x.id, x.thumb); }
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
    return { get: (id) => run('readonly', (s) => s.get(id)), put: (id, url) => run('readwrite', (s) => s.put(url, id)), del: (id) => run('readwrite', (s) => s.delete(id)) };
  })();

  const repaintStore = (code) => { if (storeView && storeView.code === code) storeView.paintTable(); };

  // 작은 미리보기를 만든다. 사진(파일 또는 data 주소)을 받아, 글자 길이가 maxChars 이하인 작은 jpg 주소 글자로 돌려준다.
  // 서버는 이 글자를 사진 파일의 '설명' 칸에 붙여 영구 보관한다(칸이 2만 4천 자까지는 받는 것을 확인해서 2만 2천 자 이하로 맞춘다).
  // 화질: ① 크게 줄일 때는 절반씩 줄여 가며 고품질로 그린다(한 번에 크게 줄이면 계단·거친 무늬가 생겨 "깨져" 보인다)
  //       ② 큰 변·높은 화질부터 시작해, 글자 수가 넘으면 조금씩만 줄인다.
  const THUMB_MAX_CHARS = 22000;
  const THUMB_STEPS = [[400, 0.62], [380, 0.58], [360, 0.55], [330, 0.52], [300, 0.5], [270, 0.46], [240, 0.42], [240, 0.36]];
  const LOWRES_EDGE = 230; // 이보다 작은 미리보기(드라이브가 만든 220 크기 등)는 원본에서 다시 만들어 바꾼다
  function scaleDown(src, w, h, tw, th) {
    let cur = src, cw = w, ch = h;
    while (cw / 2 >= tw && ch / 2 >= th) {
      const c = document.createElement('canvas'); c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
      const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; cw = c.width; ch = c.height;
    }
    const out = document.createElement('canvas'); out.width = tw; out.height = th;
    const g = out.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, tw, th);
    return out;
  }
  async function fitThumb(src, maxChars = THUMB_MAX_CHARS) {
    let bmp;
    if (typeof src === 'string') {
      bmp = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('열 수 없는 사진')); img.src = src; });
    } else {
      bmp = await createImageBitmap(src);
    }
    const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
    let out = '', base = null;
    for (const [edge, quality] of THUMB_STEPS) {
      const s = Math.min(1, edge / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
      if (!base) base = scaleDown(bmp, w, h, tw, th); // 첫 크기까지만 원본에서 줄이고, 더 작게 줄일 때는 그 결과에서 줄인다
      const c = base.width === tw && base.height === th ? base : scaleDown(base, base.width, base.height, tw, th);
      out = c.toDataURL('image/jpeg', quality);
      if (out.length - 23 <= maxChars) break; // 앞의 'data:image/jpeg;base64,' 23글자는 빼고 잰다
    }
    if (bmp.close) bmp.close();
    return out;
  }
  // 낮은 화질(작은 크기) 미리보기를 원본에서 다시 만들어 바꾼다. 예전에 올린 사진의 드라이브 기본 미리보기(220 크기)가 대상이고, 한 사진당 이 기기에서 한 번만 시도한다.
  // 2장씩만 동시에 받아 서버에 부담을 주지 않고, 새로 만든 것이 눈에 띄게 크지 않으면 바꾸지 않는다.
  const upgradeQ = { running: 0, wait: [] };
  async function upgradeThumb(store, e) {
    if (DEMO || e.upTried || e.repairing || e.local) return;
    e.upTried = true;
    await new Promise((resolve) => { if (upgradeQ.running < 2) { upgradeQ.running += 1; resolve(); } else upgradeQ.wait.push(() => { upgradeQ.running += 1; resolve(); }); });
    try {
      const url = await fetchImage(e, 'photo', 'full');
      if (!url) return;
      const better = await fitThumb(url);
      e.full = ''; // 큰 원본은 메모리에서 비운다
      if (better && better.length > (e.thumb || '').length * 1.25) {
        e.thumb = better; thumbDB.put(e.id, better);
        postJson({ action: 'put_thumb', force: true, store: store.code, name: store.name, id: e.id, thumb: better.split(',')[1] }).catch(() => {});
        repaintStore(store.code);
      }
    } catch { /* 못 바꿔도 지금 미리보기는 그대로 보인다 */ }
    finally { upgradeQ.running -= 1; const next = upgradeQ.wait.shift(); if (next) next(); }
  }
  // 서버가 작은 사진을 못 만든 사진(드라이브가 아직 안 만들었고 원본이 큰 경우)은, 원본을 받아 여기서 줄여 만든다.
  // 만든 것은 이 기기에 남겨 두고, 서버 기억에도 채워서 다음 사람은 바로 보게 한다.
  async function repairThumb(store, e) {
    if (e.repairing) return;
    e.repairing = true; e.thumbFailed = false;
    try {
      const url = await fetchImage(e, 'photo', 'full');
      if (!url) throw new Error('원본을 받지 못했어요');
      const small = await fitThumb(url);
      e.thumb = small;
      e.full = ''; // 큰 원본은 메모리에서 비운다(크게 볼 때 다시 받는다)
      thumbDB.put(e.id, small);
      if (!DEMO) postJson({ action: 'put_thumb', store: store.code, name: store.name, id: e.id, thumb: small.split(',')[1] }).catch(() => {});
    } catch { e.thumbFailed = true; }
    e.repairing = false;
    repaintStore(store.code);
  }

  // 목록에 같이 오지 않은 작은 사진을 채운다: ① 이 기기에 남은 것 ② 서버가 가진 것(6장씩 묶어 한꺼번에, 동시에 3묶음) ③ 그래도 없으면 원본을 받아 직접 만들기(동시에 2장)
  async function fillThumbs(store) {
    const b = book(store.code);
    const need = [...b.before, ...b.after].filter((e) => !e.thumb && !e.local);
    if (!need.length) return;
    need.forEach((e) => { e.thumbFailed = false; });
    await Promise.all(need.map(async (e) => { const u = await thumbDB.get(e.id); if (u) e.thumb = u; }));
    repaintStore(store.code);
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
        } catch { /* 못 받으면 아래에서 원본으로 직접 만든다 */ }
        repaintStore(store.code);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const broken = need.filter((e) => !e.thumb);
    let at = 0;
    const fixer = async () => { while (at < broken.length) { const e = broken[at]; at += 1; await repairThumb(store, e); } };
    await Promise.all([fixer(), fixer()]);
  }

  function lightbox() {
    let dlg = $('#lightbox');
    if (dlg) return dlg;
    dlg = h('dialog', { id: 'lightbox', 'aria-label': '올린 사진' },
      h('button', { type: 'button', class: 'lb-close', 'aria-label': '닫기', onclick: () => dlg.close() }, '×'),
      h('div', { class: 'lb-stage' }, h('img', { alt: '올린 사진' }), h('div', { class: 'lb-spin', role: 'status', hidden: true }, spinnerSvg(40, 4, true))),
      h('p', { class: 'cap' }));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    return dlg;
  }

  async function openPhoto(entry, caption) {
    const dlg = lightbox();
    const img = $('img', dlg), spin = $('.lb-spin', dlg), cap = $('.cap', dlg);
    const text = [caption, fmtDate(entry.t), entry.by].filter(Boolean).join('  ');
    img.removeAttribute('src');
    img.src = entry.full || entry.thumb || '';
    cap.textContent = text;
    dlg.showModal();
    if (!entry.full) {
      spin.hidden = false; // 큰 사진을 받는 동안 스피너
      const url = await fetchImage(entry, 'photo', 'full');
      spin.hidden = true;
      if (url && dlg.open) img.src = url;
      else if (!url) cap.textContent = `${text}  (큰 사진을 불러오지 못했어요)`;
    }
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
  function recount(code, kind, replaced, slot) {
    const b = book(code);
    const next = mkStatus(data.status[code]);
    next[2] = new Date().toISOString();
    if (b.loaded) { next[0] = slotCount(b.before); next[1] = slotCount(b.after); }
    else if (!replaced) next[kind === 'before' ? 0 : 1] += 1;
    if (slot === 'back' && next[7]) { next[7] = 0; if (!b.loaded) next[8] = 0; } // 후면 사진을 올리면 '후면 미해당' 표시는 풀린다(서버도 같이 푼다)
    next[8] = completeOf(code, next[7], next[8]);
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
    const upok = h('span', { class: 'upok', hidden: true, role: 'status' }, ckIcon(), '업로드 완료');
    const okmark = h('span', { class: 'okmark', hidden: true, title: '업로드 완료' }, ckIcon());
    const progrow = h('div', { class: 'progrow' }, progress, upok);

    // 관리자 코멘트: 관리자는 쓰고 지울 수 있고, 그 점포를 맡은 SV는 읽기만 한다(서버도 같은 규칙으로 막는다). 개선 완료 버튼 바로 아래.
    const commentsHost = h('section', { class: 'cmbox', hidden: true, 'aria-label': '관리자 코멘트' });
    const cmState = { list: [], canWrite: isManager() };
    const cmList = h('ul', { class: 'cmlist' });
    const cmErr = h('p', { class: 'form-note', role: 'alert', hidden: true });
    const cmCount = h('small', { class: 'cmcount', text: '0/500' });
    const cmInput = h('textarea', { class: 'cminput', rows: '3', maxlength: '500', placeholder: '이 매장에 남길 코멘트 (담당 SV에게도 보여요)', 'aria-label': '코멘트 입력',
      oninput: () => { cmCount.textContent = `${cmInput.value.length}/500`; } });
    const cmBtn = h('button', { type: 'button', class: 'btn primary cmpost', onclick: () => postComment() }, '코멘트 남기기');
    const bumpCommentCount = (n) => {
      const c = mkStatus(data.status[code]);
      c[6] = n;
      data.status[code] = c;
      if (!DEMO) ls.set('status-cache', JSON.stringify(data.status));
    };
    function paintComments() {
      if (DEMO) return;
      const items = cmState.list;
      if (!cmState.canWrite && !items.length) { commentsHost.hidden = true; return; } // SV는 코멘트가 있을 때만 이 칸이 보인다
      commentsHost.hidden = false;
      cmList.replaceChildren(...(items.length ? items.map((c) => h('li', { class: 'cmitem' },
        h('div', { class: 'cmmeta' }, h('b', { text: c.who }), h('span', { text: fmtDate(new Date(c.t).toISOString()) }),
          cmState.canWrite ? h('button', { type: 'button', class: 'cmdel', 'aria-label': `${c.who}의 코멘트 삭제`, onclick: () => delComment(c) }, '삭제') : null),
        h('p', { class: 'cmtext', text: c.text }))) : [h('li', { class: 'cmempty', text: '아직 코멘트가 없어요.' })]));
    }
    async function loadComments() {
      if (DEMO) return;
      try {
        const r = await getJson({ action: 'comments', store: code });
        if (!r.ok) return;
        cmState.list = r.comments || []; cmState.canWrite = !!r.canWrite;
        bumpCommentCount(cmState.list.length);
        paintComments();
      } catch { /* 코멘트를 못 불러와도 사진 올리기는 그대로 된다 */ }
    }
    async function postComment() {
      const text = cmInput.value.trim();
      if (!text) { cmErr.textContent = '코멘트를 입력해 주세요.'; cmErr.hidden = false; return; }
      cmErr.hidden = true; cmBtn.disabled = true;
      try {
        const r = await postJson({ action: 'comment_add', store: code, name: store.name, text });
        if (!r || !r.ok) throw fail((r && r.error) || 'comment_failed');
        cmState.list.unshift(r.comment); cmInput.value = ''; cmCount.textContent = '0/500';
        bumpCommentCount(cmState.list.length); paintComments(); snack('코멘트를 남겼어요', store.name);
      } catch (err) {
        cmErr.textContent = { too_long: '코멘트는 500자까지 쓸 수 있어요.', limit: '이 매장에는 코멘트를 더 남길 수 없어요(100건까지).', bad_code: '접속 코드가 맞지 않아 저장하지 못했어요. 로그아웃한 뒤 코드를 다시 입력해 주세요.', not_allowed: '관리자만 코멘트를 남길 수 있어요.' }[err && err.code] || '코멘트를 저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
        cmErr.hidden = false;
      }
      cmBtn.disabled = false;
    }
    async function delComment(c) {
      if (!window.confirm('이 코멘트를 삭제할까요?')) return;
      try {
        const r = await postJson({ action: 'comment_del', store: code, id: c.id });
        if (!r || !r.ok) throw fail((r && r.error) || 'comment_failed');
        cmState.list = cmState.list.filter((x) => x.id !== c.id); bumpCommentCount(cmState.list.length); paintComments(); snack('코멘트를 삭제했어요', store.name);
      } catch { cmErr.textContent = '코멘트를 삭제하지 못했어요. 잠시 뒤 다시 눌러 주세요.'; cmErr.hidden = false; }
    }
    commentsHost.append(h('h2', { class: 'cmtitle', text: '관리자 코멘트' }), cmList,
      isManager() ? h('div', { class: 'cmform' }, cmInput, h('div', { class: 'cmrow' }, cmCount, cmBtn), cmErr) : null);
    // 확인완료: 사진을 올리지 않아도 개선이 끝났거나, 개선할 점이 없는 점포. 체크하면 팀별 진행율에서 미진행으로 세지 않는다.
    const confirmBox = h('input', { type: 'checkbox', id: 'confirm-chk', checked: stat(code).confirmed,
      onchange: (e) => toggleConfirm(e.target.checked) });
    const confirmRow = h('label', { class: 'confirm', for: 'confirm-chk' }, confirmBox,
      h('span', { class: 'ctext' }, h('b', { text: '확인완료 매장' }), h('small', { text: '개선이 끝났거나, 개선할 점이 없는 매장이에요. 개선 전 사진은 필수로 업로드해야 해요.' })));
    // 확인완료(체크)와 "개선 완료"(버튼)는 같은 방식으로 저장한다. 현황 칸: [.., 확인완료(4), 개선완료 직접 누름(5)]
    async function setFlag(kind, on, revertUi) {
      const idx = kind === 'done' ? 5 : 4, what = kind === 'done' ? '개선 완료' : '확인완료';
      const was = !!(data.status[code] || [])[idx];
      const setLocal = (v) => {
        const n = mkStatus(data.status[code]);
        n[idx] = v ? 1 : 0;
        data.status[code] = n;
        if (DEMO) ls.set('demo-status', JSON.stringify(data.status)); else ls.set('status-cache', JSON.stringify(data.status));
      };
      setLocal(on); paintImprove(); progCache = null; // 진행율 숫자가 바뀌므로 들고 있던 것을 비운다
      const title = on ? `${what}로 표시했어요` : `${what} 표시를 풀었어요`;
      if (DEMO) { snack(title, store.name); return; }
      confirmBox.disabled = true; improveBtn.disabled = true;
      try {
        const r = await postJson({ action: 'confirm', kind, store: code, name: store.name, on });
        if (!r || !r.ok) throw fail((r && r.error) || 'confirm_failed');
        snack(title, store.name);
      } catch (err) {
        setLocal(was); revertUi(was); // 저장하지 못했으면 원래대로 돌려 놓는다
        notice = err && err.code === 'bad_code' ? '접속 코드가 맞지 않아 저장하지 못했어요. 로그아웃한 뒤 코드를 다시 입력해 주세요.' : `${what} 표시를 저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.`;
        paintTable();
      }
      confirmBox.disabled = false; improveBtn.disabled = false;
    }
    const toggleConfirm = (on) => setFlag('confirmed', on, (was) => { confirmBox.checked = was; });

    // 후면 미해당: 후면 사진이 없는 매장(출입문이 하나인 곳 등). 체크하면 후면은 올린 것으로 쳐서 업로드 완료·진행율에 들어간다.
    let backBusy = false;
    async function toggleBackNa(on) {
      const was = stat(code).backNa;
      const bk = book(code);
      const hasBack = bk.before.some((e) => e.slot === 'back') || bk.after.some((e) => e.slot === 'back') || working.has('before:back') || working.has('after:back');
      if (on && hasBack) { notice = '후면 사진이 이미 있어서 \'후면 미해당\'으로 표시할 수 없어요.'; paintTable(); return; }
      const wasComplete = stat(code).complete;
      const setLocal = (v) => {
        const n = mkStatus(data.status[code]);
        n[7] = v ? 1 : 0;
        n[8] = completeOf(code, n[7], v ? n[8] : 0);
        data.status[code] = n;
        if (DEMO) ls.set('demo-status', JSON.stringify(data.status)); else ls.set('status-cache', JSON.stringify(data.status));
      };
      setLocal(on); progCache = null; notice = '';
      const msg = on ? (stat(code).complete && !wasComplete ? ['✓ 업로드 완료', `${store.name} · 후면 미해당으로 표시했어요`] : ['후면 미해당으로 표시했어요', store.name]) : ['후면 미해당 표시를 풀었어요', store.name];
      if (DEMO) { paintTable(); snack(msg[0], msg[1]); return; }
      backBusy = true; paintTable();
      try {
        const r = await postJson({ action: 'back_na', store: code, name: store.name, on });
        if (!r || !r.ok) throw fail((r && r.error) || 'back_na_failed');
        snack(msg[0], msg[1]);
      } catch (err) {
        setLocal(was);
        notice = err && err.code === 'bad_code' ? '접속 코드가 맞지 않아 저장하지 못했어요. 로그아웃한 뒤 코드를 다시 입력해 주세요.'
          : (err && err.code === 'has_photo' ? '후면 사진이 이미 있어서 \'후면 미해당\'으로 표시할 수 없어요.' : '후면 미해당 표시를 저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.');
      }
      backBusy = false; paintTable();
    }
    const backNaBox = () => h('label', { class: 'backna', for: 'backna-chk' },
      h('input', { type: 'checkbox', id: 'backna-chk', checked: stat(code).backNa, disabled: backBusy, onchange: (e) => toggleBackNa(e.target.checked) }),
      h('span', { text: '후면 미해당' }));
    const naCell = (kind) => h('div', { class: 'cell na', 'aria-label': `후면 ${COL[kind]} 미해당` }, h('span', { class: 'fill' }, h('b', { text: '미해당' })));

    // 몇 곳만 개선하는 점포는 사진 항목이 다 채워지지 않아 개선중으로 남는다. 개선이 끝났으면 이 버튼으로 직접 개선완료로 올린다.
    const improveBtn = h('button', { type: 'button', class: 'improve', id: 'improve-btn', onclick: () => setFlag('done', !stat(code).improved, paintImprove) });
    function paintImprove() {
      const on = stat(code).improved;
      improveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      improveBtn.classList.toggle('on', on);
      improveBtn.replaceChildren(
        h('span', { class: 'itx' }, h('b', { text: on ? '✓ 개선 완료됨' : '개선 완료' }),
          h('small', { text: on ? '눌러서 취소할 수 있어요' : '전체 항목이 아니라 몇 곳만 개선해도 되는 매장이면, 개선이 끝났을 때 눌러 주세요' })));
    }
    paintImprove();

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
      let shot;
      if (st) {
        shot = h('div', { class: 'shot' }, h('img', { alt: `${label} ${col}`, src: st.url }));
      } else if (entry.thumb) {
        // 작은 사진이 깨져서 열리지 않으면 한 번 다시 만든다
        const img = h('img', { alt: `${label} ${col}`, src: entry.thumb, onload: (ev) => { const im = ev.target; if (Math.max(im.naturalWidth, im.naturalHeight) <= LOWRES_EDGE) upgradeThumb(store, entry); }, onerror: () => { if (entry.thumbBad) { entry.thumbFailed = true; entry.thumb = ''; repaintStore(code); return; } entry.thumbBad = true; entry.thumb = ''; thumbDB.del(entry.id); repairThumb(store, entry); repaintStore(code); } });
        shot = h('button', { type: 'button', class: 'shot', 'aria-label': `${label} ${col} 크게 보기`, onclick: () => openPhoto(entry, `${label} ${col}`) }, img);
      } else if (entry.thumbFailed && !entry.repairing) {
        // 작은 사진을 만들지 못했다: 눌러서 크게 보거나 다시 시도할 수 있다
        shot = h('button', { type: 'button', class: 'shot failed', 'aria-label': `${label} ${col} 크게 보기`, onclick: () => { repairThumb(store, entry); openPhoto(entry, `${label} ${col}`); } },
          h('b', { text: '미리보기를 못 불러왔어요' }), h('small', { text: '눌러서 크게 보기' }));
      } else {
        // 아직 받는 중: 스피너
        shot = h('button', { type: 'button', class: 'shot waiting', 'aria-label': `${label} ${col} 불러오는 중`, onclick: () => openPhoto(entry, `${label} ${col}`) }, spinnerSvg(26, 5));
      }
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
      let ok = stat(code).complete;
      if (b.loaded) { // 올린 사진 목록을 받았으면 지금 화면 기준으로 다시 계산하고, 기억해 둔 현황에도 맞춘다
        const c = completeOf(code, stat(code).backNa, 0);
        if (c && !ok && uploadedHere.has(code)) { uploadedHere.delete(code); snack('✓ 업로드 완료', `${store.name}의 모든 항목이 올라갔어요`); }
        if (c !== (ok ? 1 : 0)) { const n = mkStatus(data.status[code]); n[8] = c; data.status[code] = n; if (!DEMO) ls.set('status-cache', JSON.stringify(data.status)); else ls.set('demo-status', JSON.stringify(data.status)); }
        ok = !!c;
      }
      upok.hidden = !ok; okmark.hidden = !ok;
      sheetHost.replaceChildren(...[
        notice ? h('p', { class: 'form-note', role: 'alert', text: notice }) : null,
        b.loading ? h('div', { class: 'loadrow', role: 'status', 'aria-live': 'polite' }, spinnerSvg(22, 5), h('span', { text: '올린 사진을 불러오는 중이에요' })) : null,
        b.failed ? h('p', { class: 'hint', text: '올린 사진을 불러오지 못했어요. 새로 올리는 것은 그대로 됩니다.' }) : null,
        h('div', { class: 'sheet' },
          h('div', { class: 'sheet-cols', 'aria-hidden': 'true' }, h('span', { text: '항목' }), h('span', { text: COL.before }), h('span', { text: COL.after })),
          SECTIONS.map((sec) => h('section', { class: 'grp', 'aria-label': sec.title },
            h('h2', { text: sec.title }),
            sec.items.map(([slot, label, desc]) => {
              const isNa = slot === 'back' && stat(code).backNa;
              return h('div', { class: isNa ? 'srow na' : 'srow' },
                h('div', { class: 'lbl' }, h('b', { text: label }), desc ? h('small', { text: desc }) : null, slot === 'back' ? backNaBox() : null),
                isNa ? naCell('before') : cell('before', slot, label), isNa ? naCell('after') : cell('after', slot, label));
            }))))].filter(Boolean));
    }

    // 사진을 고르면 그 자리에 바로 올린다
    async function send(kind, slot, file) {
      const key = `${kind}:${slot}`;
      const prev = working.get(key);
      if (prev && (prev.state === 'up' || prev.state === 'wait')) return;
      if (prev && prev.file !== file) URL.revokeObjectURL(prev.url);
      const st = { state: uploadQ.running < UPLOAD_PARALLEL ? 'up' : 'wait', file, url: prev && prev.file === file ? prev.url : URL.createObjectURL(file) };
      working.set(key, st); notice = ''; uploadedHere.add(code); paintTable();
      try {
        await schedule(async () => {
          st.state = 'up';
          if (storeView && storeView.code === code) storeView.paintTable();
          const blob = await compress(file);
          const tiny = DEMO ? '' : await fitThumb(blob).catch(() => ''); // 서버가 사진에 붙여 영구 보관하도록 작은 사진을 함께 보낸다(1만 8천 자 이하)
          const res = await sendPhoto(store, kind, slot, file.name, blob, tiny);
          const replaced = await remember(store, kind, slot, blob, res || {}, tiny);
          URL.revokeObjectURL(st.url); working.delete(key);
          const wasComplete = stat(code).complete;
          recount(code, kind, replaced, slot);
          if (!wasComplete && stat(code).complete) justCompleted = store.name;
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
        h('a', { class: 'back', href: nav.back, onclick: () => { if (nav.back === '#/') home.q = ''; } }, nav.back === '#/' ? '‹ 처음' : '‹ 목록'),
        h('h1', { class: 'store-name' }, store.name, okmark),
        h('p', { class: 'sub', text: [store.team, store.sv && `${store.sv} 담당`].filter(Boolean).join(' ') }),
        progrow, confirmRow, improveBtn, commentsHost),
      sheetHost)));
    // 작은 사진이 하나씩 도착할 때마다 표를 통째로 다시 그리지 않도록, 한 화면 프레임에 한 번만 그린다
    let paintQueued = false;
    const paintSoon = () => {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(() => { paintQueued = false; if (storeView && storeView.code === code) paintTable(); });
    };
    storeView = { code, paintTable: paintSoon };
    paintTable();
    loadPhotos(store);
    loadComments();
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
  const uploadedHere = new Set(); // 이 화면에서 사진을 올린 점포(완료가 되면 한 번 알려 주려고)
  let justCompleted = ''; // 방금 올린 사진으로 모든 항목이 채워진 점포 이름
  const slotLabel = (slot) => { for (const sec of SECTIONS) for (const it of sec.items) if (it[0] === slot) return it[1]; return slot; };
  function flushSaved() {
    if (uploadQ.running || uploadQ.waiting.length || !justSaved.length) return;
    const n = justSaved.length, last = justSaved[n - 1];
    justSaved.length = 0;
    if (justCompleted) { const nm = justCompleted; justCompleted = ''; uploadedHere.clear(); snack('✓ 업로드 완료', `${nm}의 모든 항목이 올라갔어요`); return; }
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
    const back = h('a', { class: 'back', href: '#/', onclick: () => { home.q = ''; } }, '‹ 처음');
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
        h('div', {}, h('b', { text: '지금 접속한 IP ' }), h('span', { class: 'ipv', text: info ? info.ip : '확인하지 못했어요' })),
        h('p', { class: 'fine', text: internal.length ? `사내망으로 등록한 IP: ${internal.join(', ')}` : '아직 사내망 IP를 등록하지 않아 모든 접속이 "미분류"로 보여요. 회사에서 접속한 상태로 오른쪽 버튼을 눌러 등록하세요.' })),
      info ? h('button', { type: 'button', class: 'pill', onclick: toggleNet }, registered ? '사내망에서 빼기' : '이 IP를 사내망으로 등록') : null);

    // 기록 한 줄: [시각, 이름, 구분, IP, 사내망/외부, 결과, 경로]
    const logRow = (l) => h('li', { class: 'logrow' },
      h('div', { class: 'lname' }, h('b', { text: l[1] }), l[2] ? h('small', { text: l[2] }) : null),
      h('div', { class: 'ltime', text: fmtDate(new Date(l[0]).toISOString()) }),
      h('div', { class: 'lip', text: l[3] }),
      h('div', { class: 'lnet' }, h('i', { class: `bd ${l[4] === '사내망' ? 'dark' : (l[4] === '외부' ? 'line' : 'soft')}`, text: l[4] })),
      h('div', { class: 'lres' }, h('i', { class: `bd ${l[5] === '실패' ? 'dark' : 'soft'}`, text: l[5] })));

    let filter = '전체', shown = LOG_PAGE;
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
    function paint() {
      const rows = json.logs.filter((l) => filter === '전체' || l[4] === filter);
      const opts = ['전체', '사내망', '외부', ...(json.logs.some((l) => l[4] === '미분류') ? ['미분류'] : [])];
      shell(
        h('p', { class: 'meta-line', text: '최근 7일 · 김규민, 오형철 계정에서만 보여요' }),
        h('div', { class: 'stats' }, stat('오늘 로그인', json.stats.today), stat('외부 접속', json.stats.outside), stat('로그인 실패', json.stats.failed)),
        netCard,
        h('div', { class: 'segs inline', role: 'group', 'aria-label': '접속 구분', style: `--n:${opts.length}` },
          opts.map((n) => h('button', { type: 'button', class: n === filter ? 'segb on' : 'segb', 'aria-pressed': String(n === filter), onclick: () => { filter = n; shown = LOG_PAGE; paint(); } }, n))),
        h('div', { class: 'loghead', 'aria-hidden': 'true' }, ['이름', '로그인 시각', 'IP', '구분', '결과'].map((t) => h('span', { text: t }))),
        h('ul', { class: 'loglist' }, rows.length ? rows.slice(0, shown).map(logRow) : h('li', { class: 'empty', text: '기록이 없어요.' })),
        rows.length > shown ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { shown += LOG_PAGE; paint(); } }, `더 보기 (${rows.length - shown}건 남음)`) : null,
        h('p', { class: 'fine', text: '사내망은 등록한 회사 IP 기준으로 구분해요. 접속 위치는 기록하지 않아요.' }));
    }
    paint();
  }

  // ---------- 활동 기록 (김규민, 오형철 계정에서만) ----------
  // 누가 무엇을 눌렀는지(사진 올림·교체, 확인완료, 개선 완료)를 보여준다. 구글 시트·깃허브에는 남기지 않고 서버 안에만 있다.
  // 행: [시각, 점포 식별값, 점포명, 종류, 항목, 한 사람, 교체(1/0)]  종류: b 기존 사진, a 개선 사진, C/c 확인완료 표시/해제, I/i 개선 완료 누름/취소
  let actToken = 0;
  const isPhotoAct = (e) => e[3] === 'b' || e[3] === 'a';
  async function renderActivity() {
    document.title = '활동 기록 | 빽다방 홍보물 취합';
    const token = ++actToken;
    const back = h('a', { class: 'back', href: '#/', onclick: () => { home.q = ''; } }, '‹ 처음');
    const shell = (...kids) => { if (token === actToken) view.replaceChildren(h('div', { class: 'wrap' }, back, h('h1', { class: 'page-title', text: '활동 기록' }), ...kids)); };
    const denied = () => {
      if (token !== actToken) return;
      view.replaceChildren(h('div', { class: 'wrap' }, back, h('div', { class: 'denied' },
        h('span', { class: 'lockc', 'aria-hidden': 'true', html: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' }),
        h('h1', { text: '볼 수 없는 화면이에요' }),
        h('p', { text: '활동 기록은 김규민, 오형철 계정에서만 볼 수 있어요.' }))));
    };
    if (!canLog()) { denied(); return; }
    shell(loadingBlock('활동 기록을 불러오는 중이에요'));
    let json;
    try { json = await getJson({ action: 'activity' }); }
    catch { shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }
    if (token !== actToken) return;
    if (!json.ok) { if (json.error === 'not_allowed') denied(); else shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }

    let filter = '전체', q = '', shown = LOG_PAGE;
    const slotText = (slot) => (slot ? slotLabel(slot) : '항목 미상');
    // 한 일을 글자로: [뱃지 글자, 뱃지 모양, 설명]
    const what = (e) => {
      if (isPhotoAct(e)) return [e[3] === 'a' ? '개선' : '기존', e[3] === 'a' ? 'dark' : 'soft', `${slotText(e[4])} ${e[6] ? '사진 교체' : '사진 올림'}`];
      if (e[3] === 'C') return ['확인완료', 'line', '확인완료로 표시'];
      if (e[3] === 'c') return ['확인완료', 'soft', '확인완료 표시 해제'];
      if (e[3] === 'M') return ['코멘트', 'line', '코멘트 작성'];
      if (e[3] === 'm') return ['코멘트', 'soft', '코멘트 삭제'];
      if (e[3] === 'N') return ['후면 미해당', 'line', '후면 미해당으로 표시'];
      if (e[3] === 'n') return ['후면 미해당', 'soft', '후면 미해당 표시 해제'];
      if (e[3] === 'I') return ['개선 완료', 'line', '"개선 완료" 버튼 누름'];
      return ['개선 완료', 'soft', '"개선 완료" 취소'];
    };
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
    const input = h('input', { type: 'search', class: 'upsearch', placeholder: '점포명이나 누른 사람으로 찾기', autocomplete: 'off', 'aria-label': '활동 기록 검색' });
    const listHost = h('div', {});
    const actRow = (e) => {
      const [bt, bs, txt] = what(e);
      const exists = data.byCode.has(e[1]);
      const cells = [
        h('div', { class: 'utime', text: fmtDate(new Date(e[0]).toISOString()) }),
        h('div', { class: 'ustore', text: e[2] || e[1] }),
        h('div', { class: 'uwhat' }, h('i', { class: `bd ${bs}`, text: bt }), h('span', { text: txt })),
        h('div', { class: 'uwho', text: e[5] }),
      ];
      return h('li', {}, exists ? h('a', { class: 'uprow', href: `#/store/${enc(e[1])}` }, ...cells) : h('div', { class: 'uprow', role: 'group' }, ...cells));
    };
    function paintList() {
      const text = norm(q);
      const rows = json.rows.filter((e) => (filter === '전체' || (filter === '사진' ? isPhotoAct(e) : !isPhotoAct(e)))
        && (!text || norm(e[2]).includes(text) || norm(e[5]).includes(text) || norm(what(e)[2]).includes(text)));
      // 더 보기 버튼이 없을 때의 빈 값(null)을 그대로 넘기면 화면에 "null" 글자가 찍히므로 걸러서 넘긴다
      listHost.replaceChildren(...[
        h('p', { class: 'meta-line', text: `${rows.length}건` }),
        h('div', { class: 'uphead', 'aria-hidden': 'true' }, ['시각', '점포', '한 일', '누른 사람'].map((t) => h('span', { text: t }))),
        h('ul', { class: 'uplist' }, rows.length ? rows.slice(0, shown).map(actRow) : h('li', { class: 'empty', text: '기록이 없어요.' })),
        rows.length > shown ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { shown += LOG_PAGE; paintList(); } }, `더 보기 (${rows.length - shown}건 남음)`) : null,
      ].filter(Boolean));
    }
    input.addEventListener('input', () => { q = input.value.trim(); shown = LOG_PAGE; paintList(); });
    const segs = h('div', { class: 'segs inline', role: 'group', 'aria-label': '종류', style: '--n:3' },
      ['전체', '사진', '표시'].map((n) => h('button', { type: 'button', class: n === '전체' ? 'segb on' : 'segb', 'aria-pressed': String(n === '전체'), onclick: () => {
        filter = n; shown = LOG_PAGE;
        segs.querySelectorAll('.segb').forEach((b) => { const on = b.textContent === n; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        paintList();
      } }, n)));
    shell(
      h('p', { class: 'meta-line', text: '누가 무엇을 눌렀는지 · 김규민, 오형철 계정에서만 보여요' }),
      h('div', { class: 'stats' }, stat('오늘 활동', json.stats.today), stat('최근 7일', json.stats.week), stat('오늘 한 사람', json.stats.people)),
      h('label', { class: 'upsearchwrap' }, input),
      segs, listHost,
      h('p', { class: 'fine', text: `이 기록은 구글 시트·드라이브·깃허브에 남기지 않고 서버 안에만 최근 ${json.keep || 1500}건까지 보관해요. "사진"은 사진 올림·교체, "표시"는 확인완료와 "개선 완료" 버튼이에요.` }));
    paintList();
  }
  // ---------- 팀별 진행율 (관리자) ----------
  // 점포마다 한 가지 상태: 확인완료(체크한 점포) / 미진행(사진이 한 장도 없음) / 개선완료(개선 전 사진이 있는 항목마다 개선 후 사진이 있음) / 개선중(그 밖에 일부 올라옴)
  const PROG_KINDS = [['none', '미진행'], ['doing', '개선중'], ['done', '개선완료'], ['confirmed', '확인완료']];
  const PROG_BAR = ['confirmed', 'done', 'doing', 'none']; // 막대에서 칸이 놓이는 순서(왼쪽부터, 진한 색부터)
  const pctText = (n, t) => `${t ? (Math.round((n / t) * 1000) / 10).toFixed(1) : '0.0'}%`;
  let progToken = 0;
  // 진행율 응답은 잠깐(30초) 들고 있다가 항목을 눌러 매장 목록을 볼 때 다시 쓴다. 체크·버튼을 누르면 비운다.
  let progCache = null;
  async function loadProgress(fresh) {
    if (!fresh && progCache && Date.now() - progCache.at < 30000) return progCache.json;
    const json = await getJson({ action: 'progress' });
    if (json && json.ok) progCache = { json, at: Date.now() };
    return json;
  }
  const progHref = (team, kind) => `#/progress/${enc(team)}/${kind}`;

  // 진행율 화면이 열리면 숫자는 0에서부터 세어 올라가고, 막대는 왼쪽에서부터 차오른다(움직임을 줄인 설정이면 바로 최종 값)
  function runCountUp() {
    if (window.__noAnim || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const bars = [...view.querySelectorAll('.pbar i')], nums = [...view.querySelectorAll('.pn[data-n]')], pcts = [...view.querySelectorAll('.pp[data-n]')];
    if (!nums.length) return;
    bars.forEach((i) => { i.dataset.w = i.style.width; i.style.transition = 'none'; i.style.width = '0%'; });
    nums.forEach((e) => { e.textContent = '0곳'; });
    pcts.forEach((e) => { e.textContent = pctText(0, Number(e.dataset.t)); });
    requestAnimationFrame(() => requestAnimationFrame(() => bars.forEach((i) => { i.style.transition = 'width 1.1s cubic-bezier(.2,.7,.2,1)'; i.style.width = i.dataset.w; })));
    const t0 = performance.now(), D = 1100;
    const step = (now) => {
      if (!nums[0].isConnected) return;
      const p = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - p, 3);
      nums.forEach((el) => { el.textContent = `${Math.round(Number(el.dataset.n) * e)}곳`; });
      pcts.forEach((el) => { el.textContent = pctText(Number(el.dataset.n) * e, Number(el.dataset.t)); });
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function renderProgress() {
    document.title = '팀별 진행율 | 빽다방 홍보물 취합';
    const token = ++progToken;
    const back = h('a', { class: 'back', href: '#/', onclick: () => { home.q = ''; } }, '‹ 처음');
    const shell = (...kids) => { if (token === progToken) view.replaceChildren(h('div', { class: 'wrap' }, back, h('h1', { class: 'page-title', text: '팀별 진행율' }), ...kids)); };
    if (!isManager()) { shell(h('p', { class: 'empty', text: '팀별 진행율은 관리자 계정에서만 볼 수 있어요.' })); return; }
    if (DEMO) { shell(h('p', { class: 'empty', text: '시험 모드에서는 볼 수 없어요.' })); return; }
    shell(loadingBlock('팀별 진행율을 불러오는 중이에요'));
    let json;
    try { json = await loadProgress(true); }
    catch { shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }
    if (token !== progToken) return;
    if (!json.ok) { shell(h('p', { class: 'empty', text: json.error === 'not_allowed' ? '팀별 진행율은 관리자 계정에서만 볼 수 있어요.' : '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }

    const card = (title, o, big) => h('section', { class: big ? 'pcard big' : 'pcard', 'aria-label': `${title} 진행율` },
      h('div', { class: 'phead' }, h('h2', { text: title }), h('span', { class: 'ptotal', text: `전체 ${o.total}곳` })),
      // 막대는 끝난 것(확인완료·개선완료)이 왼쪽 맨 앞부터 채워지고 남은 것이 오른쪽에 남는다: 진행율이 오르면 막대가 왼쪽에서 차오른다
      h('div', { class: 'pbar', role: 'img', 'aria-label': PROG_KINDS.map(([k, t]) => `${t} ${o[k]}곳`).join(', ') },
        PROG_BAR.map((k) => h('i', { class: `s-${k}`, style: `width:${o.total ? (o[k] / o.total) * 100 : 0}%` }))),
      // 항목을 누르면 그 팀의 그 상태인 매장 목록이 나온다
      h('ul', { class: 'plist' }, PROG_KINDS.map(([k, t]) => h('li', {},
        h('a', { class: 'plink', href: progHref(big ? 'all' : title, k), 'aria-label': `${title} ${t} ${o[k]}곳, 매장 목록 보기` },
          h('i', { class: `sw s-${k}`, 'aria-hidden': 'true' }),
          h('span', { class: 'pl', text: t }),
          h('span', { class: 'pn', 'data-n': String(o[k]), text: `${o[k]}곳` }),
          h('span', { class: 'pp', 'data-n': String(o[k]), 'data-t': String(o.total), text: pctText(o[k], o.total) }),
          h('span', { class: 'go', 'aria-hidden': 'true', text: '›' }))))));

    shell(
      h('div', { class: 'pmeta' },
        h('p', { class: 'meta-line', text: `기준 ${fmtDate(json.at)} · 팀 ${json.teams.length}개 · 전체 ${json.all.total}곳` }),
        h('button', { type: 'button', class: 'pill', onclick: () => renderProgress() }, '새로고침')),
      card('전체', json.all, true),
      h('div', { class: 'pgrid' }, json.teams.map((t) => card(t.team, t))),
      h('div', { class: 'pdefs' },
        h('p', { class: 'fine' }, h('b', { text: '미진행 ' }), '사진이 한 장도 올라오지 않은 매장'),
        h('p', { class: 'fine' }, h('b', { text: '개선중 ' }), '사진은 올라왔지만 개선 후 사진이 아직 없거나, 개선 전 사진이 있는 항목 중 개선 후 사진이 없는 항목이 있는 매장'),
        h('p', { class: 'fine' }, h('b', { text: '개선완료 ' }), '개선 전 사진이 있고, 개선 전 사진이 있는 항목마다 개선 후 사진이 올라온 매장'),
        h('p', { class: 'fine' }, h('b', { text: '확인완료 ' }), '매장 화면에서 확인완료로 체크한 매장(사진이 없어도 미진행으로 세지 않아요)'),
        h('p', { class: 'fine', text: '모든 항목에 사진이 꼭 있어야 하는 것은 아니라서, 올라와 있는 항목끼리만 맞춰 봐요.' }),
        h('p', { class: 'fine', text: '각 항목을 누르면 그 팀의 해당 매장 목록을 볼 수 있어요.' })));
    runCountUp();
  }

  // ---------- 진행율 항목을 눌렀을 때: 그 팀의 해당 상태 매장 목록 ----------
  const progList = { key: '', shown: PAGE };
  async function renderProgressList(teamKey, kind) {
    const token = ++progToken;
    const kindName = Object.fromEntries(PROG_KINDS)[kind];
    const teamName = teamKey === 'all' ? '전체' : teamKey;
    document.title = `${teamName} ${kindName} | 빽다방 홍보물 취합`;
    nav.back = progHref(teamKey, kind); // 매장을 열었다가 돌아오면 이 목록으로
    const back = h('a', { class: 'back', href: '#/progress' }, '‹ 진행율');
    const shell = (...kids) => { if (token === progToken) view.replaceChildren(h('div', { class: 'wrap' }, back, h('h1', { class: 'page-title', text: `${teamName} · ${kindName}` }), ...kids)); };
    if (!isManager()) { shell(h('p', { class: 'empty', text: '팀별 진행율은 관리자 계정에서만 볼 수 있어요.' })); return; }
    if (DEMO) { shell(h('p', { class: 'empty', text: '시험 모드에서는 볼 수 없어요.' })); return; }
    if (!PROG_KINDS.some(([k]) => k === kind)) { shell(h('p', { class: 'empty', text: '없는 항목이에요.' })); return; }
    shell(loadingBlock('매장 목록을 불러오는 중이에요'));
    let json;
    try { json = await loadProgress(false); }
    catch { shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }
    if (token !== progToken) return;
    if (!json.ok || !json.kinds) { shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }

    const inTeam = data.stores.filter((s) => teamKey === 'all' || (s.team || '팀 미지정') === teamKey);
    const kindOf = (s) => json.kinds[s.code] || 'none';
    const counts = Object.fromEntries(PROG_KINDS.map(([k]) => [k, 0]));
    inTeam.forEach((s) => { counts[kindOf(s)] += 1; });
    const pool = inTeam.filter((s) => kindOf(s) === kind).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    const key = `${teamKey}|${kind}`;
    if (progList.key !== key) { progList.key = key; progList.shown = PAGE; }

    const list = h('ul', { class: 'rows' });
    if (!pool.length) list.append(h('li', { class: 'empty', text: `${kindName} 매장이 없어요.` }));
    pool.slice(0, progList.shown).forEach((s) => list.append(row(s, teamKey === 'all')));
    const more = pool.length > progList.shown
      ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { progList.shown += PAGE; renderProgressList(teamKey, kind); } }, `더 보기 (${pool.length - progList.shown}곳 남음)`)
      : null;
    // 같은 팀의 다른 상태로 바로 넘어가는 세그먼트
    const segs = h('div', { class: 'segs left', role: 'group', 'aria-label': '상태 바꾸기', style: `--n:${PROG_KINDS.length}` },
      PROG_KINDS.map(([k, t]) => h('a', { class: k === kind ? 'segb on' : 'segb', href: progHref(teamKey, k), 'aria-current': k === kind ? 'page' : false }, `${t} ${counts[k]}`)));
    shell(
      h('p', { class: 'meta-line', text: `${teamName} ${inTeam.length}곳 중 ${kindName} ${pool.length}곳 (${pctText(pool.length, inTeam.length)})` }),
      segs, list, more);
  }

  // ---------- 라우터 ----------
  function render() {
    if (!me) return; // 로그인 전에는 로그인 화면만 보인다
    const hash = location.hash || '#/';
    let m = hash.match(/^#\/store\/(.+)$/);
    if (m) { renderStore(decodeURIComponent(m[1])); window.scrollTo(0, 0); return; }
    storeView = null;
    if (hash === '#/progress') { renderProgress(); window.scrollTo(0, 0); return; }
    m = hash.match(/^#\/progress\/([^/]+)\/([a-z]+)$/);
    if (m) { renderProgressList(decodeURIComponent(m[1]), m[2]); window.scrollTo(0, 0); return; }
    if (hash === '#/log') { renderLog(); window.scrollTo(0, 0); return; }
    if (hash === '#/activity') { renderActivity(); window.scrollTo(0, 0); return; }
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

  // 맨 위의 "빽다방 홍보물 취합"을 누르면 어디서든 첫 화면으로 돌아간다(이미 첫 화면이면 검색을 지우고 처음 상태로)
  $('.brand')?.addEventListener('click', (e) => {
    if (!me) return; // 로그인 화면에서는 기본 동작 그대로
    e.preventDefault();
    home.q = '';
    if (!location.hash || location.hash === '#/') { render(); } else { location.hash = '#/'; }
  });

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
