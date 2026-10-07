'use strict';

let SERVER = false;

const localView = function (raw) {
  const order = S.set.order;
  const rank = (room) => { let i = order.indexOf(room.id); if (i < 0) i = order.findIndex((x) => x.toLowerCase() === room.label.toLowerCase()); return i < 0 ? 1e9 : i; };
  const rooms = raw.rooms.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => ({ id: x.r.id, label: x.r.label }));
  if (S.set.anonymize) rooms.forEach((r, i) => { r.label = 'Room ' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''); });
  const rIdx = new Map(rooms.map((r, i) => [r.id, i]));
  const agents = raw.agents.map((a) => { const o = { ...a }; if (!S.set.titles) delete o.title; return o; });
  const queue = raw.queue || agents.filter((a) => a.state === 'waiting').sort((a, b) => rIdx.get(a.room) - rIdx.get(b.room) || (a.since || 0) - (b.since || 0)).map((a) => a.id);
  return { ...raw, rooms, agents, queue };
};

const applyState = function (raw) {
  S.last = raw;
  const oldRooms = S.rooms, oldSlots = S.slots, oldWall = S.wall, oldLH = S.LH;
  const efid = E.moving ? null : S.floors[Math.round(E.fy)];
  const first = !S.gotState;
  S.gotState = true;
  const s = SERVER ? raw : localView(raw);
  const oldFloors = S.floors.slice();
  const gen = s.generatedAt || Date.now();
  const joinIds = new Set();
  if (!first) for (const e of s.events || []) if (e.kind === 'join' && gen - e.at < 20000 && !S.joined.has(e.id)) { S.joined.add(e.id); joinIds.add(e.agentId); }
  if (S.joined.size > 300) S.joined = new Set([...S.joined].slice(-100));
  const joiners = [];
  const present = new Set();
  for (const d of s.agents) {
    present.add(d.id);
    let a = S.agents.get(d.id);
    if (!a) {
      a = newAgent(d); S.agents.set(a.id, a);
      if (joinIds.has(d.id)) { a.joining = true; a.away = true; a.fr = LOBBY; a.x = BM + 14; a.sit = 0; a.facing = 1; joiners.push(a); }
    }
    a.name = d.name; a.state = d.state; a.sleepy = !!d.sleepy; a.gone = false; a.title = d.title || '';
    if (a.room !== d.room) { a.room = d.room; if (!a.away) a.fr = d.room; }
  }
  const leavers = [];
  for (const [id, a] of [...S.agents]) {
    if (a.visitor || present.has(id) || a.leaving) continue;
    if (a.away) a.gone = true;
    else if (S.ready && !first && a.slot >= 0 && !a.joining) { a.gone = true; a.leaving = true; leavers.push(a); }
    else S.agents.delete(id);
  }
  S.rooms = s.rooms.map((r) => ({ id: r.id, label: r.label }));
  for (const r of oldRooms) if (!S.rooms.some((x) => x.id === r.id) && [...S.agents.values()].some((a) => a.leaving && a.room === r.id)) S.rooms.splice(Math.min(oldRooms.indexOf(r), S.rooms.length), 0, { id: r.id, label: r.label });
  const roomIds = new Set(S.rooms.map((r) => r.id));
  const slots = new Map();
  for (const r of S.rooms) {
    const prev = (S.slots.get(r.id) || []).map((id) => { const a = S.agents.get(id); return a && (!a.gone || a.leaving) && a.room === r.id ? id : null; });
    const arr = prev.slice();
    for (const d of s.agents) {
      if (d.room !== r.id || arr.includes(d.id)) continue;
      const free = arr.indexOf(null);
      if (free >= 0) arr[free] = d.id; else if (arr.length < MAXS) arr.push(d.id);
    }
    while (arr.length && arr[arr.length - 1] === null) arr.pop();
    slots.set(r.id, arr);
  }
  S.slots = slots;
  for (const a of S.agents.values()) {
    if (a.visitor) continue;
    const arr = slots.get(a.room);
    a.slot = arr ? arr.indexOf(a.id) : -1;
    if (a.slot < 0 && !a.away) S.agents.delete(a.id);
  }
  S.floors = [BOSS, ...S.rooms.map((r) => r.id), LOBBY];
  assignWalls();
  S.queue = (s.queue || []).slice();
  const added = S.floors.filter((id) => !oldFloors.includes(id));
  const removed = oldFloors.filter((id) => !S.floors.includes(id));
  const moved = S.floors.some((id) => oldFloors.includes(id) && oldFloors.indexOf(id) !== S.floors.indexOf(id));
  const reorder = S.ready && !first && (added.length > 0 || removed.length > 0 || moved);
  const ghosts = removed.map((id) => ({ id, i: oldFloors.indexOf(id), label: (oldRooms.find((r) => r.id === id) || {}).label || '', slots: (oldSlots.get(id) || []).map((x) => (x && S.agents.has(x) ? x : null)), wall: oldWall.get(id) }));
  for (const a of S.agents.values()) if (!roomIds.has(a.fr) && a.fr !== LOBBY && a.fr !== BOSS && !a.away) a.fr = a.room;
  const ei = typeof efid === 'string' ? S.floors.indexOf(efid) : -1;
  E.fy = ei >= 0 ? ei : clamp(E.fy, 0, S.floors.length - 1);
  E.fid = reorder && ei >= 0 && !E.moving ? efid : null;
  const list = [...S.agents.values()].filter((a) => !a.visitor && !a.gone);
  const c = { working: 0, waiting: 0, idle: 0 };
  for (const a of list) c[a.state]++;
  S.counts = c;
  S.msg = '';
  statEl.textContent = `${c.working} working, ${c.waiting} waiting, ${c.idle} idle (${DEMO ? 'demo' : 'live'})`;
  const sig = S.rooms.map((r) => r.id + r.label + (slots.get(r.id) || []).map((id) => { const a = id && S.agents.get(id); return a ? a.name : '-'; }).join(',')).join('|') + `:${c.working}:${c.waiting}:${c.idle}`;
  const changed = sig !== S.sig;
  S.sig = sig;
  S.working = c.working + c.waiting;
  S.total = list.length;
  if (changed || !S.ready) layout(); else snapSeated();
  if (reorder) beginAnim(oldFloors, added, ghosts, oldLH);
  for (const a of joiners) spawn(joinTask(a));
  leavers.forEach((a, k) => spawn(k < 3 ? leaveTask(a) : fadeTask(a)));
  UI.dirty = true;
  maybeStartTour();
};

const seen = new Set();
let firstLoad = true;
const handleEvents = function (s) {
  const now = s.generatedAt || Date.now();
  for (const e of s.events || []) {
    if (e.kind === 'join' || seen.has(e.id)) continue;
    seen.add(e.id);
    if (firstLoad && now - e.at > 8000) continue;
    if (now - e.at > 20000) continue;
    if (e.kind === 'boss_visit') { if (!UI.tour) pushVisit(e.to); }
    else startTrip(e.from, e.to, TEXTS[hash(e.id) % TEXTS.length]);
  }
  if (seen.size > 500) { const keep = [...seen].slice(-200); seen.clear(); keep.forEach((k) => seen.add(k)); }
  if (s.focus && s.focus.agentId) setFocus(s.focus.agentId, s.focus.at); else setFocus(null);
  firstLoad = false;
};

const hudMessage = function (m) { S.msg = m; statEl.textContent = m; if (S.ready) drawStatic(); };

const poll = async function () {
  if (document.hidden || S.posting) return;
  try {
    const r = await fetch('state.json', { cache: 'no-store' });
    const s = await r.json();
    if (S.posting) return;
    applyState(s); handleEvents(s);
  } catch {
    hudMessage('offline - run node scan.mjs');
  }
};

const LS_KEY = DEMO ? 'so.settings.demo' : 'so.settings';
const cleanSet = (o) => {
  const r = { ...DEF_SET };
  if (!o || typeof o !== 'object') return r;
  if (Array.isArray(o.order)) r.order = [...new Set(o.order.filter((x) => typeof x === 'string' && x.length <= 64))].slice(0, 64);
  for (const k of ['anonymize', 'titles', 'sound']) if (typeof o[k] === 'boolean') r[k] = o[k];
  if ([1, 2, 3].includes(o.speed)) r.speed = o.speed;
  if (typeof o.onboardedAt === 'string') r.onboardedAt = o.onboardedAt;
  return r;
};
const lsRead = function () { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); } catch { return null; } };
const lsWrite = function (o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {} };

let postChain = Promise.resolve();
const saveSet = function (patch) {
  S.set = cleanSet({ ...S.set, ...patch });
  if (!SERVER) { lsWrite(S.set); return Promise.resolve(); }
  S.posting++;
  const body = JSON.stringify(patch);
  postChain = postChain
    .then(() => fetch('settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    .then(async (r) => { if (r.ok) S.set = cleanSet(await r.json()); })
    .catch(() => {})
    .then(() => { S.posting--; if (!S.posting) poll(); });
  return postChain;
};

const loadSettings = async function () {
  if (!DEMO && location.protocol.startsWith('http')) {
    try {
      const r = await fetch('settings', { cache: 'no-store' });
      if (r.ok) { S.set = cleanSet(await r.json()); SERVER = true; }
    } catch {}
  }
  if (!SERVER) S.set = cleanSet(lsRead());
  S.setReady = true;
};
