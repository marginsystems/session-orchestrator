'use strict';

const spawn = function (gen) { const task = { gen, done: false }; S.tasks.push(task); gen.next(); return task; };
const tween = function* (d, fn) { let t = 0; while (t < d) { t += yield; fn(Math.min(1, t / d)); } fn(1); };
const wait = function* (s) { let t = 0; while (t < s) t += yield; };
const until = function* (cond) { while (!cond()) yield; };

const walkTo = function* (a, tx) {
  const x0 = a.x, dist = Math.abs(tx - x0);
  if (dist < 0.5) { a.x = tx; return; }
  a.facing = tx > x0 ? 1 : -1; a.walking = true;
  const dur = clamp(dist / (a.spd || 56), 0.3, 8);
  let last = x0;
  yield* tween(dur, (p) => { const x = lerp(x0, tx, walkEase(p)); a.phase += Math.abs(x - last) / 4.5; last = x; a.x = x; });
  a.x = tx; a.walking = false;
};

const stand = function* (a) {
  yield* tween(0.35, (p) => { a.hop = Math.sin(p * Math.PI) * 5; if (p > 0.4) a.sit = 0; });
  a.hop = 0; a.sit = 0;
};
const sitDown = function* (a) {
  a.facing = 1;
  yield* tween(0.4, (p) => { a.hop = Math.sin(p * Math.PI) * 4; if (p > 0.6) a.sit = 1; });
  a.hop = 0; a.sit = 1;
};

const moveCab = function* (room) {
  const from = E.fy;
  if (Math.abs(from - fIdxN(room)) < 0.001) return;
  E.moving = true;
  yield* tween(0.5 + 0.38 * Math.abs(fIdxN(room) - from), (p) => { E.fy = lerp(from, fIdxN(room), ease(p)); });
  E.fy = fIdxN(room); E.moving = false;
};
const doors = function* (to) {
  const f = E.open;
  yield* tween(0.3, (p) => { E.open = lerp(f, to, ease(p)); });
  E.open = to;
  if (to === 1) E.ding = { f: Math.round(E.fy), t0: S.t };
};

const elevatorProc = function* () {
  for (;;) {
    if (!E.queue.length) { yield; continue; }
    const r = E.queue[0];
    yield* moveCab(r.fromRoom);
    yield* doors(1);
    r.state = 'board';
    while (r.state !== 'in') yield;
    E.queue.shift(); E.rider = r.a;
    yield* wait(0.15);
    yield* doors(0);
    yield* moveCab(r.toRoom);
    yield* doors(1);
    r.state = 'exit';
    while (r.state !== 'out') yield;
    E.rider = null;
    yield* wait(0.3);
    yield* doors(0);
  }
};

const ride = function* (a, toRoom) {
  const fromRoom = a.fr;
  const r = { a, fromRoom, toRoom, state: 'wait' };
  E.queue.push(r);
  yield* until(() => r.state === 'board');
  E.use.set(fromRoom, Math.max(0, (E.use.get(fromRoom) || 1) - 1));
  yield* walkTo(a, EXC());
  a.facing = 1; a.inCab = true; r.state = 'in';
  yield* until(() => r.state === 'exit');
  a.inCab = false; a.fr = S.floors.includes(toRoom) ? toRoom : LOBBY; r.state = 'out';
};

const goTo = function* (a, room, x) {
  if (a.fr !== room) {
    const f0 = a.fr, k = E.use.get(f0) || 0;
    E.use.set(f0, k + 1);
    yield* walkTo(a, EXC() - 24 - 12 * k);
    yield* ride(a, room);
  }
  yield* walkTo(a, x);
};

const homeOf = (a) => (a.visitor ? { room: LOBBY, x: BM + 14 } : { room: a.room, x: slotX(a.room, Math.max(0, a.slot)) });

const exitBuilding = function* (a) {
  yield* goTo(a, LOBBY, EXC());
  if (!a.gone) { yield* leaveAndSit(a); return; }
  yield* tween(0.35, (p) => { if (a.gone) a.alpha = 1 - p; });
  if (!a.gone) { a.alpha = 1; yield* leaveAndSit(a); return; }
  S.agents.delete(a.id);
};

const leaveAndSit = function* (a) {
  if (a.gone && !a.visitor) { yield* exitBuilding(a); return; }
  const h = homeOf(a);
  yield* goTo(a, h.room, h.x);
  if (a.visitor) { S.agents.delete(a.id); return; }
  yield* sitDown(a);
  a.away = false; a.spd = 0; a.fr = a.room; a.x = slotX(a.room, Math.max(0, a.slot)); a.sit = 1; a.facing = 1; a.walking = false; a.hop = 0;
  if (a.gone) S.agents.delete(a.id);
};

const freeSeat = function (a) {
  a.leaving = false;
  if (S.agents.get(a.id) === a) return;
  const px = slotX(a.room, Math.max(0, a.slot)) + 14, room = a.room;
  if (S.last) applyState(S.last);
  if (S.floors.includes(room) && !S.anim) S.puffs.push({ x: px, y: footY(fIdx(room)), t0: S.t });
};

const leaveTask = function* (a) {
  yield* until(() => activeMovers(a) < 2 || !a.gone);
  if (!a.gone) { freeSeat(a); return; }
  a.away = true; a.fr = a.room; a.spd = 95;
  yield* stand(a);
  yield* exitBuilding(a);
  freeSeat(a);
};

const fadeTask = function* (a) {
  yield* tween(0.5, (p) => { if (a.gone) a.alpha = 1 - p; });
  if (a.gone) S.agents.delete(a.id); else a.alpha = 1;
  freeSeat(a);
};

const trip = function* (a, bid, text) {
  a.away = true;
  if (a.visitor) { a.fr = LOBBY; a.x = BM + 14; a.sit = 0; a.facing = 1; yield* wait(0.2); }
  else yield* stand(a);
  const b = S.agents.get(bid);
  if (b && !b.gone && b.slot >= 0) {
    yield* goTo(a, b.room, slotX(b.room, b.slot) - VIS_DX);
    a.facing = 1;
    yield* wait(0.2);
    a.bubble = speech(text, S.t); b.react = S.t;
    yield* wait(2.4);
    a.bubble = null;
    yield* wait(0.15);
  }
  yield* leaveAndSit(a);
};

const pushVisit = function (id) {
  if (S.visits.includes(id) || S.visits.length >= 6) return false;
  S.visits.push(id);
  return true;
};

const bossVisit = function* (id) {
  const a = S.agents.get(id);
  if (!a || a.gone || a.slot < 0 || a.visitor) return;
  B.away = true;
  yield* stand(B);
  yield* goTo(B, a.room, slotX(a.room, Math.max(0, a.slot)) - VIS_DX);
  B.facing = 1;
  yield* wait(0.2);
  const mine = speech(BOSS_VISIT_TEXTS[hash(id + S.visits.length + Math.floor(S.t)) % BOSS_VISIT_TEXTS.length], S.t, 15);
  B.bubble = mine;
  a.react = S.t;
  yield* wait(0.5);
  let reply = TYPE_ONLY ? speech('', 0) : null;
  const entry = { id, agentAway: a.away, agentBubble: !!a.bubble, answered: false };
  S.visitLog.push(entry);
  if (S.visitLog.length > 100) S.visitLog.shift();
  if (!a.away && !a.bubble) { reply = speech('ON IT, BOSS!', S.t); a.bubble = reply; entry.answered = true; }
  yield* wait(2.5);
  B.bubble = null;
  if (reply && a.bubble === reply) a.bubble = null;
  yield* wait(0.15);
  yield* goTo(B, BOSS, bossX());
  yield* sitDown(B);
  B.away = false; B.fr = BOSS; B.x = bossX(); B.sit = 1; B.facing = 1; B.walking = false; B.hop = 0;
};

const bossProc = function* () {
  for (;;) {
    yield;
    if (!S.visits.length || B.away || S.focusVisitor || activeMovers() > 3) continue;
    yield* bossVisit(S.visits.shift());
    yield* wait(0.6);
  }
};

const joinTask = function* (a) {
  yield* until(() => !S.anim && activeMovers(a) < 3);
  yield* wait(0.4);
  if (a.gone || a.slot < 0) { a.joining = false; yield* leaveAndSit(a); return; }
  S.drops.set(a.id, { t0: S.t });
  yield* wait(0.38);
  a.joining = false;
  S.drops.delete(a.id);
  S.puffs.push({ x: slotX(a.room, a.slot) + 14, y: footY(fIdx(a.room)), t0: S.t });
  drawStatic();
  yield* wait(0.35);
  yield* leaveAndSit(a);
};

const makeVisitor = function () {
  const a = newAgent({ id: 'v' + (++S.vid), name: 'Guest', state: 'idle', room: LOBBY });
  a.visitor = true; a.slot = -1; a.fr = LOBBY; a.x = BM + 14; a.sit = 0;
  S.agents.set(a.id, a);
  return a;
};

const startTrip = function (fromId, toId, text) {
  const target = S.agents.get(toId);
  if (!target || target.gone || target.slot < 0) return false;
  let a = S.agents.get(fromId);
  if (!a || a.gone) a = makeVisitor();
  else if (a.away || a.slot < 0) return false;
  spawn(trip(a, toId, up(text)));
  return true;
};

const focusTrip = function* (a, token, fromLine) {
  const alive = () => S.focus && S.focus.token === token;
  a.away = true;
  if (fromLine) { SEC.t0 = S.t; yield* wait(1); a.q = false; }
  else if (a.visitor) { a.fr = LOBBY; a.x = BM + 14; a.sit = 0; a.facing = 1; yield* wait(0.2); }
  else yield* stand(a);
  if (alive()) {
    if (!fromLine) {
      yield* goTo(a, BOSS, secX());
      a.facing = 1;
      if (alive()) { SEC.t0 = S.t; yield* wait(1); }
    }
    yield* walkTo(a, bossSpot());
    a.facing = -1;
    if (alive()) {
      yield* until(() => !B.away || !alive());
      yield* wait(0.2);
      BS.react = S.t; S.focusVisitor = a;
      a.bubble = speech(BOSS_TEXTS[hash(token) % BOSS_TEXTS.length], S.t);
      yield* until(() => !alive());
      a.bubble = null; S.focusVisitor = null;
      yield* wait(0.3);
    }
  }
  yield* leaveAndSit(a);
};

const setFocus = function (agentId, at) {
  if (!agentId) { S.focus = null; return; }
  const token = agentId + ':' + at;
  if (S.focus && S.focus.token === token) return;
  S.focus = { token, agentId };
  spawn((function* () {
    const target = () => S.agents.get(agentId);
    const stale = () => !S.focus || S.focus.token !== token;
    let a;
    if (agentId === 'visitor' || !target()) a = makeVisitor();
    else {
      yield* until(() => { const x = target(); return !x || stale() || x.q || (!x.away && x.slot >= 0); });
      a = target();
      if (!a || stale() || a.q) return;
    }
    yield* focusTrip(a, token, false);
  })());
};

const queueTask = function* (a) {
  a.q = true; a.away = true;
  yield* stand(a);
  yield* goTo(a, BOSS, lineX(slotOf(a.id)));
  for (;;) {
    if (S.focus && S.focus.agentId === a.id) { yield* focusTrip(a, S.focus.token, true); return; }
    const k = S.want.indexOf(a.id);
    if (k < 0 || a.gone) break;
    const tx = lineX(slotOf(a.id));
    a.facing = -1;
    if (Math.abs(a.x - tx) > 0.5) yield* walkTo(a, tx); else yield;
  }
  yield* until(() => activeMovers(a) < 3 || a.gone);
  a.q = false;
  yield* leaveAndSit(a);
};

const settledAway = (a) => (a.q && a.fr === BOSS && !a.inCab) || a === S.focusVisitor;
const activeMovers = (except) => [...S.agents.values()].filter((a) => a.away && a !== except && !settledAway(a)).length + (B.away && except !== B ? 1 : 0);

const syncLine = function () {
  const fid = S.focus && S.focus.agentId;
  const want = S.queue.filter((id) => {
    const a = S.agents.get(id);
    return a && !a.visitor && !a.gone && a.state === 'waiting' && a.slot >= 0 && id !== fid;
  });
  S.want = want;
  for (const id of want) {
    const a = S.agents.get(id);
    if (!a) continue;
    if (!a.q && !a.away && a.sit > 0.99 && activeMovers() < 3) spawn(queueTask(a));
  }
};

const queueProc = function* () {
  for (;;) { yield; syncLine(); }
};
