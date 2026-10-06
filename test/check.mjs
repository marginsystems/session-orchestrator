import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, utimesSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { inflateSync } from 'node:zlib';

const require = createRequire(process.env.PW_DIR ? join(process.env.PW_DIR, 'x.js') : import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || join(tmpdir(), 'session-orchestrator-shots');
mkdirSync(SHOTS, { recursive: true });
const { isHumanPrompt } = await import(join(ROOT, 'lib', 'prompts.mjs'));
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !ONLY || ONLY.includes(n);
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log('FAIL', msg); } };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(s).digest('hex');
const agentId = (uuid) => 'a' + sha(uuid).slice(0, 8);
const demoUrl = (q = '') => `file://${ROOT}/index.html?demo=1&onboarding=0&${q}`;

let browser;
const getBrowser = async () => browser || (browser = await chromium.launch());

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

async function open(vw, vh, dpr, url, wait = 700) {
  const ctx = await (await getBrowser()).newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await sleep(wait);
  return { ctx, page, errors };
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
  for (const k of d.desks) (desksByFloor[k.room] ||= []).push(k.x);
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
    await sleep(100);
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
    await sleep(100);
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
    await sleep(100);
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
  await sleep(2500);
  const still = await page.evaluate((id) => window.__office.agents().find((x) => x.id === id), info.id);
  check(still && still.fr === '__boss' && still.away, `${tag} focus agent left the boss office before focus changed`);
  await page.evaluate(() => window.__office.clearFocus());
  let back = false;
  for (let i = 0; i < 700; i++) {
    await sleep(100);
    const a = await page.evaluate((id) => window.__office.agents().find((x) => x.id === id), info.id);
    if (a && !a.away) { back = true; check(Math.abs(a.x - dk.x) < 0.01 && Math.abs(a.y - dk.y) < 0.01 && a.sit === 1, `${tag} focus agent not at desk after return`); break; }
  }
  check(back, `${tag} focus agent did not return`);
}

async function queueSeatCheck(page, tag) {
  let q = null;
  for (let i = 0; i < 600; i++) {
    await sleep(100);
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
  const rank = await page.evaluate(() => { const o = window.__office, rooms = o.rooms().map((r) => r.id); return o.queue().queue.map((id) => rooms.indexOf(o.agents().find((a) => a.id === id).room)); });
  check(rank.every((r, i) => !i || rank[i - 1] <= r), `${tag} queue not ordered by floor priority: ${rank}`);
}

async function secretaryCheck(page, tag) {
  let q = null, id = null;
  for (let i = 0; i < 600; i++) {
    await sleep(100);
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
    await sleep(100);
    const s = await page.evaluate((i2) => ({ sec: window.__office.secretary(), a: window.__office.agents().find((x) => x.id === i2), b: window.__office.boss() }), id);
    if (s.sec.waving) waved = true;
    if (waved && s.a && s.a.fr === '__boss' && s.a.x < q.door) entered = true;
    if (entered && s.a.bubble) break;
  }
  check(waved, `${tag} secretary did not wave the front agent through`);
  check(entered, `${tag} front agent did not walk into the Boss Office`);
  await page.evaluate(() => window.__office.clearFocus());
  await sleep(1500);
}

async function bossRouteCheck(page, tag) {
  const info = await page.evaluate(() => {
    const o = window.__office, ag = o.agents().filter((a) => !a.visitor && !a.away && !a.q);
    const a = ag.find((x) => x.room !== o.rooms()[0].id) || ag[0];
    return { id: a.id, desk: o.desks().find((d) => d.id === a.id) };
  });
  await page.evaluate((id) => window.__office.visit(id), info.id);
  let stood = false, cab = false, atDesk = false, bubbles = 0, returned = false, bubbleMs = 0, lastT = 0;
  for (let i = 0; i < 1500; i++) {
    await sleep(80);
    const s = await page.evaluate((id) => ({ b: window.__office.bossActor(), a: window.__office.agents().find((x) => x.id === id), w: window.__office.world() }), info.id);
    if (s.b.away && s.b.sit === 0) stood = true;
    if (s.b.inCab) cab = true;
    if (s.b.away && s.b.fr === info.desk.room && Math.abs(s.b.x - (info.desk.x - 17)) < 0.6 && s.b.bubble) {
      atDesk = true;
      if (!lastT) lastT = Date.now();
      bubbleMs = Date.now() - lastT;
      check(s.b.bubble.x >= 0 && s.b.bubble.y >= 0 && s.b.bubble.x + s.b.bubble.w <= s.w.w, `${tag} boss bubble outside canvas`);
      if (s.a.bubble) { bubbles++; check(!hit(s.b.bubble, s.a.bubble), `${tag} boss and agent bubbles overlap`); }
    }
    if (stood && atDesk && !s.b.away) { returned = true; break; }
  }
  check(stood, `${tag} boss never stood up`);
  check(cab, `${tag} boss skipped the elevator`);
  check(atDesk, `${tag} boss never reached the agent's desk`);
  check(bubbles > 0, `${tag} agent never answered the boss`);
  check(bubbleMs > 800, `${tag} boss bubble too short (${bubbleMs}ms real time)`);
  check(returned, `${tag} boss did not return`);
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
  let cab = false, seated = false, sawAnim = false;
  for (let i = 0; i < 900; i++) {
    await sleep(100);
    const s = await page.evaluate((i2) => { const o = window.__office; return { a: o.agents().find((x) => x.id === i2), desks: o.desks(), anim: o.animating() }; }, id);
    if (s.anim) sawAnim = true;
    if (!s.a) continue;
    if (s.a.inCab) cab = true;
    if (!s.a.away && s.a.sit === 1) { seated = true; break; }
  }
  check(seated, `${tag} new agent never sat down`);
  check(cab, `${tag} new agent skipped the elevator`);
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
  await sleep(120);
  await page.mouse.up();
}

async function tourCheck(page, tag, shot) {
  let u = await uiState(page);
  check(!!u.tour && u.tour.step === 0, `${tag} tour not shown on first run`);
  const seen = [];
  for (let step = 0; step < 6; step++) {
    await sleep(250);
    u = await boxChecks(page, tag, 'tour step ' + step);
    seen.push(u.tour && u.tour.step);
    check(u.tour && u.tour.step === step, `${tag} expected tour step ${step}, got ${u.tour && u.tour.step}`);
    const t0 = u.tour.shown;
    await sleep(400);
    const t1 = (await uiState(page)).tour.shown;
    check(t1 > t0 || t0 === u.tour.len, `${tag} typewriter not advancing on step ${step}`);
    if (shot && step === shot.step) await page.screenshot({ path: join(SHOTS, `${tag}-${shot.name}.png`) });
    if (step === 2) check(!!u.strip, `${tag} states strip missing on step 2`);
    if (step === 3) {
      check(u.settings && !!u.geo, `${tag} settings not open on step 3`);
      const before = await page.evaluate(() => window.__office.rooms().map((r) => r.id));
      if (before.length > 1) {
        await dragRow(page, 0, 1);
        await sleep(300);
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
        await sleep(100);
        const st = await ev(page, () => ({ ag: window.__office.agents(), door: window.__office.queue().door }));
        if (st.ag.some((a) => a.visitor && a.fr === '__boss' && a.x < st.door)) walked = true;
      }
      check(walked, `${tag} no agent walked up on the queue step`);
    }
    for (let k = 0; k < 2; k++) {
      const next = page.locator('[data-id="next"]');
      if (!(await next.count())) break;
      await next.click();
      await sleep(150);
      const cur = await uiState(page);
      if (!cur.tour || cur.tour.step !== step) break;
    }
  }
  await sleep(300);
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
      const file = join(dir, uuid + '.jsonl');
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const at = new Date(Date.now() - ageSec * 1000);
      utimesSync(file, at, at);
      out.push({ project, uuid, file, kind, ageSec, id: agentId(uuid) });
    });
  }
  const meta = join(root, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, 'local_fixture1.json'), JSON.stringify({ sessionId: 'local_fixture1', cliSessionId: out[0].uuid, title: 'Tidy the parser' }));
  return out;
}

function makeCrowd(root) {
  const projects = [['bulk', 12], ['p1', 5], ['p2', 5], ['p3', 5], ['p4', 5], ['p5', 5]];
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
  const meta = join(root, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, 'local_crowd1.json'), JSON.stringify({ sessionId: 'local_crowd1', cliSessionId: oldest.uuid }));
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
function startServer(home, port, extra = []) {
  const child = spawn('node', [join(ROOT, 'scan.mjs'), '--port', String(port), ...extra], { stdio: 'ignore', env: { ...process.env, HOME: home } });
  spawned.push(child);
  return child;
}

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
  console.log('unit ok', cases.length, 'cases');
}

let fixtureHome;
let fixture;
const SPORT = 7791;

if (want('server')) {
  fixtureHome = mkdtempSync(join(tmpdir(), 'so-home-'));
  fixture = makeFixture(fixtureHome);
  const ids = Object.fromEntries(fixture.map((f) => [f.project + f.ageSec, f.id]));
  let server = startServer(fixtureHome, SPORT);
  await sleep(1500);
  let s = await stateOf(SPORT);
  check(s.rooms.map((r) => r.label).join() === 'atlas,delta,beacon,citadel', `server default room order ${s.rooms.map((r) => r.label)}`);
  check(!s.events.some((e) => e.kind === 'join'), 'server emitted join events for sessions that existed at startup');
  const expectDefault = [ids.atlas300, ids.delta400, ids.beacon380, ids.beacon200, ids.citadel240];
  check(JSON.stringify(s.queue) === JSON.stringify(expectDefault), `server default queue ${JSON.stringify(s.queue)} != ${JSON.stringify(expectDefault)}`);
  const raw = JSON.stringify(s);
  check(!raw.includes('/work') && !raw.includes(fixtureHome) && !/"title"/.test(raw), 'state.json leaks paths or titles by default');
  const ok = { origin: `http://127.0.0.1:${SPORT}`, 'content-type': 'application/json' };
  const post = (obj, headers = ok) => httpReq(SPORT, { method: 'POST', path: '/settings', headers, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  const defaults = JSON.parse((await httpReq(SPORT, { path: '/settings' })).text);
  check(defaults.order.length === 0 && defaults.onboardedAt === null && defaults.speed === 1, 'default settings wrong');

  const r = await post({ order: [s.rooms.find((x) => x.label === 'citadel').id, 'beacon'] });
  check(r.status === 200, `valid order post rejected ${r.status} ${r.text}`);
  s = await stateOf(SPORT);
  check(s.rooms.map((x) => x.label).join() === 'citadel,beacon,atlas,delta', `priority not applied to rooms: ${s.rooms.map((x) => x.label)}`);
  const expectOrdered = [ids.citadel240, ids.beacon380, ids.beacon200, ids.atlas300, ids.delta400];
  check(JSON.stringify(s.queue) === JSON.stringify(expectOrdered), `queue not ordered by floor priority then wait: ${JSON.stringify(s.queue)}`);
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
  check((await post({ speed: 3 }, { ...ok, origin: `http://127.0.0.1:${SPORT + 1}` })).status === 403, 'other-port origin accepted');
  check((await post({ speed: 3 }, { ...ok, 'sec-fetch-site': 'cross-site' })).status === 403, 'cross-site fetch metadata accepted');
  check((await post({ speed: 3 }, { origin: ok.origin, 'content-type': 'text/plain' })).status === 415, 'text/plain post accepted');
  check((await httpReq(SPORT, { method: 'POST', path: '/settings', headers: ok, body: '{"speed":3}', host: 'evil.example' })).status === 403, 'foreign Host header accepted');
  check((await httpReq(SPORT, { method: 'POST', path: '/state.json', headers: ok, body: '{}' })).status === 403, 'post to another path accepted');
  check((await httpReq(SPORT, { method: 'PUT', path: '/settings', headers: ok, body: '{}' })).status === 403, 'PUT accepted');
  const still = JSON.parse((await httpReq(SPORT, { path: '/settings' })).text);
  check(still.speed === 2, `a rejected post changed settings (speed ${still.speed})`);

  server.kill();
  await sleep(500);
  server = startServer(fixtureHome, SPORT);
  await sleep(1500);
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

  const echoDir = join(fixtureHome, '.claude', 'projects', '-work-echo');
  mkdirSync(echoDir, { recursive: true });
  const echoUuid = randomUUID();
  writeFileSync(join(echoDir, echoUuid + '.jsonl'), JSON.stringify({ type: 'user', userType: 'external', cwd: '/work/echo', timestamp: nowIso(), message: { role: 'user', content: 'hello' } }) + '\n');
  s = await waitState(SPORT, (st) => st.events.some((e) => e.kind === 'join'));
  const joins = s.events.filter((e) => e.kind === 'join');
  check(joins.length === 1 && joins[0].agentId === agentId(echoUuid), `join events wrong: ${JSON.stringify(joins)}`);
  check(s.rooms.some((room) => room.label === 'echo'), 'new project missing from rooms');
  check(s.rooms.map((room) => room.label).slice(0, 3).join() === 'citadel,beacon,echo', `new project not placed after the listed floors by activity: ${s.rooms.map((room) => room.label)}`);
  const focusDir = join(fixtureHome, '.session-orchestrator');
  writeFileSync(join(focusDir, 'focus.json'), JSON.stringify({ sessionId: fixture.find((f) => f.project === 'beacon' && f.ageSec === 200).uuid, at: nowIso() }));
  s = await waitState(SPORT, (st) => st.focus && st.focus.agentId);
  check(s.focus && s.focus.agentId === ids.beacon200, 'focus.json not mapped to the agent');
  console.log('server ok');
  server.kill();
  await sleep(300);
}

if (want('server')) {
  const home = mkdtempSync(join(tmpdir(), 'so-crowd-'));
  const { sessions, oldest } = makeCrowd(home);
  const focusFile = join(home, '.session-orchestrator', 'focus.json');
  mkdirSync(join(home, '.session-orchestrator'), { recursive: true });
  const crowdServer = startServer(home, SPORT + 2);
  await sleep(1500);
  let s = await stateOf(SPORT + 2);
  check(s.agents.length === 30, `crowd: expected the 30 session cap, got ${s.agents.length}`);
  check(!s.agents.some((a) => a.id === oldest.id), 'crowd: the oldest session was picked without focus');
  writeFileSync(focusFile, JSON.stringify({ sessionId: 'local_crowd1', at: new Date().toISOString() }));
  s = await waitState(SPORT + 2, (st) => st.focus && st.focus.agentId);
  check(s.focus && s.focus.agentId === oldest.id, `crowd: local id mapped to ${s.focus && s.focus.agentId}`);
  check(s.agents.some((a) => a.id === oldest.id), 'crowd: focused agent missing from agents');
  check(s.agents.length === 30, `crowd: focus changed the cap to ${s.agents.length}`);
  check(s.agents.filter((a) => a.room === (s.agents.find((x) => x.id === oldest.id) || {}).room).length === 6, 'crowd: focus exceeded the per-room cap');
  check(!s.queue.includes('visitor'), 'crowd: queue contains a visitor');
  writeFileSync(focusFile, JSON.stringify({ sessionId: oldest.uuid, at: new Date().toISOString() }));
  s = await waitState(SPORT + 2, (st) => st.focus && st.focus.agentId === oldest.id);
  check(s.focus && s.focus.agentId === oldest.id && s.agents.some((a) => a.id === oldest.id), 'crowd: bare uuid not mapped to the agent');
  writeFileSync(focusFile, JSON.stringify({ sessionId: 'local_unknown9', at: new Date().toISOString() }));
  s = await waitState(SPORT + 2, (st) => st.focus && st.focus.agentId === 'visitor');
  check(s.focus && s.focus.agentId === 'visitor', 'crowd: unknown local id did not stay visitor');
  writeFileSync(focusFile, JSON.stringify({ sessionId: randomUUID(), at: new Date().toISOString() }));
  s = await waitState(SPORT + 2, (st) => st.focus && st.focus.agentId === 'visitor');
  check(s.focus && s.focus.agentId === 'visitor', 'crowd: unknown uuid did not stay visitor');
  check(sessions.length > 30, 'crowd: fixture too small');
  console.log('crowd ok');
  crowdServer.kill();
  rmSync(home, { recursive: true, force: true });
  await sleep(300);
}

if (want('live')) {
  const home = mkdtempSync(join(tmpdir(), 'so-live-'));
  const fx = makeFixture(home);
  const ids = Object.fromEntries(fx.map((f) => [f.project + f.ageSec, f.id]));
  const server = startServer(home, SPORT + 1);
  await sleep(1500);
  const base = `http://127.0.0.1:${SPORT + 1}/`;
  const settingsFile = join(home, '.session-orchestrator', 'settings.json');
  {
    const { ctx, page, errors } = await open(1280, 720, 1, base, 1500);
    check(await ev(page, () => window.__office.server()), 'live page did not detect the server');
    await tourCheck(page, 'live-tour', { step: 4, name: 'queue' });
    await sleep(800);
    check(existsSync(settingsFile) && !!JSON.parse(readFileSync(settingsFile, 'utf8')).onboardedAt, 'onboardedAt not persisted by the server');
    check(errors.length === 0, 'live tour console errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, base, 2500);
    check(!(await uiState(page)).tour, 'onboarding shown again after it was finished');
    const labels = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(labels.join() === 'delta,atlas,beacon,citadel', `live floors show ${labels} (the tour reordered the first two)`);
    const plaques = await ev(page, () => window.__office.labels().map((l) => l.id));
    check(plaques.length > 0, 'no plaques');
    await sleep(500);
    await page.click('#gear');
    await sleep(400);
    const u = await boxChecks(page, 'live', 'settings');
    check(u.settings && u.geo && u.geo.n === 4, 'settings panel did not open with four floors');
    const downs = page.locator('[data-kind="down"]');
    await downs.first().click();
    await sleep(250);
    check(await ev(page, () => window.__office.animating()), 'floors did not start re-stacking after a priority change');
    const mid = await ev(page, () => window.__office.floors().filter((f) => f.id !== '__boss' && f.id !== '__lobby').map((f) => ({ top: f.top, y: f.y })));
    check(mid.some((f) => Math.abs(f.y - f.top) > 0.5), 'no floor was between positions during the re-stack');
    await sleep(1400);
    check(!(await ev(page, () => window.__office.animating())), 're-stack animation never finished');
    const after = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(after.join() === 'atlas,delta,beacon,citadel', `priority change gave ${after}`);
    const floorsNow = await ev(page, () => window.__office.floors());
    check(floorsNow.every((f) => Math.abs(f.y - f.top) < 0.01), 'floors not settled at their slots');
    check(floorsNow.filter((f) => f.id[0] === 'r').map((f) => f.id).join() === (await ev(page, () => window.__office.rooms().map((r) => r.id))).join(), 'floor stacking differs from priority order');
    await sleep(600);
    const served = JSON.parse((await httpReq(SPORT + 1, { path: '/state.json' })).text);
    check(served.rooms.map((r) => r.label).join() === 'atlas,delta,beacon,citadel', 'server state does not reflect the UI priority change');
    const disk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    check(disk.order.join() === served.rooms.map((r) => r.id).join(), 'settings.json order does not match floors');
    await page.locator('[data-id="tg:anonymize"]').click();
    await sleep(3200);
    const anon = await ev(page, () => window.__office.rooms().map((r) => r.label));
    check(anon.join() === 'Room A,Room B,Room C,Room D', `anonymize toggle gave ${anon}`);
    await page.locator('[data-id="tg:anonymize"]').click();
    await page.locator('[data-id="tg:titles"]').click();
    await sleep(3200);
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
    check(labels.join() === 'atlas,delta,beacon,citadel', `priority lost after reload: ${labels}`);
    const q = await queueWait(page);
    const expect = [ids.atlas300, ids.delta400, ids.beacon380, ids.beacon200, ids.citadel240].filter((id) => q.queue.includes(id));
    check(JSON.stringify(q.queue) === JSON.stringify(expect), `browser queue ${JSON.stringify(q.queue)} != ${JSON.stringify(expect)}`);
    check(q.want.length === Math.min(q.cap, q.queue.length), `queue seats ${q.want.length} vs capacity ${q.cap}`);
    await queueSeatCheck(page, 'live');
    await page.screenshot({ path: join(SHOTS, 'live-queue.png') });
    writeFileSync(join(home, '.session-orchestrator', 'focus.json'), JSON.stringify({ sessionId: fx.find((f) => f.id === q.want[0]).uuid, at: new Date().toISOString() }));
    let entered = false, waved = false;
    for (let i = 0; i < 300 && !entered; i++) {
      await sleep(100);
      const s = await ev(page, () => ({ ag: window.__office.agents(), q: window.__office.queue(), sec: window.__office.secretary() }));
      if (s.sec.waving) waved = true;
      const a = s.ag.find((x) => x.id === q.want[0]);
      if (a && a.fr === '__boss' && a.x < s.q.door && a.bubble) entered = true;
    }
    check(waved, 'live: secretary did not wave when focus.json named the front agent');
    check(entered, 'live: focused agent did not step from the queue into the Boss Office');
    await sleep(1500);
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
    const { ctx, page, errors } = await open(1280, 720, 1, base, 800);
    let atSecretary = false, atBoss = false;
    for (let i = 0; i < 400 && !atBoss; i++) {
      await sleep(100);
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
    }, SPORT + 1);
    check(r === 200, 'same-origin page post failed');
    const foreign = await (await getBrowser()).newContext();
    const fp = await foreign.newPage();
    await fp.goto(`file://${ROOT}/index.html?demo=1&onboarding=0`);
    const fr = await fp.evaluate(async (p) => {
      try {
        const x = await fetch(`http://127.0.0.1:${p}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"speed":1}' });
        return x.status;
      } catch { return 0; }
    }, SPORT + 1);
    check(fr !== 200, `cross-origin page post got through (${fr})`);
    const disk = JSON.parse(readFileSync(settingsFile, 'utf8'));
    check(disk.speed === 3, `cross-origin page changed settings (speed ${disk.speed})`);
    await foreign.close();
    await ctx.close();
  }
  server.kill();
  rmSync(home, { recursive: true, force: true });
  console.log('live ok');
}

async function queueWait(page) {
  let q = null;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
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
    await sleep(250);
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
  console.log(tag, 'ok; px', d.px, 'world', d.w.w + 'x' + d.w.h, 'max away', moving);
  await ctx.close();
}

async function runUi(vw, vh, dpr, tag) {
  {
    const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?demo=1&seed=3&speed=3&sim=0`, 1200);
    await tourCheck(page, tag + '-tour', { step: 1, name: 'highlight' });
    const ls = await ev(page, () => window.__office.settings());
    check(!!ls.onboardedAt, `${tag} onboarding not saved to localStorage`);
    await page.reload();
    await sleep(1200);
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
    await sleep(300);
    check(!(await uiState(page)).tour, `${tag} skip did not close the tour`);
    await page.reload();
    await sleep(1200);
    check(!!(await uiState(page)).tour, `${tag} ?onboarding=1 not forced again after skipping`);
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(vw, vh, dpr, demoUrl('seed=3&speed=3&sim=0&autofocus=0'), 1200);
    check(!(await uiState(page)).tour, `${tag} onboarding=0 still showed the tour`);
    await page.locator('#gear').click();
    await sleep(300);
    const u = await boxChecks(page, tag, 'settings');
    check(u.settings && u.geo.n === 4, `${tag} settings did not list four floors`);
    await page.screenshot({ path: join(SHOTS, `${tag}-settings.png`) });
    const start = await ev(page, () => window.__office.rooms().map((r) => r.id));
    await page.locator('[data-kind="down"]').first().click();
    await sleep(150);
    check(await ev(page, () => window.__office.animating()), `${tag} no re-stack animation`);
    await sleep(1400);
    let now = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(now[0] === start[1] && now[1] === start[0], `${tag} down button did not swap the first two floors`);
    await page.locator('[data-kind="row"]').nth(3).focus();
    await page.keyboard.press('ArrowUp');
    await sleep(1400);
    now = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(now[2] === start[3], `${tag} keyboard move failed: ${now}`);
    await dragRow(page, 2, 0);
    await sleep(1500);
    now = await ev(page, () => window.__office.rooms().map((r) => r.id));
    check(now[0] === start[3], `${tag} drag to the top failed: ${now}`);
    const floors = await ev(page, () => window.__office.floors().map((f) => f.id).filter((id) => id[0] !== '_'));
    check(floors.join() === now.join(), `${tag} floors not stacked in priority order`);
    const stored = await ev(page, () => window.__office.settings().order);
    check(stored.join() === now.join(), `${tag} settings order ${stored} != floors ${now}`);
    await boxChecks(page, tag, 'settings after reorder');
    await page.locator('[data-id="tg:anonymize"]').click();
    await sleep(300);
    check((await ev(page, () => window.__office.rooms().map((r) => r.label))).join() === 'Room A,Room B,Room C,Room D', `${tag} demo anonymize failed`);
    await page.locator('[data-id="tg:anonymize"]').click();
    await page.locator('[data-id="tg:titles"]').click();
    await sleep(300);
    check((await ev(page, () => window.__office.agents().filter((a) => a.title).length)) === 10, `${tag} demo titles not shown`);
    await page.locator('[data-id="tg:titles"]').click();
    await page.locator('[data-id="sp:2"]').click();
    await page.locator('[data-id="tg:sound"]').click();
    const st = await ev(page, () => window.__office.settings());
    check(st.speed === 2 && st.sound === true, `${tag} speed/sound toggles not stored`);
    await page.locator('[data-id="reset"]').click();
    await sleep(400);
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
      await sleep(250);
      const s = await page.evaluate(() => ({ ag: window.__office.agents(), b: window.__office.bossActor() }));
      moving = Math.max(moving, s.ag.filter((a) => a.away && !a.settled).length + (s.b.away ? 1 : 0));
      if (s.ag.some((a) => a.fr === '__boss' && a.away && !a.inCab && !a.queued)) atBoss = true;
      if (s.b.away) bossAway = true;
      if (s.ag.some((a) => a.id.startsWith('dn_'))) sawVisit = true;
    }
    console.log('demo max concurrent movers', moving);
    check(moving >= 2 && moving <= 4, `demo concurrent movers ${moving} outside 2..4`);
    check(atBoss, 'demo never summoned an agent to the boss office');
    check(bossAway, 'demo never sent the boss to a desk');
    check(sawVisit, 'demo never added a joining agent');
    check(errors.length === 0, 'concurrency page errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, demoUrl('seed=5'));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const m0 = (await cdp.send('Performance.getMetrics')).metrics;
    const get = (m, n) => m.find((x) => x.name === n).value;
    const f0 = await page.evaluate(() => window.__office.frames());
    await sleep(8000);
    const m1 = (await cdp.send('Performance.getMetrics')).metrics;
    const f1 = await page.evaluate(() => window.__office.frames());
    const cpu = (get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / 8;
    const fps = (f1 - f0) / 8;
    console.log('cpu', (cpu * 100).toFixed(1) + '%', 'fps', fps.toFixed(1));
    check(cpu < 0.2, `cpu too high ${cpu}`);
    check(fps <= 21 && fps >= 8, `fps out of range ${fps}`);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(300);
    const h0 = await page.evaluate(() => window.__office.frames());
    await sleep(1500);
    const h1 = await page.evaluate(() => window.__office.frames());
    check(h1 === h0, 'frame loop not paused while hidden');
    check(errors.length === 0, 'perf page errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 2, `file://${ROOT}/index.html?demo=1&seed=5&onboarding=1`, 1500);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.locator('[data-id="next"]').click();
    await page.locator('[data-id="next"]').click();
    await page.locator('[data-id="next"]').click();
    await page.locator('[data-id="next"]').click();
    const m0 = (await cdp.send('Performance.getMetrics')).metrics;
    await sleep(6000);
    const m1 = (await cdp.send('Performance.getMetrics')).metrics;
    const get = (m, n) => m.find((x) => x.name === n).value;
    const cpu = (get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / 6;
    console.log('cpu with the tour and settings open', (cpu * 100).toFixed(1) + '%');
    check(cpu < 0.3, `cpu with the tour open too high ${cpu}`);
    check(errors.length === 0, 'tour perf errors ' + errors.join('|'));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open(1280, 720, 1, demoUrl('night=1'));
    await sleep(4000);
    check((await page.evaluate(() => window.__office.dim())) > 0.5, 'night dim not applied');
    check((await page.evaluate(() => window.__office.sky())) === 'night', 'night sky not applied');
    await page.screenshot({ path: join(SHOTS, 'night.png') });
    check(errors.length === 0, 'night errors');
    await ctx.close();
  }
}

if (want('demo')) {
  const sizes = [[1280, 720], [1920, 1080], [750, 1000], [390, 844]];
  for (const dpr of [1, 2]) for (const [w, h] of sizes) await runDemo(w, h, dpr, `d${w}x${dpr}`);
}
const NAMES = ['averyveryverylongprojectname', 'layer-by-layer-rollout', 'café-crème', '数据管道', 'a_b.c-d e', 'alpha', 'LONG-UPPER-NAME-HERE', 'fifteen-letters', 'two words here now'];
async function runNames(vw, vh, dpr, tag) {
  const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?onboarding=0`, 900);
  const rooms = NAMES.map((label, i) => ({ id: 'n' + i, label }));
  const agents = rooms.map((r, i) => ({ id: 'na' + i, name: 'Fern' + i, room: r.id, state: 'idle', since: 0 }));
  await ev(page, (st) => window.__office.load(st), { rooms, agents, events: [], generatedAt: Date.now() });
  await sleep(500);
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
    await sleep(500);
    check((await uiState(page)).settings, `${tag} settings did not open`);
    await page.screenshot({ path: join(dir, `settings-${vw}.png`) });
  }
  check(errors.length === 0, `${tag} names console errors ${errors.join('|')}`);
  await ctx.close();
}
if (want('ui')) {
  const sizes = [[1280, 720], [1920, 1080], [750, 1000], [390, 844]];
  for (const dpr of [1, 2]) for (const [w, h] of sizes) await runNames(w, h, dpr, `n${w}x${dpr}`);
  for (const dpr of [1, 2]) for (const [w, h] of sizes) await runUi(w, h, dpr, `u${w}x${dpr}`);
}
if (want('perf')) await perf();

if (browser) await browser.close();
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
