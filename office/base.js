'use strict';

const Q = new URLSearchParams(location.search);
const DEMO = Q.has('demo');
const SPEED = Number(Q.get('speed')) || 1;
const NIGHT = Q.has('night');
const HUD = Q.get('hud') !== '0';
const AUTOFOCUS = Q.get('autofocus') !== '0';
const SIM = Q.get('sim') !== '0';
const ONBOARDING = Q.get('onboarding');

const MINLW = 370, MAXLW = 560, HUDH = 14, ROOFH = 12, GRND = 8, HF_MIN = 64, HF_MAX = 84, BM = 6, LABW = 58, SHAFT = 26, FB = 11, MAXS = 6;
const LOBBY = '__lobby', BOSS = '__boss', DESK_W = 28, BOSS_DESK_W = 46, VIS_DX = 17;
const TEXTS = ['GOT A SEC?', "PR'S UP", 'HANDING OFF', 'NEED EYES', 'DONE!'];
const BOSS_TEXTS = ['GOT A DECISION', 'NEED A CALL', 'UPDATE!'];

const PAL = { '0': '#1a1c2c', '1': '#5d275d', '2': '#b13e53', '3': '#ef7d57', '4': '#ffcd75', '5': '#a7f070', '6': '#38b764', '7': '#257179', '8': '#29366f', '9': '#3b5dc9', a: '#41a6f6', b: '#73eff7', c: '#f4f4f4', d: '#94b0c2', e: '#566c86', f: '#333c57', g: '#a0623a', h: '#c98a4b', i: '#5f3a2e', j: '#e0b070', k: '#c4915a', m: '#f7e6bd', n: '#8a4b2a', p: '#b86fd1', q: '#7a2c3d', r: '#5a1f2e' };
const WALLS = [['#2f8f8b', '#237370'], ['#8a4f9e', '#6e3b82'], ['#4a6fd0', '#3a58ac'], ['#4fa05e', '#3b8049'], ['#d0714f', '#b05a3d'], ['#d1a24a', '#b38836']];
const WALL_LOBBY = ['#e8d3a8', '#caa97a'], WALL_BOSS = ['#4a3b6b', '#352a50'];

const FUR = [
  { o: '#5d275d', b: '#ef7d57', s: '#b13e53', l: '#ffcd75' },
  { o: '#29366f', b: '#41a6f6', s: '#3b5dc9', l: '#73eff7' },
  { o: '#257179', b: '#a7f070', s: '#38b764', l: '#f4f4f4' },
  { o: '#8a4b2a', b: '#ffcd75', s: '#ef7d57', l: '#f4f4f4' },
  { o: '#1a1c2c', b: '#e0566e', s: '#b13e53', l: '#ef7d57' },
  { o: '#333c57', b: '#94b0c2', s: '#566c86', l: '#f4f4f4' },
  { o: '#257179', b: '#73eff7', s: '#41a6f6', l: '#f4f4f4' },
  { o: '#5d275d', b: '#b86fd1', s: '#7d4698', l: '#e0b4f0' },
];
const BOSS_FUR = { o: '#1a1c2c', b: '#8a4fa8', s: '#5d275d', l: '#c58be0' };
const ACCS = ['#ffcd75', '#41a6f6', '#b13e53', '#a7f070', '#f4f4f4', '#ef7d57'];

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const walkEase = (p) => 0.4 * p + 0.6 * ease(p);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hash = function (s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const hn = function (n) { n = Math.imul(n ^ (n >>> 15), 2246822507); n = Math.imul(n ^ (n >>> 13), 3266489909); return (n ^ (n >>> 16)) >>> 0; };
const rng = function (seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const mix = function (hex, to, t) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = (s) => Math.round(lerp((a >> s) & 255, (b >> s) & 255, t));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
};

const GLYPHS = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  '.': [0, 0, 0, 0, 0, 12, 12], '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 8, 0, 0, 0, 0], '-': [0, 0, 0, 31, 0, 0, 0], ':': [0, 12, 12, 0, 12, 12, 0], ',': [0, 0, 0, 0, 12, 4, 8], '_': [0, 0, 0, 0, 0, 0, 31], '/': [1, 1, 2, 4, 8, 16, 16], '+': [0, 4, 4, 31, 4, 4, 0], '=': [0, 0, 31, 0, 31, 0, 0], ' ': [0, 0, 0, 0, 0, 0, 0], '…': [0, 0, 0, 0, 0, 0, 21],
};
const GLYPHS3 = {
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [6, 1, 2, 4, 7], 3: [6, 1, 2, 1, 6], 4: [5, 5, 7, 1, 1], 5: [7, 4, 6, 1, 6], 6: [3, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 6],
  '.': [0, 0, 0, 0, 2], '!': [2, 2, 2, 0, 2], '?': [6, 1, 2, 0, 2], "'": [2, 2, 0, 0, 0], '-': [0, 0, 7, 0, 0], ':': [0, 2, 0, 2, 0], ',': [0, 0, 0, 2, 4], '_': [0, 0, 0, 0, 7], '/': [1, 1, 2, 4, 4], '+': [0, 2, 7, 2, 0], '=': [0, 7, 0, 7, 0], ' ': [0, 0, 0, 0, 0], '…': [0, 0, 0, 0, 21],
};
const smallAdv = (ch) => (ch === '…' ? 6 : 4);
const smallW = (t) => { let w = 0; for (const ch of t) w += smallAdv(ch); return Math.max(0, w - 1); };
const fitW = (t, sm) => (sm ? smallW(t) : textW(t));
const tcache = new Map();
const smallCv = function (t, col) {
  const k = col + '|s|' + t;
  let cv = tcache.get(k);
  if (cv) return cv;
  if (tcache.size > 400) tcache.clear();
  cv = document.createElement('canvas');
  cv.width = Math.max(1, smallW(t)); cv.height = 5;
  const c = context2d(cv);
  c.fillStyle = col;
  let x0 = 0;
  for (const ch of t) {
    const g = GLYPHS3[ch] || GLYPHS3['?'], gw = ch === '…' ? 5 : 3;
    for (let y = 0; y < 5; y++) for (let x = 0; x < gw; x++) if (g[y] & (1 << (gw - 1 - x))) c.fillRect(x0 + x, y, 1, 1);
    x0 += smallAdv(ch);
  }
  tcache.set(k, cv);
  return cv;
};
const textCv = function (t, col, sm) {
  if (sm) return smallCv(t, col);
  const k = col + '|' + t;
  let cv = tcache.get(k);
  if (cv) return cv;
  if (tcache.size > 400) tcache.clear();
  cv = document.createElement('canvas');
  cv.width = Math.max(1, t.length * 6 - 1); cv.height = 7;
  const c = context2d(cv);
  c.fillStyle = col;
  [...t].forEach((ch, i) => {
    const g = GLYPHS[ch] || GLYPHS['-'];
    for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (g[y] & (16 >> x)) c.fillRect(i * 6 + x, y, 1, 1);
  });
  tcache.set(k, cv);
  return cv;
};
const textW = (t) => Math.max(0, t.length * 6 - 1);
const text = function (c, t, x, y, col, sm) { if (t) c.drawImage(textCv(t, col, sm), Math.round(x), Math.round(y)); };
const FOLD = { 'Ø': 'O', 'Æ': 'AE', 'Œ': 'OE', 'Ł': 'L', 'Đ': 'D', 'Ð': 'D', 'Þ': 'TH', '’': "'", '‘': "'", '–': '-', '—': '-', '‐': '-' };
const fold = (s) => [...String(s).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()].map((ch) => FOLD[ch] || (GLYPHS[ch] ? ch : '?')).join('');
const LABT = LABW - 5;
const fitLine = function (s, pw) {
  if (textW(s) <= pw) return { t: s };
  if (smallW(s) <= pw) return { t: s, sm: 1 };
  const cs = [...s];
  let n = cs.length;
  while (n > 0 && smallW(cs.slice(0, n).join('').replace(/[ \-_.]+$/, '') + '…') > pw) n--;
  return { t: cs.slice(0, n).join('').replace(/[ \-_.]+$/, '') + '…', sm: 1 };
};
const splitName = function (s, pw) {
  const toks = [];
  let cur = '';
  for (const ch of s) { cur += ch; if (' -_.'.includes(ch)) { toks.push(cur); cur = ''; } }
  if (cur) toks.push(cur);
  for (const sm of [0, 1]) {
    let best = TYPE_ONLY ? { m: 0, rows: [{ t: '', sm: 0 }] } : null;
    for (let k = 1; k < toks.length; k++) {
      const a = toks.slice(0, k).join('').trimEnd(), b = toks.slice(k).join('').trimStart();
      const wa = fitW(a, sm), wb = fitW(b, sm);
      if (wa > pw || wb > pw) continue;
      if (!best || Math.max(wa, wb) < best.m) best = { m: Math.max(wa, wb), rows: [{ t: a, sm }, { t: b, sm }] };
    }
    if (best) return best.rows;
  }
  return null;
};
const nameRows = function (raw, pw) {
  const s = fold(raw);
  if (smallW(s) <= pw || textW(s) <= pw) return [fitLine(s, pw)];
  return splitName(s, pw) || [fitLine(s, pw)];
};
const up = (s) => String(s).toUpperCase();
const canvasById = function (id) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLCanvasElement)) throw new Error('missing canvas ' + id);
  return el;
};
const elementById = function (id) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) throw new Error('missing element ' + id);
  return el;
};
const context2d = function (canvas) {
  const c = canvas.getContext('2d');
  if (!c) throw new Error('2d canvas context unavailable');
  return c;
};
const TYPE_ONLY = false;
const DEF_SET = { order: TYPE_ONLY ? [''] : [], anonymize: false, titles: false, speed: 1, sound: false, onboardedAt: TYPE_ONLY ? '' : null, streamer: false, onAir: TYPE_ONLY ? [''] : [] };

const R = (c, x, y, w, h, col) => { c.fillStyle = PAL[col] || col; c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
const px = (c, x, y, col) => R(c, x, y, 1, 1, col);
const blob = function (c, cx, cy, rx, ry, col) {
  c.fillStyle = PAL[col] || col;
  for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x * x) / (rx * rx + 0.5) + (y * y) / (ry * ry + 0.5) <= 1) c.fillRect(cx + x, cy + y, 1, 1);
};
