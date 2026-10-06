import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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
  max: Number(opt('--max', '30')),
};

const FOCUS_FILE = join(homedir(), '.session-orchestrator', 'focus.json');
const FOCUS_MAX_MS = 24 * 3600 * 1000;
const PROJECTS = join(homedir(), '.claude', 'projects');
const DESKTOP_SESSIONS = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const WINDOW_MS = 7 * 24 * 3600 * 1000;
const WORKING_MS = 30 * 1000;
const PENDING_WORKING_MS = 120 * 1000;
const PENDING_MAX_MS = 10 * 60 * 1000;
const SLEEPY_MS = 30 * 60 * 1000;
const EVENT_MS = 10 * 60 * 1000;
const TAIL_BYTES = 400 * 1024;
const HEAD_BYTES = 128 * 1024;
const MAX_PER_ROOM = 6;
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

function lastCwd(text) {
  let last = null;
  for (const m of text.matchAll(CWD_RE)) last = m[1];
  if (last === null) return null;
  try {
    return JSON.parse('"' + last + '"');
  } catch {
    return null;
  }
}

const MSG_RE = /<cross-session-message[^>]*?from-session=\\?"(local_[0-9a-fA-F-]+)\\?"/g;
const TS_RE = /"timestamp":"([^"]+)"/;

function analyzeFile(path, size) {
  const tail = readTail(path, size);
  let cwd = lastCwd(tail);
  if (!cwd) cwd = lastCwd(readRange(path, 0, Math.min(size, HEAD_BYTES)));
  let last = null;
  const messages = [];
  const seen = new Set();
  for (const line of tail.split('\n')) {
    if (!line) continue;
    if (line.includes('<cross-session-message')) {
      const ts = TS_RE.exec(line);
      const at = ts ? Date.parse(ts[1]) : NaN;
      if (Number.isFinite(at)) {
        for (const m of line.matchAll(MSG_RE)) {
          const key = m[1] + ':' + Math.floor(at / 10000);
          if (!seen.has(key)) {
            seen.add(key);
            messages.push({ from: m[1], at });
          }
        }
      }
    }
    if (!line.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
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
  return { cwd, last, messages };
}

const fileCache = new Map();

function analyzeCached(path, st) {
  const key = st.mtimeMs + ':' + st.size;
  const hit = fileCache.get(path);
  if (hit && hit.key === key) return hit.value;
  let value;
  try {
    value = analyzeFile(path, st.size);
  } catch {
    value = { cwd: null, last: null, messages: [] };
  }
  fileCache.set(path, { key, value });
  return value;
}

const desktopCache = new Map();

function desktopSessions() {
  const out = new Map();
  let level1;
  try {
    level1 = readdirSync(DESKTOP_SESSIONS);
  } catch {
    return out;
  }
  for (const a of level1) {
    let level2;
    try {
      level2 = readdirSync(join(DESKTOP_SESSIONS, a));
    } catch {
      continue;
    }
    for (const b of level2) {
      let files;
      try {
        files = readdirSync(join(DESKTOP_SESSIONS, a, b));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        const p = join(DESKTOP_SESSIONS, a, b, f);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        let rec = desktopCache.get(p);
        if (!rec || rec.mtimeMs !== st.mtimeMs) {
          try {
            const j = JSON.parse(readFileSync(p, 'utf8'));
            rec = { mtimeMs: st.mtimeMs, local: j.sessionId, cli: j.cliSessionId, title: j.title };
          } catch {
            rec = { mtimeMs: st.mtimeMs };
          }
          desktopCache.set(p, rec);
        }
        if (rec.local && rec.cli) out.set(rec.local, rec);
      }
    }
  }
  return out;
}

function roomRoot(cwd) {
  const m = /^(.*?)\/\.(?:claude|codex)\/worktrees\//.exec(cwd);
  return m && m[1] ? m[1] : cwd.replace(/\/+$/, '') || '/';
}

function roomLabel(root) {
  if (root === homedir()) return 'home';
  return basename(root) || '/';
}

const roomOrder = [];

function scan(now = Date.now()) {
  const desktop = desktopSessions();
  const cliToLocal = new Map();
  for (const rec of desktop.values()) cliToLocal.set(rec.cli, rec);

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
      if (!st.isFile() || now - st.mtimeMs > WINDOW_MS) continue;
      found.push({ p, uuid: f.slice(0, -6), mtime: st.mtimeMs, st });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);

  const rooms = new Map();
  const picked = [];
  for (const s of found) {
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

  const alive = new Set(picked.map((s) => s.room.id));
  for (let i = roomOrder.length - 1; i >= 0; i--) if (!alive.has(roomOrder[i])) roomOrder.splice(i, 1);
  for (const s of picked) if (!roomOrder.includes(s.room.id)) roomOrder.push(s.room.id);

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
    else if (kind === 'tool_use' && age < PENDING_MAX_MS) state = 'waiting';
    let name = NAMES[num(s.uuid) % NAMES.length];
    for (let n = 2; names.has(name); n++) name = NAMES[num(s.uuid) % NAMES.length] + ' ' + n;
    names.add(name);
    const agent = { id: 'a' + sha(s.uuid).slice(0, 8), name, room: s.room.id, state };
    if (state === 'idle' && age > SLEEPY_MS) agent.sleepy = true;
    if (OPTS.titles) {
      const rec = cliToLocal.get(s.uuid);
      if (rec && rec.title) agent.title = String(rec.title);
    }
    byUuid.set(s.uuid, agent);
    agents.push({ agent, s });
  }

  const events = [];
  for (const { agent, s } of agents) {
    for (const m of s.info.messages) {
      if (now - m.at > EVENT_MS) continue;
      const rec = desktop.get(m.from);
      const sender = rec && byUuid.get(rec.cli);
      const from = sender ? sender.id : 'visitor';
      events.push({ id: 'e' + sha(from + agent.id + Math.floor(m.at / 1000)).slice(0, 10), at: m.at, from, to: agent.id });
    }
  }
  events.sort((a, b) => a.at - b.at);

  let focus = null;
  try {
    const f = JSON.parse(readFileSync(FOCUS_FILE, 'utf8'));
    const at = Date.parse(f.at);
    const sid = typeof f.sessionId === 'string' ? f.sessionId : '';
    if (sid && Number.isFinite(at) && at <= now && now - at < FOCUS_MAX_MS) {
      const uuid = sid.startsWith('local_') ? (desktop.get(sid) || {}).cli : sid;
      const target = uuid && byUuid.get(uuid);
      focus = { agentId: target ? target.id : 'visitor', at };
    }
  } catch {}

  const roomById = new Map([...rooms.values()].map((r) => [r.id, r]));
  const ordered = roomOrder.filter((id) => roomById.has(id));
  const outRooms = ordered.map((id, i) => ({
    id,
    label: OPTS.anonymize ? 'Room ' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '') : roomLabel(roomById.get(id).root),
  }));

  return { generatedAt: now, rooms: outRooms, agents: agents.map((a) => a.agent), events, focus };
}

function counts(snap) {
  const c = { working: 0, waiting: 0, idle: 0 };
  for (const a of snap.agents) c[a.state]++;
  return `rooms=${snap.rooms.length} agents=${snap.agents.length} working=${c.working} waiting=${c.waiting} idle=${c.idle} events=${snap.events.length}`;
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

const server = createServer((req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  const okHost = host === `127.0.0.1:${OPTS.port}` || host === `localhost:${OPTS.port}`;
  if (!okHost || req.method !== 'GET') {
    res.writeHead(403).end();
    return;
  }
  const path = (req.url || '/').split('?')[0];
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (path === '/state.json') {
    res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot));
  } else if (path === '/' || path === '/index.html') {
    try {
      const html = readFileSync(join(HERE, 'index.html'));
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, headers).end();
    }
  } else {
    res.writeHead(404, headers).end();
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${OPTS.port} is in use, try --port <n>` : String(e.message));
  process.exit(1);
});
server.listen(OPTS.port, '127.0.0.1', () => {
  console.log(`session-orchestrator on http://127.0.0.1:${OPTS.port}  (${counts(snapshot)})`);
});
