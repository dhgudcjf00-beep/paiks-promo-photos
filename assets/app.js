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
    return { before: v ? Number(v[0]) || 0 : 0, after: v ? Number(v[1]) || 0 : 0, folder: v && v[3] ? v[3] : '', confirmed: !!(v && v[4]), improved: !!(v && v[5]) };
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
      h('span', { class: 'name', text: s.name }),
      sub ? h('span', { class: 'sub', text: sub }) : null,
      h('span', { class: 'marks' },
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
          canLog() ? h('a', { class: 'pill dark', href: '#/uploads' },
            h('span', { 'aria-hidden': 'true', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14"/></svg>' }), '업로드 이력') : null,
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
    return { get: (id) => run('readonly', (s) => s.get(id)), put: (id, url) => run('readwrite', (s) => s.put(url, id)), del: (id) => run('readwrite', (s) => s.delete(id)) };
  })();

  const repaintStore = (code) => { if (storeView && storeView.code === code) storeView.paintTable(); };

  // 작은 미리보기를 만든다. 사진(파일 또는 data 주소)을 받아, 글자 길이가 maxChars 이하인 작은 jpg 주소 글자로 돌려준다.
  // 서버는 이 글자를 사진 파일의 '설명' 칸에 붙여 영구 보관한다(칸이 2만 5천 자쯤까지만 받아서 1만 8천 자 이하로 맞춘다).
  // 큰 변·낮은 화질부터 시작해 길이가 넘으면 조금씩 더 줄인다.
  const THUMB_MAX_CHARS = 17500;
  const THUMB_STEPS = [[320, 0.64], [300, 0.56], [280, 0.5], [260, 0.45], [240, 0.4], [200, 0.4], [160, 0.4]];
  async function fitThumb(src, maxChars = THUMB_MAX_CHARS) {
    let bmp;
    if (typeof src === 'string') {
      bmp = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('열 수 없는 사진')); img.src = src; });
    } else {
      bmp = await createImageBitmap(src);
    }
    const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
    let out = '';
    for (const [edge, quality] of THUMB_STEPS) {
      const s = Math.min(1, edge / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      out = c.toDataURL('image/jpeg', quality);
      if (out.length - 23 <= maxChars) break; // 앞의 'data:image/jpeg;base64,' 23글자는 빼고 잰다
    }
    if (bmp.close) bmp.close();
    return out;
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
  function recount(code, kind, replaced) {
    const b = book(code);
    const cur = data.status[code] || [0, 0, '', '', 0, 0];
    const next = [cur[0] || 0, cur[1] || 0, new Date().toISOString(), cur[3] || '', cur[4] ? 1 : 0, cur[5] ? 1 : 0];
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
        const c = data.status[code] || [0, 0, '', '', 0, 0];
        const n = [c[0] || 0, c[1] || 0, c[2] || '', c[3] || '', c[4] ? 1 : 0, c[5] ? 1 : 0];
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
        const img = h('img', { alt: `${label} ${col}`, src: entry.thumb, onerror: () => { if (entry.thumbBad) { entry.thumbFailed = true; entry.thumb = ''; repaintStore(code); return; } entry.thumbBad = true; entry.thumb = ''; thumbDB.del(entry.id); repairThumb(store, entry); repaintStore(code); } });
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
          const tiny = DEMO ? '' : await fitThumb(blob).catch(() => ''); // 서버가 사진에 붙여 영구 보관하도록 작은 사진을 함께 보낸다(1만 8천 자 이하)
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
        h('a', { class: 'back', href: nav.back, onclick: () => { if (nav.back === '#/') home.q = ''; } }, nav.back === '#/' ? '‹ 처음' : '‹ 목록'),
        h('h1', { class: 'store-name', text: store.name }),
        h('p', { class: 'sub', text: [store.team, store.sv && `${store.sv} 담당`].filter(Boolean).join(' ') }),
        progress, confirmRow, improveBtn),
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
        h('div', { class: 'loghead', 'aria-hidden': 'true' }, ['이름', '로그인 시각', 'IP', '구분', '결과'].map((t) => h('span', { text: t }))),
        h('ul', { class: 'loglist' }, rows.length ? rows.map(logRow) : h('li', { class: 'empty', text: '기록이 없어요.' })),
        h('p', { class: 'fine', text: '사내망은 등록한 회사 IP 기준으로 구분해요. 접속 위치는 기록하지 않아요.' }));
    }
    paint();
  }

  // ---------- 업로드 이력 (김규민, 오형철 계정에서만) ----------
  // 시트·깃허브에는 남기지 않고 서버 안에만 있는 이력을 보여준다. 행: [시각, 점포 식별값, 점포명, 'b'(기존)/'a'(개선), 항목, 올린 사람]
  let upToken = 0;
  async function renderUploads() {
    document.title = '업로드 이력 | 빽다방 홍보물 취합';
    const token = ++upToken;
    const back = h('a', { class: 'back', href: '#/', onclick: () => { home.q = ''; } }, '‹ 처음');
    const shell = (...kids) => { if (token === upToken) view.replaceChildren(h('div', { class: 'wrap' }, back, h('h1', { class: 'page-title', text: '업로드 이력' }), ...kids)); };
    const denied = () => {
      if (token !== upToken) return;
      view.replaceChildren(h('div', { class: 'wrap' }, back, h('div', { class: 'denied' },
        h('span', { class: 'lockc', 'aria-hidden': 'true', html: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' }),
        h('h1', { text: '볼 수 없는 화면이에요' }),
        h('p', { text: '업로드 이력은 김규민, 오형철 계정에서만 볼 수 있어요.' }))));
    };
    if (!canLog()) { denied(); return; }
    shell(loadingBlock('업로드 이력을 불러오는 중이에요'));
    let json;
    try { json = await getJson({ action: 'uploads' }); }
    catch { shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }
    if (token !== upToken) return;
    if (!json.ok) { if (json.error === 'not_allowed') denied(); else shell(h('p', { class: 'empty', text: '불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.' })); return; }

    let kind = '전체', q = '', shown = 50;
    const label = (slot) => (slot ? slotLabel(slot) : '항목 미상');
    const stat = (k, v) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: String(v) }));
    const input = h('input', { type: 'search', class: 'upsearch', placeholder: '점포명이나 올린 사람으로 찾기', autocomplete: 'off', 'aria-label': '업로드 이력 검색' });
    const listHost = h('div', {});
    const upRow = (e) => {
      const exists = data.byCode.has(e[1]);
      const cells = [
        h('div', { class: 'utime', text: fmtDate(new Date(e[0]).toISOString()) }),
        h('div', { class: 'ustore', text: e[2] || e[1] }),
        h('div', { class: 'uwhat' }, h('i', { class: `bd ${e[3] === 'a' ? 'dark' : 'soft'}`, text: e[3] === 'a' ? '개선' : '기존' }), h('span', { text: label(e[4]) })),
        h('div', { class: 'uwho', text: e[5] }),
      ];
      return h('li', {}, exists ? h('a', { class: 'uprow', href: `#/store/${enc(e[1])}` }, ...cells) : h('div', { class: 'uprow', role: 'group' }, ...cells));
    };
    function paintList() {
      const text = norm(q);
      const rows = json.rows.filter((e) => (kind === '전체' || (kind === '개선' ? e[3] === 'a' : e[3] === 'b'))
        && (!text || norm(e[2]).includes(text) || norm(e[5]).includes(text) || norm(label(e[4])).includes(text)));
      listHost.replaceChildren(
        h('p', { class: 'meta-line', text: `${rows.length}장` }),
        h('div', { class: 'uphead', 'aria-hidden': 'true' }, ['올린 시각', '점포', '구분 · 항목', '올린 사람'].map((t) => h('span', { text: t }))),
        h('ul', { class: 'uplist' }, rows.length ? rows.slice(0, shown).map(upRow) : h('li', { class: 'empty', text: '이력이 없어요.' })),
        rows.length > shown ? h('button', { type: 'button', class: 'btn ghost block more', onclick: () => { shown += 50; paintList(); } }, `더 보기 (${rows.length - shown}장 남음)`) : null);
    }
    input.addEventListener('input', () => { q = input.value.trim(); shown = 50; paintList(); });
    const segs = h('div', { class: 'segs inline', role: 'group', 'aria-label': '구분', style: '--n:3' },
      ['전체', '기존', '개선'].map((n) => h('button', { type: 'button', class: n === '전체' ? 'segb on' : 'segb', 'aria-pressed': String(n === '전체'), onclick: (ev) => {
        kind = n; shown = 50;
        segs.querySelectorAll('.segb').forEach((b) => { const on = b.textContent === n; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        paintList();
      } }, n)));
    shell(
      h('p', { class: 'meta-line', text: '김규민, 오형철 계정에서만 보여요' }),
      h('div', { class: 'stats' }, stat('오늘 올린 사진', json.stats.today), stat('최근 7일', json.stats.week), stat('오늘 올린 사람', json.stats.people)),
      h('label', { class: 'upsearchwrap' }, input),
      segs, listHost,
      h('p', { class: 'fine', text: `업로드 이력은 구글 시트·드라이브·깃허브에 남기지 않고 서버 안에만 최근 ${json.keep || 1500}장까지 보관해요.` }));
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
          h('span', { class: 'pn', text: `${o[k]}곳` }),
          h('span', { class: 'pp', text: pctText(o[k], o.total) }),
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
    if (hash === '#/uploads') { renderUploads(); window.scrollTo(0, 0); return; }
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
