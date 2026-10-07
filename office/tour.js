'use strict';

const STEPS = [
  'WELCOME TO YOUR OFFICE! I AM THE BOSS. LET ME SHOW YOU AROUND.',
  'EACH FLOOR IS A PROJECT. EACH CRITTER IS A CLAUDE CODE SESSION.',
  'WORKING: TYPING AWAY. WAITING: NEEDS YOU. IDLE: ON A BREAK.',
  'SET YOUR PRIORITIES. DRAG A FLOOR TO REORDER. TOP GOES FIRST.',
  'WAITING CRITTERS QUEUE AT MY DOOR. NEXT CALLS THE FRONT ONE IN.',
  'EVERYTHING STAYS ON THIS MACHINE. NO NETWORK. NOTHING LEAVES.',
];
const TYPE_CPS = 45;

const stepText = function (i) {
  const T = UI.tour;
  if (i === 3) {
    if (S.rooms.length < 2) return 'FLOORS SHOW UP AS YOU OPEN PROJECTS. YOU CAN DRAG THEM HERE TO SET PRIORITY.';
    if (T && T.did) return 'NICE! THAT IS YOUR NEW ORDER. THE TOP FLOOR GETS SERVED FIRST.';
  }
  return STEPS[i];
};

const newTour = () => ({ step: 0, t0: S.t, text: '', shown: 0, did: false, token: 0 });

const tourStart = function () {
  UI.tour = newTour();
  enterStep(0);
};

const enterStep = function (i) {
  const T = UI.tour;
  if (!T) return;
  T.step = i; T.t0 = S.t; T.did = false; T.token++;
  T.text = stepText(i); T.shown = 0;
  UI.settings = i === 3;
  if (i === 3) UI.scroll = 0;
  statEl.textContent = T.text;
  BS.react = S.t;
  stageEl.scrollTop = 0;
  if (i === 4) { const tok = T.token; spawn(tourSummon(tok)); }
  UI.dirty = true;
  UI.refocus = 'next';
};

const tourNext = function () {
  const T = UI.tour;
  if (!T) return;
  if (T.shown < T.text.length) { T.t0 = S.t - T.text.length / TYPE_CPS; return; }
  if (T.step >= STEPS.length - 1) tourFinish(false); else enterStep(T.step + 1);
};

const tourFinish = function (skipped) {
  const T = UI.tour;
  if (!T) return;
  UI.tour = null; UI.settings = false; UI.dirty = true;
  saveSet({ onboardedAt: new Date().toISOString() });
  if (!skipped) burst(90, U.W / 2, U.H - 60);
  statEl.textContent = '';
  S.tourChecked = true;
};

const resetOnboarding = function () {
  saveSet({ onboardedAt: null });
  UI.settings = false;
  tourStart();
};

const maybeStartTour = function () {
  if (S.tourChecked || !S.setReady || !S.gotState || !S.ready) return;
  S.tourChecked = true;
  if (Q.get('settings') === '1') openSettings();
  if (ONBOARDING === '0' || !(DEMO || SERVER)) return;
  if (ONBOARDING === '1' || !S.set.onboardedAt) tourStart();
};

const tourSummon = function* (tok) {
  const alive = () => UI.tour && UI.tour.step === 4 && UI.tour.token === tok;
  const a = makeVisitor();
  a.away = true; a.fr = LOBBY; a.x = BM + 14; a.sit = 0; a.facing = 1;
  yield* wait(0.3);
  yield* goTo(a, BOSS, lineX(Math.min(S.want.length, lineCap() - 1)));
  a.facing = -1;
  yield* wait(1.8);
  if (alive()) {
    yield* walkTo(a, bossSpot());
    a.facing = -1;
    if (alive()) {
      yield* until(() => !B.away || !alive());
      yield* wait(0.2);
      BS.react = S.t; S.focusVisitor = a;
      a.bubble = speech('GOT A DECISION', S.t);
      yield* until(() => !alive());
      a.bubble = null; S.focusVisitor = null;
      yield* wait(0.3);
    }
  }
  yield* leaveAndSit(a);
};

const tourRects = function () {
  const T = UI.tour;
  if (!T) return [];
  if (T.step === 0) { const bx = bossX(), fy = footY(0); return [{ x: bx - 15, y: fy - 40, w: 80, h: 42 }]; }
  if (T.step === 1 && S.rooms.length) {
    const rid = S.rooms[0].id, top = topNow(rid), fy = footNow(rid);
    const out = [{ x: BM, y: top + 2, w: LABW, h: labelLines(rid).h + 4 }];
    const first = (S.slots.get(rid) || [])[0];
    if (first) out.push({ x: slotX(rid, 0) - 11, y: fy - 36, w: 48, h: 38 });
    return out;
  }
  if (T.step === 4) { const top = floorTop(0), fy = footY(0); return [{ x: doorX() - 2, y: top + 9, w: hallW() + 2, h: fy - top - 6 }]; }
  return [];
};

const drawStrip = function (t) {
  const s = UI.strip;
  if (!s) return;
  framePx(s.x, s.y, s.w, s.h, 'STATES');
  const states = [['working', 'WORKING'], ['waiting', 'WAITING'], ['idle', 'IDLE']];
  const fy = s.y + s.h - 15;
  states.forEach(([st, name], i) => {
    const cw = (s.w - 12) / 3, x = Math.round(s.x + 6 + cw * i + cw / 2) - 12;
    const fake = { state: st, hop: 0, react: -9, sleepy: false, sit: 1, seed: 11 + i * 5, away: false, room: BOSS, name: '', st: styleFor('tour' + i) };
    withCtx(uctx, () => {
      drawStation(uctx, x, fy, fake);
      drawScreen(x, fy, fake, t);
      drawSeated(fake, t, x, fy, fake.st, seatedPose(fake, t));
      if (st === 'waiting') thought(t, x, fy);
    });
    uT(name, x + 12 - Math.floor(textW(name) / 2), fy + 4, '#f7e6bd');
  });
};

const drawDialog = function (t) {
  const d = UI.dialog, T = UI.tour;
  if (!d || !T) return;
  uR(d.x, d.y, d.w, d.h, '#f7e6bd'); uR(d.x + 2, d.y + 2, d.w - 4, d.h - 4, '#1a1c2c');
  uR(d.x + 3, d.y + 3, d.w - 6, d.h - 6, '#202339');
  uR(d.x + 6, d.y + 6, 30, 24, '#5d275d'); uR(d.x + 6, d.y + 6, 30, 1, '#7d4698');
  const typing = T.shown < T.text.length;
  const face = typing ? (Math.floor(t * 8) % 2 ? 'happy' : 'neutral') : 'happy';
  uctx.drawImage(headCv(BS.style, face, 0), d.x + 7, d.y + 7, 28, 22);
  uT('BOSS', d.x + 7, d.y + 32, '#ffcd75');
  const tx = d.x + 42;
  let left = T.shown, ty = d.y + 7;
  for (const line of d.lines) {
    const part = line.slice(0, Math.max(0, left));
    uT(part, tx, ty, '#f4f4f4');
    left -= line.length + 1;
    ty += 9;
  }
  const info = (T.step + 1) + '/' + STEPS.length;
  const sk = UI.items.find((i) => i.kind === 'skip');
  if (sk) uT(info, sk.x - 6 - textW(info), sk.y + 2, '#94b0c2');
  for (const it of UI.items) {
    if (it.kind === 'next') button(it, !typing && Math.floor(t * 2.5) % 2 ? '#a7f070' : T.step === STEPS.length - 1 ? '#ffcd75' : '#38b764', '#1a1c2c', T.step === STEPS.length - 1 ? 'DONE' : 'NEXT');
    else if (it.kind === 'skip') button(it, '#333c57', '#d6d6e0', 'SKIP');
  }
};
