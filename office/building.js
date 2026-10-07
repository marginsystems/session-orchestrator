'use strict';

const cv = canvasById('cv');
let ctx = context2d(cv);
const withCtx = (c, fn) => { const p = ctx; ctx = c; try { fn(); } finally { ctx = p; } };
const stageEl = elementById('stage');
const wrapEl = elementById('wrap');
const gearEl = elementById('gear');
const uc = canvasById('uc');
const uiEl = elementById('ui');
const hitEl = elementById('hit');
const statEl = elementById('stat');
const stCv = document.createElement('canvas');
const stC = context2d(stCv);

const speech = (text, t0, lift = 0) => ({ text, t0, lift });

const newAgent = function (d) {
  return { id: d.id, name: d.name, state: d.state, sleepy: !!d.sleepy, room: d.room, fr: d.room, slot: -1, x: 0, sit: 1, facing: 1, phase: 0, walking: false, away: false, q: false, title: d.title || '', inCab: false, alpha: 1, bubble: TYPE_ONLY ? speech('', 0) : null, gone: false, visitor: false, hop: 0, react: -9, seed: hash(d.id), st: styleFor(d.id), boss: false, spd: 0, joining: false, leaving: false };
};

const BS = { react: -9, style: styleFor('boss', true) };
const B = { ...newAgent({ id: 'boss', name: 'Boss', state: 'working', room: BOSS }), st: BS.style, boss: true, fr: BOSS };
const BOSS_VISIT_TEXTS = ["HERE'S THE PLAN", "LET'S DO IT", 'GOT A MINUTE?'];
const SEC_STYLE = { boss: false, fur: { o: '#7a2c3d', b: '#f4b6c2', s: '#d9778f', l: '#ffe5ea' }, acc: '#1a1c2c', ear: 'cat', accKind: 'glasses', screen: 0, key: 'secretary' };
const SEC = { t0: -9, fake: { seed: 5, state: 'working', hop: 0, react: -9, sleepy: false, sit: 1, boss: true } };

const newAnim = (t0, from, slide, out, keepH) => ({ t0, dur: out.length ? 0.9 : 0.8, from: new Map(from.map((id, i) => [id, i])), p: 0, pf: 0, ps: 0, slide, out, keepH });

const S = { rooms: TYPE_ONLY ? [{ id: '', label: '' }] : [], floors: [BOSS, LOBBY], agents: new Map(TYPE_ONLY ? [['', B]] : []), slots: new Map(TYPE_ONLY ? [['', ['']]] : []), Hf: 70, s: 2, dpr: 1, LW: 380, LH: 300, t: 0, dt: 0.07, dim: 0, sig: '', tasks: TYPE_ONLY ? [{ gen: wait(0), done: false }] : [], vid: 0, sky: 'day', counts: { working: 0, waiting: 0, idle: 0 }, msg: '', focus: TYPE_ONLY ? { token: '', agentId: '' } : null, frames: 0, dyn: { coffees: TYPE_ONLY ? [{ id: '', x: 0, dy: 0 }] : [] }, set: { ...DEF_SET }, last: TYPE_ONLY ? { rooms: [{ id: '', label: '' }] } : null, queue: TYPE_ONLY ? [''] : [], queueSize: 0, want: TYPE_ONLY ? [''] : [], anim: TYPE_ONLY ? newAnim(0, [], [], [], 0) : null, fc: TYPE_ONLY ? new Map([['', stCv]]) : null, bgCv: TYPE_ONLY ? stCv : null, posting: 0, wall: new Map(), visits: TYPE_ONLY ? [''] : [], visitLog: TYPE_ONLY ? [{ id: '', agentAway: false, agentBubble: false, answered: false }] : [], drops: new Map(), puffs: TYPE_ONLY ? [{ x: 0, y: 0, t0: 0 }] : [], joined: new Set(), firstApplied: false, gotState: false, setReady: false, particles: TYPE_ONLY ? [{ x: 0, y: 0, vx: 0, vy: 0, col: '', life: 0, sz: 0 }] : [] };
const E = { fy: 0, open: 0, moving: false, queue: TYPE_ONLY ? [{ a: B, fromRoom: '', toRoom: '', state: '' }] : [], rider: TYPE_ONLY ? B : null, use: new Map(), ding: TYPE_ONLY ? { f: 0, t0: 0 } : null };

const T0 = () => (HUD ? HUDH : 0) + ROOFH;
const fIdxN = (id) => { const i = S.floors.indexOf(id); return i < 0 ? S.floors.length - 1 : i; };
const fIdx = (id) => {
  const i = fIdxN(id);
  if (!S.anim) return i;
  const f = S.anim.from.get(id);
  return f === undefined ? i : lerp(f, i, S.anim.pf);
};
const floorTop = (i) => Math.round(T0() + i * S.Hf);
const footY = (i) => floorTop(i) + S.Hf - FB;
const EXC = () => S.LW - BM - 2 - SHAFT / 2;
const zl = () => BM + LABW + 4;
const zr = () => S.LW - BM - SHAFT - 8;
const cellsFor = (rid) => Math.max(3, (S.slots.get(rid) || []).length);
const pitchOf = (rid) => (zr() - zl()) / cellsFor(rid);
const slotX = (rid, k) => Math.round(zl() + pitchOf(rid) * (k + 0.5) - 12);
const cabH = () => Math.min(38, S.Hf - FB - 10);
const cabFoot = () => T0() + ((S.anim && E.fid && !E.moving ? fIdx(E.fid) : E.fy) + 1) * S.Hf - FB;
const bossX = () => Math.round(zl() + (zr() - zl()) * 0.26);
const bossSpot = () => bossX() + 5 + BOSS_DESK_W + 10;
const hallW = () => clamp(Math.floor((zr() - bossSpot() - 34) * 0.6), 100, 160);
const doorX = () => zr() - hallW();
const lineCap = () => Math.max(2, Math.floor((hallW() - 46) / 13));
const lineX = (k) => doorX() + 44 + k * 13;
const secX = () => doorX() + 10;
const yOf = (a) => (a.inCab ? Math.round(cabFoot()) : footY(fIdx(a.fr)));

const snapSeated = function () {
  for (const a of S.agents.values()) {
    if (a.away || a.visitor || a.slot < 0) continue;
    a.fr = a.room; a.x = slotX(a.room, a.slot); a.sit = 1; a.facing = 1; a.walking = false; a.hop = 0;
  }
};

const measure = function () {
  const dpr = window.devicePixelRatio || 1, n = S.floors.length;
  const devW = Math.max(1, stageEl.clientWidth * dpr), devH = Math.max(1, stageEl.clientHeight * dpr);
  const t0 = T0(), hmin = t0 + n * HF_MIN + GRND;
  const sW = Math.max(1, Math.floor(devW / MINLW + 1e-6));
  const sH = Math.max(1, Math.floor(devH / hmin));
  const cap = Math.max(1, Math.round(2 * dpr));
  let s = sW;
  if (s > cap) s = Math.max(cap, Math.min(sW, sH));
  S.s = s; S.dpr = dpr;
  S.LW = clamp(Math.floor(devW / s), 340, MAXLW);
  S.Hf = clamp(Math.floor((devH / s - t0 - GRND) / n), HF_MIN, HF_MAX);
  S.LH = t0 + n * S.Hf + GRND;
};

const layout = function () {
  S.anim = null; S.fc = null; S.bgCv = null; E.fid = null;
  measure();
  cv.width = S.LW; cv.height = S.LH; stCv.width = S.LW; stCv.height = S.LH;
  cv.style.width = (S.LW * S.s / S.dpr) + 'px'; cv.style.height = (S.LH * S.s / S.dpr) + 'px';
  ctx.imageSmoothingEnabled = false; stC.imageSmoothingEnabled = false;
  S.ready = true;
  snapSeated();
  if (!B.away) B.x = bossX();
  drawStatic();
  placeGear();
  uiMeasure();
};

const assignWalls = function () {
  const use = WALLS.map(() => 0), out = new Map(), ids = S.rooms.map((r) => r.id);
  for (const id of ids) if (S.wall.has(id)) { out.set(id, S.wall.get(id)); use[S.wall.get(id)]++; }
  for (const id of ids.slice().sort()) {
    if (out.has(id)) continue;
    const k = hash(id) % WALLS.length;
    let best = k;
    for (let n = 0; n < WALLS.length; n++) { const c = (k + n) % WALLS.length; if (use[c] < use[best]) best = c; }
    use[best]++;
    out.set(id, best);
  }
  S.wall = out;
};

const wallColors = function (id) {
  if (id === LOBBY) return WALL_LOBBY;
  if (id === BOSS) return WALL_BOSS;
  const k = S.wall.get(id);
  return WALLS[k === undefined ? hash(id) % WALLS.length : k];
};

const labelLines = function (id) {
  const rows = [];
  if (id === LOBBY) rows.push({ t: 'LOBBY', col: '#f7e6bd' });
  else if (id === BOSS) { rows.push({ t: 'BOSS', col: '#ffcd75' }); rows.push({ t: 'OFFICE', col: '#f7e6bd' }); }
  else {
    for (const r of nameRows((S.rooms.find((room) => room.id === id) || {}).label || '', LABT)) rows.push({ ...r, col: '#f7e6bd' });
    const cnt = (S.slots.get(id) || []).filter((x) => x && !(S.agents.get(x) || {}).joining).length;
    rows.push({ t: cnt + (cnt === 1 ? ' AGENT' : ' AGENTS'), col: '#e0b070' });
  }
  return { rows, h: rows.length * 8 + 4 };
};

let curFloor = TYPE_ONLY ? { id: '', top: 0 } : null;
const drawFloor = function (c, i, id, collect) {
  curFloor = collect ? { id, top: floorTop(i) } : null;
  const Hf = S.Hf, top = floorTop(i), fy = footY(i), BL = BM, BR = S.LW - BM, EX = EXC();
  const [wm, wd] = wallColors(id);
  const wl = mix(wm, '#ffffff', 0.1);
  R(c, BL, top, BR - BL, fy - top, wm);
  for (let y = top + 4; y < fy - 14; y += 4) for (let x = BL + (((y - top) >> 2) & 1) * 2; x < BR; x += 4) px(c, x, y, wl);
  R(c, BL, top, BR - BL, 2, wd); R(c, BL, top + 2, BR - BL, 1, wl);
  R(c, BL, fy - 12, BR - BL, 12, wd); R(c, BL, fy - 12, BR - BL, 1, wl);
  const bossFloor = id === BOSS, lobby = id === LOBBY;
  R(c, BL, fy, BR - BL, Hf - (fy - top), bossFloor ? 'r' : 'j');
  if (bossFloor) { for (let x = BL; x < BR; x += 4) R(c, x, fy + 2, 2, 1, 'q'); R(c, BL, fy, BR - BL, 1, 'q'); }
  else {
    for (const yy of [fy + 3, fy + 7]) R(c, BL, yy, BR - BL, 1, 'k');
    for (let row = 0; row < 3; row++) for (let x = BL + row * 9; x < BR; x += 18) R(c, x, fy + 1 + row * 4 - (row ? 1 : 0), 1, 2, 'k');
  }
  R(c, BL, top + Hf - 2, BR - BL, 2, 'i'); R(c, BL, top + Hf - 2, BR - BL, 1, 'g');
  R(c, BL - 1, top, 1, Hf, 'f'); R(c, BR, top, 1, Hf, 'f');
  R(c, EX - 13, top, SHAFT, Hf - 2, '0'); R(c, EX - 13, top, 1, Hf - 2, 'f'); R(c, EX + 12, top, 1, Hf - 2, 'f');
  const lines = labelLines(id);
  R(c, BL + 1, top + 4, LABW - 2, lines.h, 'i'); R(c, BL + 1, top + 4, LABW - 2, 1, 'h'); R(c, BL + 1, top + 3 + lines.h, LABW - 2, 1, 'n');
  lines.rows.forEach((r, j) => text(c, r.t, BL + 3, top + 7 + j * 8 + (r.sm ? 1 : 0), r.col, r.sm));
  const arr = S.slots.get(id) || [];
  const ncell = cellsFor(id), pitch = pitchOf(id), L = zl();
  const rr = rng(hash(id) + 11);
  const wallH = fy - top;
  if (lobby) {
    R(c, BL + 4, fy - 32, 20, 32, 'i'); R(c, BL + 6, fy - 30, 16, 30, 'h'); R(c, BL + 8, fy - 27, 12, 10, 'a'); R(c, BL + 8, fy - 27, 12, 1, 'c'); R(c, BL + 19, fy - 13, 2, 2, '4'); R(c, BL + 4, fy - 33, 20, 1, 'k');
  }
  if (bossFloor) {
    const bx = bossX(), dX = doorX(), sp = bossSpot();
    const ww = clamp(Math.floor((dX - bx - 40) * 0.5), 44, 70);
    skylineWindow(c, bx + 4, top + 7, ww, Math.min(22, wallH - 36));
    pPlant(c, L + 6, fy, true);
    bossStation(c, fy);
    const tx = dX - 16;
    pTrophy(c, tx, fy);
    const sx = sp + 24;
    if (tx - 24 - sx > 18) pBookshelf(c, Math.round((sx + tx - 24) / 2), fy);
    if (wallH > 56) pPoster(c, tx, top + 20, 1);
    pClock(c, dX - 3, top + 8);
    R(c, dX - 1, top + 3, 5, fy - top - 3 - 27, wd); R(c, dX - 1, top + 3, 1, fy - top - 3 - 27, wl);
    R(c, dX - 2, fy - 28, 7, 2, '4'); R(c, dX - 2, fy - 28, 7, 1, 'm'); R(c, dX - 2, fy - 27, 1, 27, 'h'); R(c, dX + 4, fy - 27, 1, 27, 'n');
    const hw = hallW();
    R(c, dX + 6, top + 12, hw - 6, 11, 'i'); R(c, dX + 7, top + 13, hw - 8, 9, '1'); R(c, dX + 7, top + 13, hw - 8, 1, '2');
    const sign = 'TAKE A NUMBER';
    text(c, sign, dX + 6 + Math.floor((hw - 6 - textW(sign)) / 2), top + 15, '#ffcd75');
    secretaryDesk(c, secX(), fy);
    for (let k = 0; k < lineCap(); k++) chair(c, lineX(k), fy);
    return;
  }
  const order = lobby ? ['reception', 'plant', 'sofa', 'bigplant', 'cooler', 'plant'] : ['bookshelf', 'cooler', 'coffee', 'plant', 'printer', 'lamp', 'bigplant', 'cactus'];
  let pi = Math.floor(rr() * order.length);
  for (let k = 0; k < ncell; k++) {
    const cx = L + pitch * (k + 0.5);
    const aid = arr[k], a = aid && S.agents.get(aid);
    const ww = Math.min(26, Math.floor(pitch) - 10);
    windowAt(c, Math.round(cx - ww / 2), top + 6, ww, 12, hash(id) + k * 7);
    const free = fy - 25 - (top + 22);
    if (pitch >= 70 && k < ncell - 1) { const ex = Math.round(cx + pitch / 2), kd = (k + hash(id)) % 3; if (kd === 0) pBoard(c, ex, top + 24); else if (kd === 1) pPoster(c, ex, top + 22, k % 3); else pClock(c, ex, top + 26); }
    if (a && a.joining) continue;
    if (a) {
      drawStation(c, slotX(id, k), fy, a);
      if (free >= 15) { const kind = (k + hash(id)) % 4; if (kind === 3) pClock(c, Math.round(cx + 12), top + 24); else pPoster(c, Math.round(cx + 12), top + 24 + Math.floor((free - 15) / 2), kind); }
      const gap = pitch / 2 - 21;
      if (gap >= 12) BIG[SMALL[(k + pi) % SMALL.length]](c, Math.round(cx + 21 + gap / 2), fy);
    } else {
      const kind = order[pi % order.length]; pi++;
      BIG[kind](c, Math.round(cx), fy);
      const w = PROP_W[kind];
      if (pitch - w >= 28) BIG[SMALL[pi % SMALL.length]](c, Math.round(cx + w / 2 + 9), fy);
      if (free >= 15) { if (kind === 'bookshelf') pBoard(c, Math.round(cx), top + 24); else if (k % 2) pPoster(c, Math.round(cx), top + 24 + Math.floor((free - 15) / 2), (k + 1) % 3); else if (kind !== 'lamp') pBoard(c, Math.round(cx), top + 24 + Math.floor((free - 14) / 2)); }
    }
  }
};

const drawHud = function (c) {
  R(c, 0, 0, S.LW, HUDH, '0'); R(c, 0, HUDH - 1, S.LW, 1, 'f');
  c.drawImage(headCv(styleFor('hud'), 'happy', 0), 3, 1);
  const edge = S.LW - (HUD ? 23 : 6);
  const drawTitle = (limit) => {
    const full = 'SESSION ORCHESTRATOR', title = limit - 8 > 20 + textW(full) ? full : 'ORCHESTRATOR';
    text(c, title, 21, 4, '#5d275d'); text(c, title, 20, 3, '#ffcd75');
  };
  if (S.msg) { const m = up(S.msg); text(c, m, edge - textW(m), 4, '#ef7d57'); drawTitle(edge - textW(m)); return; }
  const segs = [['5', S.counts.working + ' WORKING'], ['4', S.counts.waiting + ' WAITING'], ['d', S.counts.idle + ' IDLE']];
  const mode = DEMO ? 'DEMO' : 'LIVE';
  let x = edge - textW(mode);
  text(c, mode, x, 4, DEMO ? '#ef7d57' : '#38b764');
  for (let i = segs.length - 1; i >= 0; i--) {
    const [col, t] = segs[i];
    x -= 8 + textW(t);
    text(c, t, x, 4, '#f4f4f4');
    R(c, x - 6, 5, 4, 4, col);
    x -= 8;
  }
  drawTitle(x);
};

const drawBg = function (c) {
  const W = S.LW, H = S.LH, t0 = T0(), n = S.floors.length;
  c.clearRect(0, 0, W, H);
  R(c, 0, 0, W, H, S.sky === 'day' ? '#41a6f6' : S.sky === 'dusk' ? '#b13e53' : '#29366f');
  if (S.sky === 'night') { const r = rng(9); for (let i = 0; i < 24; i++) px(c, Math.floor(r() * W), Math.floor(r() * (t0 + 20)), r() < 0.3 ? '4' : 'c'); R(c, 20, t0 - 8, 5, 5, '4'); px(c, 22, t0 - 8, '#29366f'); }
  else if (S.sky === 'day') { blob(c, 38, t0 - 4, 7, 2, 'c'); blob(c, W - 60, t0 - 8, 6, 2, 'c'); R(c, W - 18, t0 - 9, 6, 6, '4'); }
  else R(c, 30, t0 - 7, 7, 7, '4');
  const bBot = t0 + n * S.Hf;
  R(c, 0, bBot, W, GRND, '6'); R(c, 0, bBot, W, 1, '5'); R(c, 0, bBot + 3, W, GRND - 3, '7');
  for (let x = 3; x < W; x += 9) px(c, x, bBot + 1, '5');
  R(c, BM - 3, t0 - 3, W - 2 * BM + 6, 3, 'f'); R(c, BM - 3, t0 - 3, W - 2 * BM + 6, 1, 'e');
  const EX = EXC();
  R(c, EX - 14, t0 - 10, 28, 7, 'e'); R(c, EX - 14, t0 - 10, 28, 1, 'd'); R(c, EX - 10, t0 - 8, 8, 4, 'f'); blob(c, EX + 6, t0 - 6, 2, 2, 'd');
  R(c, EX - 30, t0 - 8, 1, 6, 'f'); R(c, EX - 30, t0 - 14, 1, 6, 'd');
  if (HUD) drawHud(c);
};

const drawFloorFull = function (c, i, id, collect) {
  drawFloor(c, i, id, collect);
  const ch = cabH(), EX = EXC(), fy = footY(i);
  R(c, EX - 13, fy - ch - 4, SHAFT, 3, 'e'); R(c, EX - 13, fy - ch - 4, SHAFT, 1, 'd'); R(c, EX - 4, fy - ch - 3, 8, 1, 'f'); R(c, EX - 13, fy, SHAFT, 1, 'd');
};

const drawStatic = function () {
  S.dyn = { coffees: [] };
  S.sky = skyMode();
  drawBg(stC);
  S.floors.forEach((id, i) => drawFloorFull(stC, i, id, true));
};

const floorCanvas = function (i, id) {
  const f = document.createElement('canvas');
  f.width = S.LW; f.height = S.Hf;
  const c = context2d(f);
  c.imageSmoothingEnabled = false;
  c.translate(0, -floorTop(i));
  drawFloorFull(c, i, id, false);
  return f;
};

const ghostCanvas = function (g) {
  const sr = S.rooms, ss = S.slots, sw = S.wall;
  S.rooms = [...sr, { id: g.id, label: g.label }]; S.slots = new Map(ss).set(g.id, g.slots); S.wall = new Map(sw).set(g.id, g.wall);
  try { return floorCanvas(g.i, g.id); } finally { S.rooms = sr; S.slots = ss; S.wall = sw; }
};

const setCanvasH = function (h) {
  cv.height = h;
  cv.style.height = (h * S.s / S.dpr) + 'px';
  ctx.imageSmoothingEnabled = false;
};

const beginAnim = function (old, added, ghosts, oldLH) {
  const keepH = Math.max(S.LH, oldLH || 0);
  if (keepH > S.LH) setCanvasH(keepH);
  const bg = document.createElement('canvas');
  bg.width = S.LW; bg.height = keepH;
  const bc = context2d(bg);
  bc.imageSmoothingEnabled = false;
  drawBg(bc);
  R(bc, BM, T0(), S.LW - 2 * BM, S.floors.length * S.Hf, '#1a1c2c');
  S.bgCv = bg;
  S.fc = new Map(S.floors.map((id, i) => [id, floorCanvas(i, id)]));
  const slide = new Set((added || []).filter((id) => (S.slots.get(id) || []).every((aid) => !aid || (S.agents.get(aid) || {}).joining)));
  S.animCount = (S.animCount || 0) + 1;
  const out = (ghosts || []).map((g) => ({ i: g.i, cv: ghostCanvas(g) }));
  S.anim = newAnim(S.t, old, slide, out, keepH);
};
