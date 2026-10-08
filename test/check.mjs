import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, utimesSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { inflateSync } from 'node:zlib';
import { AsyncLocalStorage } from 'node:async_hooks';

const require = createRequire(process.env.PW_DIR ? join(process.env.PW_DIR, 'x.js') : import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || join(tmpdir(), 'session-orchestrator-shots');
mkdirSync(SHOTS, { recursive: true });
const { isHumanPrompt } = await import(join(ROOT, 'lib', 'prompts.mjs'));
const QUICK = process.env.TIER === 'quick' || (process.env.ONLY || '').split(',').includes('quick');
const ONLY = process.env.ONLY && !QUICK ? process.env.ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
const JOBS = Math.max(1, Math.floor(Number(process.env.JOBS) || 6));
const jobs = new AsyncLocalStorage();
const say = (...a) => {
  const job = jobs.getStore();
  if (job) job.lines.push(a.join(' '));
  else console.log(...a);
};
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); say('FAIL', msg); } };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex');
const agentId = (uuid) => 'a' + sha(uuid).slice(0, 8);
const demoUrl = (q = '') => `file://${ROOT}/index.html?demo=1&onboarding=0&${q}`;

let browser;
let browserLaunch;
const getBrowser = () => browser || (browserLaunch ||= chromium.launch().then((b) => (browser = b)));

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const parts = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); ct = buf[p + 17]; }
    if (type === 'IDAT') parts.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(parts)), stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = x >= bpp && y ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const clocks = new WeakMap();
const adv = async (page, seconds) => {
  clocks.set(page, (clocks.get(page) || 0) + seconds);
  await page.evaluate((s) => window.__office.advance(s), seconds);
  if (page.url().startsWith('http')) await sleep(20);
};
const nap = (page, ms) => adv(page, ms / 1000);
const vnow = (page) => (clocks.get(page) || 0) * 1000;

async function open(vw, vh, dpr, url, wait = 700, realTime = false) {
  const ctx = await (await getBrowser()).newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
  jobs.getStore()?.contexts.add(ctx);
  if (!realTime) await ctx.addInitScript(() => { window['__officeHold'] = true; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  if (realTime) await sleep(wait);
  else {
    if (url.startsWith('http')) await page.waitForFunction(() => window.__office.rooms().length > 0);
    await nap(page, wait);
  }
  return { ctx, page, errors };
}

async function settle(page, pred, arg, maxSeconds = 8, realMs = 25) {
  for (let t = 0; t < maxSeconds; t += 0.1) {
    if (await page.evaluate(pred, arg)) return true;
    await sleep(realMs);
    await adv(page, 0.1);
  }
  return page.evaluate(pred, arg);
}

async function realUntil(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
const uiState = (page) => ev(page, () => window.__office.ui());

async function staticChecks(page, tag) {
  const d = await page.evaluate(() => {
    const o = window.__office, cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
    return { w: o.world(), labels: o.labels(), desks: o.desks(), agents: o.agents(), floors: o.floors(), dpr: o.dpr(), px: o.px(), cssW: r.width, cssH: r.height, pxW: cv.width, pxH: cv.height, vw: innerWidth, scrollW: document.documentElement.scrollWidth, ir: getComputedStyle(cv).imageRendering, boss: o.boss(), el: o.elevator() };
  });
  check(d.pxW === d.w.w && d.pxH === d.w.h, `${tag} canvas backing ${d.pxW}x${d.pxH} != world ${d.w.w}x${d.w.h}`);
  check(Math.abs(d.cssW * d.dpr - d.w.w * d.px) < 0.6 && Math.abs(d.cssH * d.dpr - d.w.h * d.px) < 0.6, `${tag} canvas not an integer device-pixel multiple (${d.cssW}*${d.dpr} vs ${d.w.w}*${d.px})`);
  check(Number.isInteger(d.px) && d.px >= 1, `${tag} non-integer pixel scale ${d.px}`);
  check(d.ir === 'pixelated', `${tag} image-rendering ${d.ir}`);
  check(d.scrollW <= d.vw + 1, `${tag} horizontal scroll ${d.scrollW}>${d.vw}`);
  check(d.cssW <= d.vw + 1, `${tag} canvas wider than viewport`);
  for (const k of d.desks) {
    const a = d.agents.find((x) => x.id === k.id);
    if (!a || a.away) continue;
    check(Math.abs(a.x - k.x) < 0.01 && Math.abs(a.y - k.y) < 0.01 && a.sit === 1 && a.fr === k.room, `${tag} agent ${a.name} not at desk (${a.x},${a.y}) vs (${k.x},${k.y})`);
  }
  d.labels.forEach((l, i) => {
    check(l.x + l.w <= 63, `${tag} label ${l.id} overflows plaque`);
    d.labels.forEach((m, j) => { if (i < j) check(!hit(l, m), `${tag} labels overlap`); });
    const fl = d.floors.find((f) => f.id === l.id);
    check(l.y >= fl.top && l.y + l.h <= fl.foot, `${tag} label outside floor ${l.id}`);
  });
  const desksByFloor = {};
  for (const k of d.desks) (desksByFloor[k.room + '|' + k.row] ||= []).push(k.x);
  for (const xs of Object.values(desksByFloor)) {
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) check(xs[i] - xs[i - 1] >= 40, `${tag} desks closer than a station`);
    check(xs[xs.length - 1] + 34 <= d.el.x - 13, `${tag} desk runs into the elevator shaft`);
  }
  return d;
}

async function crisp(page, tag, px) {
  const el = await page.$('#cv');
  const img = decodePng(await el.screenshot());
  if (px < 2) return;
  const bad = (ox, oy) => {
    let n = 0;
    for (let by = oy; by + px <= img.h && by < oy + px * 120; by += px) {
      for (let bx = ox; bx + px <= img.w && bx < ox + px * 160; bx += px) {
        const o0 = (by * img.w + bx) * img.bpp;
        for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
          const o = ((by + y) * img.w + bx + x) * img.bpp;
          for (let c = 0; c < 3; c++) if (img.data[o + c] !== img.data[o0 + c]) { n++; break; }
        }
      }
    }
    return n;
  };
  let best = Infinity;
  for (let oy = 0; oy < px && best; oy++) for (let ox = 0; ox < px && best; ox++) best = Math.min(best, bad(ox, oy));
  check(best === 0, `${tag} blurry scaling: ${best} off-grid pixels at best alignment`);
}

async function tripCheck(page, tag) {
  const info = await page.evaluate(() => {
    const ag = window.__office.agents().filter((a) => !a.visitor && !a.away);
    const A = ag[0], B = ag.find((a) => a.room !== A.room);
    return { A: A.id, B: B ? B.id : ag[1].id, same: !B };
  });
  const deskB = await page.evaluate((id) => window.__office.desks().find((d) => d.id === id), info.B);
  await page.evaluate(([a, b]) => window.__office.trip(a, b, "PR's up"), [info.A, info.B]);
  let sawBubble = false, usedElevator = false, arrived = false, returned = false;
  for (let i = 0; i < 500; i++) {
    await nap(page, 100);
    const s = await page.evaluate((a) => { const o = window.__office; return { A: o.agents().find((x) => x.id === a), w: o.world(), labels: o.labels() }; }, info.A);
    const A = s.A;
    if (A.inCab) usedElevator = true;
    if (A.bubble) {
      sawBubble = true;
      const b = A.bubble;
      check(b.x >= 0 && b.y >= 0 && b.x + b.w <= s.w.w && b.y + b.h + 3 <= s.w.h, `${tag} bubble outside canvas`);
      for (const l of s.labels) check(!hit(b, l), `${tag} bubble overlaps label`);
      if (!arrived) {
        arrived = true;
        check(Math.abs(A.x - (deskB.x - 17)) < 0.6 && Math.abs(A.y - deskB.y) < 0.6 && A.fr === deskB.room, `${tag} walker not at target desk (${A.x},${A.y}) fr=${A.fr} vs (${deskB.x - 17},${deskB.y})`);
      }
    }
    if (arrived && !A.away) { returned = true; break; }
  }
  check(sawBubble, `${tag} no bubble`);
  check(returned, `${tag} did not return`);
  if (!info.same) check(usedElevator, `${tag} cross-floor trip did not use elevator`);
  const end = await page.evaluate((a) => window.__office.agents().find((x) => x.id === a), info.A);
  const dk = await page.evaluate((a) => window.__office.desks().find((x) => x.id === a), info.A);
  check(Math.abs(end.x - dk.x) < 0.01 && Math.abs(end.y - dk.y) < 0.01 && end.sit === 1, `${tag} not seated exactly after return`);
}

async function visitorCheck(page, tag) {
  const B = await page.evaluate(() => { const ag = window.__office.agents().filter((a) => !a.visitor && !a.away); return ag[ag.length - 1].id; });
  const desk = await page.evaluate((id) => window.__office.desks().find((d) => d.id === id), B);
  check(await page.evaluate((b) => window.__office.trip('nobody', b, 'need eyes'), B), `${tag} visitor trip refused`);
  let arrived = false, gone = false, started = false;
  for (let i = 0; i < 600; i++) {
    await nap(page, 100);
    const s = await page.evaluate(() => { const o = window.__office; return { v: o.agents().find((a) => a.visitor), w: o.world() }; });
    if (s.v) {
      started = true;
      if (s.v.bubble && !arrived) {
        arrived = true;
        check(Math.abs(s.v.x - (desk.x - 17)) < 0.6 && s.v.fr === desk.room, `${tag} visitor not at target desk`);
        check(s.v.bubble.x >= 0 && s.v.bubble.x + s.v.bubble.w <= s.w.w, `${tag} visitor bubble outside`);
      }
    } else if (started) { gone = true; break; }
  }
  check(arrived && gone, `${tag} visitor flow arrived=${arrived} gone=${gone}`);
}

async function focusCheck(page, tag) {
  const info = await page.evaluate(() => {
    const o = window.__office, ag = o.agents().filter((a) => !a.visitor && !a.away && !a.q);
    return { id: ag[ag.length - 1].id, boss: o.boss(), desks: o.desks() };
  });
  const dk = info.desks.find((d) => d.id === info.id);
  await page.evaluate((id) => window.__office.focus(id, 'test' + Math.random()), info.id);
  let arrived = false, usedElevator = false;
  for (let i = 0; i < 700 && !arrived; i++) {
    await nap(page, 100);
    const s = await page.evaluate((id) => ({ a: window.__office.agents().find((x) => x.id === id), w: window.__office.world() }), info.id);
    if (!s.a) continue;
    if (s.a.inCab) usedElevator = true;
    if (s.a.bubble && s.a.fr === '__boss') {
      arrived = true;
      check(Math.abs(s.a.x - info.boss.spot) < 0.6 && Math.abs(s.a.y - info.boss.foot) < 0.6, `${tag} focus agent not at boss spot (${s.a.x},${s.a.y}) vs (${info.boss.spot},${info.boss.foot})`);
      check(!hit({ x: s.a.x - 7, y: s.a.y - 16, w: 14, h: 16 }, info.boss.desk), `${tag} focus agent overlaps boss desk`);
      const b = s.a.bubble;
      check(b.x >= 0 && b.y >= 0 && b.x + b.w <= s.w.w, `${tag} boss bubble outside canvas`);
    }
  }
  check(arrived, `${tag} focus agent never reached boss office`);
  check(usedElevator, `${tag} focus agent skipped the elevator`);
  await nap(page, 2500);
  const still = await page.evaluate((id) => window.__office.agents().find((x) => x.id === id), info.id);
  check(still && still.fr === '__boss' && still.away, `${tag} focus agent left the boss office before focus changed`);
  await page.evaluate(() => window.__office.clearFocus());
  let back = false;
  for (let i = 0; i < 700; i++) {
    await nap(page, 100);
    const a = await page.evaluate((id) => window.__office.agents().find((x) => x.id === id), info.id);
    if (a && !a.away) { back = true; check(Math.abs(a.x - dk.x) < 0.01 && Math.abs(a.y - dk.y) < 0.01 && a.sit === 1, `${tag} focus agent not at desk after return`); break; }
  }
  check(back, `${tag} focus agent did not return`);
}

async function queueSeatCheck(page, tag) {
  let q = null;
  for (let i = 0; i < 600; i++) {
    await nap(page, 100);
    q = await page.evaluate(() => window.__office.queue());
    const ag = await page.evaluate(() => window.__office.agents());
    if (q.want.length >= 2 && q.want.every((id) => ag.find((a) => a.id === id && a.queued))) break;
  }
  const ag = await page.evaluate(() => window.__office.agents());
  check(q.want.length >= 2, `${tag} fewer than two agents queued (${q.want.length})`);
  const seated = q.want.map((id) => ag.find((a) => a.id === id));
  seated.forEach((a, k) => {
    check(a && a.queued, `${tag} queue member ${k} not seated in the waiting room`);
    if (!a) return;
    check(Math.abs(a.x - q.spots[k]) < 0.6 && Math.abs(a.y - q.foot) < 0.6, `${tag} queue member ${k} not on chair ${k} (${a.x},${a.y}) vs (${q.spots[k]},${q.foot})`);
    check(a.fr === '__boss' && a.facing === -1, `${tag} queue member ${k} not facing the secretary`);
    if (k) check(a.x > seated[k - 1].x, `${tag} queue seats out of order`);
  });
  check(q.spots[0] > q.door && q.spots[q.spots.length - 1] < q.door + q.hall, `${tag} chairs outside the waiting room`);
}

async function secretaryCheck(page, tag) {
  let q = null, id = null;
  for (let i = 0; i < 600; i++) {
    await nap(page, 100);
    q = await page.evaluate(() => window.__office.queue());
    if (!q.want.length) continue;
    const a = await page.evaluate((w) => window.__office.agents().find((x) => x.id === w), q.want[0]);
    if (a && a.queued) { id = q.want[0]; break; }
  }
  check(!!id, `${tag} no queued agent for the secretary to wave through`);
  if (!id) return;
  await page.evaluate((i) => window.__office.focus(i, 'sec' + Math.random()), id);
  let waved = false, entered = false;
  for (let i = 0; i < 400; i++) {
    await nap(page, 100);
    const s = await page.evaluate((i2) => ({ sec: window.__office.secretary(), a: window.__office.agents().find((x) => x.id === i2), b: window.__office.boss() }), id);
    if (s.sec.waving) waved = true;
    if (waved && s.a && s.a.fr === '__boss' && s.a.x < q.door) entered = true;
    if (entered && s.a.bubble) break;
  }
  check(waved, `${tag} secretary did not wave the front agent through`);
  check(entered, `${tag} front agent did not walk into the Boss Office`);
  await page.evaluate(() => window.__office.clearFocus());
  await nap(page, 1500);
}

async function bossRouteCheck(page, tag) {
  let info = null, log = null, bubbles = 0;
  const tried = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const seen = await page.evaluate(() => window.__office.visitLog().length);
    info = await page.evaluate((skip) => {
      const o = window.__office, ag = o.agents().filter((a) => !a.visitor && !a.away && !a.q && !skip.includes(a.id));
      const a = ag.find((x) => x.room !== o.rooms()[0].id) || ag[0];
      if (!a) return null;
      return { id: a.id, desk: o.desks().find((d) => d.id === a.id) };
    }, tried);
    if (!info) { check(false, `${tag} no eligible agent for boss visit`); return; }
    tried.push(info.id);
    await page.evaluate((id) => window.__office.visit(id), info.id);
    let stood = false, cab = false, atDesk = false, returned = false, bubbleMs = 0, lastT = 0;
    bubbles = 0;
    for (let i = 0; i < 1500; i++) {
      await nap(page, 80);
      const s = await page.evaluate((id) => ({ b: window.__office.bossActor(), a: window.__office.agents().find((x) => x.id === id), w: window.__office.world() }), info.id);
      if (s.b.away && s.b.sit === 0) stood = true;
      if (s.b.inCab) cab = true;
      if (s.b.away && s.b.fr === info.desk.room && Math.abs(s.b.x - (info.desk.x - 17)) < 0.6 && s.b.bubble) {
        atDesk = true;
        if (!lastT) lastT = vnow(page);
        bubbleMs = vnow(page) - lastT;
        check(s.b.bubble.x >= 0 && s.b.bubble.y >= 0 && s.b.bubble.x + s.b.bubble.w <= s.w.w, `${tag} boss bubble outside canvas`);
        if (s.a.bubble) { bubbles++; check(!hit(s.b.bubble, s.a.bubble), `${tag} boss and agent bubbles overlap`); }
      }
      if (stood && atDesk && !s.b.away) { returned = true; break; }
    }
    check(stood, `${tag} boss never stood up`);
    check(cab, `${tag} boss skipped the elevator`);
    check(atDesk, `${tag} boss never reached the agent's desk`);
    check(bubbleMs > 800, `${tag} boss bubble too short (${bubbleMs}ms real time)`);
    check(returned, `${tag} boss did not return`);
    log = (await page.evaluate(() => window.__office.visitLog())).slice(seen).find((v) => v.id === info.id);
    check(!!log, `${tag} visit was never logged`);
    if (!log || !log.agentAway) break;
  }
  check(!!log && !log.agentAway, `${tag} every visit found its agent away from the desk`);
  if (log && !log.agentAway) {
    check(log.answered || log.agentBubble, `${tag} agent never answered the boss (${JSON.stringify(log)})`);
    if (log.answered) check(bubbles > 0, `${tag} agent answer bubble never rendered`);
  }
  const end = await page.evaluate(() => window.__office.bossActor());
  check(!end.away && end.sit === 1 && end.fr === '__boss' && Math.abs(end.x - end.chair) < 0.01, `${tag} boss not exactly at his chair after the visit (${end.x} vs ${end.chair})`);
  const a = await page.evaluate((id) => window.__office.agents().find((x) => x.id === id), info.id);
  check(!!a, `${tag} visited agent vanished`);
}

async function joinCheck(page, tag, newProject) {
  const before = await page.evaluate(() => ({ anims: window.__office.animations(), rooms: window.__office.rooms().map((r) => r.id), desks: window.__office.desks().length }));
  const joined = await page.evaluate((np) => {
    const o = window.__office;
    const id = o.join(np);
    return { id, pendingDesk: o.desks().some((d) => d.id === id) && o.agents().some((a) => a.id === id && a.away) };
  }, newProject);
  const id = joined.id;
  check(!!id, `${tag} join hook returned nothing`);
  check(joined.pendingDesk, `${tag} join never showed the pending desk`);
  let cab = false, seated = false, sawAnim = false, doorOpen = false;
  for (let i = 0; i < 900; i++) {
    await nap(page, 100);
    const s = await page.evaluate((i2) => { const o = window.__office; return { a: o.agents().find((x) => x.id === i2), desks: o.desks(), anim: o.animating(), door: o.lobbyDoor().open }; }, id);
    if (s.anim) sawAnim = true;
    if (s.door > 0.9) doorOpen = true;
    if (!s.a) continue;
    if (s.a.inCab) cab = true;
    if (!s.a.away && s.a.sit === 1) { seated = true; break; }
  }
  check(seated, `${tag} new agent never sat down`);
  check(cab, `${tag} new agent skipped the elevator`);
  check(doorOpen, `${tag} lobby door never opened for the new agent`);
  const d = await staticChecks(page, tag + ' after join');
  const mine = d.desks.find((k) => k.id === id);
  check(!!mine, `${tag} no desk for the new agent`);
  const a = d.agents.find((x) => x.id === id);
  check(a && mine && Math.abs(a.x - mine.x) < 0.01 && Math.abs(a.y - mine.y) < 0.01 && a.sit === 1, `${tag} new agent not exactly at its desk`);
  const rooms = await page.evaluate(() => window.__office.rooms().map((r) => r.id));
  if (newProject) {
    check(rooms.length === before.rooms.length + 1, `${tag} no new floor`);
    check(sawAnim || (await page.evaluate(() => window.__office.animations())) > before.anims, `${tag} new floor did not animate`);
  } else check(rooms.join() === before.rooms.join(), `${tag} existing floors changed on join`);
  check(d.desks.length === before.desks + 1, `${tag} desk count ${d.desks.length} != ${before.desks + 1}`);
  const fl = d.floors.map((f) => f.top);
  check(fl.every((t, i) => !i || t > fl[i - 1]), `${tag} floors not stacked in order`);
}

async function boxChecks(page, tag, what) {
  const u = await uiState(page);
  const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const inside = (r, W, H) => r && r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;
  if (u.dialog) {
    check(inside(u.dialog, u.U.W, u.U.H), `${tag} ${what} dialog off canvas ${JSON.stringify(u.dialog)} in ${u.U.W}x${u.U.H}`);
    const need = Math.max(...u.dialog.lines.map((l) => l.length)) * 6;
    check(need <= u.dialog.w - 46, `${tag} ${what} dialog text wider than the box`);
    check(u.canvas.x >= 0 && u.canvas.y >= 0 && u.canvas.x + u.canvas.w <= vw.w + 1 && u.canvas.y + u.canvas.h <= vw.h + 1, `${tag} ${what} ui canvas outside viewport`);
  }
  if (u.geo) check(inside(u.geo, u.U.W, u.U.H), `${tag} ${what} settings panel off canvas ${JSON.stringify(u.geo)} in ${u.U.W}x${u.U.H}`);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('#hit .hb:not([tabindex="-1"])')].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.id, x: r.left, y: r.top, w: r.width, h: r.height }; }));
  for (const b of boxes) check(b.x >= -1 && b.y >= -1 && b.x + b.w <= vw.w + 1 && b.y + b.h <= vw.h + 1, `${tag} ${what} control ${b.id} outside viewport`);
  if (u.dialog) {
    const n = boxes.find((b) => b.id === 'next'), s = boxes.find((b) => b.id === 'skip');
    check(n && s && !hit(n, s), `${tag} ${what} next/skip overlap`);
    check(n && n.w >= 24 && n.h >= 16, `${tag} ${what} next target too small ${n && n.w}x${n && n.h}`);
  }
  return u;
}

async function dragRow(page, from, to) {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('#hit .hb[data-kind="row"]')].map((b) => { const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }));
  const a = boxes[from], b = boxes[to];
  await page.mouse.move(a.x + 24, a.y + a.h / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 24, a.y + a.h / 2 + (b.y - a.y) / 2, { steps: 4 });
  await page.mouse.move(a.x + 24, b.y + b.h / 2 + (to > from ? 2 : -2), { steps: 6 });
  await nap(page, 120);
  await page.mouse.up();
}

async function tourCheck(page, tag, shot) {
  let u = await uiState(page);
  check(!!u.tour && u.tour.step === 0, `${tag} tour not shown on first run`);
  const seen = [];
  for (let step = 0; step < 6; step++) {
    await nap(page, 250);
    u = await boxChecks(page, tag, 'tour step ' + step);
    seen.push(u.tour && u.tour.step);
    check(u.tour && u.tour.step === step, `${tag} expected tour step ${step}, got ${u.tour && u.tour.step}`);
    const t0 = u.tour.shown;
    await nap(page, 400);
    const t1 = (await uiState(page)).tour.shown;
    check(t1 > t0 || t0 === u.tour.len, `${tag} typewriter not advancing on step ${step}`);
    if (shot && step === shot.step) await page.screenshot({ path: join(SHOTS, `${tag}-${shot.name}.png`) });
    if (step === 2) check(!!u.strip, `${tag} states strip missing on step 2`);
    if (step === 3) {
      check(u.settings && !!u.geo, `${tag} settings not open on step 3`);
      const before = await page.evaluate(() => window.__office.rooms().map((r) => r.id));
      if (before.length > 1) {
        await dragRow(page, 0, 1);
        await nap(page, 300);
        const after = await page.evaluate(() => window.__office.rooms().map((r) => r.id));
        check(after.join() !== before.join() && after[1] === before[0], `${tag} tour drag did not reorder`);
        const u3 = await uiState(page);
        check(u3.tour.did, `${tag} tour did not celebrate the reorder`);
        check((await ev(page, () => window.__office.particles())) > 0, `${tag} no confetti after reorder`);
        if (shot && shot.name === 'settings') await page.screenshot({ path: join(SHOTS, `${tag}-settings-tour.png`) });
      }
    }
    if (step === 4) {
      let walked = false;
      for (let i = 0; i < 400 && !walked; i++) {
        await nap(page, 100);
        const st = await ev(page, () => ({ ag: window.__office.agents(), door: window.__office.queue().door }));
        if (st.ag.some((a) => a.visitor && a.fr === '__boss' && a.x < st.door)) walked = true;
      }
      check(walked, `${tag} no agent walked up on the queue step`);
    }
    for (let k = 0; k < 2; k++) {
      const next = page.locator('[data-id="next"]');
      if (!(await next.count())) break;
      await next.click();
      await nap(page, 150);
      const cur = await uiState(page);
      if (!cur.tour || cur.tour.step !== step) break;
    }
  }
  await nap(page, 300);
  u = await uiState(page);
  check(!u.tour, `${tag} tour still open after finishing`);
  check((await ev(page, () => window.__office.particles())) > 0, `${tag} no confetti on finish`);
  const s = await ev(page, () => window.__office.settings());
  check(!!s.onboardedAt, `${tag} onboardedAt not saved`);
  check(seen.join() === '0,1,2,3,4,5', `${tag} steps reached ${seen}`);
}

function httpReq(port, { method = 'GET', path = '/', headers = {}, body, host }) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function writeQueue(root, ids, orchestrator = null) {
  const dir = join(root, '.session-orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'queue.json'), JSON.stringify({ at: new Date().toISOString(), orchestrator, items: ids.map((sessionId) => ({ sessionId })) }));
}

function makeFixture(root) {
  const spec = {
    atlas: [['tool_use', 300], ['reply', 3600], ['prompt', 5]],
    beacon: [['tool_use', 380], ['tool_use', 200], ['reply', 7200]],
    citadel: [['tool_use', 240], ['reply', 100000]],
    delta: [['tool_use', 400], ['prompt', 8], ['reply', 4000]],
  };
  const out = [];
  for (const [project, list] of Object.entries(spec)) {
    const dir = join(root, '.claude', 'projects', '-work-' + project);
    mkdirSync(dir, { recursive: true });
    list.forEach(([kind, ageSec], n) => {
      const uuid = randomUUID();
      const ts = new Date(Date.now() - ageSec * 1000).toISOString();
      const lines = [{ type: 'user', userType: 'external', cwd: '/work/' + project, timestamp: ts, message: { role: 'user', content: 'task ' + n } }];
      if (kind === 'tool_use') lines.push({ type: 'assistant', cwd: '/work/' + project, timestamp: ts, message: { content: [{ type: 'tool_use', id: 't' + n, name: 'Bash', input: {} }] } });
      else if (kind === 'reply') lines.push({ type: 'assistant', cwd: '/work/' + project, timestamp: ts, message: { content: [{ type: 'text', text: 'done' }] } });
      if (kind === 'reply') lines.push({ type: 'user', cwd: '/work/' + project + '/bench/t1', timestamp: ts, toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }, { type: 'assistant', cwd: '/work/' + project + '/bench/t1', timestamp: ts, message: { content: [{ type: 'text', text: 'done' }] } });
      const file = join(dir, uuid + '.jsonl');
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const at = new Date(Date.now() - ageSec * 1000);
      utimesSync(file, at, at);
      out.push({ project, uuid, file, kind, ageSec, id: agentId(uuid) });
    });
  }
  writeDesktop(root, 'local_fixture1', out[0].uuid, { title: 'Tidy the parser', lastActivityAt: Date.now() });
  out.slice(1).forEach((f, n) => writeDesktop(root, 'local_fx' + n, f.uuid));
  const hiddenDir = join(root, '.claude', 'projects', '-work-hidden');
  mkdirSync(hiddenDir, { recursive: true });
  writeDesktop(root, 'local_archived1', writeSession(hiddenDir, 'hidden', 50).uuid, { isArchived: true });
  writeDesktop(root, 'local_otheracct1', writeSession(hiddenDir, 'hidden', 60).uuid, {}, 'oldacct');
  const pick = (project, ageSec) => out.find((f) => f.project === project && f.ageSec === ageSec);
  const queued = [pick('atlas', 300), pick('delta', 400), pick('beacon', 380), pick('beacon', 200), pick('citadel', 240)];
  writeQueue(root, ['local_fixture1', null, ...queued.slice(1).map((f) => f.uuid)]);
  return out;
}

function writeDesktop(root, local, cli, extra = {}, account = 'acct') {
  const meta = join(root, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', account, 'org');
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, local + '.json'), JSON.stringify({ sessionId: local, cliSessionId: cli, isArchived: false, lastActivityAt: 1, ...extra }));
}

function makeCrowd(root) {
  const projects = [['bulk', 40], ['p1', 14], ['p2', 14], ['p3', 14], ['p4', 14], ['p5', 14]];
  const out = [];
  let age = 10;
  for (const [project, count] of projects) {
    const dir = join(root, '.claude', 'projects', '-work-' + project);
    mkdirSync(dir, { recursive: true });
    for (let n = 0; n < count; n++) {
      out.push({ project, ageSec: age += 10, ...writeSession(dir, project, age) });
    }
  }
  const oldest = { project: 'bulk', ageSec: 5000, ...writeSession(join(root, '.claude', 'projects', '-work-bulk'), 'bulk', 5000) };
  out.push(oldest);
  writeDesktop(root, 'local_crowd1', oldest.uuid, { lastActivityAt: Date.now() });
  out.filter((f) => f !== oldest).forEach((f, n) => writeDesktop(root, 'local_cr' + n, f.uuid));
  return { sessions: out, oldest };
}

function writeSession(dir, project, ageSec) {
  const uuid = randomUUID();
  const ts = new Date(Date.now() - ageSec * 1000).toISOString();
  const file = join(dir, uuid + '.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/' + project, timestamp: ts, message: { role: 'user', content: 'task' } }) + '\n');
  const at = new Date(Date.now() - ageSec * 1000);
  utimesSync(file, at, at);
  return { uuid, file, id: agentId(uuid) };
}

const spawned = [];
process.on('exit', () => { for (const c of spawned) c.kill(); });
const portReservations = new Map();
async function startServer(home, port, extra = []) {
  const reservation = portReservations.get(port);
  if (reservation) {
    portReservations.delete(port);
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  }
  const child = spawn('node', [join(ROOT, 'scan.mjs'), '--port', String(port), ...extra], { stdio: 'ignore', env: { ...process.env, HOME: home } });
  spawned.push(child);
  jobs.getStore()?.servers.add(child);
  return child;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const serverReady = (port) => realUntil(async () => (await httpReq(port, { path: '/state.json' })).status === 200, 15000);
const stateOf = async (port) => JSON.parse((await httpReq(port, { path: '/state.json' })).text);
async function waitState(port, pred, ms = 9000) {
  const end = Date.now() + ms;
  let s = null;
  while (Date.now() < end) { s = await stateOf(port); if (pred(s)) return s; await sleep(400); }
  return s;
}

if (want('unit')) {
  const line = (o) => ({ type: 'user', userType: 'external', timestamp: new Date().toISOString(), ...o });
  const cases = [
    ['typed string', line({ message: { role: 'user', content: 'please add a retry to the fetch helper' } }), true],
    ['typed text block', line({ message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } }), true],
    ['typed text after a system reminder block', line({ message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>be brief</system-reminder>' }, { type: 'text', text: 'what is next?' }] } }), true],
    ['typed slash-free question with angle bracket', line({ message: { role: 'user', content: 'is a < b true here?' } }), true],
    ['tool result', line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { stdout: 'ok' } }), false],
    ['tool result block only', line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), false],
    ['cross-session message', line({ message: { role: 'user', content: '<cross-session-message from-session="local_x">hello</cross-session-message>' } }), false],
    ['cross-session message in a block', line({ message: { role: 'user', content: [{ type: 'text', text: '<cross-session-message from-session="local_x">hi</cross-session-message>' }] } }), false],
    ['task notification', line({ message: { role: 'user', content: '<task-notification><task-id>1</task-id></task-notification>' } }), false],
    ['system reminder only', line({ message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] } }), false],
    ['scheduled task wrapper', line({ message: { role: 'user', content: '<scheduled-task name="nightly">run the report</scheduled-task>' } }), false],
    ['local command output', line({ message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' } }), false],
    ['meta entry', line({ isMeta: true, message: { role: 'user', content: 'Caveat: generated' } }), false],
    ['sidechain entry', line({ isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }), false],
    ['compact summary', line({ isCompactSummary: true, message: { role: 'user', content: 'summary of the conversation' } }), false],
    ['interrupt marker', line({ message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), false],
    ['assistant entry', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, false],
    ['empty text', line({ message: { role: 'user', content: '   ' } }), false],
    ['non-external user type', line({ userType: 'internal', message: { role: 'user', content: 'injected' } }), false],
    ['garbage', null, false],
  ];
  for (const [name, entry, expected] of cases) check(isHumanPrompt(entry) === expected, `unit: ${name} expected ${expected}`);
  say('unit ok', cases.length, 'cases');
}

let fixtureHome;
let fixture;
const freePort = (port = 0) => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(port, '127.0.0.1', () => { const { port: reservedPort } = srv.address(); portReservations.set(reservedPort, srv); resolve(reservedPort); });
});
const basePort = Number(process.env.SO_TEST_PORT) || 0;
const SPORT = await freePort(basePort);
const LPORT = await freePort(basePort ? basePort + 1 : 0);
const CPORT = await freePort(basePort ? basePort + 2 : 0);
const TPORT = await freePort(basePort ? basePort + 3 : 0);

const serverJob = async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), 'so-home-'));
  fixture = makeFixture(fixtureHome);
  const ids = Object.fromEntries(fixture.map((f) => [f.project + f.ageSec, f.id]));
  let server = await startServer(fixtureHome, SPORT);
  await serverReady(SPORT);
  let s = await stateOf(SPORT);
  check(s.rooms.map((r) => r.label).join() === 'atlas,beacon,citadel,delta', `server default room order ${s.rooms.map((r) => r.label)}`);
  check(!s.events.some((e) => e.kind === 'join'), 'server emitted join events for sessions that existed at startup');
  const expectDefault = [ids.atlas300, ids.delta400, ids.beacon380, ids.beacon200, ids.citadel240];
  check(JSON.stringify(s.queue) === JSON.stringify(expectDefault), `server default queue ${JSON.stringify(s.queue)} != ${JSON.stringify(expectDefault)}`);
  check(s.queueSize === 6, `queueSize ${s.queueSize} is not the number of items in queue.json`);
  const info = execFileSync('node', [join(ROOT, 'scan.mjs'), '--next-info'], { env: { ...process.env, HOME: fixtureHome }, encoding: 'utf8' });
  check(/^SESSION_ID: "local_fixture1"$/m.test(info) && /^TITLE: "Tidy the parser"$/m.test(info) && /^PROJECT: "atlas"$/m.test(info) && /^CONTEXT_TOKENS: /m.test(info), `--next-info output wrong: ${info}`);
  check(s.line.length === 6 && s.line[1] === null && JSON.stringify(s.line.filter((id) => id)) === JSON.stringify(expectDefault), `waiting room line ${JSON.stringify(s.line)}`);
  const raw = JSON.stringify(s);
  check(!raw.includes('/work') && !raw.includes(fixtureHome) && !/"title"/.test(raw), 'state.json leaks paths or titles by default');
  check(!s.rooms.some((r) => r.label === 'hidden'), 'archived or other-account sessions are shown');
  const bare = mkdtempSync(join(tmpdir(), 'so-bare-'));
  const bareDir = join(bare, '.claude', 'projects', '-work-solo');
  mkdirSync(bareDir, { recursive: true });
  writeSession(bareDir, 'solo', 30);
  const bareState = JSON.parse(execFileSync('node', [join(ROOT, 'scan.mjs'), '--once', '--json'], { env: { ...process.env, HOME: bare }, encoding: 'utf8' }));
  check(bareState.agents.length === 1 && bareState.rooms[0].label === 'solo', 'without desktop metadata the recent transcripts are not shown');
  const ok = { origin: `http://127.0.0.1:${SPORT}`, 'content-type': 'application/json' };
  const post = (obj, headers = ok) => httpReq(SPORT, { method: 'POST', path: '/settings', headers, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  const defaults = JSON.parse((await httpReq(SPORT, { path: '/settings' })).text);
  check(defaults.order.length === 0 && defaults.onboardedAt === null && defaults.speed === 1, 'default settings wrong');

  const r = await post({ order: [s.rooms.find((x) => x.label === 'citadel').id, 'beacon'] });
  check(r.status === 200, `valid order post rejected ${r.status} ${r.text}`);
  s = await stateOf(SPORT);
  check(s.rooms.map((x) => x.label).join() === 'citadel,beacon,atlas,delta', `priority not applied to rooms: ${s.rooms.map((x) => x.label)}`);
  check(JSON.stringify(s.queue) === JSON.stringify(expectDefault), `floor priority reordered the orchestrator queue: ${JSON.stringify(s.queue)}`);
  check(s.agents.filter((a) => a.state === 'waiting').length === expectDefault.length, 'waiting agents differ from the queue');
  await post({ anonymize: true });
  s = await stateOf(SPORT);
  check(s.rooms.map((x) => x.label).join() === 'Room A,Room B,Room C,Room D', `anonymize not applied: ${s.rooms.map((x) => x.label)}`);
  check(!JSON.stringify(s).includes('citadel'), 'anonymized state still names projects');
  await post({ anonymize: false, titles: true, speed: 2, sound: true, onboardedAt: '2026-10-06T00:00:00.000Z' });
  s = await stateOf(SPORT);
  check(s.agents.some((a) => a.title === 'Tidy the parser'), 'titles toggle did not add titles');
  const file = join(fixtureHome, '.session-orchestrator', 'settings.json');
  check(existsSync(file), 'settings.json not written under the temp HOME');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  check(onDisk.speed === 2 && onDisk.titles === true && onDisk.order.length === 2, 'settings.json content wrong');
  await post({ titles: false });

  const bad = [
    ['invalid json', '{nope', 400], ['array body', '[]', 400], ['unknown key', { bogus: 1 }, 400], ['wrong type', { anonymize: 'yes' }, 400],
    ['bad speed', { speed: 9 }, 400], ['order not array', { order: 'a' }, 400], ['order duplicate', { order: ['a', 'a'] }, 400],
    ['order item type', { order: [1] }, 400], ['order too long', { order: Array.from({ length: 65 }, (_, i) => 'r' + i) }, 400],
    ['order control char', { order: ['a\u0001b'] }, 400], ['bad date', { onboardedAt: 'tomorrow' }, 400], ['null body', 'null', 400],
  ];
  for (const [name, body, status] of bad) { const x = await post(body); check(x.status === status, `bad post "${name}" got ${x.status}`); }
  const big = await post({ order: Array.from({ length: 62 }, (_, i) => String(i).padStart(2, '0') + 'x'.repeat(62)) });
  check(big.status === 413 || big.status === 0, `oversized post got ${big.status}`);
  const hugeNoLength = await post('{"order":["' + 'y'.repeat(9000) + '"]}');
  check(hugeNoLength.status === 413 || hugeNoLength.status === 0, `huge post got ${hugeNoLength.status}`);
  check((await post({ speed: 3 }, { 'content-type': 'application/json' })).status === 403, 'post without Origin accepted');
  check((await post({ speed: 3 }, { ...ok, origin: 'http://evil.example' })).status === 403, 'cross-origin post accepted');
  check((await post({ speed: 3 }, { ...ok, origin: `http://127.0.0.1:${LPORT}` })).status === 403, 'other-port origin accepted');
  check((await post({ speed: 3 }, { ...ok, 'sec-fetch-site': 'cross-site' })).status === 403, 'cross-site fetch metadata accepted');
  check((await post({ speed: 3 }, { origin: ok.origin, 'content-type': 'text/plain' })).status === 415, 'text/plain post accepted');
  check((await httpReq(SPORT, { method: 'POST', path: '/settings', headers: ok, body: '{"speed":3}', host: 'evil.example' })).status === 403, 'foreign Host header accepted');
  check((await httpReq(SPORT, { method: 'POST', path: '/state.json', headers: ok, body: '{}' })).status === 403, 'post to another path accepted');
  check((await httpReq(SPORT, { method: 'PUT', path: '/settings', headers: ok, body: '{}' })).status === 403, 'PUT accepted');
  const still = JSON.parse((await httpReq(SPORT, { path: '/settings' })).text);
  check(still.speed === 2, `a rejected post changed settings (speed ${still.speed})`);

  server.kill();
  await realUntil(async () => (await httpReq(SPORT, { path: '/state.json' })).status === 0);
  server = await startServer(fixtureHome, SPORT);
  await serverReady(SPORT);
  const re = JSON.parse((await httpReq(SPORT, { path: '/settings' })).text);
  check(re.speed === 2 && re.sound === true && re.order.length === 2 && re.onboardedAt === '2026-10-06T00:00:00.000Z', 'settings did not survive a restart');
  s = await stateOf(SPORT);
  check(s.rooms.map((x) => x.label).join() === 'citadel,beacon,atlas,delta', 'priority did not survive a restart');

  const atlasWorking = fixture.find((f) => f.project === 'atlas' && f.kind === 'prompt');
  const deltaWorking = fixture.find((f) => f.project === 'delta' && f.kind === 'prompt');
  const nowIso = () => new Date().toISOString();
  const t0 = Date.now() - 1000;
  appendFileSync(atlasWorking.file, JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/atlas', timestamp: nowIso(), message: { role: 'user', content: 'please add tests for the parser' } }) + '\n');
  appendFileSync(deltaWorking.file, [
    { type: 'user', userType: 'external', cwd: '/work/delta', timestamp: nowIso(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }, toolUseResult: { stdout: 'ok' } },
    { type: 'user', userType: 'external', cwd: '/work/delta', timestamp: nowIso(), message: { role: 'user', content: '<cross-session-message from-session="local_zzz">ping</cross-session-message>' } },
    { type: 'user', userType: 'external', cwd: '/work/delta', timestamp: nowIso(), message: { role: 'user', content: '<task-notification>done</task-notification>' } },
    { type: 'user', userType: 'external', cwd: '/work/delta', timestamp: nowIso(), message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  s = await waitState(SPORT, (st) => st.events.some((e) => e.kind === 'boss_visit' && e.at >= t0));
  const visits = s.events.filter((e) => e.kind === 'boss_visit' && e.at >= t0);
  check(visits.length === 1 && visits[0].to === atlasWorking.id && Number.isFinite(visits[0].at), `boss_visit events wrong: ${JSON.stringify(visits)}`);
  check(!s.events.some((e) => e.kind === 'boss_visit' && e.at >= t0 && e.to === deltaWorking.id), 'system or tool lines produced a boss_visit');
  const queueFile = join(fixtureHome, '.session-orchestrator', 'queue.json');
  writeFileSync(queueFile, JSON.stringify({ ...JSON.parse(readFileSync(queueFile, 'utf8')), at: nowIso(), orchestrator: deltaWorking.uuid }));
  const t1 = Date.now() - 500;
  appendFileSync(deltaWorking.file, JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/delta', timestamp: nowIso(), message: { role: 'user', content: 'next' } }) + '\n');
  appendFileSync(atlasWorking.file, JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/atlas', timestamp: nowIso(), message: { role: 'user', content: 'and the docs' } }) + '\n');
  s = await waitState(SPORT, (st) => st.events.some((e) => e.kind === 'boss_visit' && e.at >= t1));
  check(!s.events.some((e) => e.kind === 'boss_visit' && e.at >= t1 && e.to === deltaWorking.id), 'a prompt in the orchestrator session sent the boss out');

  const echoDir = join(fixtureHome, '.claude', 'projects', '-work-echo');
  mkdirSync(echoDir, { recursive: true });
  const echoUuid = randomUUID();
  writeDesktop(fixtureHome, 'local_echo1', echoUuid);
  writeFileSync(join(echoDir, echoUuid + '.jsonl'), JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/echo', timestamp: nowIso(), message: { role: 'user', content: 'hello' } }) + '\n');
  s = await waitState(SPORT, (st) => st.events.some((e) => e.kind === 'join'));
  const joins = s.events.filter((e) => e.kind === 'join');
  check(joins.length === 1 && joins[0].agentId === agentId(echoUuid), `join events wrong: ${JSON.stringify(joins)}`);
  check(s.rooms.some((room) => room.label === 'echo'), 'new project missing from rooms');
  check(s.rooms.map((room) => room.label).slice(0, 3).join() === 'citadel,beacon,atlas', `unlisted floors not alphabetical after the listed ones: ${s.rooms.map((room) => room.label)}`);
  const focusDir = join(fixtureHome, '.session-orchestrator');
  writeFileSync(join(focusDir, 'focus.json'), JSON.stringify({ sessionId: fixture.find((f) => f.project === 'beacon' && f.ageSec === 200).uuid, at: nowIso() }));
  s = await waitState(SPORT, (st) => st.focus && st.focus.agentId);
  check(s.focus && s.focus.agentId === ids.beacon200, 'focus.json not mapped to the agent');
  const focusedFile = fixture.find((f) => f.project === 'beacon' && f.ageSec === 200).file;
  const later = () => new Date(Date.now() + 2000).toISOString();
  appendFileSync(focusedFile, JSON.stringify({ type: 'user', userType: 'external', isMeta: true, cwd: '/work/beacon', timestamp: later(), message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="local_0a1b2c3d-0000-4000-8000-00000000abcd" name="Orchestrator">go ahead</cross-session-message>' } }) + '\n');
  s = await waitState(SPORT, (st) => !st.focus);
  check(!s.focus, 'focus kept after the focused session got a message');
  writeFileSync(join(focusDir, 'focus.json'), JSON.stringify({ sessionId: fixture.find((f) => f.project === 'beacon' && f.ageSec === 200).uuid, at: later() }));
  s = await waitState(SPORT, (st) => st.focus && st.focus.agentId);
  check(s.focus && s.focus.agentId === ids.beacon200, 'a fresh focus was ended by an older message');
  appendFileSync(focusedFile, JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/beacon', timestamp: new Date(Date.now() + 4000).toISOString(), message: { role: 'user', content: 'ship it' } }) + '\n');
  s = await waitState(SPORT, (st) => !st.focus);
  check(!s.focus, 'focus kept after the user prompted the focused session');
  say('server ok');
  server.kill();

};

const goneJob = async () => {
  const home = mkdtempSync(join(tmpdir(), 'so-gone-'));
  const fx = makeFixture(home);
  const env = { env: { ...process.env, HOME: home }, encoding: 'utf8' };
  const nextInfo = () => execFileSync('node', [join(ROOT, 'scan.mjs'), '--next-info'], env);
  const state = () => JSON.parse(execFileSync('node', [join(ROOT, 'scan.mjs'), '--once', '--json'], env));
  writeQueue(home, ['local_archived1', 'local_deleted1', 'local_fixture1', null]);
  let info = nextInfo();
  check(/^GONE: 0,1$/m.test(info) && /^QUEUE_INDEX: 2$/m.test(info) && /^TITLE: "Tidy the parser"$/m.test(info), `gone --next-info ${info}`);
  let s = state();
  check(s.queueSize === 2 && s.line.length === 2 && s.line[0] === fx[0].id && s.line[1] === null && s.deferred === 0, `gone waiting room ${JSON.stringify([s.line, s.queueSize, s.deferred])}`);
  writeQueue(home, ['local_archived1', 'local_deleted1']);
  info = nextInfo();
  check(info.trim() === 'GONE: 0,1\nQUEUE: empty', `all gone --next-info ${info}`);
  s = state();
  check(s.queueSize === 0 && s.line.length === 0, `all gone waiting room ${JSON.stringify([s.line, s.queueSize])}`);
  writeQueue(home, ['local_fixture1']);
  check(!/GONE/.test(nextInfo()), 'GONE printed with no gone items');
  check(/^CONTEXT_PERCENT: unknown$/m.test(nextInfo()), `context percent without usage ${nextInfo()}`);
  const usageLine = (model, read) => JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, cache_creation_input_tokens: 83, cache_read_input_tokens: read } } }) + '\n';
  appendFileSync(fx[0].file, usageLine('claude-opus-5-5', 260000) + usageLine('<synthetic>', 0));
  info = nextInfo();
  check(/^CONTEXT_TOKENS: 260085$/m.test(info) && /^CONTEXT_MODEL: "claude-opus-5-5"$/m.test(info) && /^CONTEXT_PERCENT: 26$/m.test(info), `context percent opus ${info}`);
  appendFileSync(fx[0].file, usageLine('claude-new-model-9', 500000));
  check(/^CONTEXT_PERCENT: unknown$/m.test(nextInfo()), `context percent unknown model ${nextInfo()}`);
  appendFileSync(fx[0].file, usageLine('claude-new-model-9[1m]', 767560));
  check(/^CONTEXT_PERCENT: 77$/m.test(nextInfo()), `context percent 1m model ${nextInfo()}`);
  say('gone ok');
};

const checkInJob = async () => {
  const home = mkdtempSync(join(tmpdir(), 'so-checkin-'));
  const fx = makeFixture(home);
  const local = (project, ageSec) => 'local_fx' + (fx.findIndex((f) => f.project === project && f.ageSec === ageSec) - 1);
  for (const [project, ageSec] of [['atlas', 3600], ['beacon', 7200], ['citadel', 100000]]) {
    writeDesktop(home, local(project, ageSec), fx.find((f) => f.project === project && f.ageSec === ageSec).uuid, { title: 'Idle ' + project });
  }
  const dir = join(home, '.session-orchestrator');
  const env = { env: { ...process.env, HOME: home }, encoding: 'utf8' };
  const nextInfo = () => execFileSync('node', [join(ROOT, 'scan.mjs'), '--next-info'], env);
  const asked = (ids) => writeFileSync(join(dir, 'checkins.json'), JSON.stringify({ items: ids.map((sessionId) => ({ sessionId, at: new Date().toISOString() })) }));
  writeQueue(home, []);
  const info = nextInfo();
  check(/^QUEUE: empty\nCHECK_IN: idle$/m.test(info) && new RegExp(`^SESSION_ID: "${local('atlas', 3600)}"$`, 'm').test(info) && /^TITLE: "Idle atlas"$/m.test(info) && /^PROJECT: "atlas"$/m.test(info) && /^CONTEXT_PERCENT: /m.test(info), `check-in top floor ${info}`);
  writeQueue(home, [], local('atlas', 3600));
  check(/^TITLE: "Idle beacon"$/m.test(nextInfo()), `check-in skips the orchestrator ${nextInfo()}`);
  writeQueue(home, []);
  asked([local('atlas', 3600)]);
  check(/^TITLE: "Idle beacon"$/m.test(nextInfo()), `check-in skips a session asked recently ${nextInfo()}`);
  writeFileSync(join(dir, 'checkins.json'), JSON.stringify({ items: [{ sessionId: local('atlas', 3600), at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }] }));
  check(/^TITLE: "Idle atlas"$/m.test(nextInfo()), `check-in asks again after a day ${nextInfo()}`);
  const rooms = JSON.parse(execFileSync('node', [join(ROOT, 'scan.mjs'), '--once', '--json'], env)).rooms;
  const roomId = (label) => rooms.find((r) => r.label === label).id;
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ order: [roomId('citadel')] }));
  check(/^TITLE: "Idle citadel"$/m.test(nextInfo()), `check-in follows floor priority ${nextInfo()}`);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ streamer: true, onAir: [roomId('atlas')] }));
  asked([local('atlas', 3600)]);
  check(nextInfo().trim() === 'QUEUE: empty', `check-in only asks on-air floors ${nextInfo()}`);
  writeQueue(home, ['local_fixture1']);
  rmSync(join(dir, 'settings.json'));
  check(!/CHECK_IN/.test(nextInfo()), `check-in with items queued ${nextInfo()}`);
  say('check-in ok');
};

const streamerJob = async () => {
  const home = mkdtempSync(join(tmpdir(), 'so-stream-'));
  const fx = makeFixture(home);
  const ids = Object.fromEntries(fx.map((f) => [f.project + f.ageSec, f.id]));
  const queueFile = join(home, '.session-orchestrator', 'queue.json');
  const queueBefore = readFileSync(queueFile, 'utf8');
  await startServer(home, TPORT);
  await serverReady(TPORT);
  const ok = { origin: `http://127.0.0.1:${TPORT}`, 'content-type': 'application/json' };
  const post = (obj) => httpReq(TPORT, { method: 'POST', path: '/settings', headers: ok, body: JSON.stringify(obj) });
  const nextInfo = () => execFileSync('node', [join(ROOT, 'scan.mjs'), '--next-info'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const base = await stateOf(TPORT);
  check(base.deferred === 0 && base.rooms.every((r) => !r.offAir), 'streamer off: deferred is not 0 or a room is off air');
  const roomId = (label) => base.rooms.find((r) => r.label === label).id;
  const full = JSON.stringify(base.line);
  check(/^QUEUE_INDEX: 0$/m.test(nextInfo()) && !/DEFERRED/.test(nextInfo()), `streamer off --next-info ${nextInfo()}`);
  check((await post({ streamer: 'yes' })).status === 400, 'streamer must be a boolean');
  for (const [name, body] of [['not an array', { onAir: 'a' }], ['duplicate', { onAir: ['a', 'a'] }], ['item type', { onAir: [1] }], ['too long', { onAir: Array.from({ length: 65 }, (_, i) => 'r' + i) }], ['control char', { onAir: ['a\u0001b'] }], ['angle bracket', { onAir: ['<b>'] }]]) {
    const x = await post(body);
    check(x.status === 400, `bad onAir "${name}" got ${x.status}`);
  }
  check((await post({ streamer: true, onAir: [roomId('beacon')] })).status === 200, 'streamer post rejected');
  let s = await stateOf(TPORT);
  const raw = JSON.stringify(s);
  for (const label of ['atlas', 'citadel', 'delta']) check(!raw.includes(label), `streamer state.json leaks ${label}`);
  check(!raw.includes('/work') && !raw.includes(home) && !raw.includes('Tidy the parser'), 'streamer state.json leaks paths or titles');
  const off = s.rooms.filter((r) => r.offAir);
  check(off.length === 3 && off.every((r) => r.label === 'OFF AIR'), `off-air rooms ${JSON.stringify(s.rooms)}`);
  check(s.rooms.filter((r) => !r.offAir).map((r) => r.label).join() === 'beacon', 'the on-air room lost its label');
  const air = [ids.beacon380, ids.beacon200];
  check(JSON.stringify(s.line) === JSON.stringify(air) && JSON.stringify(s.queue) === JSON.stringify(air), `streamer line/queue ${JSON.stringify(s.line)} ${JSON.stringify(s.queue)}`);
  check(s.queueSize === 2 && s.deferred === 4, `streamer queueSize ${s.queueSize} deferred ${s.deferred}`);
  check(s.agents.filter((a) => a.state === 'waiting').map((a) => a.id).sort().join() === [...air].sort().join(), 'deferred agents still waiting');
  check(readFileSync(queueFile, 'utf8') === queueBefore, 'streamer mode wrote queue.json');
  let info = nextInfo();
  check(/^QUEUE_INDEX: 3$/m.test(info) && /^DEFERRED: 3$/m.test(info) && /^PROJECT: "beacon"$/m.test(info) && /^SESSION_ID: "/m.test(info) && /^TITLE_AVAILABLE: false$/m.test(info) && /^CONTEXT_TOKENS: /m.test(info) && /^CHECKED_AT: /m.test(info), `streamer --next-info ${info}`);
  const real = JSON.parse((await httpReq(TPORT, { path: '/rooms.json' })).text);
  check(real.map((r) => r.label).sort().join() === 'atlas,beacon,citadel,delta', `rooms.json ${JSON.stringify(real)}`);
  await post({ titles: true, onAir: [roomId('atlas')] });
  s = await stateOf(TPORT);
  check(s.agents.some((a) => a.title === 'Tidy the parser') && !JSON.stringify(s).includes('beacon'), 'on-air titles missing or off-air label leaked');
  info = nextInfo();
  check(/^QUEUE_INDEX: 0$/m.test(info) && /^DEFERRED: 0$/m.test(info) && /^TITLE: "Tidy the parser"$/m.test(info), `streamer --next-info atlas ${info}`);
  await post({ titles: false, onAir: [roomId('delta')] });
  s = await stateOf(TPORT);
  check(s.line.length === 1 && s.line[0] === ids.delta400 && /^QUEUE_INDEX: 2$/m.test(nextInfo()) && /^DEFERRED: 2$/m.test(nextInfo()), `delta only ${JSON.stringify(s.line)} ${nextInfo()}`);
  await post({ onAir: [] });
  s = await stateOf(TPORT);
  check(s.line.length === 0 && s.queue.length === 0 && s.queueSize === 0 && s.deferred === 6, `nothing on air state ${JSON.stringify([s.line, s.queue, s.queueSize, s.deferred])}`);
  check(s.agents.every((a) => a.state !== 'waiting') && s.rooms.every((r) => r.offAir), 'nothing on air: agents waiting or rooms visible');
  check(nextInfo().trim() === 'QUEUE: nothing on air', `nothing on air --next-info ${nextInfo()}`);
  const onDisk = JSON.parse(readFileSync(join(home, '.session-orchestrator', 'settings.json'), 'utf8'));
  check(onDisk.streamer === true && Array.isArray(onDisk.onAir) && onDisk.onAir.length === 0, 'streamer settings not persisted');
  await post({ streamer: false });
  s = await stateOf(TPORT);
  check(JSON.stringify(s.line) === full && s.deferred === 0 && s.queueSize === 6, 'streamer off did not restore the full line');
  check(s.rooms.map((r) => r.label).join() === 'atlas,beacon,citadel,delta' && s.rooms.every((r) => !r.offAir), 'streamer off did not restore labels');
  check(/^QUEUE_INDEX: 0$/m.test(nextInfo()) && readFileSync(queueFile, 'utf8') === queueBefore, 'streamer off --next-info or queue.json changed');
  say('streamer ok');
};

const crowdJob = async () => {
  const home = mkdtempSync(join(tmpdir(), 'so-crowd-'));
  const { sessions, oldest } = makeCrowd(home);
  const focusFile = join(home, '.session-orchestrator', 'focus.json');
  mkdirSync(join(home, '.session-orchestrator'), { recursive: true });
  const crowdServer = await startServer(home, CPORT);
  await serverReady(CPORT);
  let s = await stateOf(CPORT);
  check(s.agents.length === 80, `crowd: expected the 80 session cap, got ${s.agents.length}`);
  check(!s.agents.some((a) => a.id === oldest.id), 'crowd: the oldest session was picked without focus');
  writeFileSync(focusFile, JSON.stringify({ sessionId: 'local_crowd1', at: new Date().toISOString() }));
  s = await waitState(CPORT, (st) => st.focus && st.focus.agentId);
  check(s.focus && s.focus.agentId === oldest.id, `crowd: local id mapped to ${s.focus && s.focus.agentId}`);
  check(s.agents.some((a) => a.id === oldest.id), 'crowd: focused agent missing from agents');
  check(s.agents.length === 80, `crowd: focus changed the cap to ${s.agents.length}`);
  check(s.agents.filter((a) => a.room === (s.agents.find((x) => x.id === oldest.id) || {}).room).length === 24, 'crowd: focus exceeded the per-room cap');
  check(!s.queue.includes('visitor'), 'crowd: queue contains a visitor');
  writeFileSync(focusFile, JSON.stringify({ sessionId: oldest.uuid, at: new Date().toISOString() }));
  s = await waitState(CPORT, (st) => st.focus && st.focus.agentId === oldest.id);
  check(s.focus && s.focus.agentId === oldest.id && s.agents.some((a) => a.id === oldest.id), 'crowd: bare uuid not mapped to the agent');
  writeFileSync(focusFile, JSON.stringify({ sessionId: 'local_unknown9', at: new Date().toISOString() }));
  s = await waitState(CPORT, (st) => st.focus && st.focus.agentId === 'visitor');
  check(s.focus && s.focus.agentId === 'visitor', 'crowd: unknown local id did not stay visitor');
  writeFileSync(focusFile, JSON.stringify({ sessionId: randomUUID(), at: new Date().toISOString() }));
  s = await waitState(CPORT, (st) => st.focus && st.focus.agentId === 'visitor');
  check(s.focus && s.focus.agentId === 'visitor', 'crowd: unknown uuid did not stay visitor');
  check(sessions.length > 80, 'crowd: fixture too small');
  say('crowd ok');
  crowdServer.kill();
  rmSync(home, { recursive: true, force: true });

};

const liveJob = async () => {
  const home = mkdtempSync(join(tmpdir(), 'so-live-'));
  const fx = makeFixture(home);
  const ids = Object.fromEntries(fx.map((f) => [f.project + f.ageSec, f.id]));
  const server = await startServer(home, LPORT);
  await serverReady(LPORT);
  const base = `http://127.0.0.1:${LPORT}/`;
  const settingsFile = join(home, '.session-orchestrator', 'settings.json');
  {
    const { ctx, page, errors } = await open(1280, 720, 1, base, 1500);
    check(await ev(page, () => window.__office.server()), 'live page did not detect the server');
    await tourCheck(page, 'live-tour', { step: 4, name: 'queue' });
    const persisted = await realUntil(() => existsSync(settingsFile) && !!readJson(settingsFile).onboardedAt);
    check(persisted, 'onboardedAt not persisted by the server');
    check(errors.length === 0, 'live tour console errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, base, 2500);
    check(!(await uiState(page)).tour, 'onboarding shown again after it was finished');
    const labels = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(labels.join() === 'beacon,atlas,citadel,delta', `live floors show ${labels} (the tour reordered the first two)`);
    const plaques = await ev(page, () => window.__office.labels().map((l) => l.id));
    check(plaques.length > 0, 'no plaques');
    await nap(page, 500);
    await page.click('#gear');
    await nap(page, 400);
    const u = await boxChecks(page, 'live', 'settings');
    check(u.settings && u.geo && u.geo.n === 4, 'settings panel did not open with four floors');
    const downs = page.locator('[data-kind="down"]');
    await downs.first().click();
    await nap(page, 250);
    check(await ev(page, () => window.__office.animating()), 'floors did not start re-stacking after a priority change');
    const mid = await ev(page, () => window.__office.floors().filter((f) => f.id !== '__boss' && f.id !== '__lobby').map((f) => ({ top: f.top, y: f.y })));
    check(mid.some((f) => Math.abs(f.y - f.top) > 0.5), 'no floor was between positions during the re-stack');
    await nap(page, 1400);
    check(!(await ev(page, () => window.__office.animating())), 're-stack animation never finished');
    const after = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(after.join() === 'atlas,beacon,citadel,delta', `priority change gave ${after}`);
    const floorsNow = await ev(page, () => window.__office.floors());
    check(floorsNow.every((f) => Math.abs(f.y - f.top) < 0.01), 'floors not settled at their slots');
    check(floorsNow.filter((f) => f.id[0] === 'r').map((f) => f.id).join() === (await ev(page, () => window.__office.rooms().map((r) => r.id))).join(), 'floor stacking differs from priority order');
    await realUntil(async () => (await stateOf(LPORT)).rooms.map((r) => r.label).join() === 'atlas,beacon,citadel,delta');
    const served = await stateOf(LPORT);
    check(served.rooms.map((r) => r.label).join() === 'atlas,beacon,citadel,delta', 'server state does not reflect the UI priority change');
    const disk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    check(disk.order.join() === served.rooms.map((r) => r.id).join(), 'settings.json order does not match floors');
    await page.locator('[data-id="tg:anonymize"]').click();
    await settle(page, () => window.__office.rooms().map((r) => r.label).join() === 'Room A,Room B,Room C,Room D');
    const anon = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(anon.join() === 'Room A,Room B,Room C,Room D', `anonymize toggle gave ${anon}`);
    await page.locator('[data-id="tg:anonymize"]').click();
    await page.locator('[data-id="tg:titles"]').click();
    await settle(page, () => window.__office.agents().filter((a) => a.title === 'Tidy the parser').length === 1);
    check((await ev(page, () => window.__office.agents().filter((a) => a.title === 'Tidy the parser').length)) === 1, 'titles toggle did not show the session title tag');
    await page.screenshot({ path: join(SHOTS, 'live-settings.png') });
    await page.locator('[data-id="tg:titles"]').click();
    await page.keyboard.press('Escape');
    check(errors.length === 0, 'live console errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, base, 3000);
    const labels = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(labels.join() === 'atlas,beacon,citadel,delta', `priority lost after reload: ${labels}`);
    const q = await queueWait(page);
    const expect = [ids.atlas300, ids.delta400, ids.beacon380, ids.beacon200, ids.citadel240].filter((id) => q.queue.includes(id));
    check(JSON.stringify(q.queue) === JSON.stringify(expect), `browser queue ${JSON.stringify(q.queue)} != ${JSON.stringify(expect)}`);
    check(q.want.length === q.queue.length, `waiting room holds ${q.want.length} of ${q.queue.length} queued agents`);
    check(q.size === 6 && q.line.length === 6 && q.guests === 1, `waiting room line ${JSON.stringify(q.line)} guests ${q.guests} for ${q.size} items`);
    check(JSON.stringify(q.want) === JSON.stringify(expect.slice(0, q.want.length)), `waiting room order ${JSON.stringify(q.want)} differs from fixture queue ${JSON.stringify(expect)}`);
    await queueSeatCheck(page, 'live');
    await page.screenshot({ path: join(SHOTS, 'live-queue.png') });
    writeFileSync(join(home, '.session-orchestrator', 'focus.json'), JSON.stringify({ sessionId: fx.find((f) => f.id === q.want[0]).uuid, at: new Date().toISOString() }));
    await realUntil(async () => ((await stateOf(LPORT)).focus || {}).agentId === q.want[0]);
    await ev(page, () => window.__office.poll());
    let entered = false, waved = false;
    for (let i = 0; i < 300 && !entered; i++) {
      await nap(page, 100);
      const s = await ev(page, () => ({ ag: window.__office.agents(), q: window.__office.queue(), sec: window.__office.secretary() }));
      if (s.sec.waving) waved = true;
      const a = s.ag.find((x) => x.id === q.want[0]);
      if (a && a.fr === '__boss' && a.x < s.q.door && a.bubble) entered = true;
    }
    check(waved, 'live: secretary did not wave when focus.json named the front agent');
    check(entered, 'live: focused agent did not step from the queue into the Boss Office');
    await nap(page, 1500);
    const after = await ev(page, () => window.__office.queue());
    check(!after.want.includes(q.want[0]) && after.want[0] === q.want[1], 'live: the queue did not shuffle forward after the front agent went in');
    const forward = await ev(page, () => window.__office.agents().find((a) => a.id === window.__office.queue().want[0]));
    if (forward) check(Math.abs(forward.x - after.spots[0]) < 0.6 || forward.walking, 'live: next in line did not move to the front chair');
    check(errors.length === 0, 'live queue console errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const seated = fx.find((f) => f.project === 'atlas' && f.ageSec === 3600);
    writeFileSync(join(home, '.session-orchestrator', 'focus.json'), JSON.stringify({ sessionId: seated.uuid, at: new Date().toISOString() }));
    await realUntil(async () => ((await stateOf(LPORT)).focus || {}).agentId === seated.id);
    const { ctx, page, errors } = await open(1280, 720, 1, base, 800);
    let atSecretary = false, atBoss = false;
    for (let i = 0; i < 400 && !atBoss; i++) {
      await nap(page, 100);
      const s = await ev(page, (id) => ({ a: window.__office.agents().find((x) => x.id === id) || null, sec: window.__office.secretary(), boss: window.__office.boss() }), seated.id);
      if (!s.a) continue;
      if (s.a.fr === '__boss' && Math.abs(s.a.x - s.sec.x) < 3 && s.sec.waving) atSecretary = true;
      if (atSecretary && s.a.fr === '__boss' && s.a.bubble && Math.abs(s.a.x - s.boss.spot) < 0.6) atBoss = true;
    }
    check(atSecretary, 'live: seated focus agent did not stop at the secretary while she waved');
    check(atBoss, 'live: seated focus agent did not continue to the boss spot after the secretary waved');
    check(errors.length === 0, 'live seated focus console errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(1280, 720, 1, base, 1500);
    const r = await page.evaluate(async (p) => {
      try {
        const x = await fetch(`http://127.0.0.1:${p}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"speed":3}' });
        return x.status;
      } catch { return 0; }
    }, LPORT);
    check(r === 200, 'same-origin page post failed');
    const foreign = await (await getBrowser()).newContext();
    const fp = await foreign.newPage();
    await fp.goto(`file://${ROOT}/index.html?demo=1&onboarding=0`);
    const fr = await fp.evaluate(async (p) => {
      try {
        const x = await fetch(`http://127.0.0.1:${p}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"speed":1}' });
        return x.status;
      } catch { return 0; }
    }, LPORT);
    check(fr !== 200, `cross-origin page post got through (${fr})`);
    const disk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    check(disk.speed === 3, `cross-origin page changed settings (speed ${disk.speed})`);
    await foreign.close();
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, base, 2500, true);
    await page.click('#gear');
    await page.waitForFunction(() => window.__office.ui().geo && document.querySelectorAll('#hit [data-kind="row"]').length === 4);
    const start = await ev(page, () => window.__office.rooms().map((r) => r.id));
    const rid = start[0];
    await ev(page, () => {
      const uc = document.querySelector('canvas#uc');
      const g = window.__office.ui().geo;
      const W = { nodes: new Set(document.querySelectorAll('#hit button')), hidden: 0, blank: 0, frames: 0, shifts: 0, geo: JSON.stringify(g) };
      window['__steady'] = W;
      new MutationObserver(() => { if (!document.getElementById('ui').classList.contains('on')) W.hidden++; }).observe(document.getElementById('ui'), { attributes: true });
      const c = uc.getContext('2d');
      const tick = () => {
        W.frames++;
        if (c.getImageData(g.x + 2, g.y + 2, 1, 1).data[3] === 0) W.blank++;
        const now = window.__office.ui().geo;
        if (JSON.stringify(now) !== W.geo) W.shifts++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const poke = () => ev(page, () => { window.__office.poll(); });
    for (const [kind, n] of [['down', 3], ['up', 2]]) {
      for (let i = 0; i < n; i++) {
        await poke();
        await page.locator(`[data-id="${kind}:${rid}"]`).click();
        check(await ev(page, (id) => document.activeElement?.getAttribute('data-id') === id, `${kind}:${rid}`), `steady: focus left ${kind}:${rid} after a click`);
      }
    }
    await page.locator(`[data-id="row:${rid}"]`).focus();
    for (const key of ['ArrowUp', 'ArrowDown']) {
      await poke();
      await page.keyboard.press(key);
      check(await ev(page, (id) => document.activeElement?.getAttribute('data-id') === id, `row:${rid}`), `steady: focus left the row after ${key}`);
    }
    await sleep(3500);
    const expect = [start[1], rid, start[2], start[3]].join();
    const order = await ev(page, () => window.__office.rooms().map((r) => r.id).join());
    check(order === expect, `steady: floor order ${order} != ${expect}`);
    const w = await ev(page, () => { const W = window['__steady'], now = [...document.querySelectorAll('#hit button')]; return { same: now.length === W.nodes.size && now.every((b) => W.nodes.has(b)), hidden: W.hidden, blank: W.blank, frames: W.frames, shifts: W.shifts, open: window.__office.ui().settings }; });
    check(w.same, 'steady: settings controls were rebuilt instead of patched in place');
    check(w.open && w.hidden === 0, `steady: settings panel was hidden ${w.hidden} times`);
    check(w.frames > 30 && w.blank === 0, `steady: settings panel blank in ${w.blank} of ${w.frames} frames`);
    check(w.shifts === 0, `steady: settings panel moved ${w.shifts} times`);
    await page.screenshot({ path: join(SHOTS, 'live-steady.png') });
    const real = errors.filter((e) => !e.includes('willReadFrequently'));
    check(real.length === 0, 'steady console errors ' + real.join('|'));
    await ctx.close();
  }
  server.kill();
  rmSync(home, { recursive: true, force: true });
  say('live ok');
};

async function queueWait(page) {
  let q = null;
  for (let i = 0; i < 200; i++) {
    await nap(page, 100);
    q = await ev(page, () => window.__office.queue());
    if (q.want.length) break;
  }
  return q;
}

async function runDemo(vw, vh, dpr, tag) {
  const { ctx, page, errors } = await open(vw, vh, dpr, demoUrl('seed=3&speed=3&autofocus=0&sim=0'));
  const d = await staticChecks(page, tag);
  check(d.agents.length === 10 && d.floors.length === 6, `${tag} demo expected 10 agents/6 floors got ${d.agents.length}/${d.floors.length}`);
  await crisp(page, tag, d.px);
  await (await page.$('#cv')).screenshot({ path: join(SHOTS, `${tag}-0.png`) });
  await page.screenshot({ path: join(SHOTS, `${tag}-view.png`) });
  await queueSeatCheck(page, tag);
  await page.screenshot({ path: join(SHOTS, `${tag}-queue.png`) });
  await tripCheck(page, tag);
  await visitorCheck(page, tag);
  await focusCheck(page, tag);
  await secretaryCheck(page, tag);
  await bossRouteCheck(page, tag);
  await page.screenshot({ path: join(SHOTS, `${tag}-boss.png`) });
  await joinCheck(page, tag + ' join', false);
  await joinCheck(page, tag + ' newproject', true);
  await page.screenshot({ path: join(SHOTS, `${tag}-joined.png`) });
  let moving = 0;
  for (let i = 0; i < 60; i++) {
    await nap(page, 250);
    const s = await page.evaluate(() => { const o = window.__office; return { ag: o.agents(), fl: o.floors(), el: o.elevator(), w: o.world(), labels: o.labels() }; });
    moving = Math.max(moving, s.ag.filter((a) => a.away).length);
    for (const a of s.ag) {
      if (a.away && !a.inCab && !a.queued) { const f = s.fl.find((x) => x.id === a.fr); check(f && Math.abs(a.y - f.foot) < 0.01, `${tag} walker ${a.name} off floor line`); }
      if (a.inCab) check(Math.abs(a.y - Math.round(s.el.foot)) < 0.01, `${tag} rider y != cab`);
      if (a.bubble) {
        const b = a.bubble;
        check(b.x >= 0 && b.y >= 0 && b.x + b.w <= s.w.w && b.y + b.h + 3 <= s.w.h, `${tag} bubble outside canvas`);
        for (const l of s.labels) check(!hit(b, l), `${tag} bubble overlaps label`);
      }
    }
  }
  await (await page.$('#cv')).screenshot({ path: join(SHOTS, `${tag}-1.png`) });
  const e2 = errors.filter(Boolean);
  check(e2.length === 0, `${tag} console errors: ${e2.join(' | ')}`);
  say(tag, 'ok; px', d.px, 'world', d.w.w + 'x' + d.w.h, 'max away', moving);
  await ctx.close();
}

const floorSpread = (page, id) => page.evaluate((fid) => {
  const f = window.__office.floors().find((x) => x.id === fid);
  const w = window.__office.world();
  const c = document.getElementById('cv');
  const copy = document.createElement('canvas');
  copy.width = c.width; copy.height = c.height;
  const g = copy.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, 0, 0);
  let spread = 0;
  for (let x = 60; x < w.w - 60; x += 3) {
    for (const y of [f.y + 6, f.y + Math.round((f.foot - f.top) / 2), f.foot - 3]) {
      const d = g.getImageData(x, y, 1, 1).data;
      spread = Math.max(spread, Math.max(d[0], d[1], d[2]) - Math.min(d[0], d[1], d[2]));
    }
  }
  return spread;
}, id);

async function streamerUi(page, tag) {
  const names = ['dashboard', 'gateway', 'infra', 'docs'];
  const labels = () => ev(page, () => window.__office.rooms().map((r) => r.label));
  await page.locator('[data-id="tg:streamer"]').click();
  await nap(page, 400);
  check((await page.locator('[data-id="tg:streamer"]').getAttribute('aria-checked')) === 'true', `${tag} streamer toggle not on`);
  check((await labels()).every((l) => l === 'OFF AIR'), `${tag} streamer on did not put every floor off air: ${await labels()}`);
  const ticks = page.locator('[data-kind="tick"]');
  const tickCount = await ticks.count();
  check(tickCount === (await uiState(page)).geo.rows && tickCount >= 3, `${tag} floor rows missing ticks (${tickCount})`);
  const first = await ticks.first().getAttribute('aria-label');
  check(/, off stream$/.test(first || '') && names.some((n) => (first || '').startsWith(n)), `${tag} tick label ${first}`);
  await boxChecks(page, tag, 'settings streamer');
  const before = await ev(page, () => window.__office.rooms().map((r) => r.id));
  const firstId = before[0];
  await ticks.first().click();
  await nap(page, 400);
  const afterTick = await ev(page, () => window.__office.rooms());
  check(afterTick.map((r) => r.id).join() === before.join(), `${tag} a tick click moved a floor`);
  check(afterTick.filter((r) => !r.offAir).map((r) => r.id).join() === firstId && afterTick[0].label !== 'OFF AIR' && afterTick.slice(1).every((r) => r.label === 'OFF AIR'), `${tag} ticking one floor did not put only it on air: ${JSON.stringify(afterTick)}`);
  check((await ticks.first().getAttribute('aria-checked')) === 'true' && /, on stream$/.test((await ticks.first().getAttribute('aria-label')) || ''), `${tag} tick not checked after click`);
  check((await ev(page, () => window.__office.settings().onAir)).join() === firstId, `${tag} onAir not stored`);
  const fl = await ev(page, () => window.__office.floors().map((f) => f.id));
  const onSpread = await floorSpread(page, firstId);
  const offSpread = await floorSpread(page, fl.find((id) => id[0] !== '_' && id !== firstId) || '');
  check(onSpread > 40 && offSpread < 14, `${tag} off-air floors not greyed (on ${onSpread}, off ${offSpread})`);
  await page.screenshot({ path: join(SHOTS, `${tag}-streamer-on.png`) });
  await page.locator('[data-kind="row"]').nth(1).focus();
  await page.keyboard.press('Space');
  await nap(page, 400);
  const afterSpace = await ev(page, () => window.__office.rooms());
  check(afterSpace.filter((r) => !r.offAir).length === 2 && !afterSpace[1].offAir, `${tag} Space on a row did not toggle its floor: ${JSON.stringify(afterSpace)}`);
  check(await ev(page, () => document.activeElement instanceof HTMLElement && document.activeElement.dataset.id === 'row:' + window.__office.rooms()[1].id), `${tag} focus lost after Space`);
  await page.keyboard.press('Space');
  await nap(page, 400);
  check((await ev(page, () => window.__office.rooms().filter((r) => !r.offAir).length)) === 1, `${tag} Space did not toggle off again`);
  await page.locator('[data-id="tg:streamer"]').click();
  await nap(page, 400);
  const restored = await labels();
  check(restored.every((l) => l !== 'OFF AIR') && restored.slice().sort().join() === names.slice().sort().join(), `${tag} streamer off did not restore labels: ${restored}`);
  check((await page.locator('[data-kind="tick"]').count()) === 0, `${tag} ticks still shown with streamer off`);
  check((await ev(page, () => window.__office.rooms().every((r) => !r.offAir))), `${tag} offAir flags remain after streamer off`);
  check((await ev(page, () => window.__office.settings().onAir)).join() === firstId, `${tag} onAir lost when streamer turned off`);
}

async function runUi(vw, vh, dpr, tag) {
  {
    const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?demo=1&seed=3&speed=3&sim=0`, 1200);
    await tourCheck(page, tag + '-tour', { step: 1, name: 'highlight' });
    const ls = await ev(page, () => window.__office.settings());
    check(!!ls.onboardedAt, `${tag} onboarding not saved to localStorage`);
    await page.reload();
    await nap(page, 1200);
    check(!(await uiState(page)).tour, `${tag} onboarding shown again after the first run`);
    const saved = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(saved[0] !== 'dashboard', `${tag} floor priority not restored from localStorage: ${saved}`);
    check(errors.length === 0, `${tag} tour console errors ${errors.join('|')}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(vw, vh, dpr, `file://${ROOT}/index.html?demo=1&seed=3&speed=3&sim=0&onboarding=1`, 1200);
    check(!!(await uiState(page)).tour, `${tag} ?onboarding=1 did not force the tour`);
    await page.locator('[data-id="skip"]').click();
    await nap(page, 300);
    check(!(await uiState(page)).tour, `${tag} skip did not close the tour`);
    await page.reload();
    await nap(page, 1200);
    check(!!(await uiState(page)).tour, `${tag} ?onboarding=1 not forced again after skipping`);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(vw, vh, dpr, demoUrl('seed=3&speed=3&sim=0&autofocus=0'), 1200);
    check(!(await uiState(page)).tour, `${tag} onboarding=0 still showed the tour`);
    await page.locator('#gear').click();
    await nap(page, 300);
    const u = await boxChecks(page, tag, 'settings');
    check(u.settings && u.geo.n === 4, `${tag} settings did not list four floors`);
    await page.screenshot({ path: join(SHOTS, `${tag}-settings.png`) });
    const start = await ev(page, () => window.__office.rooms().map((r) => r.id));
    await page.locator('[data-kind="down"]').first().click();
    await nap(page, 150);
    check(await ev(page, () => window.__office.animating()), `${tag} no re-stack animation`);
    await nap(page, 1400);
    let now = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(now[0] === start[1] && now[1] === start[0], `${tag} down button did not swap the first two floors`);
    await page.locator('[data-kind="row"]').nth(3).focus();
    await page.keyboard.press('ArrowUp');
    await nap(page, 1400);
    now = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(now[2] === start[3], `${tag} keyboard move failed: ${now}`);
    await dragRow(page, 2, 0);
    await nap(page, 1500);
    now = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(now[0] === start[3], `${tag} drag to the top failed: ${now}`);
    const floors = await ev(page, () => window.__office.floors().map((f) => f.id).filter((id) => id[0] !== '_'));
    check(floors.join() === now.join(), `${tag} floors not stacked in priority order`);
    const stored = await ev(page, () => window.__office.settings().order);
    check(stored.join() === now.join(), `${tag} settings order ${stored} != floors ${now}`);
    await boxChecks(page, tag, 'settings after reorder');
    await page.locator('[data-id="tg:anonymize"]').click();
    await nap(page, 300);
    check((await ev(page, () => window.__office.rooms().map((r) => r.label))).join() === 'Room A,Room B,Room C,Room D', `${tag} demo anonymize failed`);
    await page.locator('[data-id="tg:anonymize"]').click();
    await page.locator('[data-id="tg:titles"]').click();
    await nap(page, 300);
    check((await ev(page, () => window.__office.agents().filter((a) => a.title).length)) === 10, `${tag} demo titles not shown`);
    await page.locator('[data-id="tg:titles"]').click();
    await streamerUi(page, tag);
    await page.locator('[data-id="sp:2"]').click();
    await page.locator('[data-id="tg:sound"]').click();
    const st = await ev(page, () => window.__office.settings());
    check(st.speed === 2 && st.sound === true, `${tag} speed/sound toggles not stored`);
    await page.locator('[data-id="reset"]').click();
    await nap(page, 400);
    check(!!(await uiState(page)).tour && !(await ev(page, () => window.__office.settings().onboardedAt)), `${tag} reset onboarding did not restart the tour`);
    await page.locator('[data-id="skip"]').click();
    check(errors.length === 0, `${tag} settings console errors ${errors.join('|')}`);
    await ctx.close();
  }
}

async function perf() {
  {
    const { ctx, page, errors } = await open(1280, 720, 1, demoUrl('seed=4&speed=3&autofocus=1'));
    let moving = 0, atBoss = false, bossAway = false, sawVisit = false;
    for (let i = 0; i < 360; i++) {
      await nap(page, 250);
      const s = await page.evaluate(() => ({ ag: window.__office.agents(), b: window.__office.bossActor() }));
      moving = Math.max(moving, s.ag.filter((a) => a.away && !a.settled).length + (s.b.away ? 1 : 0));
      if (s.ag.some((a) => a.fr === '__boss' && a.away && !a.inCab && !a.queued)) atBoss = true;
      if (s.b.away) bossAway = true;
      if (s.ag.some((a) => a.id.startsWith('dn_'))) sawVisit = true;
    }
    say('demo max concurrent movers', moving);
    check(moving >= 2 && moving <= 4, `demo concurrent movers ${moving} outside 2..4`);
    check(atBoss, 'demo never summoned an agent to the boss office');
    check(bossAway, 'demo never sent the boss to a desk');
    check(sawVisit, 'demo never added a joining agent');
    check(errors.length === 0, 'concurrency page errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, demoUrl('seed=5'), 700, true);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const m0 = (await cdp.send('Performance.getMetrics')).metrics;
    const get = (m, n) => m.find((x) => x.name === n).value;
    const f0 = await page.evaluate(() => window.__office.frames());
    await sleep(5000);
    const m1 = (await cdp.send('Performance.getMetrics')).metrics;
    const f1 = await page.evaluate(() => window.__office.frames());
    const cpu = (get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / 5;
    const fps = (f1 - f0) / 5;
    say('cpu', (cpu * 100).toFixed(1) + '%', 'fps', fps.toFixed(1));
    check(cpu < 0.2, `cpu too high ${cpu}`);
    check(fps <= 21 && fps >= 8, `fps out of range ${fps}`);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(300);
    const h0 = await page.evaluate(() => window.__office.frames());
    await sleep(800);
    const h1 = await page.evaluate(() => window.__office.frames());
    check(h1 === h0, 'frame loop not paused while hidden');
    check(errors.length === 0, 'perf page errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 2, `file://${ROOT}/index.html?demo=1&seed=5&onboarding=1`, 1500, true);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.locator('[data-id="next"]').click();
    await page.locator('[data-id="next"]').click();
    await page.locator('[data-id="next"]').click();
    await page.locator('[data-id="next"]').click();
    const m0 = (await cdp.send('Performance.getMetrics')).metrics;
    await sleep(4000);
    const m1 = (await cdp.send('Performance.getMetrics')).metrics;
    const get = (m, n) => m.find((x) => x.name === n).value;
    const cpu = (get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / 4;
    say('cpu with the tour and settings open', (cpu * 100).toFixed(1) + '%');
    check(cpu < 0.3, `cpu with the tour open too high ${cpu}`);
    check(errors.length === 0, 'tour perf errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, demoUrl('night=1'), 700, true);
    await sleep(3000);
    check((await page.evaluate(() => window.__office.dim())) > 0.5, 'night dim not applied');
    check((await page.evaluate(() => window.__office.sky())) === 'night', 'night sky not applied');
    await page.screenshot({ path: join(SHOTS, 'night.png') });
    check(errors.length === 0, 'night errors');
    await ctx.close();
  }
}

const leaveState = (drop) => {
  const rooms = ['r1', 'r2', 'r3', 'r4'].filter((r) => !(drop.rooms || []).includes(r)).map((r) => ({ id: r, label: 'room ' + r }));
  const agents = [];
  for (const r of rooms) for (let k = 0; k < 2; k++) { const id = r.id + '_a' + k; if (!(drop.agents || []).includes(id)) agents.push({ id, name: 'Ag' + id, room: r.id, state: k ? 'idle' : 'working' }); }
  return { rooms, agents, events: [], generatedAt: Date.now() };
};

async function leaveCheck(vw, vh, tag) {
  const { ctx, page, errors } = await open(vw, vh, 1, `file://${ROOT}/index.html?onboarding=0`, 600);
  const feed = (drop) => page.evaluate((st) => window.__office.apply(st), leaveState(drop));
  await feed({});
  await nap(page, 1500);
  const base = await page.evaluate(() => ({ d: window.__office.desks().length, x: window.__office.elevator().x, ag: window.__office.agents().length }));
  check(base.d === 8 && base.ag === 8, `${tag} leave setup has ${base.d} desks, ${base.ag} agents`);
  await feed({ agents: ['r1_a0'] });
  const start = await page.evaluate(() => window.__office.agents().find((a) => a.id === 'r1_a0'));
  let closer = false, cab = false, deskKept = false, goneAt = -1, shot = false, atDoor = false, doorOpen = false, doorShot = false;
  for (let i = 0; i < 250; i++) {
    await nap(page, 100);
    const s = await page.evaluate(() => ({ a: window.__office.agents().find((a) => a.id === 'r1_a0'), desk: window.__office.desks().some((d) => d.id === 'r1_a0'), n: window.__office.agents().length, door: window.__office.lobbyDoor() }));
    if (s.door.open > 0.9) doorOpen = true;
    if (!s.a) { goneAt = i; break; }
    if (s.a.x <= s.door.x + 6) atDoor = true;
    if (!doorShot && s.door.open > 0.5) { doorShot = true; await page.screenshot({ path: join(SHOTS, `leave-anims-${tag}-door.png`) }); }
    if (i < 4 && s.desk && s.a) deskKept = true;
    if (Math.abs(s.a.x - base.x) < Math.abs(start.x - base.x) - 8 || s.a.inCab) closer = true;
    if (s.a.inCab) cab = true;
    if (!shot && s.a.walking && Math.abs(s.a.x - start.x) > 70) { shot = true; await page.screenshot({ path: join(SHOTS, `leave-anims-${tag}-walkout.png`) }); }
  }
  check(deskKept, `${tag} desk vanished as soon as the agent was removed`);
  check(closer && cab, `${tag} removed agent did not walk to the elevator and board (closer ${closer}, cab ${cab})`);
  check(goneAt > 3 && goneAt >= 0, `${tag} removed agent vanished at once or never left (${goneAt})`);
  check(atDoor && doorOpen, `${tag} removed agent did not leave through the lobby door (at door ${atDoor}, door opened ${doorOpen})`);
  await nap(page, 1200);
  const shut = await page.evaluate(() => window.__office.lobbyDoor().open);
  check(shut === 0, `${tag} lobby door did not close after the agent left (${shut})`);
  const after = await page.evaluate(() => ({ d: window.__office.desks().map((d) => d.id), ag: window.__office.agents().length }));
  check(!after.d.includes('r1_a0') && after.ag === 7, `${tag} desk not freed after the agent left`);
  const back = leaveState({});
  await page.evaluate((st) => window.__office.apply(st), back);
  await nap(page, 300);
  await feed({ agents: ['r4_a1'] });
  await nap(page, 500);
  await page.evaluate((st) => window.__office.apply(st), back);
  let sat = false;
  for (let i = 0; i < 300 && !sat; i++) {
    await nap(page, 100);
    const a = await page.evaluate(() => window.__office.agents().find((x) => x.id === 'r4_a1'));
    sat = !!a && !a.away && a.sit === 1 && !a.gone;
  }
  check(sat, `${tag} agent that reappeared while leaving did not go back to its desk`);
  await feed({ rooms: ['r2'] });
  let slid = false, stillDrawn = false, ghostOut = 0, shot2 = false, shot3 = false;
  for (let i = 0; i < 600; i++) {
    await nap(page, 60);
    const s = await page.evaluate(() => ({ an: window.__office.anim(), fl: window.__office.floors().map((f) => f.id), ag: window.__office.agents().length }));
    if (s.an && s.an.out > 0) {
      slid = true; ghostOut++;
      if (!shot3) { shot3 = true; await page.screenshot({ path: join(SHOTS, `leave-anims-${tag}-firstframe.png`) }); }
      if (!shot2 && s.an.ps > 0.25) { shot2 = true; await page.screenshot({ path: join(SHOTS, `leave-anims-${tag}-slideout.png`) }); }
    }
    if (s.an && s.an.out > 0 && s.fl.length === 5) stillDrawn = true;
    if (!s.an && slid) break;
  }
  check(slid && ghostOut >= 3, `${tag} removed floor never slid out (${ghostOut} frames)`);
  check(stillDrawn, `${tag} removed floor not kept while animating`);
  await nap(page, 300);
  const final = await page.evaluate(() => ({ fl: window.__office.floors(), ds: window.__office.desks(), w: window.__office.world(), an: window.__office.animating(), ch: document.getElementById('cv').height, ag: window.__office.agents().map((a) => ({ id: a.id, x: a.x, y: a.y })).sort((p, q) => (p.id < q.id ? -1 : 1)) }));
  check(!final.an, `${tag} removal animation never finished`);
  check(final.ch === final.w.h, `${tag} canvas height ${final.ch} not shrunk to the world ${final.w.h}`);
  const fresh = await open(vw, vh, 1, `file://${ROOT}/index.html?onboarding=0`, 600);
  await fresh.page.evaluate((st) => window.__office.apply(st), leaveState({ rooms: ['r2'] }));
  await nap(fresh.page, 1800);
  const ref = await fresh.page.evaluate(() => ({ fl: window.__office.floors(), ds: window.__office.desks(), w: window.__office.world(), ag: window.__office.agents().map((a) => ({ id: a.id, x: a.x, y: a.y })).sort((p, q) => (p.id < q.id ? -1 : 1)) }));
  check(JSON.stringify(final.fl) === JSON.stringify(ref.fl), `${tag} floors differ from a fresh load: ${JSON.stringify(final.fl)} vs ${JSON.stringify(ref.fl)}`);
  check(JSON.stringify(final.ds) === JSON.stringify(ref.ds) && JSON.stringify(final.w) === JSON.stringify(ref.w), `${tag} desks or world differ from a fresh load`);
  check(JSON.stringify(final.ag) === JSON.stringify(ref.ag), `${tag} agents differ from a fresh load ${JSON.stringify(final.ag)} vs ${JSON.stringify(ref.ag)}`);
  check(final.fl.length === 5 && final.fl.every((f) => Math.abs(f.y - f.top) < 0.01), `${tag} floors not settled ${JSON.stringify(final.fl)}`);
  check(errors.length === 0 && fresh.errors.length === 0, `${tag} leave console errors ${errors.join('|')} ${fresh.errors.join('|')}`);
  await fresh.ctx.close();
  await ctx.close();
}

const NAMES = ['averyveryverylongprojectname', 'layer-by-layer-rollout', 'café-crème', '数据管道', 'a_b.c-d e', 'alpha', 'LONG-UPPER-NAME-HERE', 'fifteen-letters', 'two words here now'];
async function runNames(vw, vh, dpr, tag) {
  const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?onboarding=0`, 900);
  const rooms = NAMES.map((label, i) => ({ id: 'n' + i, label }));
  const agents = rooms.map((r, i) => ({ id: 'na' + i, name: 'Fern' + i, room: r.id, state: 'idle', since: 0 }));
  await ev(page, (st) => window.__office.load(st), { rooms, agents, events: [], generatedAt: Date.now() });
  await nap(page, 500);
  const d = await ev(page, (names) => ({ labels: window.__office.labels(), sign: window.__office.sign(), folds: names.map((n) => window.__office.fold(n)) }), NAMES);
  rooms.forEach((r, i) => {
    const rows = d.labels.filter((l) => l.id === r.id), nameRows = rows.slice(0, -1), full = d.folds[i], ts = nameRows.map((l) => l.t), last = ts[ts.length - 1];
    check(nameRows.length >= 1 && nameRows.length <= 2, `${tag} ${r.label} has ${nameRows.length} name rows`);
    for (const l of nameRows) {
      check(l.w <= d.sign.max, `${tag} ${r.label} row "${l.t}" is ${l.w}px, max ${d.sign.max}`);
      check(l.x + l.w <= d.sign.x - 2 + d.sign.inner, `${tag} ${r.label} row "${l.t}" crosses the sign edge`);
    }
    if (last.endsWith('…')) check(ts.length === 1 && full.startsWith(last.slice(0, -1)), `${tag} ${r.label} bad ellipsis rows ${JSON.stringify(ts)}`);
    else if (ts.length === 1) check(last === full, `${tag} ${r.label} single row "${last}" != "${full}"`);
    else check(ts.join(' ') === full || (ts.join('') === full && /[-_.]$/.test(ts[0])), `${tag} ${r.label} split inside a word: ${JSON.stringify(ts)} of "${full}"`);
  });
  const hy = d.labels.filter((l) => l.id === 'n1').map((l) => l.t);
  check(hy.length === 3 && hy[0].endsWith('-'), `${tag} hyphenated name not split at a hyphen: ${JSON.stringify(hy)}`);
  check(d.labels.filter((l) => l.id === 'n3')[0].t === '????', `${tag} cjk name not question marks`);
  await staticChecks(page, tag + '-names');
  if (dpr === 1 && (vw === 1280 || vw === 390)) {
    const dir = process.env.SHOTS_NAMES || SHOTS;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `office-${vw}.png`) });
    await page.click('#gear');
    await nap(page, 500);
    check((await uiState(page)).settings, `${tag} settings did not open`);
    await page.screenshot({ path: join(dir, `settings-${vw}.png`) });
  }
  check(errors.length === 0, `${tag} names console errors ${errors.join('|')}`);
  await ctx.close();
}

const GENERIC_SAY = ['...', '?!', 'HMM', 'SO...', 'YEP', 'OH?'];
function behaviorFixture() {
  const rooms = [{ id: 'r1', label: 'alpha' }, { id: 'r2', label: 'beta' }, { id: 'r3', label: 'gamma' }];
  const mk = (id, room, state, extra = {}) => ({ id, name: id.toUpperCase(), room, state, since: state === 'waiting' ? Number(id.slice(2)) + 1 : 0, ...extra });
  const agents = [mk('bw0', 'r1', 'waiting'), mk('bw1', 'r1', 'waiting'), mk('bw2', 'r1', 'waiting'), mk('bk0', 'r1', 'working'), mk('bw3', 'r2', 'waiting'), mk('bw4', 'r2', 'waiting'), mk('bk1', 'r2', 'working'), mk('bi0', 'r3', 'idle'), mk('bi1', 'r3', 'idle', { sleepy: true }), mk('bi2', 'r3', 'idle')];
  const queue = ['bw0', 'bw1', 'bw2', 'bw3', 'bw4'];
  const line = ['bw0', 'bw1', null, 'bw2', 'bw3', null, 'bw4'];
  return { rooms, agents, events: [], queue, queueSize: 7, line, generatedAt: Date.now() };
}

async function behaviorRun(vw, vh, tag, chaos, shots) {
  const url = `file://${ROOT}/index.html?onboarding=0&chaos=${chaos}&speed=3`;
  const { ctx, page, errors } = await open(vw, vh, 1, url, 600);
  const st = behaviorFixture();
  await ev(page, (s) => window.__office.load(s), st);
  let ready = false;
  for (let i = 0; i < 160 && !ready; i++) {
    await nap(page, 400);
    ready = await ev(page, () => window.__office.agents().filter((a) => a.queued).length === 5);
  }
  check(ready, `${tag} the five queued agents never settled in the waiting room`);
  const dir = process.env.SHOTS_BEHAVIOR || join(SHOTS, 'behavior');
  mkdirSync(dir, { recursive: true });
  const taken = new Set();
  const snap = async (name) => {
    if (!shots || taken.has(name)) return;
    taken.add(name);
    await page.screenshot({ path: join(dir, `${name}-${vw}.png`) });
  };
  let maxDrift = 0, sawFace = false, sawDoze = null, workingMoved = false, sawWave = false;
  const wake = { done: false };
  const t0 = vnow(page);
  const limit = chaos === 0 ? 14000 : 80000;
  while (vnow(page) - t0 < limit) {
    await nap(page, chaos === 0 ? 500 : 150);
    const d = await ev(page, () => ({ b: window.__office.behavior(), ag: window.__office.agents(), q: window.__office.queue() }));
    d.q.want.forEach((id, i) => {
      const a = d.ag.find((x) => x.id === id);
      if (a && a.queued) maxDrift = Math.max(maxDrift, Math.abs(a.x - d.q.spots[i]));
    });
    for (const a of d.ag.filter((x) => x.id.startsWith('bk'))) if (a.away || a.sit !== 1) workingMoved = true;
    const chats = d.b.poses.filter((p) => p.kind === 'chat').sort((a, b) => a.slot - b.slot);
    for (let i = 0; i + 1 < chats.length; i++) if (chats[i + 1].slot === chats[i].slot + 1 && chats[i].dir === 1 && chats[i + 1].dir === -1) sawFace = true;
    if (sawFace && d.b.poses.some((p) => p.text)) await snap('chat');
    if (d.b.poses.filter((p) => ['hop', 'stretch', 'look'].includes(p.kind)).length >= 2) { sawWave = true; await snap('wave'); }
    if (d.b.dozing.length) { sawDoze = sawDoze || d.b.dozing[0]; await snap('doze'); }
    if (sawDoze && !wake.done && chaos > 0) {
      wake.done = true;
      const st2 = behaviorFixture();
      st2.agents.find((a) => a.id === sawDoze).state = 'working';
      await ev(page, (s) => window.__office.load(s), st2);
      await nap(page, 250);
      const dz = await ev(page, () => window.__office.behavior().dozing);
      check(!dz.includes(sawDoze), `${tag} agent kept dozing after its real state changed to working`);
      await ev(page, (s) => window.__office.load(s), behaviorFixture());
    }
    const b = d.b;
    const chainOk = b.log.some((e) => e.chain >= 2);
    if (chaos > 0 && chainOk && sawFace && sawDoze && sawWave && vnow(page) - t0 > 20000) break;
  }
  const b = await ev(page, () => window.__office.behavior());
  say(tag, 'chaos', chaos, 'log', b.log.length, 'maxDrift', maxDrift.toFixed(2));
  check(!workingMoved, `${tag} a working agent left its desk`);
  check(b.log.every((e) => e.state !== 'working' || e.act === 'shh'), `${tag} a working agent acted`);
  check(b.log.filter((e) => e.act === 'doze').every((e) => e.state === 'idle'), `${tag} a non-idle agent dozed`);
  check(maxDrift < 3, `${tag} a waiting agent drifted ${maxDrift}px from its slot`);
  check(b.chaos === Number(chaos), `${tag} snapshot chaos ${b.chaos}`);
  if (chaos === 0) {
    check(b.log.length === 0 && b.poses.length === 0 && b.dozing.length === 0, `${tag} chaos=0 still acted: ${JSON.stringify(b.log.slice(0, 3))}`);
  } else if (shots) {
    const acts = b.log.filter((e) => ['hop', 'stretch', 'look'].includes(e.act));
    check(acts.some((e) => e.chain === 1 && e.from === ''), `${tag} no fidget action happened`);
    const chained = b.log.filter((e) => e.chain >= 2);
    check(chained.length > 0, `${tag} no contagion chain of length 2 or more`);
    check(b.log.every((e) => e.chain <= b.cap), `${tag} a chain outgrew the cap ${b.cap}`);
    for (const e of chained) {
      const parent = b.log.filter((p) => p.key === e.from && p.root === e.root && p.chain === e.chain - 1 && p.t <= e.t).pop();
      if (parent) check(e.t - parent.t <= 3.6, `${tag} contagion fired ${e.t - parent.t}s after its source`);
    }
    check(b.log.filter((e) => e.act === 'chat').length > 0 && sawFace, `${tag} no adjacent pair faced each other to chat`);
    const said = b.log.filter((e) => e.act === 'say');
    check(said.length > 0 && said.every((e) => GENERIC_SAY.includes(e.text)), `${tag} chat bubbles not from the generic set: ${JSON.stringify(said.map((e) => e.text))}`);
    check(sawDoze !== null, `${tag} nobody dozed next to a sleepy desk neighbour`);
    check(b.log.filter((e) => e.act === 'doze').every((e) => ['bi0', 'bi2'].includes(e.key)), `${tag} dozing not limited to idle neighbours of the sleepy agent`);
  }
  if (shots && chaos > 0) {
    const ag = await ev(page, () => window.__office.queue().want);
    const st3 = behaviorFixture();
    st3.agents.find((a) => a.id === 'bw0').state = 'working';
    st3.queue = ag.slice(1);
    st3.queueSize = 6;
    st3.line = ['bw1', null, 'bw2', 'bw3', null, 'bw4'];
    const rec = await ev(page, (s) => {
      const o = window.__office;
      const first = new Map(o.agents().filter((a) => a.queued).map((a) => [a.id, a.x]));
      const started = new Map();
      const tStart = o.behavior().t;
      o.load(s);
      for (;;) {
        o.advance(1 / 15);
        const t = o.behavior().t;
        for (const a of o.agents()) if (first.has(a.id) && !started.has(a.id) && Math.abs(a.x - first.get(a.id)) > 0.5) started.set(a.id, t);
        if (t - tStart > 5) return { want: o.queue().want, started: [...started.entries()] };
      }
    }, st3);
    const starts = rec.want.map((id) => (rec.started.find((e) => e[0] === id) || [id, null])[1]).filter((v) => v !== null);
    check(starts.length >= 3, `${tag} too few waiters stepped forward: ${JSON.stringify(rec)}`);
    let ordered = true;
    for (let i = 1; i < starts.length; i++) if (starts[i] < starts[i - 1] - 0.001) ordered = false;
    check(ordered && starts[starts.length - 1] > starts[0], `${tag} waiters did not step forward as a ripple: ${JSON.stringify(starts)}`);
  }
  check(errors.length === 0, `${tag} behavior console errors ${errors.join('|')}`);
  await ctx.close();
}
function coolerFixture(withLeaver, patch = {}) {
  const rooms = [{ id: 'c2', label: 'alpha' }, { id: 'd1', label: 'beta' }];
  const mk = (id, room, state, extra = {}) => ({ id, name: id.toUpperCase(), room, state, since: state === 'waiting' ? 1 : 0, ...extra });
  const agents = [mk('cw0', 'c2', 'working'), ...(withLeaver ? [mk('cx', 'c2', 'idle')] : []), mk('cw2', 'c2', 'working'), mk('ci3', 'c2', 'idle'), mk('ci4', 'c2', 'idle'), mk('ci5', 'c2', 'idle'), mk('ds0', 'd1', 'idle', { sleepy: true }), mk('di1', 'd1', 'idle'), mk('di2', 'd1', 'idle'), mk('dw3', 'd1', 'working')];
  for (const a of agents) if (patch[a.id]) Object.assign(a, patch[a.id]);
  const queue = agents.filter((a) => a.state === 'waiting').map((a) => a.id);
  return { rooms, agents, events: [], queue, queueSize: queue.length, line: queue.slice(), generatedAt: Date.now() };
}

async function coolerRun(vw, vh, tag, chaos, shots) {
  const url = `file://${ROOT}/index.html?onboarding=0&chaos=${chaos}&speed=3`;
  const { ctx, page, errors } = await open(vw, vh, 1, url, 600);
  const dir = process.env.SHOTS_BEHAVIOR2 || join(SHOTS, 'behavior2');
  mkdirSync(dir, { recursive: true });
  const taken = new Set();
  const snap = async (name) => {
    if (!shots || taken.has(name)) return;
    taken.add(name);
    await page.screenshot({ path: join(dir, `${name}-${vw}.png`) });
  };
  const sample = () => ev(page, () => ({ b: window.__office.behavior(), ag: window.__office.agents(), ds: window.__office.desks(), q: window.__office.queue() }));
  const load = (st) => ev(page, (s) => window.__office.load(s), st);
  await load(coolerFixture(true));
  await nap(page, 800);
  await load(coolerFixture(false));
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    await nap(page, 300);
    const d = await sample();
    ready = d.ds.filter((x) => x.room === 'c2').length === 5 && d.b.props.some((p) => p.id === 'c2' && (p.kind === 'cooler' || p.kind === 'coffee')) && d.ag.every((a) => !a.away && a.sit === 1);
  }
  check(ready, `${tag} the cooler floor never got a free cell with a prop`);
  const events = [], seen = new Set();
  const deskX = new Map();
  const trips = new Map();
  let maxAt = 0, sawPair = false, workerMoved = false, badReturn = '', pairFacingOk = false, sawShhPose = false;
  const collect = (d) => {
    for (const e of d.b.log) { const k = `${e.t}|${e.key}|${e.act}|${e.text}`; if (!seen.has(k)) { seen.add(k); events.push(e); } }
    for (const x of d.ds) deskX.set(x.id, x.x);
    const live = new Map(d.b.cooler.map((c) => [c.key, c]));
    for (const c of d.b.cooler) trips.set(c.key, true);
    for (const id of [...trips.keys()]) {
      if (live.has(id)) continue;
      trips.delete(id);
      const a = d.ag.find((x) => x.id === id);
      if (a && !a.gone && !a.q && a.state === 'idle' && (a.away || a.sit !== 1 || Math.abs(a.x - deskX.get(id)) > 0.6)) badReturn = `${id} ${JSON.stringify(a)} desk ${deskX.get(id)}`;
    }
    const byProp = new Map();
    for (const c of d.b.cooler) if (c.phase !== 'back') byProp.set(c.propX, (byProp.get(c.propX) || 0) + 1);
    for (const n of byProp.values()) maxAt = Math.max(maxAt, n);
    const at = d.b.cooler.filter((c) => c.phase === 'at');
    if (d.b.poses.some((p) => p.text === 'SHH')) sawShhPose = true;
    if (at.length === 2 && at[0].propX === at[1].propX) {
      sawPair = true;
      const A = d.ag.find((x) => x.id === at[0].key), O = d.ag.find((x) => x.id === at[1].key);
      const l = A.x < O.x ? A : O, r = A.x < O.x ? O : A;
      if (l.facing === 1 && r.facing === -1) pairFacingOk = true;
    }
    for (const a of d.ag.filter((x) => x.id === 'cw0' || x.id === 'cw2')) if (a.away || a.sit !== 1 || Math.abs(a.x - deskX.get(a.id)) > 0.6) workerMoved = true;
    return at;
  };
  const t0 = vnow(page);
  const limit = chaos === 0 ? 14000 : 90000;
  let waitedState = false;
  while (vnow(page) - t0 < limit) {
    await nap(page, chaos === 0 ? 400 : 120);
    const d = await sample();
    const at = collect(d);
    if (at.length >= 2 && d.b.poses.some((p) => p.text && p.text !== 'SHH')) await snap('cooler-chat');
    if (d.b.poses.some((p) => p.text === 'SHH')) await snap('shh');
    if (chaos > 0 && !waitedState && at.length >= 1 && events.some((e) => e.act === 'cooler-chat')) {
      waitedState = true;
      const who = at[0].key;
      await load(coolerFixture(false, { [who]: { state: 'waiting' } }));
      let queued = false, seenAfter = false;
      for (let i = 0; i < 160 && !queued; i++) {
        await nap(page, 150);
        const d2 = await sample();
        collect(d2);
        const me = d2.ag.find((x) => x.id === who);
        if (!d2.b.cooler.some((c) => c.key === who)) seenAfter = true;
        queued = !!me && me.queued && seenAfter;
      }
      check(queued, `${tag} an agent at the cooler did not go into the queue after its state became waiting`);
      await load(coolerFixture(false));
      for (let i = 0; i < 160; i++) {
        await nap(page, 150);
        const d2 = await sample();
        collect(d2);
        const me = d2.ag.find((x) => x.id === who);
        if (me && !me.away && me.sit === 1 && Math.abs(me.x - deskX.get(who)) < 0.6) break;
      }
      const d3 = await sample();
      const me = d3.ag.find((x) => x.id === who);
      check(!!me && !me.away && me.sit === 1 && Math.abs(me.x - deskX.get(who)) < 0.6, `${tag} the queued agent never came back to its own desk ${JSON.stringify(me)}`);
    }
    if (chaos > 0 && waitedState && events.filter((e) => e.act === 'cooler').length >= 6 && events.some((e) => e.act === 'shh') && vnow(page) - t0 > 30000 && (!shots || taken.has('shh'))) break;
  }
  const bossRes = { scattered: false, woke: false };
  if (chaos > 0) {
    for (let att = 0; att < 10 && !bossRes.scattered; att++) {
      let d = await sample();
      for (let i = 0; i < 300 && !collect(d).length; i++) { await nap(page, 120); d = await sample(); }
      const tAt = d.b.t;
      await ev(page, () => window.__office.visit('cw0'));
      const t1 = vnow(page);
      while (vnow(page) - t1 < 25000 && !bossRes.scattered) {
        await nap(page, 120);
        d = await sample();
        collect(d);
        const sc = events.find((e) => e.act === 'scatter' && e.t >= tAt);
        if (sc) {
          bossRes.scattered = true;
          await snap('boss-scatter');
          let d2 = d;
          for (let i = 0; i < 100 && d2.b.t < sc.t + 1.2; i++) { await nap(page, 60); d2 = await sample(); collect(d2); }
          const c = d2.b.cooler.find((x) => x.key === sc.key);
          check(!c || c.phase !== 'at', `${tag} the cooler chatter ${sc.key} was still chatting ${d2.b.t - sc.t}s after the boss walked by`);
        }
      }
      for (let i = 0; i < 120; i++) { await nap(page, 150); d = await sample(); collect(d); if (!d.b.cooler.length && !(await ev(page, () => window.__office.bossActor().away))) break; }
    }
    check(bossRes.scattered, `${tag} the boss walking past never scattered a cooler chat`);
    for (let att = 0; att < 10 && !bossRes.woke; att++) {
      let d = await sample();
      for (let i = 0; i < 400 && !d.b.dozing.length; i++) { await nap(page, 150); d = await sample(); collect(d); }
      if (!d.b.dozing.length) break;
      const tAt = d.b.t, dz = d.b.dozing[0];
      await ev(page, () => window.__office.visit('ds0'));
      const t1 = vnow(page);
      while (vnow(page) - t1 < 25000 && !bossRes.woke) {
        await nap(page, 120);
        d = await sample();
        collect(d);
        const wk = events.find((e) => e.act === 'wake' && e.t >= tAt);
        if (wk) {
          bossRes.woke = true;
          let d2 = d;
          for (let i = 0; i < 100 && d2.b.t < wk.t + 1; i++) { await nap(page, 60); d2 = await sample(); }
          check(!d2.b.dozing.includes(wk.key), `${tag} ${wk.key} kept dozing after the boss walked by (${dz})`);
          await snap('boss-wake');
        }
      }
      for (let i = 0; i < 120; i++) { await nap(page, 150); if (!(await ev(page, () => window.__office.bossActor().away))) break; }
    }
    check(bossRes.woke, `${tag} the boss walking past never woke a dozer`);
  }
  const d = await sample();
  collect(d);
  say(tag, 'chaos', chaos, 'cooler events', events.filter((e) => e.act === 'cooler').length, 'chats', events.filter((e) => e.act === 'cooler-chat').length, 'shh', events.filter((e) => e.act === 'shh').length, 'maxAt', maxAt);
  check(!workerMoved, `${tag} a working agent left its desk`);
  check(maxAt <= 3, `${tag} ${maxAt} agents at one cooler`);
  check(badReturn === '', `${tag} a cooler visitor did not return to its own desk: ${badReturn}`);
  if (chaos === 0) {
    check(events.length === 0 && d.b.cooler.length === 0, `${tag} chaos=0 still acted: ${JSON.stringify(events.slice(0, 3))}`);
  } else {
    const trip = events.filter((e) => e.act === 'cooler');
    check(trip.length > 0 && trip.every((e) => ['ci3', 'ci4', 'ci5', 'di1', 'di2'].includes(e.key)), `${tag} cooler trips missing or by a non-idle agent: ${JSON.stringify(trip.map((e) => e.key))}`);
    check(events.some((e) => e.act === 'cooler-chat') && sawPair && pairFacingOk, `${tag} no 2-agent cooler chat with the pair facing each other (${sawPair}/${pairFacingOk})`);
    const said = events.filter((e) => e.act === 'say');
    check(said.length > 0 && said.every((e) => GENERIC_SAY.includes(e.text)), `${tag} cooler bubbles not generic: ${JSON.stringify(said.map((e) => e.text))}`);
    const shh = events.filter((e) => e.act === 'shh');
    check(shh.length > 0 && shh.every((e) => e.key === 'cw0' || e.key === 'cw2' || e.key === 'dw3'), `${tag} no SHH from a working neighbour (${shh.length})`);
    check(events.filter((e) => e.act === 'cooler-back').length > 0, `${tag} nobody walked back from the cooler`);
    check(sawShhPose, `${tag} SHH never showed as a bubble`);
  }
  check(errors.length === 0, `${tag} cooler console errors ${errors.join('|')}`);
  await ctx.close();
}
const SIZES = [[1280, 720], [1920, 1080], [750, 1000], [390, 844]];
const plan = [];
const add = (name, groups, fn, quick = false) => {
  if (QUICK ? quick : groups.some(want)) plan.push({ name, fn });
};
add('server', ['server'], serverJob, true);
add('crowd', ['server'], crowdJob, true);
add('streamer', ['server'], streamerJob, true);
add('gone', ['server'], goneJob, true);
add('check-in', ['server'], checkInJob, true);
add('live', ['live'], liveJob, true);
add('leave l1280', ['leave', 'ui'], () => leaveCheck(1280, 720, 'l1280'), true);
add('leave l390', ['leave', 'ui'], () => leaveCheck(390, 844, 'l390'));
for (const dpr of [1, 2]) for (const [w, h] of SIZES) add(`demo ${w}x${dpr}`, ['demo'], () => runDemo(w, h, dpr, `d${w}x${dpr}`), dpr === 1 && w === 1280);
add('behavior b1280', ['behavior', 'ui'], () => behaviorRun(1280, 720, 'b1280', 3, true), true);
add('behavior b390', ['behavior', 'ui'], () => behaviorRun(390, 844, 'b390', 3, true));
add('behavior b0', ['behavior', 'ui'], () => behaviorRun(1280, 720, 'b0', 0, false), true);
add('cooler c1280', ['behavior', 'ui', 'cooler'], () => coolerRun(1280, 720, 'c1280', 3, true), true);
add('cooler c390', ['behavior', 'ui', 'cooler'], () => coolerRun(390, 844, 'c390', 3, true));
add('cooler c0', ['behavior', 'ui', 'cooler'], () => coolerRun(1280, 720, 'c0', 0, false), true);
const ROWS_SPEC = [['rbig', 'bigproj', 18], ['rmid', 'midproj', 7], ['rs1', 'small-a', 2], ['rs2', 'small-b', 1]];
function rowsState(waitId) {
  const rooms = ROWS_SPEC.map(([id, label]) => ({ id, label }));
  const agents = [];
  for (const [id, , n] of ROWS_SPEC) for (let i = 0; i < n; i++) agents.push({ id: `${id}_${i}`, name: `Fern${agents.length}`, room: id, state: `${id}_${i}` === waitId ? 'waiting' : 'working', since: `${id}_${i}` === waitId ? 1 : 0 });
  const queue = waitId ? [waitId] : [];
  return { rooms, agents, events: [], queue, queueSize: queue.length, line: queue, generatedAt: Date.now() };
}
const rowsSnap = (page) => ev(page, () => { const o = window.__office; return { fl: o.floors(), desks: o.desks(), grid: o.grid(), ag: o.agents(), w: o.world(), el: o.elevator(), hf: o.hf() }; });

async function rowsRun(vw, vh, dpr, tag) {
  const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?onboarding=0&chaos=0`, 900);
  await ev(page, (st) => window.__office.load(st), rowsState(null));
  await nap(page, 1500);
  const d = await rowsSnap(page);
  const per = Math.floor((d.w.w - 108) / 42);
  for (const [id, , n] of ROWS_SPEC) {
    const g = d.grid.find((x) => x.id === id), rows = Math.max(1, Math.ceil(n / per));
    check(g.rows === rows && g.cols === Math.max(3, Math.ceil(n / rows)), `${tag} ${id} grid ${JSON.stringify(g)} for ${n} desks, ${per} per row`);
  }
  check(d.grid.find((x) => x.id === 'rbig').rows >= 2, `${tag} the 18-desk floor did not grow extra rows`);
  check(d.desks.length === 28 && d.ag.filter((a) => !a.visitor).length === 28, `${tag} desks ${d.desks.length}`);
  check(new Set(d.desks.map((k) => k.id)).size === 28, `${tag} an agent has two desks`);
  const box = (k) => ({ x: k.x - 8, y: k.y - 25, w: 42, h: 35 });
  d.desks.forEach((a, i) => d.desks.forEach((b, j) => { if (i < j) check(!hit(box(a), box(b)), `${tag} desks ${a.id} and ${b.id} overlap`); }));
  for (const k of d.desks) {
    const fl = d.fl.find((f) => f.id === k.room), b = box(k);
    check(b.x >= 64 && b.x + b.w <= d.el.x - 13 && b.y >= fl.top && b.y + b.h <= fl.top + fl.h, `${tag} desk ${k.id} outside its floor box ${JSON.stringify(b)} vs ${JSON.stringify(fl)}`);
    check(Math.abs(k.y - (fl.foot - k.row * 60)) < 0.01, `${tag} desk ${k.id} row ${k.row} not on its foot line`);
    const a = d.ag.find((x) => x.id === k.id);
    check(a && a.sit === 1 && Math.abs(a.x - k.x) < 0.01 && Math.abs(a.y - k.y) < 0.01, `${tag} agent ${k.id} not seated on its desk foot line`);
  }
  d.fl.forEach((f, i) => {
    const g = d.grid.find((x) => x.id === f.id);
    check(f.h === d.hf + ((g ? g.rows : 1) - 1) * 60, `${tag} floor ${f.id} height ${f.h}`);
    if (i) check(f.top === d.fl[i - 1].top + d.fl[i - 1].h, `${tag} floor ${f.id} does not stack on the one above`);
  });
  const last = d.fl[d.fl.length - 1];
  check(d.w.h === last.top + last.h + 8, `${tag} world height ${d.w.h} vs floors end ${last.top + last.h}`);
  await staticChecks(page, tag + '-rows');
  await crisp(page, tag + '-rows', d.w.w ? Math.round(await ev(page, () => window.__office.px())) : 1);

  const scroll = await ev(page, () => { const st = document.getElementById('stage'), c = document.getElementById('cv'); return { sh: st.scrollHeight, ch: st.clientHeight, cssH: c.getBoundingClientRect().height, ov: getComputedStyle(st).overflowY }; });
  check(scroll.ov === 'auto' && scroll.sh >= Math.floor(scroll.cssH), `${tag} stage cannot scroll the whole building (${JSON.stringify(scroll)})`);
  if (scroll.cssH > scroll.ch + 1) {
    const moved = await ev(page, () => { const st = document.getElementById('stage'); st.scrollTop = st.scrollHeight; return st.scrollTop; });
    check(moved > 0, `${tag} stage did not scroll`);
    const lastRect = await ev(page, () => { const r = document.getElementById('cv').getBoundingClientRect(); return { bottom: r.bottom, vh: innerHeight }; });
    check(lastRect.bottom <= lastRect.vh + 1, `${tag} bottom of the building not reachable (${lastRect.bottom} > ${lastRect.vh})`);
    await ev(page, () => { document.getElementById('stage').scrollTop = 0; });
  }
  await page.click('#gear');
  await nap(page, 400);
  check((await uiState(page)).settings, `${tag} gear did not open settings on the tall building`);
  await page.keyboard.press('Escape');
  await nap(page, 300);
  check(!(await uiState(page)).settings, `${tag} settings did not close`);

  const shotDir = process.env.SHOTS_ROWS || SHOTS;
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, `rows-${vw}x${vh}-dpr${dpr}-top.png`) });
  await ev(page, () => { const st = document.getElementById('stage'); st.scrollTop = st.scrollHeight; });
  await page.screenshot({ path: join(shotDir, `rows-${vw}x${vh}-dpr${dpr}-bottom.png`) });
  await ev(page, () => { document.getElementById('stage').scrollTop = 0; });

  const big = d.desks.filter((k) => k.room === 'rbig');
  const deep = big.reduce((m, k) => (k.row > m.row ? k : m), big[0]);
  check(deep.row >= 1, `${tag} no back-row desk to visit`);
  const stops = [];
  const watchCab = async () => {
    const e = await ev(page, () => window.__office.elevator());
    if (e.open > 0.95 && e.fy === Math.round(e.fy)) stops.push({ fy: e.fy, foot: e.foot });
  };
  await ev(page, (id) => window.__office.visit(id), deep.id);
  let reached = false, returned = false;
  for (let i = 0; i < 1800 && !returned; i++) {
    await nap(page, 80);
    await watchCab();
    const s = await ev(page, (id) => ({ b: window.__office.bossActor(), a: window.__office.agents().find((x) => x.id === id) }), deep.id);
    if (s.b.away && s.b.fr === 'rbig' && Math.abs(s.b.x - (deep.x - 17)) < 0.6 && Math.abs(s.b.y - deep.y) < 0.6 && s.b.bubble) reached = true;
    if (s.b.away && s.b.fr === 'rbig' && !s.b.inCab) check(s.b.y <= d.fl.find((f) => f.id === 'rbig').foot + 0.5 && s.b.y >= deep.y - 0.5, `${tag} boss left the floor box at y ${s.b.y}`);
    if (reached && !s.b.away) returned = true;
  }
  check(reached, `${tag} boss never reached the back-row desk`);
  check(returned, `${tag} boss did not go back to the office`);
  const boss = await ev(page, () => window.__office.bossActor());
  check(Math.abs(boss.y - d.fl[0].foot) < 0.01 && boss.sit === 1, `${tag} boss not back on his own foot line`);

  check(await ev(page, (id) => window.__office.trip('nobody', id, 'need eyes'), deep.id), `${tag} visitor trip to the back row refused`);
  let vArrived = false, vGone = false, vStarted = false;
  for (let i = 0; i < 1800 && !vGone; i++) {
    await nap(page, 80);
    await watchCab();
    const v = await ev(page, () => window.__office.agents().find((a) => a.visitor));
    if (v) {
      vStarted = true;
      if (v.bubble && !vArrived) { vArrived = true; check(Math.abs(v.x - (deep.x - 17)) < 0.6 && Math.abs(v.y - deep.y) < 0.6 && v.fr === 'rbig', `${tag} visitor not at the back-row desk (${v.x},${v.y}) vs (${deep.x - 17},${deep.y})`); }
    } else if (vStarted) vGone = true;
  }
  check(vArrived && vGone, `${tag} visitor to the back row arrived=${vArrived} gone=${vGone}`);

  await ev(page, (st) => window.__office.load(st), rowsState(deep.id));
  const q = await settle(page, (id) => { const o = window.__office, a = o.agents().find((x) => x.id === id), qq = o.queue(); return !!a && a.queued && Math.abs(a.x - qq.spots[0]) < 0.6; }, deep.id, 80, 5);
  check(q, `${tag} back-row agent never settled in the waiting room`);
  const inRoom = await ev(page, (id) => ({ a: window.__office.agents().find((x) => x.id === id), q: window.__office.queue() }), deep.id);
  check(Math.abs(inRoom.a.y - inRoom.q.foot) < 0.6 && inRoom.a.fr === '__boss', `${tag} queued back-row agent not on the boss foot line`);
  await ev(page, (st) => window.__office.load(st), rowsState(null));
  let home = false;
  const mainFoot = d.fl.find((f) => f.id === 'rbig').foot;
  for (let i = 0; i < 1800 && !home; i++) {
    await nap(page, 80);
    await watchCab();
    const a = await ev(page, (id) => window.__office.agents().find((x) => x.id === id), deep.id);
    if (a.fr === 'rbig' && a.away && !a.inCab) check(a.y <= mainFoot + 0.5 && a.y >= deep.y - 0.5, `${tag} returning agent left its floor box at y ${a.y}`);
    if (!a.away) { home = true; check(Math.abs(a.x - deep.x) < 0.01 && Math.abs(a.y - deep.y) < 0.01 && a.sit === 1, `${tag} agent not on its back-row desk after the queue`); }
  }
  check(home, `${tag} queued back-row agent did not return to its desk`);
  check(stops.length > 0, `${tag} elevator never opened on a floor`);
  for (const sp of stops) {
    const fl = d.fl[sp.fy];
    check(fl && Math.abs(sp.foot - fl.foot) < 0.01, `${tag} elevator stopped at foot ${sp.foot}, floor ${sp.fy} foot is ${fl && fl.foot}`);
  }
  await staticChecks(page, tag + '-rows-end');
  check(errors.length === 0, `${tag} rows console errors ${errors.join('|')}`);
  await ctx.close();
}

async function rowsCoolerRun(vw, vh, tag) {
  const { ctx, page, errors } = await open(vw, vh, 1, `file://${ROOT}/index.html?onboarding=0&chaos=3`, 600);
  const info = await ev(page, () => {
    const o = window.__office, ids = Array.from({ length: 20 }, (_, c) => 'cool' + c);
    let n = 0;
    for (let tries = 0; tries < 4; tries++) {
      const per = Math.floor((o.world().w - 108) / 42);
      if (per + 1 === n) break;
      n = per + 1;
      o.load({ rooms: ids.map((id) => ({ id, label: id })), agents: ids.flatMap((id) => Array.from({ length: n }, (_, i) => ({ id: id + '_' + i, name: 'Pip' + i, room: id, state: 'idle', since: 0 }))), events: [], generatedAt: Date.now() });
    }
    const backs = o.behavior().props.filter((p) => p.row === 1 && (p.kind === 'cooler' || p.kind === 'coffee'));
    return { n, rows: o.grid().filter((g) => g.id[0] === 'c').map((g) => g.rows), backs: backs.length };
  });
  check(info.rows.every((r) => r === 2), `${tag} cooler floors not two rows ${JSON.stringify(info)}`);
  check(info.backs > 0, `${tag} no back-row cooler or coffee machine on any of 20 floors`);
  await nap(page, 1000);
  let seen = 0, atCount = 0;
  for (let i = 0; i < 400 && atCount < 3; i++) {
    await adv(page, 1);
    const s = await ev(page, () => { const o = window.__office; return { cool: o.behavior().cooler, desks: o.desks(), ag: o.agents(), fl: o.floors() }; });
    for (const v of s.cool) {
      const desk = s.desks.find((k) => k.id === v.key), a = s.ag.find((x) => x.id === v.key), fl = s.fl.find((f) => f.id === v.floor);
      if (!desk || !a || !fl) continue;
      seen++;
      check(v.row === desk.row, `${tag} cooler visit on row ${v.row} by a row ${desk.row} agent`);
      check(Math.abs(a.y - desk.y) < 0.6 && Math.abs(a.y - (fl.foot - v.row * 60)) < 0.6, `${tag} cooler visitor y ${a.y} not on its row foot ${fl.foot - v.row * 60}`);
      if (v.phase === 'at') { atCount++; check(Math.abs(a.x - v.spot) < 0.6, `${tag} cooler visitor not at the cooler`); }
    }
  }
  check(atCount >= 1, `${tag} no back-row cooler visit seen (${seen} samples)`);
  check(errors.length === 0, `${tag} cooler rows console errors ${errors.join('|')}`);
  await ctx.close();
}

async function runNoFlash() {
  const { ctx, page, errors } = await open(1280, 720, 1, `file://${ROOT}/index.html?onboarding=0`);
  const rooms = [{ id: 'f1', label: 'alpha' }, { id: 'f2', label: 'beta' }];
  const mk = (states) => ({ rooms, agents: states.map((state, i) => ({ id: 'fa' + i, name: 'Fern ' + i, room: rooms[i % 2].id, state })), events: [], generatedAt: Date.now() });
  await page.evaluate((st) => window.__office.load(st), mk(['idle', 'working', 'idle', 'working']));
  await page.evaluate(() => window.__office.advance(1));
  const before = await page.evaluate(() => window.__office.layouts());
  const blank = [];
  for (const states of [['working', 'working', 'idle', 'working'], ['idle', 'idle', 'idle', 'working'], ['working', 'idle', 'working', 'idle']]) {
    blank.push(await page.evaluate((st) => {
      window.__office.load(st);
      const c = document.getElementById('cv');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
      return lit;
    }, mk(states)));
  }
  const after = await page.evaluate(() => window.__office.layouts());
  check(after === before, `state-only changes rebuilt the layout ${after - before} times`);
  check(blank.every((n) => n > 100), `canvas went blank right after a state change: ${blank}`);
  const real = errors.filter((e) => !e.includes('willReadFrequently'));
  check(real.length === 0, `no-flash console errors ${real.join('|')}`);
  await ctx.close();
}
add('no flash', ['ui'], () => runNoFlash(), true);
add('own clocks', ['ui'], async () => {
  const { ctx, page, errors } = await open(1280, 720, 1, demoUrl('seed=3'));
  const pairs = await page.evaluate(() => [window.__office.clocks(100), window.__office.clocks(160)]);
  const rates = pairs[0].map((c, i) => (pairs[1][i].at - c.at) / 60);
  const phases = pairs[0].map((c) => c.at % 4);
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  check(pairs[0].length >= 6, `own clocks: only ${pairs[0].length} agents`);
  check(new Set(rates.map((r) => r.toFixed(3))).size >= pairs[0].length - 1 && spread(rates) > 0.1, `agents share an animation tempo: ${rates.map((r) => r.toFixed(3))}`);
  check(spread(phases) > 1.5, `agent animation phases are bunched: ${phases.map((p) => p.toFixed(2))}`);
  check(errors.length === 0, `own clocks console errors ${errors.join('|')}`);
  await ctx.close();
}, true);
for (const dpr of [1, 2]) for (const [w, h] of [[1280, 720], [390, 844]]) add(`rows ${w}x${dpr}`, ['ui', 'rows'], () => rowsRun(w, h, dpr, `r${w}x${dpr}`), dpr === 1 && w === 390);
for (const [w, h] of [[1280, 720], [390, 844]]) add(`rows cooler ${w}`, ['ui', 'rows', 'cooler'], () => rowsCoolerRun(w, h, `rc${w}`), w === 1280);
for (const dpr of [1, 2]) for (const [w, h] of SIZES) add(`names ${w}x${dpr}`, ['ui'], () => runNames(w, h, dpr, `n${w}x${dpr}`), dpr === 1 && w === 1280);
for (const dpr of [1, 2]) for (const [w, h] of SIZES) add(`ui ${w}x${dpr}`, ['ui'], () => runUi(w, h, dpr, `u${w}x${dpr}`), dpr === 1 && w === 1280);

async function runPlan(list) {
  const state = list.map((j) => ({ ...j, lines: [], contexts: new Set(), servers: new Set(), done: false, seconds: 0 }));
  let next = 0, flushed = 0;
  const flush = () => {
    while (flushed < state.length && state[flushed].done) {
      for (const line of state[flushed].lines) console.log(line);
      flushed++;
    }
  };
  const worker = async () => {
    while (next < state.length) {
      const job = state[next++];
      const t0 = Date.now();
      try { await jobs.run(job, job.fn); } catch (e) {
        fails.push(`${job.name} crashed`);
        job.lines.push(`FAIL ${job.name} crashed: ${e instanceof Error ? e.stack : e}`);
      } finally {
        await Promise.all([...job.servers].map((server) => new Promise((resolve) => {
          if (server.exitCode !== null || server.signalCode !== null) return resolve();
          server.once('exit', resolve);
          server.kill();
        })));
        await Promise.all([...job.contexts].map((ctx) => ctx.close().catch(() => {})));
      }
      job.seconds = (Date.now() - t0) / 1000;
      job.done = true;
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, state.length) }, worker));
  if (process.env.TIMES) for (const j of state) console.log(`time ${j.name} ${j.seconds.toFixed(1)}s`);
}

const started = Date.now();
await runPlan(plan);
if (want('perf') && !QUICK) await perf();

if (browser) await browser.close();
console.log(`${QUICK ? 'quick tier' : 'full run'} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
