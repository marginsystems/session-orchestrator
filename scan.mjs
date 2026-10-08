import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, basename, dirname, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isHumanPrompt } from './lib/prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT = /^\/office\/[a-z-]+\.js$/;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OPTS = {
  once: flag('--once'),
  port: Number(opt('--port', '7777')),
  anonymize: flag('--anonymize-rooms'),
  titles: flag('--show-titles'),
  max: Number(opt('--max', '80')),
};

const DATA_DIR = join(homedir(), '.session-orchestrator');
const FOCUS_FILE = join(DATA_DIR, 'focus.json');
const QUEUE_FILE = join(DATA_DIR, 'queue.json');
const QUEUE_MAX = 200;
const CHECKIN_FILE = join(DATA_DIR, 'checkins.json');
const CHECKIN_MS = 24 * 3600 * 1000;
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const SETTINGS_MAX_BYTES = 4096;
const ORDER_MAX = 64;
const SPEEDS = [1, 2, 3];
const FOCUS_MAX_MS = 24 * 3600 * 1000;
const PROJECTS = join(homedir(), '.claude', 'projects');
const DESKTOP_SESSIONS = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const WINDOW_MS = 7 * 24 * 3600 * 1000;
const WORKING_MS = 30 * 1000;
const PENDING_WORKING_MS = 120 * 1000;
const SLEEPY_MS = 30 * 60 * 1000;
const EVENT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 400 * 1024;
const HEAD_BYTES = 128 * 1024;
const MAX_PER_ROOM = 24;
const MAX_ROOMS = 12;

const NAMES = [
  'Fern', 'Moss', 'Juniper', 'Pebble', 'Sage', 'Wren', 'Basil', 'Cedar', 'Clover', 'Ash', 'Willow', 'Hazel',
  'Maple', 'Olive', 'Ivy', 'Rowan', 'Briar', 'Thistle', 'Marlow', 'Reed', 'Lark', 'Birch', 'Alder', 'Sorrel',
  'Tansy', 'Quill', 'Nettle', 'Poppy', 'Linden', 'Aspen', 'Heron', 'Finch', 'Dune', 'Cove', 'Ember', 'Flint',
  'Gale', 'Indigo', 'Jasper', 'Kestrel', 'Lupin', 'Mica', 'Nova', 'Onyx', 'Pip', 'Quartz', 'Rue', 'Slate',
  'Tern', 'Umber', 'Vale', 'Wisp', 'Yarrow', 'Zinnia', 'Acorn', 'Bramble', 'Cinder', 'Drift', 'Echo', 'Fable',
  'Garnet', 'Haze', 'Iris', 'Jade',
];

const sha = (s) => createHash('sha1').update(s).digest('hex');
const num = (s) => parseInt(sha(s).slice(0, 8), 16);

function readRange(path, start, length) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

function readTail(path, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  let text = readRange(path, start, size - start);
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  return text;
}

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/g;

const slugOf = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function lastCwd(text, slug) {
  let last = null;
  let launch = null;
  for (const m of text.matchAll(CWD_RE)) {
    let cwd;
    try {
      cwd = JSON.parse('"' + m[1] + '"');
    } catch {
      continue;
    }
    last = cwd;
    if (slugOf(cwd) === slug) launch = cwd;
  }
  return launch || last;
}

const MSG_RE = /<cross-session-message[^>]*?from(?:-session)?=\\?"(local_[0-9a-fA-F-]+)\\?"/g;

function analyzeFile(path, size) {
  const tail = readTail(path, size);
  const slug = basename(dirname(path));
  let cwd = lastCwd(tail, slug);
  if (!cwd || slugOf(cwd) !== slug) cwd = lastCwd(readRange(path, 0, Math.min(size, HEAD_BYTES)), slug) || cwd;
  let last;
  const messages = [];
  const prompts = [];
  const seen = new Set();
  for (const line of tail.split('\n')) {
    if (!line) continue;
    if (!line.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message && o.message.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) && !content.some((b) => b && b.type === 'tool_result') ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text) : [];
    if (o.type === 'user' && !o.isSidechain && texts.some((text) => text.includes('<cross-session-message'))) {
      const at = Date.parse(o.timestamp);
      if (Number.isFinite(at)) {
        for (const text of texts) {
          for (const m of text.matchAll(MSG_RE)) {
            const key = m[1] + ':' + Math.floor(at / 10000);
            if (!seen.has(key)) {
              seen.add(key);
              messages.push({ from: m[1], at });
            }
          }
        }
      }
    }
    if (o.type === 'user' && isHumanPrompt(o)) {
      const at = Date.parse(o.timestamp);
      if (Number.isFinite(at)) prompts.push({ at });
    }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain) continue;
    const c = o.message && o.message.content;
    const blocks = Array.isArray(c) ? c : [];
    if (o.type === 'assistant') {
      last = { kind: blocks.some((b) => b && b.type === 'tool_use') ? 'tool_use' : 'reply' };
    } else {
      last = { kind: blocks.some((b) => b && b.type === 'tool_result') ? 'tool_result' : 'prompt' };
    }
  }
  return { cwd, last: last ?? null, messages, prompts };
}

const fileCache = new Map();
const known = new Set();
const joinAt = new Map();
let scanned = false;

function analyzeCached(path, st) {
  const key = st.mtimeMs + ':' + st.size;
  const hit = fileCache.get(path);
  if (hit && hit.key === key) return hit.value;
  let value;
  try {
    value = analyzeFile(path, st.size);
  } catch {
    value = { cwd: null, last: null, messages: [], prompts: [] };
  }
  fileCache.set(path, { key, value });
  return value;
}

const desktopCache = new Map();

function sidebarSessions(desktop) {
  let account = '', newest = -1;
  for (const rec of desktop.values()) if (rec.last > newest) { newest = rec.last; account = rec.account; }
  const out = new Set();
  for (const rec of desktop.values()) if (rec.account === account && !rec.archived) out.add(rec.cli);
  return out;
}

function desktopSessions() {
  const out = Object.assign(new Map(), { available: false });
  let level1;
  try {
    level1 = readdirSync(DESKTOP_SESSIONS);
  } catch {
    return out;
  }
  let complete = true;
  for (const a of level1) {
    let level2;
    try {
      level2 = readdirSync(join(DESKTOP_SESSIONS, a));
    } catch {
      complete = false;
      continue;
    }
    for (const b of level2) {
      let files;
      try {
        files = readdirSync(join(DESKTOP_SESSIONS, a, b));
      } catch {
        complete = false;
        continue;
      }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        const p = join(DESKTOP_SESSIONS, a, b, f);
        let st;
        try {
          st = statSync(p);
        } catch {
          complete = false;
          continue;
        }
        let rec = desktopCache.get(p);
        if (!rec || rec.mtimeMs !== st.mtimeMs) {
          try {
            const j = JSON.parse(readFileSync(p, 'utf8'));
            rec = { mtimeMs: st.mtimeMs, local: j.sessionId, cli: j.cliSessionId, title: j.title, archived: j.isArchived === true, account: a, last: Number(j.lastActivityAt) || 0 };
          } catch {
            rec = { mtimeMs: st.mtimeMs };
          }
          desktopCache.set(p, rec);
        }
        if (rec.local && rec.cli) out.set(rec.local, rec);
      }
    }
  }
  out.available = complete;
  return out;
}

function roomRoot(cwd) {
  const m = /^(.*?)\/\.(?:claude|codex)\/worktrees\//.exec(cwd);
  return m && m[1] ? m[1] : cwd.replace(/\/+$/, '') || '/';
}

const REMOTE_RE = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/;
const repoNames = new Map();

function repoName(root) {
  if (repoNames.has(root)) return repoNames.get(root);
  let name = '';
  try {
    let gitDir = join(root, '.git');
    if (statSync(gitDir).isFile()) {
      const dir = resolvePath(root, readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
      let common = '';
      try {
        common = readFileSync(join(dir, 'commondir'), 'utf8').trim();
      } catch {}
      gitDir = common ? resolvePath(dir, common) : dir;
    }
    const m = REMOTE_RE.exec(readFileSync(join(gitDir, 'config'), 'utf8'));
    if (m) name = basename(m[1].replace(/\/+$/, '')).replace(/\.git$/, '');
  } catch {}
  repoNames.set(root, name);
  return name;
}

function roomLabel(root) {
  if (root === homedir()) return 'home';
  return repoName(root) || basename(root) || '/';
}


const DEFAULT_SETTINGS = { order: new Array(), anonymize: false, titles: false, speed: 1, sound: false, onboardedAt: null, streamer: false, onAir: new Array() };
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
// eslint-disable-next-line no-control-regex
const ORDER_ITEM_RE = /^[^\u0000-\u001f<>]{1,64}$/;

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object' };
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!SETTING_KEYS.includes(k)) return { error: 'unknown key ' + k.slice(0, 40) };
    if (k === 'order' || k === 'onAir') {
      if (!Array.isArray(v) || v.length > ORDER_MAX) return { error: k + ' must be an array of at most ' + ORDER_MAX };
      if (!v.every((x) => typeof x === 'string' && ORDER_ITEM_RE.test(x))) return { error: k + ' items must be short strings' };
      if (new Set(v).size !== v.length) return { error: k + ' items must be unique' };
      out[k] = v;
    } else if (k === 'speed') {
      if (!SPEEDS.includes(v)) return { error: 'speed must be one of ' + SPEEDS.join(', ') };
      out.speed = v;
    } else if (k === 'onboardedAt') {
      if (v !== null && !(typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)))) return { error: 'onboardedAt must be null or an ISO date' };
      out.onboardedAt = v;
    } else {
      if (typeof v !== 'boolean') return { error: k + ' must be a boolean' };
      out[k] = v;
    }
  }
  return { value: out };
}

function readFocus(now, desktop) {
  try {
    const f = JSON.parse(readFileSync(FOCUS_FILE, 'utf8'));
    const at = Date.parse(f.at);
    const sid = typeof f.sessionId === 'string' ? f.sessionId : '';
    if (sid && Number.isFinite(at) && at <= now && now - at < FOCUS_MAX_MS) {
      return { uuid: toUuid(sid, desktop), at };
    }
  } catch {}
  return null;
}

const sessionGone = (sid, desktop) => {
  if (typeof sid !== 'string' || !sid || !desktop.available) return false;
  const rec = sid.startsWith('local_') ? desktop.get(sid) : [...desktop.values()].find((r) => r.cli === sid);
  return sid.startsWith('local_') ? !rec || rec.archived === true : Boolean(rec && rec.archived);
};

const toUuid = (sid, desktop) => {
  if (typeof sid !== 'string' || !sid) return '';
  const uuid = sid.startsWith('local_') ? (desktop.get(sid) || {}).cli : sid;
  return typeof uuid === 'string' ? uuid : '';
};

function readQueue(now, desktop, source) {
  try {
    const f = source === undefined ? JSON.parse(readFileSync(QUEUE_FILE, 'utf8')) : source;
    const at = Date.parse(f.at);
    if (!Number.isFinite(at) || at > now + 60000 || now - at >= FOCUS_MAX_MS || !Array.isArray(f.items)) return { uuids: [], slots: [], gone: [], size: 0, orchestrator: toUuid(f.orchestrator, desktop) };
    const items = f.items.slice(0, QUEUE_MAX);
    const uuids = [];
    const slots = [];
    const gone = [];
    for (const it of items) {
      const sid = typeof it === 'string' ? it : it && it.sessionId;
      const isGone = sessionGone(sid, desktop);
      const uuid = isGone ? '' : toUuid(sid, desktop);
      const fresh = uuid !== '' && !uuids.includes(uuid);
      if (fresh) uuids.push(uuid);
      slots.push(fresh ? uuid : '');
      gone.push(isGone);
    }
    return { uuids, slots, gone, size: items.length - gone.filter(Boolean).length, orchestrator: toUuid(f.orchestrator, desktop) };
  } catch {
    return { uuids: [], slots: [], gone: [], size: 0, orchestrator: '' };
  }
}

function loadSettings() {
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf8');
    if (raw.length > SETTINGS_MAX_BYTES * 4) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    const kept = {};
    for (const k of SETTING_KEYS) {
      if (!(k in parsed)) continue;
      const r = validateSettings({ [k]: parsed[k] });
      if (r.value) Object.assign(kept, r.value);
    }
    return { ...DEFAULT_SETTINGS, ...kept };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let settings = loadSettings();

function saveSettings(next) {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = SETTINGS_FILE + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, SETTINGS_FILE);
}

const anonymizing = () => OPTS.anonymize || settings.anonymize;
const showingTitles = () => OPTS.titles || settings.titles;
const OFF_AIR_LABEL = 'OFF AIR';
const onAirRooms = () => new Set(settings.onAir);

function priorityRank(room) {
  const order = settings.order;
  let i = order.indexOf(room.id);
  if (i < 0) i = order.findIndex((x) => x.toLowerCase() === roomLabel(room.root).toLowerCase());
  return i < 0 ? Infinity : i;
}

let roomLabelsNow = new Array();

function scanFull(now = Date.now(), queueSource) {
  const desktop = desktopSessions();
  const cliToLocal = new Map();
  for (const rec of desktop.values()) cliToLocal.set(rec.cli, rec);
  const listed = sidebarSessions(desktop);

  const found = [];
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS);
  } catch {}
  for (const d of dirs) {
    let files;
    try {
      files = readdirSync(join(PROJECTS, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(PROJECTS, d, f);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const uuid = f.slice(0, -6);
      if (!st.isFile() || (desktop.size ? !listed.has(uuid) : now - st.mtimeMs > WINDOW_MS)) continue;
      found.push({ p, uuid, mtime: st.mtimeMs, st });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  if (!scanned) {
    for (const f of found) known.add(f.uuid);
    scanned = true;
  } else {
    for (const f of found) {
      if (known.has(f.uuid)) continue;
      known.add(f.uuid);
      if (now - f.st.birthtimeMs < WINDOW_MS) joinAt.set(f.uuid, now);
    }
  }

  const wanted = readFocus(now, desktop);
  const focusUuid = wanted ? wanted.uuid : '';

  const rooms = new Map();
  const picked = [];
  const queueFile = readQueue(now, desktop, queueSource);
  const queued = queueFile.uuids;
  const streaming = settings.streamer;
  const air = onAirRooms();
  const first = [focusUuid, ...queued].map((u) => found.find((s) => s.uuid === u)).filter((s) => s !== undefined);
  const candidates = [...new Set([...first, ...found])];
  for (const s of candidates) {
    if (picked.length >= OPTS.max) break;
    const info = analyzeCached(s.p, s.st);
    if (!info.cwd) continue;
    const root = roomRoot(info.cwd);
    let room = rooms.get(root);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) continue;
      room = { root, count: 0, id: 'r' + sha(root).slice(0, 6) };
      rooms.set(root, room);
    }
    if (room.count >= MAX_PER_ROOM) continue;
    room.count++;
    picked.push({ ...s, info, room });
  }
  picked.sort((a, b) => b.mtime - a.mtime);
  const airUuids = new Set(picked.filter((s) => !streaming || air.has(s.room.id)).map((s) => s.uuid));
  const slotOnAir = queueFile.slots.map((u, i) => !queueFile.gone[i] && (!streaming || (u !== '' && airUuids.has(u))));
  const queuedAir = queued.filter((u) => airUuids.has(u));
  const waitingSet = new Set(queuedAir);

  const names = new Set();
  const byUuid = new Map();
  const agents = [];
  for (const s of picked) {
    const age = now - s.mtime;
    const kind = s.info.last && s.info.last.kind;
    let state = 'idle';
    if (age < WORKING_MS) state = 'working';
    else if (kind === 'tool_use' && age < PENDING_WORKING_MS) state = 'working';
    else if (kind === 'prompt' && age < PENDING_WORKING_MS) state = 'working';
    if (waitingSet.has(s.uuid)) state = 'waiting';
    let name = NAMES[num(s.uuid) % NAMES.length];
    for (let n = 2; names.has(name); n++) name = NAMES[num(s.uuid) % NAMES.length] + ' ' + n;
    names.add(name);
    const agent = { id: 'a' + sha(s.uuid).slice(0, 8), name, room: s.room.id, state };
    if (state === 'idle' && age > SLEEPY_MS) agent.sleepy = true;
    if (showingTitles() && !(streaming && !air.has(s.room.id))) {
      const rec = cliToLocal.get(s.uuid);
      if (rec && rec.title) agent.title = String(rec.title);
    }
    byUuid.set(s.uuid, agent);
    agents.push({ agent, s, state });
  }

  const events = [];
  for (const { agent, s } of agents) {
    for (const m of s.info.messages) {
      if (now - m.at > EVENT_MS) continue;
      const rec = desktop.get(m.from);
      const sender = rec && byUuid.get(rec.cli);
      const from = sender ? sender.id : 'visitor';
      events.push({ id: 'e' + sha(from + agent.id + Math.floor(m.at / 1000)).slice(0, 10), kind: 'message', at: m.at, from, to: agent.id });
    }
    for (const p of s.info.prompts) {
      if (now - p.at > EVENT_MS || s.uuid === queueFile.orchestrator) continue;
      events.push({ id: 'p' + sha('boss' + agent.id + Math.floor(p.at / 1000)).slice(0, 10), kind: 'boss_visit', at: p.at, to: agent.id });
    }
    const joined = joinAt.get(s.uuid);
    if (joined !== undefined && now - joined < EVENT_MS) events.push({ id: 'j' + sha('join' + s.uuid).slice(0, 10), kind: 'join', at: joined, agentId: agent.id });
  }
  events.sort((a, b) => a.at - b.at);

  const target = focusUuid ? byUuid.get(focusUuid) : null;
  const focused = focusUuid ? agents.find((x) => x.s.uuid === focusUuid) : undefined;
  const answered = !!wanted && !!focused && [...focused.s.info.prompts, ...focused.s.info.messages].some((p) => p.at > wanted.at);
  const focus = wanted && !answered ? { agentId: target ? target.id : 'visitor', at: wanted.at } : null;

  const ordered = [...rooms.values()].sort((a, b) => {
    const ra = priorityRank(a), rb = priorityRank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return roomLabel(a.root).localeCompare(roomLabel(b.root));
  });
  const shownLabel = (r, i) => (anonymizing() ? 'Room ' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '') : roomLabel(r.root));
  const realLabels = ordered.map((r, i) => ({ id: r.id, label: shownLabel(r, i) }));
  const outRooms = ordered.map((r, i) => (streaming && !air.has(r.id) ? { id: r.id, label: OFF_AIR_LABEL, offAir: true } : { id: r.id, label: shownLabel(r, i) }));
  const foundUuids = new Set(found.map((s) => s.uuid));
  const queue = queuedAir.filter((u) => foundUuids.has(u)).map((u) => byUuid.get(u)?.id || 'a' + sha(u).slice(0, 8));
  const line = queueFile.slots.filter((u, i) => slotOnAir[i]).map((u) => { const a = u ? byUuid.get(u) : undefined; return a ? a.id : null; });
  const snap = { generatedAt: now, rooms: outRooms, agents: agents.map((a) => a.agent), events, focus, queue, queueSize: line.length, deferred: queueFile.size - line.length, line };
  roomLabelsNow = realLabels;
  const rank = new Map(ordered.map((r, i) => [r.id, i]));
  const asleep = agents
    .filter(({ s, state }) => state === 'idle' && now - s.mtime > SLEEPY_MS && s.uuid !== queueFile.orchestrator && (!streaming || air.has(s.room.id)))
    .sort((a, b) => (rank.get(a.s.room.id) ?? 0) - (rank.get(b.s.room.id) ?? 0) || a.s.mtime - b.s.mtime)
    .map(({ s }) => s.uuid);
  return { snap, slotOnAir, asleep };
}

const scan = (now) => scanFull(now).snap;

function counts(snap) {
  const c = { working: 0, waiting: 0, idle: 0 };
  for (const a of snap.agents) c[a.state]++;
  return `rooms=${snap.rooms.length} agents=${snap.agents.length} working=${c.working} waiting=${c.waiting} idle=${c.idle} events=${snap.events.length}`;
}

const URL_BASE = `http://127.0.0.1:${OPTS.port}`;

function probe() {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: OPTS.port, path: '/state.json', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const CONTEXT_WINDOWS = new Map([['claude-opus-5-5', 1000000]]);

function contextWindow(model) {
  if (/\[1m\]$/i.test(model)) return 1000000;
  return CONTEXT_WINDOWS.get(model) || 0;
}

function contextUsage(path, size) {
  let tokens = 0, model = '';
  for (const line of readTail(path, size).split('\n')) {
    let message;
    try { message = JSON.parse(line).message; } catch { continue; }
    const usage = message?.usage;
    if (message?.model === '<synthetic>') continue;
    if (usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.cache_creation_input_tokens) && Number.isFinite(usage.cache_read_input_tokens)) {
      tokens = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
      model = typeof message.model === 'string' ? message.model : '';
    }
  }
  return { tokens, model };
}

function recentCheckins(now, desktop) {
  const out = new Set();
  try {
    const f = JSON.parse(readFileSync(CHECKIN_FILE, 'utf8'));
    for (const it of Array.isArray(f.items) ? f.items : []) {
      const at = Date.parse(it && it.at);
      if (Number.isFinite(at) && at <= now + 60000 && now - at < CHECKIN_MS) out.add(toUuid(it.sessionId, desktop));
    }
  } catch {}
  return out;
}

function sessionLines(sid, rec, uuid, now) {
  let file = '';
  try {
    for (const d of readdirSync(PROJECTS)) {
      const p = join(PROJECTS, d, uuid + '.jsonl');
      try {
        if (statSync(p).isFile()) { file = p; break; }
      } catch {}
    }
  } catch {}
  let project = 'unknown', tokens = 0, model = '';
  if (file) {
    let st;
    try { st = statSync(file); } catch {}
    if (st) {
      const info = analyzeCached(file, st);
      if (info.cwd) project = roomLabel(roomRoot(info.cwd));
      ({ tokens, model } = contextUsage(file, st.size));
    }
  }
  const windowSize = contextWindow(model);
  return [
    'SESSION_ID: ' + JSON.stringify(sid),
    'TITLE: ' + JSON.stringify(rec && rec.title ? String(rec.title) : 'unknown'),
    'TITLE_AVAILABLE: ' + Boolean(rec && rec.title),
    'PROJECT: ' + JSON.stringify(project),
    'CONTEXT_TOKENS: ' + (tokens || 'unknown'),
    'CONTEXT_MODEL: ' + JSON.stringify(model || 'unknown'),
    'CONTEXT_PERCENT: ' + (tokens && windowSize ? Math.round((tokens / windowSize) * 100) : 'unknown'),
    'CHECKED_AT: ' + new Date(now).toISOString(),
  ].join('\n');
}

function checkIn(now, desktop, full, head) {
  const asked = recentCheckins(now, desktop);
  const byCli = new Map([...desktop.values()].map((r) => [r.cli, r]));
  const uuid = full.asleep.find((u) => !asked.has(u) && byCli.get(u)?.title);
  const rec = uuid ? byCli.get(uuid) : undefined;
  if (!uuid || !rec) return head;
  return head + '\nCHECK_IN: idle\n' + sessionLines(rec.local, rec, uuid, now);
}

function nextInfo() {
  const now = Date.now();
  const desktop = desktopSessions();
  let queueSource;
  let items = [];
  try {
    queueSource = JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
    const at = Date.parse(queueSource.at);
    if (Number.isFinite(at) && at <= now + 60000 && now - at < FOCUS_MAX_MS && Array.isArray(queueSource.items)) items = queueSource.items.slice(0, QUEUE_MAX);
  } catch {}
  if (!items.length) return checkIn(now, desktop, scanFull(now, queueSource), 'QUEUE: empty');
  const gone = readQueue(now, desktop, queueSource).gone;
  const goneLine = gone.some(Boolean) ? 'GONE: ' + gone.flatMap((g, i) => (g ? [i] : [])).join(',') + '\n' : '';
  let index = gone.findIndex((g) => !g);
  if (index < 0) return checkIn(now, desktop, scanFull(now, queueSource), goneLine + 'QUEUE: empty');
  if (settings.streamer) {
    const full = scanFull(now, queueSource);
    index = full.slotOnAir.findIndex((ok) => ok);
    if (index < 0) return checkIn(now, desktop, full, goneLine + 'QUEUE: nothing on air');
  }
  const item = items[index];
  const prefix = goneLine + ['QUEUE_INDEX: ' + index, ...(settings.streamer ? ['DEFERRED: ' + index] : [])].join('\n') + '\n';
  const sid = typeof item === 'string' ? item : item && typeof item.sessionId === 'string' ? item.sessionId : '';
  if (!sid) return prefix + 'SESSION_ID: "none"\nTITLE: "none"\nPROJECT: "none"\nCONTEXT_TOKENS: 0\nCONTEXT_PERCENT: unknown';
  const rec = sid.startsWith('local_') ? desktop.get(sid) : [...desktop.values()].find((r) => r.cli === sid);
  return prefix + sessionLines(sid, rec, toUuid(sid, desktop), now);
}

if (flag('--next-info')) {
  console.log(nextInfo());
  process.exit(0);
}

if (flag('--ensure')) {
  if (!(await probe())) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--ensure')], { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 30 && !(await probe()); i++) await new Promise((r) => setTimeout(r, 150));
  }
  console.log((await probe()) ? `session-orchestrator is running at ${URL_BASE}` : `could not start session-orchestrator on port ${OPTS.port}`);
  process.exit(0);
}

if (OPTS.once) {
  const snap = scan();
  if (flag('--json')) console.log(JSON.stringify(snap, null, 2));
  else console.log(counts(snap));
  process.exit(0);
}

let snapshot = scan();
setInterval(() => {
  try {
    snapshot = scan();
  } catch {}
}, 2000).unref?.();

const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (origin !== `http://127.0.0.1:${OPTS.port}` && origin !== `http://localhost:${OPTS.port}`) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin';
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function postSettings(req, res, headers) {
  const json = (code, body) => {
    res.writeHead(code, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (!sameOrigin(req)) return json(403, { error: 'cross-origin request refused' });
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] || '')) return json(415, { error: 'content-type must be application/json' });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > SETTINGS_MAX_BYTES) {
    req.resume();
    return json(413, { error: 'body too large' });
  }
  let body;
  try {
    body = await readBody(req, SETTINGS_MAX_BYTES);
  } catch (e) {
    return json(e.code === 413 ? 413 : 400, { error: 'unreadable body' });
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid json' });
  }
  const r = validateSettings(parsed);
  if (r.error) return json(400, { error: r.error });
  const next = { ...settings, ...r.value };
  try {
    saveSettings(next);
  } catch {
    return json(500, { error: 'could not save settings' });
  }
  settings = next;
  try {
    snapshot = scan();
  } catch {}
  return json(200, settings);
}

const server = createServer((req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  const okHost = host === `127.0.0.1:${OPTS.port}` || host === `localhost:${OPTS.port}`;
  const path = (req.url || '/').split('?')[0];
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (!okHost || (req.method !== 'GET' && !(req.method === 'POST' && path === '/settings'))) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'POST') {
    postSettings(req, res, headers).catch(() => {
      if (!res.headersSent) res.writeHead(500, headers);
      res.end();
    });
  } else if (path === '/state.json') {
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot));
  } else if (path === '/rooms.json') {
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(roomLabelsNow));
  } else if (path === '/settings') {
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(settings));
  } else if (path === '/' || path === '/index.html') {
    try {
      const html = readFileSync(join(HERE, 'index.html'));
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, headers).end();
    }
  } else if (PAGE_SCRIPT.test(path)) {
    try {
      const js = readFileSync(join(HERE, path.slice(1)));
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' });
      res.end(js);
    } catch {
      res.writeHead(404, headers).end();
    }
  } else {
    res.writeHead(404, headers).end();
  }
});

server.on('error', (e) => {
  console.error(e instanceof Error && 'code' in e && e.code === 'EADDRINUSE' ? `port ${OPTS.port} is in use, try --port <n>` : String(e.message));
  process.exit(1);
});
server.listen(OPTS.port, '127.0.0.1', () => {
  console.log(`session-orchestrator on ${URL_BASE}  (${counts(snapshot)})`);
});
