'use strict';

const COOLER_MAX = 3, COOLER_NEAR = 40, COOLER_STAY = [6, 14], SHH_SPAN = 1.5, SHH_COOLDOWN = [20, 20], TRIP_COOLDOWN = [40, 40], SCARE_BEAT = 0.3;

const newVisit = (a, m, prop, side) => ({
  a, m, prop, side, floor: a.room, x: prop.x + sideOffset(prop.kind, side),
  phase: 'stand', dead: false, scare: false, until: 0, nextSay: 0, hushAt: 0, paired: false,
});

const sideOffset = function (kind, side) {
  const half = PROP_W[kind] / 2 + 6;
  return side === 0 ? -half : side === 1 ? half : half + 13;
};

const coolerTripOf = (id) => BH.visits.get(id) || null;
const coolerSettled = (a) => { const v = BH.visits.get(a.id); return !!v && v.phase === 'at'; };
const coolerClaimable = (a) => { const v = BH.visits.get(a.id); return !!v && (v.phase === 'out' || v.phase === 'at'); };
const claimCooler = function (a) {
  const v = BH.visits.get(a.id);
  if (!v || (v.phase !== 'stand' && v.phase !== 'out' && v.phase !== 'at')) return false;
  v.dead = true;
  hush(v.m);
  BH.visits.delete(a.id);
  record(v.m, 'cooler-claimed', 0, '', '', '');
  return true;
};

const coolerProps = (floor) => S.dyn.props.filter((p) => p.id === floor && (p.kind === 'cooler' || p.kind === 'coffee'));
const propNow = (v) => S.dyn.props.find((p) => p.id === v.floor && p.kind === v.prop.kind && p.x === v.prop.x) || null;
const visitorsAt = (prop, floor) => [...BH.visits.values()].filter((v) => !v.dead && v.floor === floor && v.prop.x === prop.x && v.phase !== 'back');
const settledAt = (prop, floor) => visitorsAt(prop, floor).filter((v) => v.phase === 'at');

const needed = (a) => a.state !== 'idle' || a.sleepy || a.q || a.gone || a.leaving || a.slot < 0 || a.joining
  || !!(S.focus && S.focus.agentId === a.id) || S.visits.includes(a.id) || S.visitTarget === a.id;

const bossNear = (floor, x) => B.away && !B.inCab && B.fr === floor && Math.abs(B.x - x) < COOLER_NEAR;

const dismissed = (v) => needed(v.a) || quiet() || v.a.room !== v.floor || !propNow(v);

const strollTo = function* (v, tx) {
  const a = v.a, x0 = a.x, dist = Math.abs(tx - x0);
  if (dist < 0.5) { a.x = tx; return; }
  a.facing = tx > x0 ? 1 : -1; a.walking = true;
  const dur = clamp(dist / 56, 0.3, 8);
  let last = x0, t = 0;
  while (t < dur) {
    t += yield;
    if (v.dead) return;
    if (dismissed(v)) { a.walking = false; return; }
    const x = lerp(x0, tx, walkEase(Math.min(1, t / dur)));
    a.phase += Math.abs(x - last) / 4.5; last = x; a.x = x;
  }
  a.x = tx; a.walking = false;
};

const chatter = function (v) {
  const m = v.m, a = v.a;
  if (m.bubble && S.t >= v.hushAt) hush(m);
  const peers = settledAt(v.prop, v.floor).filter((o) => o !== v);
  if (!peers.length) { a.facing = v.x < v.prop.x ? 1 : -1; v.paired = false; return; }
  let near = peers[0];
  for (const o of peers) if (Math.abs(o.x - v.x) < Math.abs(near.x - v.x)) near = o;
  a.facing = near.x > v.x ? 1 : -1;
  if (!v.paired) { v.paired = true; record(m, 'cooler-chat', 0, '', near.m.key, ''); }
  if (S.t < v.nextSay || m.bubble || peers.some((o) => o.m.bubble)) return;
  say(m, SAY[Math.floor(m.rnd() * SAY.length)], near.m);
  v.hushAt = S.t + 1.3;
  v.nextSay = S.t + 2.2 + m.rnd() * 1.5;
};

const coolerTask = function* (v) {
  const a = v.a, m = v.m;
  yield* stand(a);
  if (v.dead) return;
  v.phase = 'out';
  yield* strollTo(v, v.x);
  if (v.dead) return;
  if (!dismissed(v)) {
    v.phase = 'at';
    v.until = S.t + COOLER_STAY[0] + m.rnd() * (COOLER_STAY[1] - COOLER_STAY[0]);
    v.nextSay = S.t + 0.5 + m.rnd();
    while (!v.dead && !v.scare && S.t < v.until && !dismissed(v)) { chatter(v); yield; }
    if (v.dead) return;
  }
  hush(m);
  if (v.scare) { a.facing = 1; yield* wait(SCARE_BEAT); }
  v.phase = 'back';
  record(m, 'cooler-back', 0, '', '', '');
  yield* leaveAndSit(a);
  if (BH.visits.get(a.id) === v) BH.visits.delete(a.id);
};

const startCooler = function (m, prop) {
  const a = m.actor;
  if (!a) return;
  const taken = visitorsAt(prop, a.room).map((v) => v.side);
  const side = [0, 1, 2].find((s) => !taken.includes(s));
  if (side === undefined) return;
  const v = newVisit(a, m, prop, side);
  BH.visits.set(a.id, v);
  a.away = true;
  m.trip = S.t + TRIP_COOLDOWN[0] + m.rnd() * TRIP_COOLDOWN[1];
  record(m, 'cooler', 0, '', prop.kind, '');
  spawn(coolerTask(v));
};

const ruleCooler = function (m, c) {
  const a = m.actor;
  if (!a || !S.dyn.props.length || a.state !== 'idle' || a.sleepy || m.trip > S.t || m.doze > S.t || m.busy > S.t || napping(a)) return null;
  if (a.away || a.q || a.joining || a.leaving || a.gone || BH.visits.has(a.id) || S.visits.includes(a.id) || S.visitTarget === a.id) return null;
  if (S.focus && S.focus.agentId === a.id) return null;
  const open = coolerProps(c.floor).filter((p) => visitorsAt(p, c.floor).length < COOLER_MAX);
  if (!open.length) return null;
  const social = open.filter((p) => settledAt(p, c.floor).length > 0);
  const pool = social.length ? social : open;
  if (c.rnd() >= (social.length ? 0.1 : 0.012) * (0.25 + 0.75 * m.chatty) * c.chaos) return null;
  if (activeMovers() >= 3) return null;
  return newIntent('cooler', { prop: pool[Math.floor(c.rnd() * pool.length)] });
};

const ruleBossWake = function (m) {
  const a = m.actor;
  if (!a || !bossNear(a.fr, a.x)) return null;
  const chatting = activePose(m) && !!m.pose && m.pose.kind === 'chat';
  return napping(a) || chatting ? newIntent('wake', {}) : null;
};

const ruleBossScatter = function (m) {
  const v = BH.visits.get(m.key);
  if (!v || v.dead || v.scare || v.phase !== 'at' || !bossNear(v.floor, v.a.x)) return null;
  return newIntent('scatter', {});
};

const chatBeside = function (a, m, floor) {
  for (const p of coolerProps(floor)) if (Math.abs(p.cell - m.slot) === 1 && settledAt(p, floor).length >= 2) return true;
  for (const n of BH.speaking) if (n !== m && n.actor && n.actor.fr === a.fr && n.bubble && n.bubble.text !== 'SHH' && Math.abs(moodX(n) - a.x) < COOLER_NEAR) return true;
  return false;
};

const ruleShh = function (m, c) {
  const a = m.actor;
  if (!a || a.state !== 'working' || m.shh > S.t || m.bubble || !chatBeside(a, m, c.floor)) return null;
  return c.rnd() < 0.04 * c.chaos ? newIntent('shh', {}) : null;
};

const doWake = function (m) {
  const a = m.actor;
  if (!a) return;
  m.doze = 0; m.pose = null; m.busy = S.t + 0.5; m.cool = S.t + 20;
  hush(m);
  a.react = S.t;
  record(m, 'wake', 0, '', 'boss', '');
};

const doScatter = function (m) {
  const v = BH.visits.get(m.key);
  if (!v) return;
  v.scare = true;
  record(m, 'scatter', 0, '', 'boss', '');
};

const shhTask = function* (m) {
  yield* wait(SHH_SPAN);
  if (m.bubble && m.bubble.text === 'SHH') hush(m);
};

const doShh = function (m) {
  m.bubble = speech('SHH', S.t);
  if (!BH.speaking.includes(m)) BH.speaking.push(m);
  m.shh = S.t + SHH_COOLDOWN[0] + m.rnd() * SHH_COOLDOWN[1];
  record(m, 'shh', 0, '', '', 'SHH');
  spawn(shhTask(m));
};

const tickCoolers = function () {
  for (const v of [...BH.visits.values()]) {
    if (v.dead || v.phase !== 'at') continue;
    CTX.floor = v.floor; CTX.place = 'cooler'; CTX.rnd = v.m.rnd; CTX.chaos = CHAOS;
    const it = runRules(v.m, CTX, 'tick');
    if (it) DO[it.kind](v.m, it);
  }
};

const coolerSnapshot = () => [...BH.visits.values()].map((v) => ({ key: v.a.id, floor: v.floor, phase: v.phase, side: v.side, x: v.a.x, spot: v.x, prop: v.prop.kind, propX: v.prop.x, scare: v.scare }));
const propSnapshot = () => S.dyn.props.map((p) => ({ ...p }));
