'use strict';

const ICON = {
  up: ['...o...', '..ooo..', '.ooooo.', 'ooooooo'],
  down: ['ooooooo', '.ooooo.', '..ooo..', '...o...'],
  x: ['o...o', '.o.o.', '..o..', '.o.o.', 'o...o'],
  ck: ['.....', '....o', 'o..o.', '.oo..', '..o..'],
};
const icon = function (c, name, x, y, col) { const g = ICON[name]; c.drawImage(bake('ic' + name + col, g[0].length, g.length, g, { o: col }), x, y); };

let uctx = context2d(uc);
const U = { u: 2, W: 0, H: 0 };
const newDrag = (id, pid, y, order) => ({ id, pid, y0: y, y, order, moved: false });
const UI = { settings: false, tour: TYPE_ONLY ? newTour() : null, drag: TYPE_ONLY ? newDrag('', 0, 0, ['']) : null, scroll: 0, items: TYPE_ONLY ? [{ id: '', kind: '', x: 0, y: 0, w: 0, h: 0 }] : [], geo: TYPE_ONLY ? { x: 0, y: 0, w: 0, h: 0, ix: 0, iw: 0, listY: 0, rows: 0, n: 0, rooms: [{ id: '', label: '' }], optY: 0, speedY: 0, soundY: 0, resetY: 0 } : null, dialog: TYPE_ONLY ? { x: 0, y: 0, w: 0, h: 0, lines: [''] } : null, strip: TYPE_ONLY ? { x: 0, y: 0, w: 0, h: 0 } : null, dirty: true, focusId: '', refocus: TYPE_ONLY ? '' : null };
const RH = 13;

const CONF = ['#ef7d57', '#ffcd75', '#a7f070', '#73eff7', '#b86fd1', '#f4f4f4', '#41a6f6', '#b13e53'];

const uiMeasure = function () {
  const dpr = window.devicePixelRatio || 1;
  const devW = Math.max(1, stageEl.clientWidth * dpr), devH = Math.max(1, stageEl.clientHeight * dpr);
  const u = Math.max(S.s, Math.ceil(2 * dpr - 1e-6));
  U.u = u; U.W = Math.max(120, Math.floor(devW / u)); U.H = Math.max(120, Math.floor(devH / u));
  uc.width = U.W; uc.height = U.H;
  uctx = context2d(uc);
  uctx.imageSmoothingEnabled = false;
  const cw = U.W * u / dpr, ch = U.H * u / dpr;
  uc.style.width = cw + 'px'; uc.style.height = ch + 'px';
  uiEl.style.width = cw + 'px'; uiEl.style.height = ch + 'px';
  UI.dirty = true;
};

const uR = (x, y, w, h, col) => R(uctx, x, y, w, h, col);
const uT = (t, x, y, col, sm) => text(uctx, t, x, y, col, sm);

const wrapText = function (t, cols) {
  const lines = [];
  let cur = '';
  for (const w of t.split(' ')) {
    if (cur && cur.length + 1 + w.length > cols) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
};

const roomList = () => S.rooms.map((r) => ({ id: r.id, label: r.label }));
const listIds = () => S.rooms.map((r) => r.id);

const uiLayout = function () {
  const items = [], W = U.W, H = U.H;
  UI.dialog = null; UI.strip = null; UI.geo = null;
  let floorY = H - 4;
  const T = UI.tour;
  if (T) {
    const bw = Math.min(W - 8, 320), cols = Math.max(10, Math.floor((bw - 46) / 6));
    const lines = wrapText(T.text, cols);
    const bh = Math.max(50, 14 + lines.length * 9 + 18);
    const cb = Math.ceil(cv.getBoundingClientRect().bottom * (window.devicePixelRatio || 1) / U.u) + 6;
    const bx = (W - bw) >> 1, by = Math.min(H - bh - 4, Math.max(cb, 4));
    UI.dialog = { x: bx, y: by, w: bw, h: bh, lines };
    floorY = by - 4;
    if (T.step === 2) UI.strip = { x: (W - Math.min(W - 8, 190)) >> 1, y: by - 4 - 66, w: Math.min(W - 8, 190), h: 66 };
  }
  if (UI.settings) {
    const rooms = roomList(), n = rooms.length;
    const pw = Math.min(W - 8, 252), fixed = 15 + 22 + 5 + 9 + 4 + 4 * 13 + 4 + 15 + 7;
    const room = floorY - 8 - fixed;
    const maxRows = clamp(Math.floor(room / RH), 3, Math.max(3, n));
    const rows = Math.max(1, Math.min(n, maxRows));
    UI.scroll = clamp(UI.scroll, 0, Math.max(0, n - rows));
    const ph = fixed + rows * RH;
    const px0 = (W - pw) >> 1, py0 = T ? 4 : Math.max(4, Math.floor((floorY - ph) / 2));
    const ix = px0 + 6, iw = pw - 12;
    const g = { x: px0, y: py0, w: pw, h: ph, ix, iw, listY: py0 + 15 + 22, rows, n, rooms, optY: 0, speedY: 0, soundY: 0, resetY: 0 };
    UI.geo = g;
    if (!T) items.push({ id: 'scrim', kind: 'scrim', label: 'Close settings', x: 0, y: 0, w: W, h: H, tab: -1 });
    items.push({ id: 'blocker:panel', kind: 'blocker', x: px0, y: py0, w: pw, h: ph, tab: -1 });
    items.push({ id: 'close', kind: 'close', label: 'Close settings', x: px0 + pw - 14, y: py0 + 3, w: 11, h: 11 });
    for (let i = 0; i < rows; i++) {
      const r = rooms[UI.scroll + i];
      if (!r) break;
      const ry = g.listY + i * RH;
      items.push({ id: 'row:' + r.id, kind: 'row', rid: r.id, label: r.label + ', floor priority ' + (UI.scroll + i + 1) + ' of ' + n + '. Arrow keys move it.', x: ix, y: ry, w: iw - 24, h: RH - 1 });
      items.push({ id: 'up:' + r.id, kind: 'up', rid: r.id, label: 'Move ' + r.label + ' up', x: ix + iw - 22, y: ry + 1, w: 10, h: RH - 3 });
      items.push({ id: 'down:' + r.id, kind: 'down', rid: r.id, label: 'Move ' + r.label + ' down', x: ix + iw - 11, y: ry + 1, w: 10, h: RH - 3 });
    }
    let y = g.listY + rows * RH + 5 + 9;
    g.optY = y - 9;
    for (const [key, label] of [['anonymize', 'Anonymize room names'], ['titles', 'Show session titles']]) {
      items.push({ id: 'tg:' + key, kind: 'toggle', key, label, x: ix, y, w: iw, h: 12 });
      y += 13;
    }
    g.speedY = y;
    for (const v of [1, 2, 3]) items.push({ id: 'sp:' + v, kind: 'speed', v, label: 'Demo speed ' + v + 'x', x: ix + iw - 3 * 19 + (v - 1) * 19, y, w: 18, h: 12 });
    y += 13;
    items.push({ id: 'tg:sound', kind: 'toggle', key: 'sound', label: 'Sound (not available yet)', x: ix, y, w: iw, h: 12 });
    g.soundY = y;
    y += 13 + 4;
    items.push({ id: 'reset', kind: 'reset', label: 'Reset onboarding', x: ix, y, w: iw, h: 12 });
    g.resetY = y;
  }
  if (T && UI.dialog) {
    const d = UI.dialog, last = T.step === STEPS.length - 1;
    items.push({ id: 'blocker:dialog', kind: 'blocker', x: d.x, y: d.y, w: d.w, h: d.h, tab: -1 });
    const nw = 29;
    items.push({ id: 'next', kind: 'next', label: last ? 'Finish tour' : 'Next', x: d.x + d.w - 6 - nw, y: d.y + d.h - 15, w: nw, h: 11 });
    items.push({ id: 'skip', kind: 'skip', label: 'Skip tour', x: d.x + d.w - 6 - nw - 4 - 29, y: d.y + d.h - 15, w: 29, h: 11 });
  }
  UI.items = items;
};

const uiActive = function () { return !!(UI.settings || UI.tour || S.particles.length); };

const syncHit = function () {
  const prev = document.activeElement instanceof HTMLElement && hitEl.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const want = UI.refocus || prev;
  UI.refocus = null;
  hitEl.textContent = '';
  const k = U.u / (window.devicePixelRatio || 1);
  hitEl.setAttribute('role', UI.settings || UI.tour ? 'dialog' : 'presentation');
  hitEl.setAttribute('aria-label', UI.tour ? 'Office tour' : 'Settings');
  for (const it of UI.items) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'hb'; b.dataset.id = it.id; b.dataset.kind = it.kind;
    const pad = it.kind === 'up' || it.kind === 'down' || it.kind === 'close' ? 1 : 0;
    b.style.left = (it.x - pad) * k + 'px'; b.style.top = (it.y - pad) * k + 'px'; b.style.width = (it.w + 2 * pad) * k + 'px'; b.style.height = (it.h + 2 * pad) * k + 'px';
    if (it.tab === -1) { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); } else b.setAttribute('aria-label', it.label);
    if (it.kind === 'toggle') { b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!S.set[it.key])); }
    if (it.kind === 'speed') b.setAttribute('aria-pressed', String(S.set.speed === it.v));
    if (it.kind === 'row') wireRow(b, it);
    else b.addEventListener('click', () => act(it));
    hitEl.appendChild(b);
  }
  if (want) {
    const el = hitEl.querySelector('[data-id="' + CSS.escape(want) + '"]');
    if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  }
};

hitEl.addEventListener('focusin', (e) => { const t = e.target; UI.focusId = t instanceof HTMLElement && t.matches(':focus-visible') ? t.dataset.id ?? '' : ''; });
hitEl.addEventListener('focusout', () => { UI.focusId = ''; });
hitEl.addEventListener('wheel', (e) => {
  if (!UI.geo || UI.geo.n <= UI.geo.rows) return;
  UI.scroll = clamp(UI.scroll + (e.deltaY > 0 ? 1 : -1), 0, UI.geo.n - UI.geo.rows);
  UI.dirty = true;
  e.preventDefault();
}, { passive: false });

const logicalY = (e) => { const r = uc.getBoundingClientRect(); return (e.clientY - r.top) * U.H / r.height; };

const wireRow = function (b, it) {
  b.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    const y = logicalY(e);
    UI.drag = newDrag(it.rid, e.pointerId, y, listIds());
    try { b.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  b.addEventListener('pointermove', (e) => {
    const D = UI.drag;
    if (!D || e.pointerId !== D.pid) return;
    D.y = logicalY(e);
    if (Math.abs(D.y - D.y0) > 3) D.moved = true;
    if (!D.moved || !UI.geo) return;
    const idx = clamp(Math.floor((D.y - UI.geo.listY) / RH) + UI.scroll, 0, D.order.length - 1);
    const cur = D.order.indexOf(D.id);
    if (idx !== cur) { D.order.splice(cur, 1); D.order.splice(idx, 0, D.id); }
  });
  const end = (e) => {
    const D = UI.drag;
    if (!D || e.pointerId !== D.pid) return;
    UI.drag = null;
    UI.dirty = true;
    if (e.type === 'pointerup' && D.moved && D.order.join() !== listIds().join()) setOrder(D.order);
  };
  b.addEventListener('pointerup', end);
  b.addEventListener('pointercancel', end);
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveRoom(it.rid, e.key === 'ArrowUp' ? -1 : 1, 'row:'); }
  });
};

const setOrder = function (ids) {
  const full = [...ids, ...S.set.order.filter((x) => !ids.includes(x))].slice(0, 64);
  saveSet({ order: full });
  if (S.last) {
    const byId = new Map(S.last.rooms.map((r) => [r.id, r]));
    S.last = { ...S.last, rooms: ids.map((id) => byId.get(id)).filter(Boolean) };
    applyState(S.last);
  }
  const T = UI.tour;
  if (T && T.step === 3 && !T.did) {
    T.did = true; T.text = stepText(3); T.t0 = S.t;
    burst(40, U.W / 2, 40);
    BS.react = S.t;
  }
  UI.dirty = true;
};

const moveRoom = function (id, d, focusKind) {
  const ids = listIds(), i = ids.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  UI.refocus = (focusKind || (d < 0 ? 'up:' : 'down:')) + id;
  setOrder(ids);
  if (UI.geo) {
    if (j < UI.scroll) UI.scroll = j;
    else if (j >= UI.scroll + UI.geo.rows) UI.scroll = j - UI.geo.rows + 1;
  }
};

const act = function (it) {
  if (it.kind === 'scrim' || it.kind === 'close') closeSettings();
  else if (it.kind === 'up') moveRoom(it.rid, -1);
  else if (it.kind === 'down') moveRoom(it.rid, 1);
  else if (it.kind === 'toggle') {
    saveSet({ [it.key]: !S.set[it.key] });
    if (!SERVER && S.last && it.key !== 'sound') applyState(S.last);
    UI.dirty = true;
  } else if (it.kind === 'speed') { saveSet({ speed: it.v }); UI.dirty = true; }
  else if (it.kind === 'reset') resetOnboarding();
  else if (it.kind === 'next') tourNext();
  else if (it.kind === 'skip') tourFinish(true);
};

const openSettings = function () {
  UI.settings = true; UI.scroll = 0; UI.dirty = true;
  UI.refocus = S.rooms.length ? 'row:' + S.rooms[0].id : 'close';
  gearEl.setAttribute('aria-expanded', 'true');
};
const closeSettings = function () {
  UI.settings = false; UI.drag = null; UI.dirty = true;
  gearEl.setAttribute('aria-expanded', 'false');
  if (!UI.tour) { try { gearEl.focus({ preventScroll: true }); } catch {} }
};
gearEl.addEventListener('click', () => { if (UI.settings) closeSettings(); else openSettings(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (UI.tour) tourFinish(true); else if (UI.settings) closeSettings();
});

const burst = function (n, x, y) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 30 + Math.random() * 90;
    S.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, col: CONF[i % CONF.length], life: 1.2 + Math.random() * 0.8, sz: Math.random() < 0.3 ? 3 : 2 });
  }
  UI.dirty = true;
};

const framePx = function (x, y, w, h, title) {
  uR(x, y, w, h, '0');
  uR(x + 1, y + 1, w - 2, h - 2, 'e');
  uR(x + 1, y + 1, w - 2, 1, 'd'); uR(x + 1, y + 1, 1, h - 2, 'd');
  uR(x + 1, y + h - 2, w - 2, 1, 'f'); uR(x + w - 2, y + 1, 1, h - 2, 'f');
  uR(x + 3, y + 3, w - 6, 11, '9'); uR(x + 3, y + 3, w - 6, 1, 'a'); uR(x + 3, y + 13, w - 6, 1, '8');
  uT(title, x + 7, y + 5, '#1a1c2c'); uT(title, x + 6, y + 4, '#f4f4f4');
  uR(x + 3, y + 14, w - 6, h - 17, '#1a1c2c'); uR(x + 3, y + 14, w - 6, 1, '#0f1020');
};

const ring = function (it) {
  if (UI.focusId !== it.id) return;
  uctx.fillStyle = '#ffcd75';
  uctx.fillRect(it.x - 1, it.y - 1, it.w + 2, 1); uctx.fillRect(it.x - 1, it.y + it.h, it.w + 2, 1);
  uctx.fillRect(it.x - 1, it.y, 1, it.h); uctx.fillRect(it.x + it.w, it.y, 1, it.h);
};

const button = function (it, col, tcol, label) {
  uR(it.x, it.y, it.w, it.h, '0');
  uR(it.x + 1, it.y + 1, it.w - 2, it.h - 2, col);
  uR(it.x + 1, it.y + 1, it.w - 2, 1, 'rgba(255,255,255,0.3)');
  uR(it.x + 1, it.y + it.h - 2, it.w - 2, 1, 'rgba(0,0,0,0.3)');
  uT(label, it.x + Math.floor((it.w - textW(label)) / 2), it.y + Math.floor((it.h - 7) / 2), tcol);
  ring(it);
};

const drawPanel = function () {
  const g = UI.geo;
  if (!g) return;
  framePx(g.x, g.y, g.w, g.h, 'SETTINGS');
  const cl = UI.items.find((i) => i.kind === 'close');
  if (!cl) return;
  uR(cl.x, cl.y, cl.w, cl.h, '0'); uR(cl.x + 1, cl.y + 1, cl.w - 2, cl.h - 2, '2');
  icon(uctx, 'x', cl.x + 3, cl.y + 3, '#f4f4f4');
  ring(cl);
  uT('FLOOR PRIORITY', g.ix, g.y + 18, '#ffcd75');
  uT('TOP FLOOR IS SERVED FIRST', g.ix, g.y + 27, '#94b0c2');
  const D = UI.drag, order = D ? D.order : listIds();
  const label = new Map(roomList().map((r) => [r.id, r.label]));
  if (!order.length) { uT('NO PROJECTS YET', g.ix + 4, g.listY + 3, '#566c86'); }
  const drawRow = (id, ry, floating) => {
    const i = order.indexOf(id), it = UI.items.find((x) => x.id === 'row:' + id);
    const rowW = g.iw;
    uR(g.ix, ry, rowW, RH - 1, floating ? '#3b5dc9' : i % 2 ? '#333c57' : '#29366f');
    const wc = wallColors(id)[0];
    uR(g.ix, ry, 2, RH - 1, wc);
    for (let a = 0; a < 3; a++) { uR(g.ix + 5, ry + 3 + a * 3, 2, 1, '#94b0c2'); uR(g.ix + 8, ry + 3 + a * 3, 2, 1, '#94b0c2'); }
    uT(String(i + 1), g.ix + 13, ry + 3, '#ffcd75');
    const maxc = Math.max(3, Math.floor((rowW - 26 - 26) / 6));
    const nm = fitLine(fold(label.get(id) || ''), maxc * 6 - 1);
    uT(nm.t, g.ix + 13 + (order.length > 9 ? 17 : 11), ry + 3 + (nm.sm ? 1 : 0), '#f4f4f4', nm.sm);
    if (it) ring(it);
    if (floating) { uctx.fillStyle = '#ffcd75'; uctx.fillRect(g.ix, ry, rowW, 1); uctx.fillRect(g.ix, ry + RH - 2, rowW, 1); }
  };
  const vis = Math.min(g.rows, Math.max(0, order.length - UI.scroll));
  for (let v = 0; v < vis; v++) {
    const idx = UI.scroll + v, id = order[idx], ry = g.listY + v * RH;
    if (D && D.moved && D.id === id) { uR(g.ix, ry, g.iw, RH - 1, '#0f1020'); continue; }
    drawRow(id, ry, false);
    const upI = UI.items.find((x) => x.id === 'up:' + id), dnI = UI.items.find((x) => x.id === 'down:' + id);
    for (const { bi, nm, dis } of [{ bi: upI, nm: 'up', dis: idx === 0 }, { bi: dnI, nm: 'down', dis: idx === order.length - 1 }]) {
      if (!bi) continue;
      uR(bi.x, bi.y, bi.w, bi.h, '0'); uR(bi.x + 1, bi.y + 1, bi.w - 2, bi.h - 2, dis ? '#1a1c2c' : '#566c86');
      icon(uctx, nm, bi.x + 1, bi.y + 3, dis ? '#333c57' : '#f4f4f4');
      ring(bi);
    }
  }
  if (g.n > g.rows) {
    const th = Math.max(6, Math.floor(g.rows * RH * g.rows / g.n)), ty = g.listY + Math.floor((g.rows * RH - th) * (UI.scroll / (g.n - g.rows)));
    uR(g.ix + g.iw + 1, g.listY, 2, g.rows * RH, '#333c57'); uR(g.ix + g.iw + 1, ty, 2, th, '#ffcd75');
  }
  if (D && D.moved) {
    const ry = clamp(D.y - 6, g.listY - 2, g.listY + (g.rows - 1) * RH + 2);
    drawRow(D.id, Math.round(ry), true);
  }
  uT('OPTIONS', g.ix, g.optY, '#ffcd75');
  uR(g.ix + 46, g.optY + 3, g.iw - 46, 1, '#333c57');
  for (const it of UI.items) {
    if (it.kind === 'toggle') {
      uR(it.x, it.y + 1, 9, 9, '#94b0c2'); uR(it.x + 1, it.y + 2, 7, 7, S.set[it.key] ? '#38b764' : '#1a1c2c');
      if (S.set[it.key]) icon(uctx, 'ck', it.x + 2, it.y + 3, '#f4f4f4');
      const name = it.key === 'anonymize' ? 'ANONYMIZE ROOMS' : it.key === 'titles' ? 'SHOW SESSION TITLES' : 'SOUND';
      uT(name, it.x + 13, it.y + 2, '#f4f4f4');
      if (it.key === 'sound') uT(S.set.sound ? 'ON' : 'OFF', it.x + it.w - 4 - textW(S.set.sound ? 'ON' : 'OFF') - 0, it.y + 2, '#566c86');
      ring(it);
    } else if (it.kind === 'speed') {
      const on = S.set.speed === it.v;
      button(it, on ? '#ffcd75' : '#333c57', on ? '#1a1c2c' : '#d6d6e0', it.v + 'X');
    } else if (it.kind === 'reset') button(it, '#b13e53', '#f7e6bd', 'RESET ONBOARDING');
  }
  uT('DEMO SPEED', g.ix + 13 + 0, g.speedY + 2, '#f4f4f4');
};

const drawUi = function (t) {
  uctx.clearRect(0, 0, U.W, U.H);
  if (UI.settings) drawPanel();
  if (UI.tour) { drawStrip(t); drawDialog(t); }
  for (const p of S.particles) { uctx.fillStyle = p.col; uctx.fillRect(Math.round(p.x), Math.round(p.y), p.sz, p.sz); }
};

const stepUi = function (dt) {
  if (S.anim) {
    const k = (S.t - S.anim.t0) / S.anim.dur;
    S.anim.p = ease(clamp(k, 0, 1));
    S.anim.ps = ease(clamp(k / 0.6, 0, 1));
    S.anim.pf = S.anim.out.length ? ease(clamp((k - 0.4) / 0.6, 0, 1)) : S.anim.p;
    if (k >= 1) { if (S.anim.keepH > S.LH) setCanvasH(S.LH); S.anim = null; S.fc = null; S.bgCv = null; E.fid = null; }
  }
  const T = UI.tour;
  if (T) T.shown = Math.min(T.text.length, Math.floor((S.t - T.t0) * TYPE_CPS));
  if (S.particles.length) {
    for (const p of S.particles) { p.vy += 140 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    S.particles = S.particles.filter((p) => p.life > 0 && p.y < U.H + 4);
    if (!S.particles.length) UI.dirty = true;
  }
};

const wasActive = { v: false };
const renderUi = function (t) {
  if (UI.dirty && !UI.drag) { uiLayout(); syncHit(); UI.dirty = false; }
  const on = uiActive();
  if (on !== wasActive.v) { wasActive.v = on; uiEl.classList.toggle('on', on); }
  if (on) drawUi(t);
};
