import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const require = createRequire(process.env.PW_DIR ? join(process.env.PW_DIR, 'x.js') : import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOTS || join(ROOT, 'test', 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 7791;
const fails = [];
const check = (ok, msg) => { if (!ok) { fails.push(msg); console.log('FAIL', msg); } };
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const server = spawn('node', [join(ROOT, 'scan.mjs'), '--port', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(vw, vh, dpr, url) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await sleep(600);
  return { ctx, page, errors };
}

async function staticChecks(page, tag) {
  const d = await page.evaluate(() => {
    const o = window.__office, cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
    return { w: o.world(), labels: o.labels(), desks: o.desks(), agents: o.agents(), floors: o.floors(), dpr: o.dpr(), cssW: r.width, cssH: r.height, pxW: cv.width, pxH: cv.height, vw: innerWidth, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
  });
  check(Math.abs(d.pxW - Math.round(d.cssW * d.dpr)) <= 1, `${tag} canvas px ${d.pxW} vs css ${d.cssW}*${d.dpr}`);
  check(Math.abs(d.pxH - Math.round(d.cssH * d.dpr)) <= 1, `${tag} canvas px height`);
  check(d.scrollW <= d.vw + 1, `${tag} page has horizontal scroll ${d.scrollW}>${d.vw}`);
  for (const k of d.desks) {
    const a = d.agents.find((x) => x.id === k.id);
    if (!a || a.away) continue;
    check(Math.abs(a.x - k.x) < 0.01 && Math.abs(a.y - k.y) < 0.01 && a.sit === 1 && a.fr === k.room, `${tag} agent ${a.name} not at desk (${a.x},${a.y}) vs (${k.x},${k.y})`);
  }
  d.labels.forEach((l, i) => {
    check(l.x + l.w <= 114, `${tag} label ${l.id} overflows wall`);
    d.labels.forEach((m, j) => { if (i < j) check(!hit(l, m), `${tag} labels overlap`); });
    const fl = d.floors[i];
    check(l.y >= fl.top && l.y + l.h <= fl.foot, `${tag} label outside floor ${l.id}`);
  });
  return d;
}

async function tripCheck(page, tag) {
  const info = await page.evaluate(() => {
    const ag = window.__office.agents().filter((a) => !a.visitor && !a.away);
    const A = ag[0], B = ag.find((a) => a.room !== A.room);
    return { A: A.id, B: B ? B.id : ag[1].id, same: !B };
  });
  const deskB = await page.evaluate((id) => window.__office.desks().find((d) => d.id === id), info.B);
  await page.evaluate(([a, b]) => window.__office.trip(a, b, "PR's up"), [info.A, info.B]);
  let sawBubble = false, usedElevator = false, arrived = false, returned = false, maxQ = 0;
  for (let i = 0; i < 400; i++) {
    await sleep(100);
    const s = await page.evaluate(([a, bw]) => {
      const o = window.__office, A = o.agents().find((x) => x.id === a);
      return { A, el: o.elevator(), w: o.world(), labels: o.labels() };
    }, [info.A, info.B]);
    const A = s.A;
    if (A.inCab) {
      usedElevator = true;
      check(Math.abs(A.y - s.el.foot) < 0.01 && Math.abs(A.x - s.el.x) < 0.5 + 0 || A.x !== undefined, `${tag} rider not in cab`);
    }
    if (A.bubble) {
      sawBubble = true;
      const b = A.bubble;
      check(b.x >= 0 && b.y >= 0 && b.x + b.w <= s.w.w && b.y + b.h <= s.w.h, `${tag} bubble outside canvas`);
      for (const l of s.labels) check(!hit(b, l), `${tag} bubble overlaps label`);
      if (!arrived) {
        arrived = true;
        check(Math.abs(A.x - (deskB.x - 28)) < 0.6 && Math.abs(A.y - deskB.y) < 0.6 && A.fr === deskB.room, `${tag} walker not at target desk (${A.x},${A.y}) fr=${A.fr} vs (${deskB.x - 28},${deskB.y})`);
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
  const B = await page.evaluate(() => { const o = window.__office; const ag = o.agents().filter((a) => !a.visitor && !a.away); return ag[ag.length - 1].id; });
  const desk = await page.evaluate((id) => window.__office.desks().find((d) => d.id === id), B);
  const ok = await page.evaluate((b) => window.__office.trip('nobody', b, 'need eyes'), B);
  check(ok, `${tag} visitor trip refused`);
  let arrived = false, gone = false, started = false;
  for (let i = 0; i < 500; i++) {
    await sleep(100);
    const s = await page.evaluate(() => { const o = window.__office; return { v: o.agents().find((a) => a.visitor), w: o.world() }; });
    if (s.v) {
      started = true;
      if (s.v.bubble && !arrived) {
        arrived = true;
        check(Math.abs(s.v.x - (desk.x - 28)) < 0.6 && s.v.fr === desk.room, `${tag} visitor not at target desk`);
        check(s.v.bubble.x >= 0 && s.v.bubble.x + s.v.bubble.w <= s.w.w, `${tag} visitor bubble outside`);
      }
    } else if (started) { gone = true; break; }
  }
  check(arrived && gone, `${tag} visitor flow arrived=${arrived} gone=${gone}`);
}

async function runDemo(vw, vh, dpr, tag) {
  const { ctx, page, errors } = await open(vw, vh, dpr, `file://${ROOT}/index.html?demo=1&seed=3&speed=3`);
  const d = await staticChecks(page, tag);
  check(d.agents.length === 10 && d.floors.length === 5, `${tag} demo expected 10 agents/5 floors got ${d.agents.length}/${d.floors.length}`);
  await page.screenshot({ path: join(SHOTS, `${tag}-0.png`), fullPage: true });
  await tripCheck(page, tag);
  await visitorCheck(page, tag);
  for (let k = 1; k <= 3; k++) {
    await sleep(2500);
    await page.screenshot({ path: join(SHOTS, `${tag}-${k}.png`), fullPage: true });
  }
  let moving = 0, queued = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const s = await page.evaluate(() => {
      const o = window.__office, w = o.world();
      const ag = o.agents(), fl = o.floors(), el = o.elevator();
      return { ag, fl, el, w, labels: o.labels() };
    });
    const away = s.ag.filter((a) => a.away);
    moving = Math.max(moving, away.length);
    queued = Math.max(queued, s.el.queue);
    for (const a of s.ag) {
      if (a.away && !a.inCab) {
        const f = s.fl.find((x) => x.id === a.fr);
        check(f && Math.abs(a.y - f.foot) < 0.01, `${tag} walker ${a.name} off floor line`);
      }
      if (a.inCab) check(Math.abs(a.y - s.el.foot) < 0.01, `${tag} rider y != cab`);
      if (a.bubble) {
        const b = a.bubble;
        check(b.x >= 0 && b.y >= 0 && b.x + b.w <= s.w.w && b.y + b.h <= s.w.h, `${tag} bubble outside canvas`);
        for (const l of s.labels) check(!hit(b, l), `${tag} bubble overlaps label`);
      }
    }
  }
  check(moving >= 2, `${tag} expected concurrent walkers, saw ${moving}`);
  const e2 = errors.filter(Boolean);
  check(e2.length === 0, `${tag} console errors: ${e2.join(' | ')}`);
  console.log(tag, 'ok; max concurrent walkers', moving, 'max queue', queued);
  await ctx.close();
}

await runDemo(1280, 720, 1, 'd1280');
await runDemo(1920, 1080, 1, 'd1920');
await runDemo(390, 844, 2, 'd390');
await runDemo(1280, 720, 2, 'd1280x2');

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
  const dim = await page.evaluate(() => window.__office.dim());
  check(dim > 0.5, 'night dim not applied ' + dim);
  await page.screenshot({ path: join(SHOTS, 'night.png') });
  check(errors.length === 0, 'night errors');
  await ctx.close();
}

{
  const { ctx, page, errors } = await open(1280, 720, 1, `http://127.0.0.1:${PORT}/`);
  await sleep(3000);
  const d = await staticChecks(page, 'live');
  const txt = await page.evaluate(() => document.getElementById('stat').textContent);
  console.log('live agents', d.agents.length, 'rooms', d.floors.length - 1, txt);
  check(errors.length === 0, 'live console errors ' + errors.join('|'));
  await page.screenshot({ path: join(SHOTS, 'live.png'), fullPage: true });
  const res = await page.evaluate(async () => (await fetch('/state.json')).json());
  check(Array.isArray(res.rooms) && Array.isArray(res.agents) && Array.isArray(res.events) && typeof res.generatedAt === 'number', 'state.json schema');
  check(!JSON.stringify(res).includes('/Users/'), 'state.json leaks paths');
  await ctx.close();
}

await browser.close();
server.kill();
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
