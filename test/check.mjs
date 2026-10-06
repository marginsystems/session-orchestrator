import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const require = createRequire(process.env.PW_DIR ? join(process.env.PW_DIR, 'x.js') : import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || join(ROOT, 'test', 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 7791;
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log('FAIL', msg); } };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', [join(ROOT, 'scan.mjs'), '--port', String(PORT)], { stdio: 'ignore' });
await sleep(1200);
const browser = await chromium.launch();

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

async function open(vw, vh, dpr, url) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await sleep(700);
  return { ctx, page, errors };
}

async function staticChecks(page, tag) {
  const d = await page.evaluate(() => {
    const o = window.__office, cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
    return { w: o.world(), labels: o.labels(), desks: o.desks(), agents: o.agents(), floors: o.floors(), dpr: o.dpr(), px: o.px(), cssW: r.width, cssH: r.height, pxW: cv.width, pxH: cv.height, vw: innerWidth, scrollW: document.documentElement.scrollWidth, ir: getComputedStyle(cv).imageRendering, boss: o.boss() };
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
    const o = window.__office, ag = o.agents().filter((a) => !a.visitor && !a.away);
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

async function runDemo(vw, vh, dpr, tag) {
  const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?demo=1&seed=3&speed=3&autofocus=0`);
  const d = await staticChecks(page, tag);
  check(d.agents.length === 10 && d.floors.length === 6, `${tag} demo expected 10 agents/6 floors got ${d.agents.length}/${d.floors.length}`);
  await crisp(page, tag, d.px);
  await (await page.$('#cv')).screenshot({ path: join(SHOTS, `${tag}-0.png`) });
  await page.screenshot({ path: join(SHOTS, `${tag}-view.png`) });
  await tripCheck(page, tag);
  await visitorCheck(page, tag);
  await focusCheck(page, tag);
  let moving = 0;
  for (let i = 0; i < 100; i++) {
    await sleep(250);
    const s = await page.evaluate(() => { const o = window.__office; return { ag: o.agents(), fl: o.floors(), el: o.elevator(), w: o.world(), labels: o.labels() }; });
    moving = Math.max(moving, s.ag.filter((a) => a.away).length);
    for (const a of s.ag) {
      if (a.away && !a.inCab) { const f = s.fl.find((x) => x.id === a.fr); check(f && Math.abs(a.y - f.foot) < 0.01, `${tag} walker ${a.name} off floor line`); }
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
  console.log(tag, 'ok; px', d.px, 'world', d.w.w + 'x' + d.w.h, 'max concurrent walkers', moving);
  await ctx.close();
}

for (const dpr of [1, 2]) {
  await runDemo(1280, 720, dpr, `d1280x${dpr}`);
  await runDemo(1920, 1080, dpr, `d1920x${dpr}`);
  await runDemo(750, 1000, dpr, `d750x${dpr}`);
  await runDemo(390, 844, dpr, `d390x${dpr}`);
}

{
  const { ctx, page, errors } = await open(1280, 720, 1, `file://${ROOT}/index.html?demo=1&seed=4&speed=3`);
  let moving = 0, atBoss = false;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const ag = await page.evaluate(() => window.__office.agents());
    moving = Math.max(moving, ag.filter((a) => a.away).length);
    if (ag.some((a) => a.fr === '__boss' && a.away && !a.inCab)) atBoss = true;
  }
  check(moving >= 2 && moving <= 3, `demo concurrent walkers ${moving} outside 2..3`);
  check(atBoss, 'demo never summoned an agent to the boss office');
  check(errors.length === 0, 'concurrency page errors ' + errors.join('|'));
  await ctx.close();
}

{
  const { ctx, page, errors } = await open(1280, 720, 1, `file://${ROOT}/index.html?demo=1&seed=5`);
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
  const { ctx, page, errors } = await open(1280, 720, 1, `file://${ROOT}/index.html?demo=1&night=1`);
  await sleep(4000);
  check((await page.evaluate(() => window.__office.dim())) > 0.5, 'night dim not applied');
  check((await page.evaluate(() => window.__office.sky())) === 'night', 'night sky not applied');
  await page.screenshot({ path: join(SHOTS, 'night.png') });
  check(errors.length === 0, 'night errors');
  await ctx.close();
}

{
  const { ctx, page, errors } = await open(1280, 720, 1, `http://127.0.0.1:${PORT}/`);
  await sleep(3000);
  const d = await staticChecks(page, 'live');
  console.log('live agents', d.agents.length, 'rooms', d.floors.length - 2, await page.evaluate(() => document.getElementById('stat').textContent));
  check(errors.length === 0, 'live console errors ' + errors.join('|'));
  await page.screenshot({ path: join(SHOTS, 'live.png') });
  const res = await page.evaluate(async () => (await fetch('/state.json')).json());
  check(Array.isArray(res.rooms) && Array.isArray(res.agents) && Array.isArray(res.events) && typeof res.generatedAt === 'number' && 'focus' in res, 'state.json schema');
  const raw = JSON.stringify(res);
  check(!raw.includes('/Users/') && !/"title"|"cwd"|"path"/.test(raw), 'state.json leaks paths or titles');
  await ctx.close();
}

await browser.close();
server.kill();
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
