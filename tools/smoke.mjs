/**
 * Headless smoke test — no browser needed.
 *
 *   node tools/smoke.mjs
 *
 * 1. Sweeps shot angles/powers through the real physics module to find the
 *    scoring windows (and to prove the hoop is actually reachable).
 * 2. Boots game.js against a tiny DOM stub, plays a shot through the real
 *    pointer handlers, grabs the ball mid-flight, re-aims, and checks the HUD.
 */

import * as P from '../physics.js';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const DT = 1 / 240;

function launch(x, y, angleDeg, power) {
  const speed = P.speedFromPower(power);
  const a = (angleDeg * Math.PI) / 180;
  return { vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed };
}

function simulate(x, angleDeg, power, maxSteps = 1400) {
  const b = P.makeBall(x, P.FLOOR_Y - P.BALL_R);
  Object.assign(b, launch(x, b.y, angleDeg, power));
  for (let i = 0; i < maxSteps; i++) {
    P.stepBall(b, DT, null);
    if (b.scored) return { scored: true, swish: b.swish, steps: i, ball: b };
    if (b.onFloor && b.speed < 26 && i > 60) break;
  }
  return { scored: false, swish: false, steps: -1, ball: b };
}

function positionAfterSteps(x, angleDeg, power, steps) {
  const b = P.makeBall(x, P.FLOOR_Y - P.BALL_R);
  Object.assign(b, launch(x, b.y, angleDeg, power));
  for (let i = 0; i < steps; i++) P.stepBall(b, DT, null);
  return { x: b.x, y: b.y };
}

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) failures++;
}

/* ------------------------------------------------------------------ */
/* 1. physics sweep                                                    */
/* ------------------------------------------------------------------ */

console.log('\nphysics sweep — can it be scored?');

const serveXs = P.SERVE_X;
const winners = [];
for (const sx of serveXs) {
  for (let deg = 25; deg <= 85; deg += 1) {
    for (const power of [0.5, 0.65, 0.8, 0.9, 1]) {
      const r = simulate(sx, deg, power);
      if (r.scored) winners.push({ sx, deg, power, swish: r.swish });
    }
  }
}

check('at least one scoring window exists per serve spot',
  serveXs.every((sx) => winners.some((w) => w.sx === sx)),
  `${winners.length} scoring (angle, power) combos found`);

const full = winners.filter((w) => w.power === 1);
check('full-power shots can score too', full.length > 0, `${full.length} combos`);
check('some shots swish', winners.some((w) => w.swish), `${winners.filter((w) => w.swish).length} swishes`);

const sw = winners[0];
if (sw) console.log(`        first make: serve x=${sw.sx}, ${sw.deg}°, power ${sw.power} (${sw.swish ? 'swish' : 'in off the rim'})`);

// the on-screen aim dots must not lie
let drift = 0;
for (const sx of serveXs) {
  for (let deg = 35; deg <= 80; deg += 5) {
    for (const pw of [0.5, 0.9, 1]) {
      const v = launch(sx, P.FLOOR_Y - P.BALL_R, deg, pw);
      const guide = P.traceShot(sx, P.FLOOR_Y - P.BALL_R, v.vx, v.vy);
      const b = P.makeBall(sx, P.FLOOR_Y - P.BALL_R);
      Object.assign(b, v);
      let real = null;
      for (let i = 0; i < 1200; i++) {
        P.stepBall(b, DT, null);
        if (b.scored || b.contact & (P.CONTACT.RIM) || b.y > P.FLOOR_Y) {
          real = [b.x, b.y];
          break;
        }
      }
      if (real) drift = Math.max(drift, Math.hypot(real[0] - guide.at(-2), real[1] - guide.at(-1)));
    }
  }
}
check('aim guide matches the real flight path', drift < 1, `worst drift ${drift.toFixed(2)}px`);

/* ------------------------------------------------------------------ */
/* 2. dom stub + real game.js                                          */
/* ------------------------------------------------------------------ */

function makeClassList() {
  const set = new Set();
  return {
    set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
    contains: (c) => set.has(c),
  };
}

function makeCtx2D(canvasEl) {
  const target = { canvas: canvasEl };
  const proxy = new Proxy(function () {}, {
    get(t, p) {
      if (typeof p === 'symbol') return undefined;
      if (p === 'measureText') return () => ({ width: 40 });
      if (!(p in t)) t[p] = () => proxy;
      return t[p];
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

function makeCanvas() {
  const listeners = new Map();
  const c2d = makeCtx2D(null);
  const el = {
    width: 960,
    height: 600,
    style: {},
    classList: makeClassList(),
    getContext: () => c2d,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 600 }),
    fire(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
    },
    listenerCount: (type) => (listeners.get(type) || []).length,
  };
  c2d.canvas = el;
  return el;
}

function makeEl(id) {
  const listeners = new Map();
  const el = {
    id,
    textContent: '',
    style: {},
    attrs: {},
    classList: makeClassList(),
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    click() {
      for (const fn of listeners.get('click') || []) fn({});
    },
    key() {},
  };
  el.parentElement = { ...el, parentElement: el.parentElement };
  return el;
}

const dom = {};
const gameCanvas = makeCanvas();
for (const id of ['game', 'stage', 'score', 'makes', 'streak', 'best', 'hint', 'btnAim', 'btnSound', 'btnReset']) {
  dom[id] = id === 'game' ? gameCanvas : makeEl(id);
}
dom.stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 600 });

let rafQueue = [];
let now = 0;
const errors = [];

globalThis.document = {
  getElementById: (id) => dom[id],
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : makeEl(tag)),
  addEventListener() {},
};
globalThis.devicePixelRatio = 1;
globalThis.localStorage = {
  store: new Map(),
  getItem(k) {
    return this.store.has(k) ? this.store.get(k) : null;
  },
  setItem(k, v) {
    this.store.set(k, String(v));
  },
};
globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
globalThis.addEventListener = () => {};
globalThis.performance = globalThis.performance || { now: () => now };

function advance(frames) {
  for (let i = 0; i < frames; i++) {
    now += 1000 / 60;
    const due = rafQueue;
    rafQueue = [];
    for (const cb of due) {
      try {
        cb(now);
      } catch (err) {
        errors.push(err);
      }
    }
  }
}

console.log('\ngame.js boot + play-through');

await import('../game.js');

check('module booted and registered a frame callback', rafQueue.length === 1);

advance(30);
check('render loop runs without throwing', errors.length === 0, errors[0] ? String(errors[0]) : '');

function dragFrom(x, y, angleDeg, power) {
  const len = 6 + power * (P.MAX_DRAG - 6);
  const a = (angleDeg * Math.PI) / 180;
  const tx = x + Math.cos(a) * len;
  const ty = y - Math.sin(a) * len;
  gameCanvas.fire('pointerdown', { clientX: x, clientY: y, pointerId: 1, preventDefault() {} });
  gameCanvas.fire('pointermove', { clientX: tx, clientY: ty, pointerId: 1 });
  gameCanvas.fire('pointerup', { clientX: tx, clientY: ty, pointerId: 1 });
  return { tx, ty };
}

// --- shot A: a proven make from the first serve spot
const serveA = P.SERVE_X[0];
const ballA = { x: serveA, y: P.FLOOR_Y - P.BALL_R };
gameCanvas.fire('pointerdown', { clientX: ballA.x, clientY: ballA.y, pointerId: 1, preventDefault() {} });
check('ball is grabbable at rest', gameCanvas.classList.contains('grabbing'));
gameCanvas.fire('pointerup', { clientX: ballA.x, clientY: ballA.y - 2, pointerId: 1 });
check('a 2px drag is not a shot', dom.makes.textContent === '0 / 0', `makes="${dom.makes.textContent}"`);
dragFrom(ballA.x, ballA.y, sw.deg, sw.power);
advance(260);
check('shot A is counted', dom.makes.textContent === '1 / 1', `makes="${dom.makes.textContent}"`);
check('shot A scored', Number(dom.score.textContent) > 0, `score="${dom.score.textContent}"`);
check('streak tracked', dom.streak.textContent === '1', `streak="${dom.streak.textContent}"`);
check('best score persisted', Number(dom.best.textContent) === Number(dom.score.textContent));

// --- wait for the auto serve
advance(240);
check('a new ball is served automatically', dom.makes.textContent === '1 / 1' && errors.length === 0);
const serveB = P.SERVE_X[1];
const ballB = { x: serveB, y: P.FLOOR_Y - P.BALL_R };

// --- shot B, grabbed mid-flight and re-aimed
const setupAngle = 55;
const setupPower = 0.85;
dragFrom(ballB.x, ballB.y, setupAngle, setupPower);
advance(21);
const mid = positionAfterSteps(serveB, setupAngle, setupPower, 84);
gameCanvas.fire('pointerdown', { clientX: mid.x, clientY: mid.y, pointerId: 2, preventDefault() {} });
check('mid-air grab registered', gameCanvas.classList.contains('grabbing'));

advance(40); // held in the air while the loop keeps running
check('holding mid-air throws nothing', errors.length === 0);

const fix = [];
for (let deg = 5; deg <= 85 && !fix.length; deg += 1) {
  for (const power of [0.35, 0.45, 0.55, 0.65, 0.75, 0.9, 1]) {
    const b = P.makeBall(mid.x, mid.y);
    Object.assign(b, launch(mid.x, mid.y, deg, power));
    let scored = false;
    for (let i = 0; i < 1400 && !scored; i++) {
      P.stepBall(b, DT, null);
      if (b.scored) scored = true;
      if (b.onFloor && b.speed < 26 && i > 60) break;
    }
    if (scored) fix.push({ deg, power });
  }
}
check('a mid-air save exists', fix.length > 0);

if (fix.length) {
  const save = fix[0];
  const len = 6 + save.power * (P.MAX_DRAG - 6);
  const a = (save.deg * Math.PI) / 180;
  gameCanvas.fire('pointermove', { clientX: mid.x + Math.cos(a) * len, clientY: mid.y - Math.sin(a) * len, pointerId: 2 });
  gameCanvas.fire('pointerup', { clientX: mid.x + Math.cos(a) * len, clientY: mid.y - Math.sin(a) * len, pointerId: 2 });
  advance(260);
  // three attempts were taken: the setup shot, the mid-air re-aim, and…
  check('mid-air save became a made shot', dom.makes.textContent === '2 / 3', `makes="${dom.makes.textContent}"`);
  check('mid-air save went in', Number(dom.score.textContent) > 0, `score="${dom.score.textContent}"`);
  check('streak survived the missed setup shot or reset', dom.streak.textContent.length === 1);
} else {
  failures++;
}

check('no runtime errors during play', errors.length === 0, errors[0] ? String(errors[0]) : '');

// --- reset
dom.btnReset.click();
advance(10);
check('reset clears the board',
  dom.score.textContent === '0' && dom.makes.textContent === '0 / 0' && Number(dom.best.textContent) > 0,
  `best kept at ${dom.best.textContent}`);

/* ------------------------------------------------------------------ */

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`);
process.exit(failures === 0 ? 0 : 1);
