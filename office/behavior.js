'use strict';

const CHAOS_RAW = Q.get('chaos');
const CHAOS = CHAOS_RAW !== null && CHAOS_RAW.trim() !== '' && Number.isFinite(Number(CHAOS_RAW)) ? clamp(Number(CHAOS_RAW), 0, 3) : 1;
const TICK = 0.5, CHAIN_CAP = 4, REACT_WINDOW = 3, REACT_LATENCY = 0.25, COOLDOWN = 4, SHUFFLE_STEP = 0.12, BORED_AT = 0.35, CHAT_SPAN = 6.6, LOG_CAP = 160;
const SAY = ['...', '?!', 'HMM', 'SO...', 'YEP', 'OH?'];
const ACTS = ['hop', 'stretch', 'look'];
const ACT_SPAN = { hop: 0.5, stretch: 1.6, look: 1.4 };

const newMood = function (key, actor, guest) {
  const h = hash(key), unit = (n) => (hn(h + n) % 1000) / 1000;
  return {
    key, actor, guest, slot: -1,
    chatty: unit(1), fidgety: unit(2), sleepy: unit(3),
    boredom: unit(4) * 0.4,
    rnd: rng(h ^ (Math.imul(Number(Q.get('seed')) || 0, 0x9e3779b1))),
    last: TYPE_ONLY ? { act: '', at: 0, chain: 1, root: '', from: '' } : null,
    pose: TYPE_ONLY ? { kind: '', t0: 0, dur: 0, dir: -1 } : null,
    bubble: TYPE_ONLY ? speech('', 0) : null,
    cool: 0, busy: 0, doze: 0, dozeState: '', trip: 0, shh: 0,
  };
};
const NOMOOD = TYPE_ONLY ? newMood('', B, -1) : null;

const newIntent = (kind, p) => ({ kind, rule: '', act: '', chain: 1, root: '', from: '', delay: 0, span: 0, other: NOMOOD, lean: NOMOOD, ...p });

const CTX = { place: '', floor: '', chaos: CHAOS, rnd: rng(1), rank: 0, left: NOMOOD, right: NOMOOD, left2: NOMOOD, right2: NOMOOD, near: TYPE_ONLY ? [newMood('', B, -1)] : [] };

const BH = {
  moods: new Map(TYPE_ONLY ? [['', newMood('', B, -1)]] : []),
  line: TYPE_ONLY ? [NOMOOD] : [],
  desk: TYPE_ONLY ? [NOMOOD] : [],
  speaking: TYPE_ONLY ? [newMood('', B, -1)] : [],
  log: TYPE_ONLY ? [{ t: 0, key: '', slot: 0, state: '', act: '', chain: 0, root: '', from: '', text: '' }] : [],
  visits: new Map(TYPE_ONLY ? [['', newVisit(B, newMood('', B, -1), { id: '', kind: '', x: 0, cell: 0 }, 0)]] : []),
  batch: { t: -9, ranks: new Map(TYPE_ONLY ? [['', 0]] : []) },
};

const quiet = () => !S.ready || !!UI.tour || UI.settings || !!S.anim;

const moodFor = function (key, actor, guest) {
  let m = BH.moods.get(key);
  if (!m) { m = newMood(key, actor, guest); BH.moods.set(key, m); }
  m.actor = actor;
  return m;
};

const lineSettled = (a) => a.q && a.fr === BOSS && !a.walking && !a.inCab && !a.gone && a !== S.focusVisitor && !(S.focus && S.focus.agentId === a.id) && Math.abs(a.x - lineX(slotOf(a.id))) < 1;
const deskSeated = (a, k) => !a.away && !a.visitor && !a.joining && !a.gone && !a.leaving && a.sit > 0.99 && a.slot === k;
const presentInLine = (m) => (m.guest >= 0 ? S.line[m.guest] === null : !!m.actor && lineSettled(m.actor));
const moodX = (m) => (m.guest >= 0 ? lineX(m.guest) : m.actor ? m.actor.x : 0);
const activePose = (m) => !!m.pose && S.t - m.pose.t0 < m.pose.dur;

const napping = function (a) {
  const m = BH.moods.get(a.id);
  return !!m && m.doze > S.t && a.state === m.dozeState && a.state === 'idle' && !a.away && S.t - a.react > 1.1;
};

const record = function (m, act, chain, root, from, text) {
  BH.log.push({ t: S.t, key: m.key, slot: m.slot, state: m.actor ? m.actor.state : 'guest', act, chain, root, from, text });
  if (BH.log.length > LOG_CAP) BH.log.shift();
};

const holdPose = function (m, kind, dir, dur) {
  m.pose = { kind, t0: S.t, dur, dir };
  m.busy = S.t + dur;
};

const pickAct = function (m, rnd) {
  const w = [0.6 + m.sleepy, 0.5 + m.chatty * 0.5, 0.3 + m.fidgety * 1.5];
  let r = rnd() * (w[0] + w[1] + w[2]);
  for (let i = 0; i < 3; i++) { r -= w[i]; if (r < 0) return ['stretch', 'look', 'hop'][i]; }
  return 'hop';
};

const ruleContagion = function (m, c) {
  if (m.cool > S.t) return null;
  for (const n of c.near) {
    const r = n.last;
    if (!r || r.chain >= CHAIN_CAP) continue;
    const age = S.t - r.at;
    if (age < REACT_LATENCY || age > REACT_WINDOW) continue;
    const p = 0.18 * Math.pow(0.75, r.chain - 1) * (0.7 + 0.6 * m.fidgety) * c.chaos;
    if (c.rnd() < p) return newIntent('act', { act: r.act, chain: r.chain + 1, root: r.root, from: n.key });
  }
  return null;
};

const ruleChat = function (m, c) {
  const r = c.right;
  if (!r || m.cool > S.t || r.cool > S.t || r.busy > S.t || m.boredom < BORED_AT || r.boredom < BORED_AT) return null;
  if (c.rnd() >= 0.08 * (m.chatty + r.chatty) * c.chaos) return null;
  const free = [c.left, c.right2].filter((x) => x && x.busy <= S.t && x.cool <= S.t);
  const lean = free.length && c.rnd() < 0.4 + 0.5 * m.chatty ? free[Math.floor(c.rnd() * free.length)] : NOMOOD;
  return newIntent('chat', { other: r, lean, span: CHAT_SPAN });
};

const ruleFidget = function (m, c) {
  if (m.cool > S.t || m.boredom < 1 - 0.55 * m.fidgety || c.rnd() > 0.6) return null;
  return newIntent('act', { act: pickAct(m, c.rnd), chain: 1, root: m.key });
};

const ruleShuffle = function (m, c) {
  if (c.rank < 1) return null;
  return newIntent('shuffle', { delay: c.rank * SHUFFLE_STEP * (0.85 + 0.3 * c.rnd()) });
};

const ruleSleepSpreads = function (m, c) {
  const a = m.actor;
  if (!a || a.state !== 'idle' || a.sleepy || m.doze > S.t || m.cool > S.t) return null;
  let drowsy = 0;
  for (const n of c.near) if (n.actor && n.actor.state === 'idle' && (n.actor.sleepy || napping(n.actor))) drowsy++;
  const p = (drowsy ? 0.06 + 0.1 * m.sleepy : 0.002 * m.sleepy) * c.chaos;
  return c.rnd() < p ? newIntent('doze', { span: 20 + c.rnd() * 25 }) : null;
};

const RULES = [
  { name: 'boss-wake', on: 'tick', place: 'desk', run: ruleBossWake },
  { name: 'boss-scatter', on: 'tick', place: 'cooler', run: ruleBossScatter },
  { name: 'contagion', on: 'tick', place: 'line', run: ruleContagion },
  { name: 'chat', on: 'tick', place: 'line', run: ruleChat },
  { name: 'fidget', on: 'tick', place: 'line', run: ruleFidget },
  { name: 'shh', on: 'tick', place: 'desk', run: ruleShh },
  { name: 'water-cooler', on: 'tick', place: 'desk', run: ruleCooler },
  { name: 'sleep-spreads', on: 'tick', place: 'desk', run: ruleSleepSpreads },
  { name: 'shuffle', on: 'move', place: 'line', run: ruleShuffle },
];

const say = function (m, text, other) {
  m.bubble = speech(text, S.t);
  if (!BH.speaking.includes(m)) BH.speaking.push(m);
  record(m, 'say', 0, '', other.key, text);
};
const hush = function (m) {
  m.bubble = null;
  const i = BH.speaking.indexOf(m);
  if (i >= 0) BH.speaking.splice(i, 1);
};

const chatTask = function* (x, y, z) {
  const pair = [x, y];
  holdPose(x, 'chat', 1, CHAT_SPAN); holdPose(y, 'chat', -1, CHAT_SPAN);
  if (z) holdPose(z, 'lean', z.slot < x.slot ? 1 : -1, CHAT_SPAN);
  record(x, 'chat', 0, '', y.key, '');
  if (z) record(z, 'lean', 0, '', x.key, '');
  const speakers = [x, y, x];
  for (let i = 0; i < speakers.length; i++) {
    yield* wait(0.35);
    if (quiet() || !pair.every(presentInLine)) break;
    const who = speakers[i];
    say(who, SAY[Math.floor(who.rnd() * SAY.length)], who === x ? y : x);
    yield* wait(1.3);
    hush(who);
  }
  for (const m of z ? [x, y, z] : pair) { hush(m); m.pose = null; m.busy = S.t + 0.5; m.cool = S.t + COOLDOWN; m.boredom = Math.min(m.boredom, 0.1); }
};

const DO = {
  act(m, it) {
    const root = it.root || m.key;
    m.last = { act: it.act, at: S.t, chain: it.chain, root, from: it.from };
    holdPose(m, it.act, -1, ACT_SPAN[it.act]);
    m.busy = S.t + ACT_SPAN[it.act] + 0.3;
    m.cool = S.t + COOLDOWN;
    m.boredom = 0;
    record(m, it.act, it.chain, root, it.from, '');
  },
  chat(m, it) {
    if (!it.other) return;
    spawn(chatTask(m, it.other, it.lean));
  },
  doze(m, it) {
    if (!m.actor) return;
    m.doze = S.t + it.span;
    m.dozeState = m.actor.state;
    m.cool = m.doze + 25;
    record(m, 'doze', 0, '', '', '');
  },
  shuffle() {},
  cooler(m, it) { startCooler(m, it.prop); },
  wake: doWake,
  scatter: doScatter,
  shh: doShh,
};

const runRules = function (m, c, on) {
  for (const r of RULES) {
    if (r.on !== on || r.place !== c.place) continue;
    const it = r.run(m, c);
    if (it) { it.rule = r.name; return it; }
  }
  return null;
};

const fillCtx = function (arr, i, m, place) {
  const c = CTX;
  c.place = place; c.rnd = m.rnd; c.chaos = CHAOS;
  c.left = arr[i - 1] || null; c.right = arr[i + 1] || null; c.left2 = arr[i - 2] || null; c.right2 = arr[i + 2] || null;
  c.near.length = 0;
  for (const n of [c.left, c.right, c.left2, c.right2]) if (n) c.near.push(n);
  return c;
};

const gatherLine = function () {
  const out = BH.line;
  out.length = 0;
  S.line.forEach((id, k) => {
    let m = NOMOOD;
    if (id === null) m = moodFor('g' + k, null, k);
    else { const a = S.agents.get(id); if (a && lineSettled(a)) m = moodFor(id, a, -1); }
    if (m) m.slot = k;
    out.push(m);
  });
};

const pruneMoods = function () {
  for (const [key, m] of BH.moods) if (m.guest >= 0 ? m.guest >= S.line.length : !S.agents.has(key)) { hush(m); BH.moods.delete(key); }
};

const tickLine = function () {
  gatherLine();
  const L = BH.line, rate = TICK * 0.05 * (0.5 + 0.5 * CHAOS);
  for (const m of L) if (m) m.boredom = Math.min(1, m.boredom + rate * (0.6 + 0.8 * m.fidgety));
  for (let i = 0; i < L.length; i++) {
    const m = L[i];
    if (!m || m.busy > S.t) continue;
    const it = runRules(m, fillCtx(L, i, m, 'line'), 'tick');
    if (it) DO[it.kind](m, it);
  }
};

const tickDesks = function () {
  const D = BH.desk;
  for (const [rid, ids] of S.slots) {
    if (!S.floors.includes(rid)) continue;
    D.length = 0;
    CTX.floor = rid;
    ids.forEach((id, k) => {
      const a = id ? S.agents.get(id) : null;
      const m = a && deskSeated(a, k) ? moodFor(a.id, a, -1) : NOMOOD;
      if (m) m.slot = k;
      D.push(m);
    });
    for (let i = 0; i < D.length; i++) {
      const m = D[i];
      if (!m) continue;
      if (m.doze > 0 && !napping(m.actor || B)) m.doze = 0;
      const it = runRules(m, fillCtx(D, i, m, 'desk'), 'tick');
      if (it) DO[it.kind](m, it);
    }
  }
};

const tickBehavior = function () {
  if (!CHAOS || quiet()) return;
  tickLine();
  tickDesks();
  tickCoolers();
  pruneMoods();
};

const behaviorProc = function* () {
  for (;;) {
    yield* wait(TICK);
    tickBehavior();
  }
};

const moveDelay = function (a) {
  if (!CHAOS || quiet()) return 0;
  const b = BH.batch;
  if (S.t - b.t > 0.2) {
    b.t = S.t; b.ranks.clear();
    let k = 0;
    for (const id of S.want) {
      const w = S.agents.get(id);
      if (w && w.q && w.fr === BOSS && !w.walking && !w.inCab && Math.abs(w.x - lineX(slotOf(id))) > 0.5) b.ranks.set(id, k++);
    }
  }
  const m = moodFor(a.id, a, -1);
  const c = CTX;
  c.place = 'line'; c.rnd = m.rnd; c.rank = b.ranks.get(a.id) || 0;
  const it = runRules(m, c, 'move');
  return it ? it.delay : 0;
};

const POSE_OUT = { dir: -1, hop: 0, arms: false, face: '' };
const waiterPose = function (m) {
  const o = POSE_OUT;
  o.dir = -1; o.hop = 0; o.arms = false; o.face = '';
  const p = m && m.pose;
  if (!m || !p) return o;
  const k = (S.t - p.t0) / p.dur;
  if (k < 0 || k >= 1) return o;
  if (p.kind === 'hop') { o.hop = Math.abs(Math.sin(k * Math.PI * 2)) * 4; o.face = 'happy'; }
  else if (p.kind === 'stretch') { o.arms = true; o.face = 'yawn'; }
  else if (p.kind === 'look') { if (k > 0.2 && k < 0.7) o.dir = 1; }
  else { o.dir = p.dir; if (p.kind === 'chat') o.face = m.bubble ? 'happy' : 'wait'; }
  return o;
};

const drawBehaviorBubbles = function () {
  for (const m of BH.speaking) if (m.bubble) drawBubble({ x: moodX(m), fr: m.actor && m.guest < 0 ? m.actor.fr : BOSS, inCab: false, bubble: m.bubble });
};

const behaviorSnapshot = function () {
  const poses = [];
  for (const m of BH.moods.values()) {
    if (!activePose(m) && !m.bubble) continue;
    poses.push({ key: m.key, slot: m.slot, kind: m.pose ? m.pose.kind : '', dir: m.pose ? m.pose.dir : 0, text: m.bubble ? m.bubble.text : '', x: moodX(m) });
  }
  return {
    chaos: CHAOS, cap: CHAIN_CAP, t: S.t, moods: BH.moods.size,
    log: BH.log.map((e) => ({ ...e })),
    poses,
    cooler: coolerSnapshot(),
    props: propSnapshot(),
    dozing: [...S.agents.values()].filter(napping).map((a) => a.id),
    traits: [...BH.moods.values()].map((m) => ({ key: m.key, chatty: m.chatty, fidgety: m.fidgety, sleepy: m.sleepy, boredom: m.boredom })),
  };
};
