'use strict';

const skyMode = function () {
  if (NIGHT || (S.total > 0 && S.working / S.total <= 0.1)) return 'night';
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  if (h >= 7 && h < 17) return 'day';
  if ((h >= 17 && h < 19.5) || (h >= 5.5 && h < 7)) return 'dusk';
  return 'night';
};

const skyPane = function (c, x, y, w, h, seed) {
  const r = rng(seed);
  if (S.sky === 'day') {
    R(c, x, y, w, h, 'a'); R(c, x, y + h - 3, w, 3, 'b');
    blob(c, x + 3 + Math.floor(r() * (w - 8)), y + 3, 2, 1, 'c');
    if (r() < 0.5) R(c, x + w - 4, y + 1, 3, 3, '4');
  } else if (S.sky === 'dusk') {
    const a = Math.floor(h / 3), b = Math.floor(h * 2 / 3);
    R(c, x, y, w, a, '1'); R(c, x, y + a, w, b - a, '2'); R(c, x, y + b, w, h - b, '3');
    R(c, x + 2 + Math.floor(r() * (w - 6)), y + h - 3, 4, 3, '4');
  } else {
    R(c, x, y, w, h, '0'); R(c, x, y + h - 3, w, 3, '8');
    for (let i = 0; i < Math.max(2, Math.floor(w / 6)); i++) px(c, x + Math.floor(r() * w), y + Math.floor(r() * (h - 3)), r() < 0.4 ? '4' : 'c');
    if (r() < 0.5) { R(c, x + w - 5, y + 1, 3, 3, '4'); px(c, x + w - 4, y + 1, '0'); }
  }
};
const windowAt = function (c, x, y, w, h, seed) {
  R(c, x - 1, y - 1, w + 2, h + 2, 'i');
  skyPane(c, x, y, w, h, seed);
  R(c, x + Math.floor(w / 2), y, 1, h, 'i');
  px(c, x + 1, y + 1, 'c'); px(c, x + 2, y + 1, 'c'); px(c, x + 1, y + 2, 'c');
  R(c, x - 2, y + h + 1, w + 4, 1, 'k');
};
const skylineWindow = function (c, x, y, w, h) {
  R(c, x - 2, y - 2, w + 4, h + 4, '4'); R(c, x - 1, y - 1, w + 2, h + 2, 'i');
  skyPane(c, x, y, w, h, 77);
  const r = rng(5);
  let bx = x;
  while (bx < x + w - 3) {
    const bw = 5 + Math.floor(r() * 5), bh = 6 + Math.floor(r() * (h - 9));
    const ww = Math.min(bw, x + w - bx);
    R(c, bx, y + h - bh, ww, bh, S.sky === 'night' ? 'f' : 'e');
    for (let yy = y + h - bh + 2; yy < y + h - 2; yy += 3) for (let xx = bx + 1; xx < bx + ww - 1; xx += 2) if (r() < 0.55) px(c, xx, yy, S.sky === 'night' ? '4' : 'b');
    bx += ww + 1;
  }
  R(c, x, y + h - 1, w, 1, 'f');
  R(c, x + Math.floor(w / 2), y, 1, h, 'i');
};

const PROP_W = { bookshelf: 18, cooler: 10, coffee: 20, plant: 12, bigplant: 16, printer: 14, lamp: 8, sofa: 28, reception: 40, cactus: 8, bin: 8 };
const pPlant = function (c, x, fy, big) {
  const e = big ? 4 : 0, f = big ? 6 : 0, g = big ? 9 : 0;
  R(c, x - 4, fy - 6, 9, 6, 'n'); R(c, x - 5, fy - 7, 11, 2, 'g'); R(c, x - 3, fy - 1, 7, 1, 'i');
  blob(c, x, fy - 12 - e, big ? 7 : 5, big ? 7 : 5, '7');
  blob(c, x - 3, fy - 14 - f, big ? 5 : 3, big ? 6 : 4, '6');
  blob(c, x + 3, fy - 15 - g, big ? 5 : 3, big ? 6 : 4, '5');
  px(c, x - 1, fy - 17 - f, 'c'); px(c, x + 3, fy - 13 - e, '6');
};
const pBookshelf = function (c, x, fy) {
  const w = 18, h = 32, x0 = x - 9, y0 = fy - h, r = rng(x * 31 + fy);
  R(c, x0, y0, w, h, 'i'); R(c, x0 + 1, y0 + 1, w - 2, h - 2, 'g');
  for (let s = 0; s < 4; s++) {
    const sy = y0 + 1 + s * 7;
    R(c, x0 + 1, sy, w - 2, 6, 'n');
    let bx = x0 + 2;
    while (bx < x0 + w - 3) { const bw = 1 + Math.floor(r() * 2), bh = 3 + Math.floor(r() * 3); R(c, bx, sy + 6 - bh, bw, bh, ['2', '9', '6', '4', 'a', '3', 'c', 'p'][Math.floor(r() * 8)]); bx += bw; }
    R(c, x0 + 1, sy + 6, w - 2, 1, 'h');
  }
};
const pCooler = function (c, x, fy) {
  R(c, x - 5, fy - 12, 10, 12, 'd'); R(c, x - 5, fy - 12, 10, 1, 'c'); R(c, x + 3, fy - 11, 2, 11, 'e');
  R(c, x - 2, fy - 8, 3, 2, 'a'); px(c, x - 1, fy - 5, '2');
  R(c, x - 4, fy - 24, 8, 12, 'b'); R(c, x - 4, fy - 24, 1, 12, 'c'); R(c, x - 3, fy - 25, 6, 1, 'a'); R(c, x + 3, fy - 23, 1, 10, 'a');
};
const pCoffee = function (c, x, fy) {
  R(c, x - 10, fy - 9, 20, 2, 'h'); R(c, x - 9, fy - 7, 2, 7, 'g'); R(c, x + 7, fy - 7, 2, 7, 'g'); R(c, x - 9, fy - 3, 18, 1, 'n');
  R(c, x - 6, fy - 21, 10, 12, 'f'); R(c, x - 6, fy - 21, 10, 1, 'e'); R(c, x - 5, fy - 17, 8, 5, '0'); R(c, x - 2, fy - 12, 3, 3, 'c');
  R(c, x - 5, fy - 20, 8, 1, '2'); px(c, x - 5, fy - 19, 'e');
  R(c, x + 4, fy - 12, 3, 3, 'c'); px(c, x + 7, fy - 11, 'c');
  if (curFloor) S.dyn.coffees.push({ id: curFloor.id, x: x - 1, dy: fy - 22 - curFloor.top });
};
const pPrinter = function (c, x, fy) {
  R(c, x - 7, fy - 10, 14, 10, 'g'); R(c, x - 7, fy - 10, 14, 1, 'h'); R(c, x - 5, fy - 8, 10, 1, 'n'); R(c, x - 5, fy - 5, 10, 1, 'n');
  R(c, x - 7, fy - 16, 14, 6, 'd'); R(c, x - 7, fy - 16, 14, 1, 'c'); R(c, x - 7, fy - 11, 14, 1, 'e'); R(c, x - 4, fy - 19, 8, 3, 'c'); R(c, x - 3, fy - 18, 5, 1, 'd'); px(c, x + 5, fy - 14, '5');
};
const pLamp = function (c, x, fy) {
  R(c, x, fy - 24, 1, 23, 'e'); R(c, x - 3, fy - 2, 7, 2, 'f'); R(c, x - 4, fy - 30, 9, 3, '4'); R(c, x - 3, fy - 33, 7, 3, '4'); R(c, x - 3, fy - 33, 7, 1, 'm');
};
const pCactus = function (c, x, fy) {
  R(c, x - 3, fy - 4, 7, 4, '3'); R(c, x - 3, fy - 5, 7, 1, '2');
  R(c, x - 1, fy - 12, 3, 7, '6'); R(c, x - 4, fy - 9, 2, 1, '6'); R(c, x - 4, fy - 11, 1, 3, '6'); R(c, x + 2, fy - 8, 2, 1, '6'); R(c, x + 3, fy - 10, 1, 3, '6'); px(c, x, fy - 10, '5');
};
const pBin = function (c, x, fy) { R(c, x - 3, fy - 7, 7, 7, 'e'); R(c, x - 4, fy - 8, 9, 1, 'd'); R(c, x - 2, fy - 6, 1, 5, 'f'); R(c, x + 1, fy - 6, 1, 5, 'f'); px(c, x, fy - 9, 'c'); };
const pSofa = function (c, x, fy) {
  R(c, x - 14, fy - 14, 28, 9, '2'); R(c, x - 14, fy - 14, 28, 1, '3'); R(c, x - 12, fy - 5, 24, 4, '1'); R(c, x - 16, fy - 9, 4, 8, '2'); R(c, x + 12, fy - 9, 4, 8, '2');
  R(c, x - 1, fy - 12, 1, 7, '1'); R(c, x - 11, fy - 6, 10, 1, '3'); R(c, x + 1, fy - 6, 10, 1, '3'); R(c, x - 15, fy - 2, 2, 2, '0'); R(c, x + 13, fy - 2, 2, 2, '0');
};
const pReception = function (c, x, fy) {
  R(c, x - 20, fy - 14, 40, 2, 'h'); R(c, x - 20, fy - 14, 40, 1, 'j'); R(c, x - 19, fy - 12, 38, 12, 'g'); R(c, x - 19, fy - 12, 38, 1, 'n');
  R(c, x - 14, fy - 9, 12, 7, 'n'); R(c, x + 2, fy - 9, 12, 7, 'n'); R(c, x - 9, fy - 7, 2, 1, '4'); R(c, x + 7, fy - 7, 2, 1, '4');
  R(c, x - 12, fy - 21, 8, 7, 'f'); R(c, x - 11, fy - 20, 6, 4, '6'); R(c, x + 10, fy - 17, 4, 3, 'd'); px(c, x + 12, fy - 18, '4');
};
const secretaryDesk = function (c, x, fy) {
  R(c, x - 7, fy - 20, 2, 12, 'e'); R(c, x - 7, fy - 20, 2, 1, 'd');
  R(c, x - 7, fy - 8, 11, 2, 'f'); R(c, x - 3, fy - 6, 2, 4, 'f'); R(c, x - 8, fy - 1, 12, 1, 'f');
  R(c, x + 5, fy - 10, 20, 2, 'h'); R(c, x + 5, fy - 10, 20, 1, 'j');
  R(c, x + 6, fy - 8, 18, 8, 'g'); R(c, x + 6, fy - 8, 18, 1, 'n');
  R(c, x + 8, fy - 6, 6, 4, 'n'); R(c, x + 16, fy - 6, 6, 4, 'n'); R(c, x + 10, fy - 5, 2, 1, '4'); R(c, x + 18, fy - 5, 2, 1, '4');
  R(c, x + 14, fy - 20, 9, 10, 'd'); R(c, x + 14, fy - 20, 9, 1, 'c'); R(c, x + 16, fy - 18, 5, 6, '0'); R(c, x + 17, fy - 17, 3, 1, '5'); R(c, x + 17, fy - 15, 3, 1, '4');
  R(c, x + 17, fy - 11, 3, 1, 'e');
};
const chair = function (c, x, fy) {
  R(c, x + 4, fy - 18, 3, 15, 'e'); R(c, x + 4, fy - 18, 3, 1, 'd');
  R(c, x - 5, fy - 6, 10, 2, 'e'); R(c, x - 5, fy - 6, 10, 1, 'd');
  R(c, x - 1, fy - 4, 2, 4, 'f'); R(c, x - 4, fy - 1, 8, 1, 'f');
};
const pPoster = function (c, x, y, kind) {
  R(c, x - 6, y, 12, 15, 'i'); R(c, x - 5, y + 1, 10, 13, 'm');
  if (kind === 0) { R(c, x - 5, y + 9, 10, 5, '6'); R(c, x - 5, y + 11, 10, 3, '7'); R(c, x + 1, y + 2, 4, 4, '4'); }
  else if (kind === 1) { R(c, x - 4, y + 9, 2, 4, '9'); R(c, x - 1, y + 6, 2, 7, '2'); R(c, x + 2, y + 3, 2, 10, '6'); }
  else { R(c, x - 4, y + 3, 3, 3, '2'); R(c, x + 1, y + 3, 3, 3, '2'); R(c, x - 3, y + 6, 6, 3, '2'); R(c, x - 1, y + 9, 2, 2, '2'); }
};
const pClock = function (c, x, y) { blob(c, x, y + 4, 4, 4, 'i'); blob(c, x, y + 4, 3, 3, 'c'); px(c, x, y + 4, 'f'); R(c, x, y + 2, 1, 2, 'f'); R(c, x + 1, y + 4, 2, 1, 'f'); };
const pBoard = function (c, x, y) {
  R(c, x - 11, y, 22, 14, 'e'); R(c, x - 10, y + 1, 20, 12, 'c'); R(c, x - 8, y + 3, 9, 1, '9'); R(c, x - 8, y + 6, 13, 1, '2'); R(c, x - 8, y + 9, 6, 1, '6'); R(c, x + 3, y + 3, 5, 5, 'a'); R(c, x - 11, y + 14, 22, 1, 'd');
};
const pTrophy = function (c, x, fy) {
  R(c, x - 9, fy - 16, 18, 16, 'i'); R(c, x - 8, fy - 15, 16, 14, 'f'); R(c, x - 8, fy - 8, 16, 1, 'h');
  R(c, x - 4, fy - 14, 9, 4, '4'); R(c, x - 5, fy - 14, 1, 3, '4'); R(c, x + 5, fy - 14, 1, 3, '4'); R(c, x - 1, fy - 10, 3, 2, '4'); R(c, x - 3, fy - 9, 7, 1, 'n'); px(c, x - 3, fy - 13, 'm');
  R(c, x - 7, fy - 7, 3, 6, '2'); R(c, x - 6, fy - 6, 1, 4, '4'); R(c, x + 3, fy - 7, 4, 6, '9'); R(c, x + 4, fy - 6, 2, 1, 'c');
};
const BIG = { bookshelf: pBookshelf, cooler: pCooler, coffee: pCoffee, plant: (c, x, fy) => pPlant(c, x, fy, false), bigplant: (c, x, fy) => pPlant(c, x, fy, true), printer: pPrinter, lamp: pLamp, sofa: pSofa, reception: pReception, cactus: pCactus, bin: pBin };
const SMALL = ['cactus', 'bin', 'plant', 'lamp'];

const drawStation = function (c, x, fy, a) {
  R(c, x - 7, fy - 20, 2, 12, 'e'); R(c, x - 7, fy - 20, 2, 1, 'd');
  R(c, x - 7, fy - 8, 11, 2, 'f'); R(c, x - 3, fy - 6, 2, 4, 'f'); R(c, x - 8, fy - 1, 12, 1, 'f'); px(c, x - 8, fy, 'e'); px(c, x + 3, fy, 'e'); px(c, x - 3, fy, 'e');
  R(c, x + 5, fy - 10, DESK_W, 2, 'h'); R(c, x + 5, fy - 10, DESK_W, 1, 'j');
  R(c, x + 6, fy - 8, DESK_W - 2, 7, 'g'); R(c, x + 6, fy - 8, DESK_W - 2, 1, 'n');
  R(c, x + 8, fy - 6, 11, 4, 'n'); R(c, x + 19, fy - 6, 11, 4, 'n'); R(c, x + 13, fy - 5, 2, 1, '4'); R(c, x + 24, fy - 5, 2, 1, '4');
  R(c, x + 7, fy - 1, 2, 1, 'i'); R(c, x + 29, fy - 1, 2, 1, 'i');
  R(c, x + 7, fy - 11, 7, 1, 'e'); px(c, x + 8, fy - 11, 'd'); px(c, x + 10, fy - 11, 'd'); px(c, x + 12, fy - 11, 'd');
  R(c, x + 15, fy - 22, 14, 10, 'd'); R(c, x + 15, fy - 22, 14, 1, 'c'); R(c, x + 28, fy - 22, 1, 10, 'e'); R(c, x + 15, fy - 13, 14, 1, 'e');
  R(c, x + 17, fy - 20, 10, 7, '0'); R(c, x + 20, fy - 12, 4, 1, 'e'); R(c, x + 18, fy - 11, 8, 1, 'e');
  const maxc = Math.max(1, Math.floor((pitchOf(a.room) - 2) / 6));
  const t = up(a.name).slice(0, maxc);
  text(c, t, x + 12 - textW(t) / 2, fy + 2, '#5f3a2e');
};
const bossStation = function (c, fy) {
  const bx = bossX(), dx = bx + 5, dw = BOSS_DESK_W;
  R(c, bx - 22, fy + 1, dw + 70, 8, '2'); R(c, bx - 22, fy + 1, dw + 70, 1, '4'); R(c, bx - 22, fy + 8, dw + 70, 1, '4'); for (let x = bx - 20; x < bx + dw + 46; x += 6) R(c, x, fy + 4, 3, 2, '4');
  R(c, bx - 12, fy - 24, 4, 17, '1'); R(c, bx - 12, fy - 24, 4, 1, '4'); R(c, bx - 12, fy - 24, 1, 17, '2'); R(c, bx - 9, fy - 14, 2, 5, '4');
  R(c, bx - 8, fy - 8, 14, 2, '1'); R(c, bx - 8, fy - 8, 14, 1, '2'); R(c, bx - 4, fy - 6, 2, 4, 'f'); R(c, bx - 9, fy - 1, 14, 1, 'f'); px(c, bx - 9, fy, 'e'); px(c, bx + 4, fy, 'e');
  R(c, dx, fy - 11, dw, 3, 'i'); R(c, dx, fy - 11, dw, 1, 'h');
  R(c, dx + 1, fy - 8, dw - 2, 8, 'g'); R(c, dx + 1, fy - 8, dw - 2, 1, 'n');
  for (let k = 0; k < 3; k++) { R(c, dx + 3 + k * 14, fy - 6, 12, 4, 'n'); R(c, dx + 8 + k * 14, fy - 5, 2, 1, '4'); }
  R(c, dx + 1, fy - 1, 2, 1, 'i'); R(c, dx + dw - 3, fy - 1, 2, 1, 'i');
  R(c, dx + 6, fy - 12, 7, 1, 'e'); px(c, dx + 7, fy - 12, 'd'); px(c, dx + 9, fy - 12, 'd');
  for (const mx of [dx + 20, dx + 33]) { R(c, mx, fy - 23, 12, 11, 'd'); R(c, mx, fy - 23, 12, 1, 'c'); R(c, mx + 11, fy - 23, 1, 11, 'e'); R(c, mx + 2, fy - 21, 8, 7, '0'); R(c, mx + 4, fy - 12, 4, 1, 'e'); }
};
