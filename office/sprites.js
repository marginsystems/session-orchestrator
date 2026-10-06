'use strict';

const EARS = {
  cat: ['..oo......oo..', '..obo....obo..'],
  bear: ['..ooo....ooo..', '.obbbo..obbbo.'],
  bulb: ['.......aa.....', '.......oo.....'],
};
const HEAD = ['...oooooooo...', '..obbbbbbbbo..', '.obllbbbbbbbo.', '.oblbbbbbbbbo.', '.obbbbbbbbbbo.', '.obbbbbbbbbbo.', '.obbbbbbbbbso.', '..obbbbbbbsso.', '...oossssoo...'];
const ACC = {
  cap: { 1: '....oaaaao....', 2: '...oaaaaaao...', 3: '..oaaaaaaaao..', 4: '..oaaaaaaaaaoo' },
  phones: { 1: '....oooooo....', 2: '...o......o...', 3: '..o........o..', 4: '..o........o..', 5: '..o........o..', 6: '.ooo......ooo.', 7: '.oaao....oaao.', 8: '.oaao....oaao.', 9: '.ooo......ooo.' },
  bow: { 1: '........oo.oo.', 2: '........aaoaa.', 3: '........oo.oo.' },
  glasses: { 5: '......oooooo..', 6: '......o.oo.o..', 7: '......o.oo.o..', 8: '......oooooo..' },
  crown: { 0: '...a..aa..a...', 1: '...aaaaaaaaaa.', 2: '...aaraaraaa..' },
};
const FACES = {
  neutral: [[7, 6, 'k'], [7, 7, 'k'], [10, 6, 'k'], [10, 7, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  blink: [[7, 7, 'k'], [10, 7, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  focus: [[7, 5, 'k'], [8, 5, 'k'], [10, 5, 'k'], [11, 5, 'k'], [7, 6, 'k'], [7, 7, 'k'], [10, 6, 'k'], [10, 7, 'k'], [8, 9, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  wait: [[7, 5, 'k'], [7, 6, 'k'], [10, 5, 'k'], [10, 6, 'k'], [8, 9, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  happy: [[6, 7, 'k'], [7, 6, 'k'], [8, 7, 'k'], [9, 7, 'k'], [10, 6, 'k'], [11, 7, 'k'], [8, 9, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  wow: [[7, 6, 'w'], [8, 6, 'w'], [7, 7, 'w'], [8, 7, 'k'], [10, 6, 'w'], [11, 6, 'w'], [10, 7, 'w'], [11, 7, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  sleep: [[7, 7, 'k'], [8, 7, 'k'], [10, 7, 'k'], [11, 7, 'k'], [9, 9, 'k'], [6, 8, 'c'], [11, 8, 'c']],
  yawn: [[7, 6, 'k'], [8, 7, 'k'], [7, 8, 'k'], [11, 6, 'k'], [10, 7, 'k'], [11, 8, 'k'], [8, 9, 'k'], [9, 9, 'k'], [8, 10, 'k'], [9, 10, 'k']],
};
const TORSO = ['...oaaaaaao...', '.obobbllbbobo.', '.obobbbbbbobo.'];
const LEGS = {
  A: ['...ob....bo...', '..ooo....ooo..'],
  B: ['.....obbo.....', '....oooooo....'],
  C: ['....ob..bo....', '...ooo..ooo...'],
};
const WALK = ['A', 'B', 'C', 'B'];
const SIT = ['...oaaaaaaoooo', '...obbllbbbbbo', '...obbbbbboooo', '...obbbbbbbbbo', '.........obbo.', '.........oooo.'];
const BOSS_TIE = [[7, 1], [8, 1], [7, 2], [8, 2]];
const ARMS_UP = ['oo..........oo', 'bo..........ob', 'bo..........ob', 'bo..........ob', 'bo..........ob', 'oo..........oo'];

const bcache = new Map();
const bake = function (key, w, h, grid, map) {
  let cv = bcache.get(key);
  if (cv) return cv;
  if (bcache.size > 1500) bcache.clear();
  cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  for (let y = 0; y < h; y++) {
    const row = grid[y] || '';
    if (row.length !== w && row.length) console.error('bad sprite row width', key, y, row.length);
    for (let x = 0; x < row.length; x++) { const col = map[row[x]]; if (col) { c.fillStyle = col; c.fillRect(x, y, 1, 1); } }
  }
  bcache.set(key, cv);
  return cv;
};
const charMap = (st) => ({ o: st.fur.o, b: st.fur.b, s: st.fur.s, l: st.fur.l, a: st.acc, k: '#1a1c2c', c: '#ff7a9c', w: '#f4f4f4', r: '#b13e53' });

const styleFor = function (id, boss) {
  if (boss) return { boss: true, fur: BOSS_FUR, acc: '#ffcd75', ear: 'bear', accKind: 'crown', screen: 0, key: 'boss' };
  const h = hash(id);
  const fi = h % FUR.length;
  let acc = ACCS[(h >>> 7) % ACCS.length];
  if (acc.toLowerCase() === FUR[fi].b.toLowerCase()) acc = ACCS[((h >>> 7) + 1) % ACCS.length];
  return { boss: false, fur: FUR[fi], acc, ear: ['cat', 'bear', 'bulb'][(h >>> 5) % 3], accKind: ['cap', 'phones', 'bow', 'glasses'][(h >>> 3) % 4], screen: (h >>> 11) % 2, key: fi + acc + h % 1000 };
};
const headCv = function (st, face, shift) {
  const key = `h|${st.key}|${face}|${shift}`;
  const cv = bcache.get(key);
  if (cv) return cv;
  const grid = Array.from({ length: 11 }, () => Array(14).fill('.'));
  EARS[st.ear].forEach((r, i) => { for (let x = 0; x < 14; x++) if (r[x] !== '.') grid[i][x] = r[x]; });
  HEAD.forEach((r, i) => { for (let x = 0; x < 14; x++) if (r[x] !== '.') grid[i + 2][x] = r[x]; });
  for (const [x, y, k] of FACES[face]) { const xx = x + shift; if (xx >= 0 && xx < 14) grid[y][xx] = k; }
  const acc = ACC[st.accKind];
  for (const y of Object.keys(acc)) { const r = acc[y]; for (let x = 0; x < 14; x++) if (r[x] !== '.') grid[+y][x] = st.accKind === 'glasses' ? 'k' : r[x]; }
  return bake(key, 14, 11, grid.map((r) => r.join('')), charMap(st));
};
const standBodyCv = function (st, f) {
  const key = `sb|${st.key}|${f}`;
  const grid = [...TORSO, ...LEGS[f]].map((r) => r.split(''));
  if (st.boss) for (const [x, y] of BOSS_TIE) grid[y][x] = 'r';
  return bake(key, 14, 5, grid.map((r) => r.join('')), charMap(st));
};
const sitBodyCv = function (st) {
  const key = `sit|${st.key}`;
  const grid = SIT.map((r) => r.split(''));
  if (st.boss) for (const [x, y] of BOSS_TIE) if (grid[y][x] !== 'o') grid[y][x] = 'r';
  return bake(key, 14, 6, grid.map((r) => r.join('')), charMap(st));
};
const armsUpCv = function (st) { return bake(`au|${st.key}`, 14, 6, ARMS_UP, charMap(st)); };
