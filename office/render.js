'use strict';

const idleAct = function (a, t) {
  const T = 18, tt = t + (a.seed % 11) * 1.3, ph = tt % T, cyc = Math.floor(tt / T);
  if (ph >= 5 && ph < 6.4) return { act: 'look' };
  if (ph >= 9 && ph < 11.4) return { act: 'sip', p: (ph - 9) / 2.4 };
  if (cyc % 2 === 0 && ph >= 14 && ph < 15.8) return { act: 'stretch', p: (ph - 14) / 1.8 };
  return { act: 'none' };
};

const drawScreen = function (x, fy, a, t) {
  const sc = a.st.screen ? ['#ffcd75', '#ef7d57'] : ['#a7f070', '#38b764'];
  const tick = Math.floor(t * 3);
  const seated = a.sit > 0.99 && !a.away;
  const sx = x + 17, sy = fy - 20;
  ctx.fillStyle = '#1a1c2c'; ctx.fillRect(sx, sy, 10, 7);
  if (a.state === 'working' && seated) {
    for (let i = 0; i < 4; i++) { const L = 3 + (hn(tick + i + a.seed) % 7); ctx.fillStyle = i % 2 ? sc[1] : sc[0]; ctx.fillRect(sx + 1 + (i % 2), sy + i * 2, Math.min(L, 8 - (i % 2)), 1); }
    if (Math.floor(t * 2) % 2) { ctx.fillStyle = '#f4f4f4'; ctx.fillRect(sx + 8, sy + 6, 1, 1); }
  } else if (a.state === 'waiting' && seated) {
    ctx.fillStyle = sc[1]; ctx.fillRect(sx + 1, sy, 6, 1); ctx.fillRect(sx + 1, sy + 2, 4, 1);
    if (Math.floor(t * 1.5) % 2) { ctx.fillStyle = sc[0]; ctx.fillRect(sx + 1, sy + 5, 2, 1); }
  } else if (a.state === 'idle' && !a.sleepy && !napping(a)) {
    ctx.fillStyle = '#333c57'; ctx.fillRect(sx + 1, sy + 1, 5, 1);
    if (Math.floor(t) % 2) { ctx.fillStyle = sc[1]; ctx.fillRect(sx + 1, sy + 3, 1, 1); }
    const bx = Math.floor((t * 4 + a.seed) % 14);
    ctx.fillStyle = sc[0]; ctx.fillRect(sx + (bx < 8 ? bx : 14 - bx), sy + 5 + (bx % 2), 1, 1);
  } else { ctx.fillStyle = '#333c57'; ctx.fillRect(sx + 8, sy + 5, 1, 1); }
};

const drawBossScreens = function (t) {
  const fy = footY(0), dx = bossX() + 5;
  for (const [mx, off] of [[dx + 20, 0], [dx + 33, 5]]) {
    const tick = Math.floor(t * 2) + off;
    ctx.fillStyle = '#1a1c2c'; ctx.fillRect(mx + 2, fy - 21, 8, 7);
    for (let i = 0; i < 6; i++) { const h = 1 + (hn(tick + i * 7) % 6); ctx.fillStyle = i % 2 ? '#ffcd75' : '#a7f070'; ctx.fillRect(mx + 3 + i, fy - 14 - h, 1, h); }
  }
};

const seatedPose = function (a, t) {
  const o = { face: 'neutral', hdx: 0, hdy: 0, shift: 0, sleeping: false, act: 'none', p: 0 };
  const blink = ((t * 1000 + a.seed * 37) % 3600) < 160;
  if (a.state === 'working') { o.face = blink ? 'blink' : 'focus'; o.hdy = Math.floor(t * 4) % 2; }
  else if (a.state === 'waiting') { o.face = 'wait'; o.hdy = Math.floor(t * 1.5) % 2; }
  else if (a.sleepy || napping(a)) { o.face = 'sleep'; o.sleeping = true; o.hdx = 4; o.hdy = 3 + (Math.floor(t * 0.8) % 2); }
  else {
    const ia = idleAct(a, t);
    o.face = blink ? 'blink' : 'neutral'; o.hdy = Math.floor(t * 0.9) % 2;
    o.act = ia.act; o.p = ia.p || 0;
    if (ia.act === 'look') o.shift = -3;
    else if (ia.act === 'sip') o.face = 'happy';
    else if (ia.act === 'stretch') { o.face = 'yawn'; o.hdy = 0; }
  }
  return o;
};

const drawSeated = function (a, t, x, fy, st, o) {
  const y0 = fy - 23 - Math.round(a.hop);
  if (o.act === 'stretch') ctx.drawImage(armsUpCv(st), x - 7, y0 + 1);
  ctx.drawImage(sitBodyCv(st), x - 7, y0 + 11);
  ctx.drawImage(headCv(st, a.react > 0 && S.t - a.react < 0.5 ? 'wow' : o.face, o.shift), x - 7 + o.hdx, y0 + o.hdy);
  if (a.state === 'working' && !o.sleeping) {
    const k = Math.floor(t * 8) % 2;
    ctx.fillStyle = st.fur.l; ctx.fillRect(x + 8 + k * 3, fy - 12, 2, 1); ctx.fillRect(x + 11 - k * 3, fy - 12, 2, 1);
  }
  if (o.act === 'sip') {
    const p = Math.min(1, Math.sin(o.p * Math.PI) * 1.6);
    const my = Math.round(lerp(fy - 14, fy - 24, p));
    ctx.fillStyle = st.fur.b; ctx.fillRect(x + 6, Math.round(lerp(fy - 12, fy - 18, p)), 2, 2);
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(x + 9, my, 4, 4); ctx.fillStyle = '#566c86'; ctx.fillRect(x + 13, my + 1, 1, 2);
    ctx.fillStyle = '#c4915a'; ctx.fillRect(x + 10, my, 2, 1);
    ctx.fillStyle = '#94b0c2'; if (Math.floor(t * 4) % 2) ctx.fillRect(x + 10, my - 2, 1, 1); else ctx.fillRect(x + 11, my - 3, 1, 1);
  } else if (!a.boss) { ctx.fillStyle = '#f4f4f4'; ctx.fillRect(x + 30, fy - 14, 3, 3); ctx.fillStyle = '#566c86'; ctx.fillRect(x + 33, fy - 13, 1, 1); ctx.fillStyle = '#c4915a'; ctx.fillRect(x + 30, fy - 14, 3, 1); }
};

const drawAgent = function (a, t) {
  if (a.alpha <= 0.05) return;
  const g = ctx.globalAlpha;
  ctx.globalAlpha = g * a.alpha;
  try { drawAgentBody(a, t); } finally { ctx.globalAlpha = g; }
};

const drawAgentBody = function (a, t) {
  const x = Math.round(a.x), fy = yOf(a), st = a.st;
  if (a.q && a.fr === BOSS && !a.walking && !a.inCab) { drawWaiter(a, t, BH.moods.get(a.id)); return; }
  if (a.sit > 0.5) { drawSeated(a, t, x, fy, st, seatedPose(a, t)); return; }
  ctx.save();
  ctx.globalAlpha = 0.25 * a.alpha; ctx.fillStyle = '#000'; ctx.fillRect(x - 5, fy, 10, 1); ctx.globalAlpha = a.alpha;
  ctx.translate(x, 0); ctx.scale(a.facing, 1);
  const blink = ((t * 1000 + a.seed * 37) % 3600) < 160;
  let face = blink ? 'blink' : 'neutral';
  if (a.react > 0 && S.t - a.react < 0.9) face = 'wow';
  else if (a.bubble) face = 'happy';
  const f = a.walking ? WALK[Math.floor(a.phase) & 3] : 'C';
  const bob = a.walking && (Math.floor(a.phase) & 1) ? 1 : 0;
  const y = fy - 16 - Math.round(a.hop) - bob;
  ctx.drawImage(standBodyCv(st, f), -7, y + 11);
  ctx.drawImage(headCv(st, face, a.inCab ? -2 : 0), -7, y);
  ctx.restore();
};

const drawBoss = function (t) {
  const fy = footY(0), x = bossX();
  const fake = { seed: 3, state: 'working', hop: 0, react: BS.react, sleepy: false, sit: 1, boss: true };
  const visiting = S.focusVisitor && S.focusVisitor.bubble;
  const o = seatedPose(fake, t);
  if (visiting) { o.face = S.t - BS.react < 1 ? 'wow' : 'happy'; o.hdy = Math.floor(t * 2) % 2; }
  else if ((t + 4) % 14 > 9 && (t + 4) % 14 < 11) { o.face = 'happy'; o.hdy = 0; }
  fake.hop = S.t - BS.react < 0.3 && BS.react > 0 ? Math.round(Math.sin(((S.t - BS.react) / 0.3) * Math.PI) * 3) : 0;
  if (!B.away) drawSeated(fake, t, x, fy, BS.style, o);
  const mx = x + 5 + 13;
  ctx.fillStyle = '#f4f4f4'; ctx.fillRect(mx, fy - 16, 6, 5); ctx.fillStyle = '#b13e53'; ctx.fillRect(mx, fy - 16, 6, 1); ctx.fillStyle = '#566c86'; ctx.fillRect(mx + 6, fy - 15, 1, 3);
  ctx.fillStyle = '#1a1c2c'; ctx.fillRect(mx + 1, fy - 14, 1, 2); ctx.fillRect(mx + 2, fy - 14, 1, 1); ctx.fillRect(mx + 2, fy - 12, 1, 1); ctx.fillRect(mx + 4, fy - 14, 1, 3);
  if (visiting && S.t - BS.react < 1.2 && !B.away) bang(x + 2, fy - 33);
};

const bang = function (x, y) {
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(textCv('!', '#1a1c2c'), x + dx, y + dy);
  ctx.drawImage(textCv('!', '#ffcd75'), x, y);
};

const thought = function (t, x, fy) {
  const bx = x + 2, by = fy - 36, c = ctx;
  c.fillStyle = '#1a1c2c'; c.fillRect(bx, by, 19, 9); c.fillStyle = '#f4f4f4'; c.fillRect(bx + 1, by + 1, 17, 7);
  c.fillStyle = '#1a1c2c'; c.fillRect(bx + 2, by + 10, 3, 3); c.fillRect(bx, by + 14, 2, 2);
  c.fillStyle = '#f4f4f4'; c.fillRect(bx + 3, by + 11, 1, 1);
  const n = Math.floor(t * 2.5) % 4;
  for (let i = 0; i < 3; i++) { c.fillStyle = i < n ? '#ef7d57' : '#94b0c2'; c.fillRect(bx + 4 + i * 4, by + 4, 2, 2); }
};

const zees = function (t, x, fy) {
  for (let j = 0; j < 2; j++) {
    const p = (t * 0.35 + j * 0.5) % 1;
    const zx = Math.round(x + 10 + p * 8), zy = Math.round(fy - 27 - p * 14);
    if (j) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(textCv('Z', '#1a1c2c'), zx + dx, zy + dy);
      ctx.drawImage(textCv('Z', '#f4f4f4'), zx, zy);
    } else { ctx.fillStyle = '#1a1c2c'; ctx.fillRect(zx - 1, zy - 1, 5, 5); ctx.fillStyle = '#f4f4f4'; ctx.fillRect(zx, zy, 3, 1); ctx.fillRect(zx + 1, zy + 1, 1, 1); ctx.fillRect(zx, zy + 2, 3, 1); }
  }
};

const bubbleRect = function (a) {
  const w = textW(a.bubble.text) + 9, h = 13;
  const x = clamp(Math.round(a.x - w / 2), BM + LABW + 2, S.LW - BM - 2 - w);
  const age = S.t - a.bubble.t0;
  const y = yOf(a) - 16 - 5 - h - (a.bubble.lift || 0) + (age < 0.1 ? 3 : age < 0.2 ? -1 : 0);
  return { x, y, w, h, tipX: clamp(Math.round(a.x), x + 4, x + w - 5) };
};
const drawDrops = function () {
  for (const [id, d] of S.drops) {
    const a = S.agents.get(id);
    if (!a) continue;
    const p = clamp((S.t - d.t0) / 0.38, 0, 1), fy = footY(fIdx(a.room));
    if (!d.cv) { d.cv = document.createElement('canvas'); d.cv.width = 48; d.cv.height = 48; drawStation(context2d(d.cv), 10, 34, a); }
    const off = -Math.round((1 - p * p) * 30);
    ctx.drawImage(d.cv, slotX(a.room, a.slot) - 10, fy - 34 + off);
  }
  S.puffs = S.puffs.filter((f) => S.t - f.t0 < 0.6);
  for (const f of S.puffs) {
    const p = (S.t - f.t0) / 0.6;
    ctx.globalAlpha = 1 - p;
    ctx.fillStyle = '#d6d6e0';
    for (let i = 0; i < 7; i++) {
      const ang = Math.PI * (0.08 + 0.84 * i / 6), r = 3 + p * 15;
      const sz = p < 0.5 ? 3 : 2;
      ctx.fillRect(Math.round(f.x + Math.cos(ang) * r * (i % 2 ? -1 : 1) * 1.4) - 1, Math.round(f.y - 2 - Math.sin(ang) * r * 0.5), sz, sz);
    }
    ctx.globalAlpha = 1;
  }
};

const guestStyles = new Map();
const drawGuests = function (t) {
  S.line.forEach((id, k) => {
    if (id !== null) return;
    let g = guestStyles.get(k);
    if (!g) { g = { st: styleFor('guest' + k), seed: hash('guest' + k) }; guestStyles.set(k, g); }
    drawWaiter({ x: lineX(k), st: g.st, seed: g.seed }, t, BH.moods.get('g' + k));
  });
};

const drawQueueMarks = function () {
  const fy = footY(fIdx(BOSS)), roomy = S.line.length < 2 || lineX(1) - lineX(0) >= 12;
  S.line.forEach((id, k) => {
    if (k > 0 && !roomy) return;
    const a = id ? S.agents.get(id) : null;
    if (id && (!a || !a.q || a.fr !== BOSS || a.walking || a.inCab)) return;
    const t = String(k + 1), x = lineX(k) - Math.floor(textW(t) / 2), y = fy - 30;
    text(ctx, t, x + 1, y + 1, '#1a1c2c');
    text(ctx, t, x, y, k === 0 ? '#ffcd75' : '#f4f4f4');
  });
};

const drawTag = function (a) {
  const fy = yOf(a), x = Math.round(a.x);
  const maxc = clamp(Math.floor((pitchOf(a.room) - 6) / 6), 4, 16);
  const t = up(a.title).slice(0, maxc), w = textW(t) + 5;
  const lo = BM + LABW + 2, hi = S.LW - BM - SHAFT - 6 - w;
  const bx = clamp(x - Math.floor(w / 2), lo, Math.max(lo, hi)), by = fy - 48;
  ctx.fillStyle = '#1a1c2c'; ctx.fillRect(bx, by, w, 9);
  ctx.fillStyle = '#e0b070'; ctx.fillRect(bx, by, w, 1); ctx.fillRect(bx, by + 8, w, 1);
  ctx.drawImage(textCv(t, '#f7e6bd'), bx + 3, by + 1);
};

const ants = function (c, r, t) {
  const ph = Math.floor(t * 6), x0 = Math.round(r.x), y0 = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
  c.fillStyle = '#ffcd75';
  let n = 0;
  const dot = (x, y) => { if (((n++ + ph) & 3) < 2) c.fillRect(x, y, 1, 1); };
  for (let x = 0; x < w; x++) dot(x0 + x, y0);
  for (let y = 0; y < h; y++) dot(x0 + w - 1, y0 + y);
  for (let x = w - 1; x >= 0; x--) dot(x0 + x, y0 + h - 1);
  for (let y = h - 1; y >= 0; y--) dot(x0, y0 + y);
};

const GEAR = ['....o....', '.o.ooo.o.', '..ooooo..', '.ooo.ooo.', 'ooo...ooo', '.ooo.ooo.', '..ooooo..', '.o.ooo.o.', '....o....'];
const gearRect = () => ({ x: S.LW - 17, y: 1, w: 11, h: 11 });
const drawGear = function () {
  const g = gearRect();
  const on = UI.settings;
  ctx.fillStyle = on ? '#ffcd75' : '#333c57'; ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.fillStyle = '#1a1c2c'; ctx.fillRect(g.x + 1, g.y + 1, g.w - 2, g.h - 2);
  ctx.drawImage(bake('gear' + (on ? 1 : 0), 9, 9, GEAR, { o: on ? '#ffcd75' : '#94b0c2' }), g.x + 1, g.y + 1);
};

const placeGear = function () {
  const k = S.s / S.dpr, g = gearRect();
  gearEl.style.display = HUD ? 'block' : 'none';
  const gw = Math.max((g.w + 4) * k, 32), gh = Math.max(HUDH * k, 32);
  gearEl.style.left = (g.x + g.w + 2) * k - gw + 'px'; gearEl.style.top = '0px';
  gearEl.style.width = gw + 'px'; gearEl.style.height = gh + 'px';
  wrapEl.style.width = S.LW * k + 'px';
};

const drawSecretary = function (t) {
  const fy = footY(fIdx(BOSS)), x = secX(), waving = S.t - SEC.t0 < 1.4;
  const o = seatedPose(SEC.fake, t);
  if (waving) { o.face = 'happy'; o.hdy = Math.floor(t * 3) % 2; }
  drawSeated(SEC.fake, t, x, fy, SEC_STYLE, o);
  const st = SEC_STYLE, y0 = fy - 23;
  if (waving) {
    const k = Math.floor(t * 8) % 2;
    ctx.fillStyle = st.fur.o; ctx.fillRect(x + 7 + k, y0 - 4, 3, 12);
    ctx.fillStyle = st.fur.b; ctx.fillRect(x + 8 + k, y0 - 3, 1, 10);
  }
  ctx.fillStyle = '#a0623a'; ctx.fillRect(x + 4, fy - 17, 6, 8);
  ctx.fillStyle = '#f4f4f4'; ctx.fillRect(x + 5, fy - 16, 4, 6);
  ctx.fillStyle = '#566c86'; ctx.fillRect(x + 5, fy - 15, 3, 1); ctx.fillRect(x + 5, fy - 13, 2, 1);
  ctx.fillStyle = '#ffcd75'; ctx.fillRect(x + 6, fy - 18, 2, 1);
  if (waving) drawBubble({ x: x + 6, fr: BOSS, inCab: false, bubble: { text: 'NEXT!', t0: SEC.t0 } });
};

const drawWaiter = function (a, t, m) {
  const x = Math.round(a.x), fy = footY(fIdx(BOSS)), st = a.st, w = waiterPose(m);
  ctx.save();
  ctx.translate(x, 0); ctx.scale(w.dir, 1);
  const blink = ((t * 1000 + a.seed * 37) % 3600) < 160;
  const y = fy - 19 + (Math.floor(t * 1.2 + a.seed) % 2 ? 1 : 0) - Math.round(w.hop);
  if (w.arms) ctx.drawImage(armsUpCv(st), -7, y + 1);
  ctx.drawImage(standBodyCv(st, 'C'), -7, y + 11);
  ctx.drawImage(headCv(st, w.face || (blink ? 'blink' : 'wait'), 0), -7, y);
  ctx.restore();
  ctx.fillStyle = '#566c86'; ctx.fillRect(x - 5, fy - 5, 10, 2); ctx.fillStyle = '#94b0c2'; ctx.fillRect(x - 5, fy - 5, 10, 1);
};

const drawBubble = function (a) {
  const b = a.bubble, age = S.t - b.t0;
  if (age < 0.04) return;
  const r = bubbleRect(a), c = ctx;
  c.fillStyle = '#1a1c2c'; c.fillRect(r.x + 1, r.y, r.w - 2, r.h); c.fillRect(r.x, r.y + 1, r.w, r.h - 2);
  c.fillStyle = '#f4f4f4'; c.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  const ty = r.y + r.h;
  c.fillStyle = '#1a1c2c'; c.fillRect(r.tipX - 2, ty - 1, 5, 1); c.fillRect(r.tipX - 2, ty, 1, 1); c.fillRect(r.tipX + 2, ty, 1, 1); c.fillRect(r.tipX - 1, ty + 1, 1, 1); c.fillRect(r.tipX + 1, ty + 1, 1, 1); c.fillRect(r.tipX, ty + 2, 1, 1);
  c.fillStyle = '#f4f4f4'; c.fillRect(r.tipX - 1, ty - 1, 3, 1); c.fillRect(r.tipX - 1, ty, 3, 1); c.fillRect(r.tipX, ty + 1, 1, 1);
  c.drawImage(textCv(b.text, '#1a1c2c'), r.x + 4, r.y + 3);
};

const drawCab = function (t) {
  const ch = cabH(), EX = EXC(), foot = Math.round(cabFoot()), top = foot - ch, x = EX - 12;
  R(ctx, EX, T0() - 3, 1, Math.max(0, top - T0() + 3), 'e');
  S.floors.forEach((id) => {
    const i = fIdxN(id), lit = E.ding && E.ding.f === i && S.t - E.ding.t0 < 0.9;
    const fy = footY(fIdx(id));
    ctx.fillStyle = lit ? (Math.floor(S.t * 8) % 2 ? '#ffcd75' : '#ef7d57') : Math.abs(E.fy - i) < 0.05 ? '#a7f070' : '#1a1c2c';
    ctx.fillRect(EX - 3, fy - ch - 3, 6, 1);
    if (lit) { ctx.fillStyle = '#ffcd75'; ctx.fillRect(EX - 6, fy - ch - 6, 1, 2); ctx.fillRect(EX + 5, fy - ch - 6, 1, 2); ctx.fillRect(EX, fy - ch - 7, 1, 2); }
  });
  ctx.fillStyle = '#566c86'; ctx.fillRect(x - 1, top - 2, 26, ch + 2);
  ctx.fillStyle = '#d6a566'; ctx.fillRect(x, top, 24, ch);
  ctx.fillStyle = '#e0b070'; ctx.fillRect(x, top, 24, 2); ctx.fillStyle = '#f7e6bd'; ctx.fillRect(x + 8, top, 8, 1);
  ctx.fillStyle = '#a0623a'; ctx.fillRect(x, foot - 12, 24, 1);
  ctx.fillStyle = '#c98a4b'; ctx.fillRect(x + 1, foot - 11, 22, 11);
  ctx.fillStyle = '#94b0c2'; ctx.fillRect(x + 2, foot - 14, 20, 1);
  ctx.fillStyle = E.moving || E.open > 0.05 ? '#ffcd75' : '#566c86'; ctx.fillRect(EX - 3, top - 3, 6, 1);
  if (E.rider) drawAgent(E.rider, t);
  const lw = 12 - Math.round(E.open * 11);
  if (lw > 0) {
    ctx.fillStyle = '#94b0c2'; ctx.fillRect(x, top, lw, ch); ctx.fillRect(x + 24 - lw, top, lw, ch);
    ctx.fillStyle = '#566c86'; ctx.fillRect(x + lw - 1, top, 1, ch); ctx.fillRect(x + 24 - lw, top, 1, ch);
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(x, top, lw, 1);
  }
};

const drawOffAir = function () {
  const off = S.rooms.filter((r) => r.offAir && S.floors.includes(r.id));
  if (!off.length) return;
  ctx.save();
  for (const r of off) {
    const y = floorTop(fIdx(r.id));
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = '#808080'; ctx.fillRect(BM, y, S.LW - 2 * BM, S.Hf);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.5; ctx.fillStyle = '#1a1c2c'; ctx.fillRect(BM, y, S.LW - 2 * BM, S.Hf);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
};

const draw = function (t) {
  ctx.clearRect(0, 0, S.LW, cv.height);
  if (S.anim && S.bgCv && S.fc) {
    ctx.drawImage(S.bgCv, 0, 0);
    for (const g of S.anim.out) ctx.drawImage(g.cv, -Math.round(S.anim.ps * S.LW), floorTop(g.i));
    for (const [id, f] of S.fc) ctx.drawImage(f, S.anim.slide.has(id) ? -Math.round((1 - S.anim.p) * S.LW) : 0, floorTop(fIdx(id)));
  } else ctx.drawImage(stCv, 0, 0);
  S.dim += ((NIGHT || (S.total > 0 && S.working / S.total <= 0.1) ? 1 : 0) - S.dim) * Math.min(1, S.dt * 0.8);
  for (const [rid, arr] of S.slots) {
    if (!S.floors.includes(rid)) continue;
    const fy = footY(fIdx(rid));
    arr.forEach((aid, k) => { const a = aid && S.agents.get(aid); if (a && !a.joining) drawScreen(slotX(rid, k), fy, a, t); });
  }
  drawDrops();
  drawBossScreens(t);
  for (const cf of S.dyn.coffees) { const x = cf.x, y = Math.round(floorTop(fIdx(cf.id))) + cf.dy; const p = Math.floor(t * 3) % 3; ctx.fillStyle = '#d6d6e0'; ctx.fillRect(x + (p === 1 ? 1 : 0), y - 1 - p, 1, 1); ctx.fillRect(x + 3 - (p === 2 ? 1 : 0), y - 2 - (p + 1) % 3, 1, 1); }
  drawBoss(t);
  drawSecretary(t);
  const all = [...S.agents.values()];
  drawGuests(t);
  for (const a of all) if (!a.away) drawAgent(a, t);
  drawCab(t);
  for (const a of all) if (a.away && !a.inCab) drawAgent(a, t);
  if (B.away && !B.inCab) drawAgent(B, t);
  drawOffAir();
  if (S.dim > 0.01) { ctx.globalAlpha = 0.28 * S.dim; ctx.fillStyle = '#1a1c2c'; ctx.fillRect(BM, T0(), S.LW - 2 * BM, S.floors.length * S.Hf); ctx.globalAlpha = 1; }
  for (const a of all) {
    const x = Math.round(a.x);
    if (!a.away) {
      const fy = footY(fIdx(a.fr));
      if (a.state === 'waiting' && a.sit > 0.99 && !a.bubble) thought(t, x, fy);
      if ((a.sleepy || napping(a)) && a.state === 'idle' && a.sit > 0.99) zees(t, x, fy);
      if (a.react > 0 && S.t - a.react < 1.1 && a.sit > 0.99) bang(x + 1, fy - 33);
    } else if (a.react > 0 && S.t - a.react < 1.1) bang(x, yOf(a) - 24);
  }
  drawQueueMarks();
  for (const a of all) if (!a.away && a.title) drawTag(a);
  for (const r of tourRects()) ants(ctx, r, t);
  if (HUD) drawGear();
  for (const a of [...all, B]) if (a.bubble) drawBubble(a);
  drawBehaviorBubbles();
  if (S.skyCheck !== Math.floor(t / 5)) { S.skyCheck = Math.floor(t / 5); if (skyMode() !== S.sky) drawStatic(); }
};
