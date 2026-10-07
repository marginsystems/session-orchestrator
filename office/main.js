'use strict';

const step = function (dt) {
  S.dt = dt; S.t += dt;
  for (const task of [...S.tasks]) {
    const r = task.gen.next(dt);
    if (r.done) S.tasks.splice(S.tasks.indexOf(task), 1);
  }
  stepUi(dt);
};

let frameRemainder = 0;
const advance = function (seconds) {
  const dt = (1 / 15) * SPEED * (DEMO ? S.set.speed : 1);
  const frames = seconds * 15 + frameRemainder;
  const n = Math.round(frames);
  frameRemainder = frames - n;
  for (let i = 0; i < n; i++) step(dt);
  draw(S.t);
  renderUi(S.t);
};

const held = window['__officeHold'] === true;
let raf = 0, last = 0;
const frame = function (now) {
  raf = requestAnimationFrame(frame);
  if (held) return;
  if (now - last < 1000 / 15 - 3) return;
  const dt = Math.min(0.1, (now - last) / 1000) * SPEED * (DEMO ? S.set.speed : 1);
  last = now;
  S.frames++;
  step(dt);
  draw(S.t);
  renderUi(S.t);
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
  else if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); if (!DEMO) poll(); }
});
let rz = 0;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 100); });

spawn(elevatorProc());
spawn(queueProc());
spawn(bossProc());
spawn(behaviorProc());
measure();
if (DEMO) { S.set = cleanSet(lsRead()); S.setReady = true; startDemo(); }
else if (location.protocol.startsWith('http')) loadSettings().then(() => { poll(); setInterval(poll, 2500); });
else { S.set = cleanSet(lsRead()); S.setReady = true; S.tourChecked = true; applyState({ rooms: [], agents: [], events: [] }); hudMessage('run scan.mjs or ?demo=1'); }
if (!S.ready) layout();
raf = requestAnimationFrame(frame);

window['__office'] = {
  scale: () => S.s / S.dpr, px: () => S.s, hf: () => S.Hf, dpr: () => S.dpr, frames: () => S.frames, world: () => ({ w: S.LW, h: S.LH }),
  floors: () => S.floors.map((id, i) => ({ id, top: floorTop(i), foot: footY(i), h: S.hs[i], y: topNow(id) })),
  grid: () => S.floors.map((id) => ({ id, ...gridOf(id), rowH: ROWH, minPitch: MINP })),
  labels: () => S.floors.map((id, i) => labelLines(id).rows.map((r, j) => ({ id, x: BM + 3, y: floorTop(i) + 7 + j * 8 + (r.sm ? 1 : 0), w: fitW(r.t, r.sm), h: r.sm ? 5 : 7, t: r.t, sm: !!r.sm }))).flat(),
  desks: () => { const o = []; for (const [rid, arr] of S.slots) arr.forEach((aid, k) => { if (aid) o.push({ id: aid, room: rid, k, row: slotRow(rid, k), x: slotX(rid, k), y: deskFoot(rid, k) }); }); return o; },
  agents: () => [...S.agents.values()].map((a) => ({ id: a.id, name: a.name, state: a.state, room: a.room, fr: a.fr, x: a.x, y: yOf(a), dy: a.dy, sit: a.sit, away: a.away, queued: a.q && a.fr === BOSS && !a.walking && !a.inCab, settled: settledAway(a), q: a.q, title: a.title, walking: a.walking, facing: a.facing, inCab: a.inCab, visitor: a.visitor, gone: a.gone, leaving: !!a.leaving, alpha: a.alpha, bubble: a.bubble ? bubbleRect(a) : null })),
  elevator: () => ({ fy: E.fy, open: E.open, queue: E.queue.length, rider: E.rider ? E.rider.id : null, x: EXC(), foot: cabFoot(), h: cabH() }),
  boss: () => ({ x: bossX(), foot: footY(0), spot: bossSpot(), desk: { x: bossX() - 12, y: footY(0) - 25, w: BOSS_DESK_W + 17, h: 25 }, floor: BOSS }),
  focus: (id, at) => { setFocus(id, at || String(Date.now())); return true; },
  clearFocus: () => setFocus(null),
  bossActor: () => ({ x: B.x, y: yOf(B), fr: B.fr, away: B.away, sit: B.sit, inCab: B.inCab, bubble: B.bubble ? bubbleRect(B) : null, desk: B.fr === BOSS ? null : null, chair: bossX(), visits: S.visits.length }),
  visit: (id) => pushVisit(id),
  visitLog: () => S.visitLog.map((v) => ({ ...v })),
  join: (np) => (window['__demoJoin'] ? window['__demoJoin'](np) : null),
  secretary: () => ({ x: secX(), waving: S.t - SEC.t0 < 1.4 }),
  trip: (fromId, toId, text) => startTrip(fromId, toId || '', text || TEXTS[0]),
  dim: () => S.dim,
  queue: () => ({ queue: S.queue.slice(), size: S.queueSize, line: S.line.slice(), guests: S.line.filter((id) => id === null).length, want: S.want.slice(), cap: lineCap(), door: doorX(), hall: hallW(), spots: S.want.map((id) => lineX(slotOf(id))), foot: footY(0), spot: bossSpot() }),
  rooms: () => S.rooms.map((r) => ({ id: r.id, label: r.label, offAir: r.offAir })),
  load: (st) => { applyState(st); return true; },
  layouts: () => S.layouts,
  clocks: (t) => [...S.agents.values()].map((a) => ({ id: a.id, at: ownTime(a, t) })),
  fold: (t) => fold(t),
  sign: () => ({ x: BM + 3, max: LABT, inner: LABW - 2 }),
  settings: () => ({ ...S.set }),
  server: () => SERVER,
  animating: () => !!S.anim,
  anim: () => (S.anim ? { p: S.anim.p, pf: S.anim.pf, ps: S.anim.ps, out: S.anim.out.length } : null),
  apply: (raw) => applyState(raw),
  animations: () => S.animCount || 0,
  particles: () => S.particles.length,
  ui: () => ({ settings: UI.settings, tour: UI.tour ? { step: UI.tour.step, shown: UI.tour.shown, len: UI.tour.text.length, text: UI.tour.text, did: UI.tour.did } : null, U: { ...U }, dialog: UI.dialog, strip: UI.strip, geo: UI.geo ? { x: UI.geo.x, y: UI.geo.y, w: UI.geo.w, h: UI.geo.h, rows: UI.geo.rows, n: UI.geo.n } : null, dpr: window.devicePixelRatio || 1, canvas: (() => { const r = uc.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })() }),
  sky: () => S.sky,
  behavior: () => behaviorSnapshot(),
  advance,
  poll: () => poll(),
};
