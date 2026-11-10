(() => {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.endpoint;
  const KIND = { before: '현재 상태', after: '개선 후' };
  const PAGE = 30;
  const MAX = cfg.maxPerKind || 3; // 점포당 현재 상태·개선 후 각각 최대 장수

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

  const stat = (code) => {
    const v = data.status[code];
    return { before: v ? Number(v[0]) || 0 : 0, after: v ? Number(v[1]) || 0 : 0, folder: v && v[3] ? v[3] : '' };
  };

  // ---------- 볼 수 있는 점포 ----------
  // 직원: 본인 담당 점포만. 관리자: 모든 팀(팀 칸에서 골라 들어간다).
  const isManager = () => !!me && me.role === '관리자';
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
  const done = (s) => { const t = stat(s.code); return t.before && t.after; };

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
    const n = (s) => { const t = stat(s.code); return (t.before ? 1 : 0) + (t.after ? 1 : 0); };
    return [...list].sort((a, b) => n(a) - n(b) || a.name.localeCompare(b.name, 'ko'));
  }

  // ---------- 로그인: 접속 코드 하나로 들어온다 ----------
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
    const form = h('form', { class: 'gate-form', onsubmit: (e) => { e.preventDefault(); ls.set('accessCode', input.value.trim()); start(); } },
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
    return h('li', {}, h('a', { class: 'row', href: `#/store/${enc(s.code)}`, 'aria-label': `${s.name}, 현재 상태 ${t.before ? t.before + '장' : '없음'}, 개선 후 ${t.after ? t.after + '장' : '없음'}` },
      h('span', { class: 'name', text: s.name }),
      sub ? h('span', { class: 'sub', text: sub }) : null,
      h('span', { class: 'marks' },
        h('i', { class: t.before ? 'mk on' : 'mk', text: '현재' }),
        h('i', { class: t.after ? 'mk on' : 'mk', text: '개선' }))));
  }

  function externalLink(label, href) {
    return h('a', { class: 'btn ghost small', href, target: '_blank', rel: 'noopener' }, label);
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

    function team(key, label, pool, own) {
      const total = pool.length;
      const finished = pool.filter(done).length;
      return h('a', { class: `team${key === 'all' ? ' wide' : ''}`, href: `#/list/${enc(key)}`, 'aria-label': `${label}, ${total}곳 중 ${finished}곳 완료` },
        h('span', { class: 't' }, label, own ? h('em', { text: '내 팀' }) : null),
        h('span', { class: 'n', text: `${total}곳` }),
        h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `--p:${total ? finished / total : 0}` })),
        h('span', { class: 'd', text: `완료 ${finished}곳` }));
    }

    function paintCards() {
      const cards = [];
      if (isManager()) {
        teamList().forEach((t) => cards.push(team(t, t, listPool(t), me.team === t)));
        cards.push(team('all', '전체', data.stores, false));
      } else {
        cards.push(team('mine', '내 담당 점포', mine(), false));
      }
      const parts = [h('div', { class: 'teams' }, cards)];
      if (isManager() && (data.links.sheet || data.links.folder)) {
        parts.push(h('div', { class: 'shortcuts' },
          data.links.sheet ? externalLink('취합 시트 열기', data.links.sheet) : null,
          data.links.folder ? externalLink('드라이브 폴더 열기', data.links.folder) : null));
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
    view.replaceChildren(h('div', { class: 'wrap' },
      h('a', { class: 'back', href: '#/' }, '‹ 처음'),
      h('h1', { class: 'page-title', text: listTitle(key) }),
      h('p', { class: 'meta-line', text: `${pool.length}곳 중 ${left}곳을 아직 못 올렸어요` }),
      list, more));
  }

  // ---------- 올린 사진 (구글 드라이브에서 불러와 계속 보여준다) ----------
  const photoBook = new Map(); // 점포 식별값 -> { before: [], after: [], loaded, loading }
  const book = (code) => { if (!photoBook.has(code)) photoBook.set(code, { before: [], after: [], loaded: false, loading: false }); return photoBook.get(code); };
  let storeView = null; // 지금 열린 점포 화면이 갱신을 받는 곳

  async function loadPhotos(store) {
    const b = book(store.code);
    if (b.loaded || b.loading) return;
    b.loading = true;
    try {
      if (DEMO) {
        const all = localJson('demo-photos')[store.code] || {};
        b.before = all.before || []; b.after = all.after || [];
      } else {
        const json = await getJson({ action: 'photos', store: store.code, name: store.name });
        if (!json.ok) throw fail(json.error);
        for (const kind of ['before', 'after']) {
          const local = new Map(b[kind].map((e) => [e.id, e]));
          b[kind] = (json[kind] || []).map((e) => local.get(e.id) || e);
          b[kind].push(...[...local.values()].filter((e) => !(json[kind] || []).some((x) => x.id === e.id)));
        }
      }
      b.loaded = true;
    } catch { b.failed = true; }
    b.loading = false;
    if (storeView && storeView.code === store.code) storeView.paintGallery();
  }

  async function fetchImage(entry, action, field) {
    if (entry[field]) return entry[field];
    try {
      const json = await getJson({ action, id: entry.id });
      if (json.ok) entry[field] = `data:${json.mime};base64,${json.data}`;
    } catch { /* 못 불러오면 빈 칸으로 둔다 */ }
    return entry[field] || '';
  }

  // 작은 사진은 세 장씩만 동시에 요청한다
  const thumbQueue = [];
  let thumbActive = 0;
  function queueThumb(entry, img) {
    if (entry.thumb) { img.src = entry.thumb; return; }
    thumbQueue.push({ entry, img });
    pumpThumbs();
  }
  function pumpThumbs() {
    while (thumbActive < 3 && thumbQueue.length) {
      const { entry, img } = thumbQueue.shift();
      thumbActive += 1;
      fetchImage(entry, 'thumb', 'thumb').then((url) => { if (url) img.src = url; }).finally(() => { thumbActive -= 1; pumpThumbs(); });
    }
  }

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

  async function openPhoto(entry) {
    const dlg = lightbox();
    const img = $('img', dlg);
    img.src = entry.full || entry.thumb || '';
    $('.cap', dlg).textContent = [fmtDate(entry.t), entry.by].filter(Boolean).join('  ');
    dlg.showModal();
    if (!entry.full) { const url = await fetchImage(entry, 'photo', 'full'); if (url && dlg.open) img.src = url; }
  }

  // 방금 올린 사진을 목록에 바로 넣는다 (시험 모드에서는 이 기기에 저장해 새로 열어도 남는다)
  async function smallDataUrl(blob, edge = 720) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, edge / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.72);
  }

  async function remember(store, kind, blob, res) {
    const entry = { id: res.fileId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: res.fileName || '', t: new Date().toISOString(), by: me ? me.name : '', local: true };
    if (DEMO) {
      entry.thumb = entry.full = await smallDataUrl(blob);
      const all = localJson('demo-photos');
      const mineList = all[store.code] || { before: [], after: [] };
      mineList[kind].unshift({ ...entry, local: false });
      all[store.code] = mineList;
      ls.set('demo-photos', JSON.stringify(all)); // 가득 차면 이번 화면에서만 보인다
    } else {
      entry.thumb = entry.full = URL.createObjectURL(blob);
    }
    book(store.code)[kind].unshift(entry);
  }

  // ---------- 점포 ----------
  const up = { kind: 'before', files: [], busy: false, finished: null, enterPanel: false, notice: '' };
  const nav = { back: '#/' };

  function resetUpload(kind) {
    up.files.forEach((f) => f.url && URL.revokeObjectURL(f.url));
    Object.assign(up, { kind: kind || up.kind, files: [], busy: false, finished: null, enterPanel: false, notice: '' });
  }

  function renderStore(code) {
    const store = data.byCode.get(code);
    if (!store) { view.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'empty', text: '없는 점포예요.' }), h('a', { class: 'btn block', href: '#/', text: '처음으로' }))); return; }
    document.title = `${store.name} | 빽다방 홍보물 취합`;
    if (render.lastCode !== code) { resetUpload('before'); render.lastCode = code; }

    const root = h('div', { class: 'wrap' });
    const seg = h('div', { class: 'seg big', role: 'tablist', 'aria-label': '사진 종류' });
    const panelHost = h('div', {});
    const galleryHost = h('div', {});
    const dock = h('div', { class: 'dock' });
    const folder = isManager() ? (stat(code).folder || (DEMO ? data.links.folder : '')) : '';

    // 점포당 현재 상태·개선 후 각각 MAX장까지. 드라이브에서 불러온 목록이 있으면 그 장수가 기준
    const have = (kind) => { const b = book(code); return b.loaded ? b[kind].length : Math.max(stat(code)[kind], b[kind].length); };
    const room = () => Math.max(0, MAX - have(up.kind) - up.files.filter((f) => f.state !== 'done').length);

    function tab(kind) {
      const n = have(kind);
      return h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(up.kind === kind),
        onclick: () => { if (up.busy || up.kind === kind) return; resetUpload(kind); up.enterPanel = true; paint(); },
      }, h('b', { text: KIND[kind] }), h('small', { text: n >= MAX ? `${MAX}/${MAX}장 모두 올렸어요` : (n ? `${n}/${MAX}장 올렸어요` : '아직 없어요') }));
    }

    function paintGallery() {
      seg.replaceChildren(tab('before'), tab('after'));
      const b = book(code);
      const list = b[up.kind];
      if (!list.length) {
        galleryHost.replaceChildren(b.loading ? h('p', { class: 'hint', text: '올린 사진을 불러오는 중이에요' }) : '');
        return;
      }
      galleryHost.replaceChildren(h('section', { class: 'gallery', 'aria-label': `올린 ${KIND[up.kind]} 사진` },
        h('h2', { text: `올린 사진 ${list.length}장` }),
        h('ul', { class: 'thumbs' }, list.map((e) => {
          const img = h('img', { alt: '', loading: 'lazy' });
          queueThumb(e, img);
          return h('li', { class: 'thumb' }, h('button', { type: 'button', class: 'shot', 'aria-label': `올린 사진 크게 보기${e.t ? `, ${fmtDate(e.t)}` : ''}`, onclick: () => openPhoto(e) }, img));
        }))));
    }

    function paint() {
      const kind = up.kind;
      const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; } });
      const thumbs = h('ul', { class: 'thumbs' }, up.files.map((f, i) => h('li', { class: f.shown ? 'thumb' : 'thumb enter', 'data-state': f.state },
        h('img', { src: f.url, alt: `선택한 사진 ${i + 1}` }),
        f.state === 'idle' && !up.busy ? h('button', { type: 'button', class: 'x', 'aria-label': `사진 ${i + 1} 빼기`, onclick: () => removeFile(i), text: '×' }) : null,
        f.state !== 'idle' ? h('span', { class: 'st', text: ({ up: '올리는 중', done: '완료', error: '실패' })[f.state] }) : null)));
      up.files.forEach((f) => { f.shown = true; });

      const finished = up.finished && !up.finished.failed && up.finished.ok > 0;
      const full = !finished && have(kind) >= MAX && !up.files.length; // 이미 MAX장을 올린 상태
      const failedBox = up.finished && up.finished.failed;
      const panel = h('section', { class: up.enterPanel ? 'panel enter' : 'panel', 'aria-label': KIND[kind] },
        finished ? doneBox() : (full ? limitBox() : [
          h('p', { class: 'hint', text: `${kind === 'before' ? '고치기 전, 지금 붙어 있는 홍보물을 찍어 주세요.' : '교체하거나 고친 뒤의 모습을 찍어 주세요.'} 최대 ${MAX}장까지 올릴 수 있어요.` }),
          room() > 0 ? picker(fileInput) : null,
          up.notice ? h('p', { class: 'form-note', role: 'status', text: up.notice }) : null,
          up.files.length ? thumbs : null,
          failedBox ? h('p', { class: 'form-note', role: 'alert', text: up.finished.badCode
            ? '접속 코드가 맞지 않아 올리지 못했어요. 로그아웃한 뒤 코드를 다시 입력해 주세요.'
            : (up.finished.limit ? `이미 ${MAX}장을 모두 올려서 더 올릴 수 없어요.` : `${up.finished.failed}장을 올리지 못했어요. 연결을 확인하고 다시 눌러 주세요.`) }) : null,
        ]));
      up.enterPanel = false;
      panelHost.replaceChildren(panel);
      paintGallery();

      const pending = up.files.filter((f) => f.state !== 'done').length;
      if (finished || full) { dock.hidden = true; return; }
      dock.hidden = false;
      dock.replaceChildren(h('div', { class: 'wrap' },
        h('button', { type: 'button', class: 'btn primary block', disabled: !pending || up.busy, onclick: submit },
          up.busy ? '올리는 중' : pending ? `${pending}장 올리기` : '사진을 먼저 골라 주세요')));
    }

    // 사진 고르기 칸: 누르면 고르기, PC에서는 끌어다 놓기도 된다
    function picker(fileInput) {
      const el = h('label', { class: 'picker' }, fileInput,
        h('b', { text: up.files.length ? '사진 더 고르기' : '사진 찍기 또는 고르기' }),
        h('small', { text: `${room()}장 더 올릴 수 있어요` }),
        h('small', { class: 'drop-note', text: '사진을 여기로 끌어다 놓아도 돼요' }));
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag'));
      el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drag'); addFiles([...e.dataTransfer.files]); });
      return el;
    }

    function limitBox() {
      const canAfter = up.kind === 'before' && have('after') < MAX;
      return h('div', { class: 'done', role: 'status' },
        h('span', { class: 'check', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' }),
        h('h2', { text: `${KIND[up.kind]} 사진을 ${MAX}장 모두 올렸어요` }),
        h('div', { class: 'actions' },
          canAfter ? h('button', { type: 'button', class: 'btn primary block', onclick: () => { resetUpload('after'); up.enterPanel = true; paint(); } }, '개선 후 사진 올리기') : null,
          h('a', { class: canAfter ? 'btn ghost block' : 'btn primary block', href: nav.back }, '다른 점포 찾기')));
    }

    function doneBox() {
      const box = h('div', { class: 'done enter', role: 'status' },
        h('span', { class: 'check', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' }),
        h('h2', { text: `${KIND[up.kind]} 사진 ${up.finished.ok}장을 올렸어요` }),
        h('div', { class: 'actions' },
          up.kind === 'before' ? h('button', { type: 'button', class: 'btn primary block', onclick: () => { resetUpload('after'); up.enterPanel = true; paint(); } }, '개선 후 사진 올리기') : null,
          h('a', { class: up.kind === 'before' ? 'btn ghost block' : 'btn primary block', href: nav.back }, '다른 점포 찾기')));
      if (up.finished.shown) box.classList.remove('enter');
      up.finished.shown = true;
      return box;
    }

    function removeFile(i) { const [f] = up.files.splice(i, 1); URL.revokeObjectURL(f.url); paint(); }

    function addFiles(list) {
      const free = room();
      const imgs = list.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
      imgs.slice(0, free).forEach((file) => up.files.push({ file, url: URL.createObjectURL(file), state: 'idle' }));
      up.notice = imgs.length > free ? (free ? `${free}장만 더 올릴 수 있어서 앞의 ${free}장만 골랐어요.` : `이미 ${MAX}장을 모두 올렸어요.`) : '';
      up.finished = null;
      paint();
    }

    async function submit() {
      if (up.busy) return;
      up.busy = true; up.finished = null; paint();
      let failed = 0, badCode = false, limit = false;
      for (const f of up.files) {
        if (f.state === 'done') continue;
        f.state = 'up'; paint();
        try {
          const blob = await compress(f.file);
          const res = await sendPhoto(store, up.kind, f.file.name, blob);
          await remember(store, up.kind, blob, res || {});
          f.state = 'done';
          bump(code, up.kind);
        } catch (err) {
          f.state = 'error'; failed += 1;
          if (err && err.code === 'bad_code') { badCode = true; break; }
          if (err && err.code === 'limit') { limit = true; break; }
        }
        paint();
      }
      up.busy = false;
      if (limit) { book(code).loaded = false; loadPhotos(store); } // 드라이브의 실제 장수를 다시 불러온다
      up.finished = { ok: up.files.filter((f) => f.state === 'done').length, failed, badCode, limit };
      paint();
      const box = $('.done', panelHost);
      if (box) box.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }

    // 휴대폰: 위에서 아래로. PC: 왼쪽에 점포 정보와 탭, 오른쪽에 사진 올리기와 올린 사진
    root.append(
      h('a', { class: 'back', href: nav.back }, nav.back === '#/' ? '‹ 처음' : '‹ 목록'),
      h('div', { class: 'store-grid' },
        h('div', { class: 'store-side' },
          h('h1', { class: 'store-name', text: store.name }),
          h('p', { class: 'sub', text: [store.team, store.sv && `${store.sv} 담당`].filter(Boolean).join(' ') }),
          seg,
          folder ? h('div', { class: 'shortcuts side' }, externalLink('이 점포 드라이브 폴더 열기', folder)) : null),
        h('div', { class: 'store-main' }, panelHost, dock, galleryHost)));
    view.replaceChildren(root);
    storeView = { code, paintGallery };
    paint();
    loadPhotos(store);
  }

  function bump(code, kind) {
    const cur = data.status[code] || [0, 0, '', ''];
    const next = [cur[0] || 0, cur[1] || 0, new Date().toISOString(), cur[3] || ''];
    next[kind === 'before' ? 0 : 1] += 1;
    data.status[code] = next;
    if (DEMO) ls.set('demo-status', JSON.stringify(data.status));
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

  async function sendPhoto(store, kind, name, blob) {
    if (DEMO) { await new Promise((r) => setTimeout(r, 350)); return {}; }
    const payload = {
      action: 'upload', code: ls.get('accessCode'), uploader: me ? me.name : '',
      storeCode: store.code, storeName: store.name, kind,
      fileName: name, mime: 'image/jpeg', data: await toBase64(blob),
    };
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // text/plain 으로 보내면 브라우저 사전 확인 요청 없이 앱스 스크립트가 받는다
        const res = await fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
        const json = await res.json();
        if (json.ok) return json;
        lastErr = fail(json.error || 'upload_failed');
        if (json.error === 'bad_code') throw lastErr;
      } catch (err) { lastErr = err; if (err.code === 'bad_code') throw err; }
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    }
    throw lastErr;
  }

  // ---------- 라우터 ----------
  function render() {
    if (!me) return; // 로그인 전에는 로그인 화면만 보인다
    const hash = location.hash || '#/';
    let m = hash.match(/^#\/store\/(.+)$/);
    if (m) { renderStore(decodeURIComponent(m[1])); window.scrollTo(0, 0); return; }
    render.lastCode = null;
    storeView = null;
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
  async function start() {
    $('#demo-tag').hidden = !DEMO;
    view.replaceChildren(h('div', { class: 'wrap' }, h('p', { class: 'empty', text: '불러오는 중이에요' })));
    me = null;
    try { await loadData(); } catch (err) { me = null; renderGate(err); return; }
    if (!me) { renderGate(fail('bad_code')); return; }
    await loadStatus();
    mountWho();
    if (!routed) { window.addEventListener('hashchange', render); routed = true; }
    render();
  }
  start();
})();
