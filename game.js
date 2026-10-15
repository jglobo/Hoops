/**
 * Hoops — a small local-only basketball game.
 *
 * Rules of the shot:
 *   1. Click (or tap) the ball — on the floor or in mid air.
 *   2. Drag toward the hoop. The line you draw is the shot direction and its
 *      length is the power.
 *   3. Let go. You can grab the ball again while it is still flying, so every
 *      shot is re-savable.
 */

import * as P from './physics.js';

/* ------------------------------------------------------------------ */
/* dom                                                                 */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');

const el = {
  score: document.getElementById('score'),
  makes: document.getElementById('makes'),
  streak: document.getElementById('streak'),
  best: document.getElementById('best'),
  hint: document.getElementById('hint'),
  btnAim: document.getElementById('btnAim'),
  btnSound: document.getElementById('btnSound'),
  btnReset: document.getElementById('btnReset'),
};

const TAU = Math.PI * 2;
const FIXED_DT = 1 / 240;
const GRAB_R = P.BALL_R + 30;
const BEST_KEY = 'hoops.best.v1';
const clampNum = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------------ */
/* view fit                                                            */
/* ------------------------------------------------------------------ */

const view = { scale: 1 };

function resize() {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const scale = Math.min(r.width / P.WORLD_W, r.height / P.WORLD_H);
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.style.width = Math.floor(P.WORLD_W * scale) + 'px';
  canvas.style.height = Math.floor(P.WORLD_H * scale) + 'px';
  canvas.width = Math.round(P.WORLD_W * scale * dpr);
  canvas.height = Math.round(P.WORLD_H * scale * dpr);
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  view.scale = scale;
}

function toWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / view.scale, y: (e.clientY - r.top) / view.scale };
}

/* ------------------------------------------------------------------ */
/* audio (tiny synth, no asset files)                                  */
/* ------------------------------------------------------------------ */

const sfx = (() => {
  let ac = null;
  let master = null;
  let noiseBuf = null;
  let enabled = true;

  function ensure() {
    if (ac) return ac;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try {
      ac = new AC();
    } catch {
      return null;
    }
    master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.4), ac.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ac;
  }

  function tone({ type = 'sine', f0, f1, dur, gain, delay = 0 }) {
    if (!enabled || gain <= 0.001) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function hiss({ dur, gain, f0, f1, q = 1.1 }) {
    if (!enabled || gain <= 0.001) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.max(60, f1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  return {
    resume() {
      const c = ensure();
      if (c && c.state === 'suspended' && c.resume) c.resume().catch(() => {});
    },
    setEnabled(v) {
      enabled = v;
      if (v) this.resume();
    },
    isEnabled() {
      return enabled;
    },
    bounce(i) {
      tone({ type: 'sine', f0: 140 + i * 70, f1: 70, dur: 0.13, gain: 0.22 * i });
    },
    rim(i) {
      tone({ type: 'triangle', f0: 520 + i * 300, f1: 320, dur: 0.17, gain: 0.15 * i });
      tone({ type: 'sine', f0: 1240, f1: 980, dur: 0.08, gain: 0.06 * i });
    },
    swish() {
      hiss({ dur: 0.26, gain: 0.15, f0: 2400, f1: 650, q: 1.2 });
    },
    score() {
      [660, 880, 1180].forEach((f, i) =>
        tone({ type: 'triangle', f0: f, f1: f, dur: 0.26, gain: 0.14, delay: i * 0.07 })
      );
    },
    catch_() {
      tone({ type: 'sine', f0: 900, f1: 620, dur: 0.05, gain: 0.06 });
    },
    release(power) {
      tone({ type: 'sine', f0: 280, f1: 760 + power * 520, dur: 0.07, gain: 0.05 });
    },
  };
})();

/* ------------------------------------------------------------------ */
/* game state                                                          */
/* ------------------------------------------------------------------ */

let ball = P.makeBall(P.SERVE_X[0], P.FLOOR_Y - P.BALL_R);
let shots = P.makeShots();
let best = loadBest();
let phase = 'aim'; // 'aim' | 'flight' | 'serve'
let serveIdx = 0;
let serveTimer = 0;
let restTimer = 0;
let stallTimer = 0;
let pendingShot = false;
let showAim = true;
let hintShown = true;

const pointer = { x: -999, y: -999, inside: false };
let holding = false;

const particles = [];
const pops = [];
let trail = [];
let netSway = 0;
let netDrift = 0;
let shake = 0;
let clock = 0;

function loadBest() {
  try {
    return Number(globalThis.localStorage?.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest() {
  try {
    globalThis.localStorage?.setItem(BEST_KEY, String(best));
  } catch {
    /* private mode, nothing to do */
  }
}

function hideHint() {
  if (!hintShown) return;
  hintShown = false;
  el.hint.classList.add('hidden');
}

function serveBall() {
  const x = P.SERVE_X[serveIdx % P.SERVE_X.length];
  serveIdx++;
  ball = P.makeBall(x, P.FLOOR_Y - P.BALL_R);
  phase = 'aim';
  restTimer = 0;
  stallTimer = 0;
  pendingShot = false;
  trail = [];
}

/* ------------------------------------------------------------------ */
/* shooting                                                            */
/* ------------------------------------------------------------------ */

function hitTest(p) {
  return Math.hypot(p.x - ball.x, p.y - ball.y) <= GRAB_R;
}

function shootAt(p) {
  const shot = P.shotVelocity(p.x - ball.x, p.y - ball.y);
  holding = false;
  if (!shot) return;
  P.resetShotFlags(ball);
  ball.vx = shot.vx;
  ball.vy = shot.vy;
  phase = 'flight';
  restTimer = 0;
  stallTimer = 0;
  pendingShot = true;
  shots.taken++;
  shake = Math.max(shake, shot.power * 2.4);
  sfx.release(shot.power);
  hideHint();
}

const fxHooks = {
  onBounce: (i) => sfx.bounce(i),
  onRim: (i) => {
    sfx.rim(i);
    shake = Math.max(shake, 1 + i * 4);
    burst(ball.x, ball.y, 3, '#c2540a');
  },
  onScore: (swish) => scoreBasket(swish),
};

function scoreBasket(swish) {
  shots.made++;
  shots.streak++;
  const points = (swish ? 15 : 10) + Math.min(shots.streak, 5) * 2;
  shots.score += points;
  if (shots.score > best) {
    best = shots.score;
    saveBest();
  }

  netSway = 1;
  shake = Math.max(shake, 5);
  if (swish) sfx.swish();
  sfx.score();

  const label = swish ? 'SWISH!' : shots.streak >= 2 ? `STREAK x${shots.streak}` : 'BUCKET';
  pops.push({ x: P.RIM_MID_X, y: P.RIM_Y - 26, text: `+${points}`, label, life: 1 });
  burst(P.RIM_MID_X, P.RIM_Y + 6, swish ? 26 : 18, swish ? '#ffd08a' : '#f4842a');
  syncHud(true);
}

function enterServe() {
  if (phase === 'serve') return;
  if (pendingShot && !ball.scored) shots.streak = 0;
  pendingShot = false;
  phase = 'serve';
  serveTimer = 0;
  syncHud();
}

function resetGame() {
  shots = P.makeShots();
  serveIdx = 0;
  holding = false;
  particles.length = 0;
  pops.length = 0;
  trail = [];
  netSway = 0;
  shake = 0;
  serveBall();
  syncHud(true);
}

/* ------------------------------------------------------------------ */
/* simulation                                                          */
/* ------------------------------------------------------------------ */

function fixedUpdate(dt) {
  clock += dt;

  // effects always breathe, even while the ball is held
  shake *= Math.exp(-9 * dt);
  netSway *= Math.exp(-3.4 * dt);
  netDrift = Math.sin(clock * 19) * netSway * 7;

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    p.vy += 1400 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
  }

  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.life -= dt * 0.9;
    if (p.life <= 0) pops.splice(i, 1);
  }

  if (holding) {
    ball.vx = 0;
    ball.vy = 0;
    ball.speed = 0;
    return;
  }

  P.stepBall(ball, dt, fxHooks);

  if (phase === 'flight') {
    if (ball.onFloor && ball.speed < 26) restTimer += dt;
    else restTimer = 0;
    if (restTimer > 0.8) enterServe();
  }

  if (phase === 'serve') {
    serveTimer += dt;
    if (serveTimer > 0.45) serveBall();
  }

  // out of play
  if (ball.y > P.WORLD_H + 140 || ball.x < -180 || ball.x > P.WORLD_W + 180) {
    enterServe();
  }

  // safety valve: ball balanced on the rim and going nowhere
  if (ball.speed < 20 && !ball.onFloor) {
    stallTimer += dt;
    if (stallTimer > 1.1) {
      ball.vy += 110;
      ball.vx -= 45;
      stallTimer = 0;
    }
  } else {
    stallTimer = 0;
  }

  // motion trail
  if (ball.speed > 230 && phase !== 'aim') {
    trail.push({ x: ball.x, y: ball.y });
    if (trail.length > 16) trail.shift();
  } else if (trail.length) {
    trail.shift();
  }
}

function burst(x, y, n, color) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = 60 + Math.random() * 320;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 120,
      life: 0.45 + Math.random() * 0.55,
      size: 2 + Math.random() * 3.4,
      rot: Math.random() * TAU,
      vr: (Math.random() - 0.5) * 12,
      color,
    });
  }
}

/* ------------------------------------------------------------------ */
/* static background (cached once)                                     */
/* ------------------------------------------------------------------ */

let bg = null;

function buildBackground() {
  const c = document.createElement('canvas');
  c.width = P.WORLD_W;
  c.height = P.WORLD_H;
  const g = c.getContext('2d');

  // soft room
  const wall = g.createLinearGradient(0, 0, 0, P.FLOOR_Y);
  wall.addColorStop(0, '#ffffff');
  wall.addColorStop(1, '#f1f4f9');
  g.fillStyle = wall;
  g.fillRect(0, 0, P.WORLD_W, P.WORLD_H);

  // shooting arc hint (ellipse so it stays inside the stage)
  g.save();
  g.strokeStyle = 'rgba(242, 118, 26, 0.16)';
  g.lineWidth = 3;
  g.setLineDash([12, 12]);
  g.beginPath();
  g.ellipse(P.RIM_MID_X, P.RIM_Y, 330, 248, 0, Math.PI * 0.72, Math.PI * 1.28);
  g.stroke();
  g.restore();

  // back wall
  const wg = g.createLinearGradient(P.WALL_X, 0, P.WORLD_W, 0);
  wg.addColorStop(0, '#d9dee6');
  wg.addColorStop(1, '#c6cdd8');
  g.fillStyle = wg;
  g.fillRect(P.WALL_X, 0, P.WALL_W, P.WORLD_H);
  g.strokeStyle = 'rgba(120, 132, 150, 0.22)';
  g.lineWidth = 1;
  for (let y = 0; y < P.WORLD_H; y += 46) {
    g.beginPath();
    g.moveTo(P.WALL_X, y);
    g.lineTo(P.WORLD_W, y);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillRect(P.WALL_X, 0, 3, P.WORLD_H);

  // floor
  const fg = g.createLinearGradient(0, P.FLOOR_Y, 0, P.WORLD_H);
  fg.addColorStop(0, '#e7e2d9');
  fg.addColorStop(1, '#d7d1c5');
  g.fillStyle = fg;
  g.fillRect(0, P.FLOOR_Y, P.WORLD_W, P.WORLD_H - P.FLOOR_Y);
  g.fillStyle = 'rgba(255,255,255,0.65)';
  g.fillRect(0, P.FLOOR_Y, P.WORLD_W, 2);

  // rim bolted straight onto the wall — no backboard
  g.fillStyle = 'rgba(28, 38, 54, 0.09)';
  roundRect(g, P.RIM_LEFT_X + 4, P.RIM_Y + 5, P.RIM_LEN - 4, 8, 4);
  g.fill();
  g.fillStyle = '#aeb7c4';
  roundRect(g, P.WALL_X - 3, P.RIM_Y - 17, 16, 34, 4);
  g.fill();
  g.fillStyle = 'rgba(70, 80, 96, 0.5)';
  for (const dy of [-9, 9]) {
    g.beginPath();
    g.arc(P.WALL_X + 6, P.RIM_Y + dy, 2.1, 0, TAU);
    g.fill();
  }
  g.strokeStyle = '#e2620f';
  g.lineWidth = 8;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(P.RIM_LEFT_X, P.RIM_Y);
  g.lineTo(P.RIM_RIGHT_X, P.RIM_Y);
  g.stroke();

  // vignette
  const vg = g.createRadialGradient(
    P.WORLD_W * 0.45,
    P.WORLD_H * 0.4,
    P.WORLD_W * 0.25,
    P.WORLD_W * 0.45,
    P.WORLD_H * 0.4,
    P.WORLD_W * 0.72
  );
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(20,30,45,0.06)');
  g.fillStyle = vg;
  g.fillRect(0, 0, P.WORLD_W, P.WORLD_H);

  bg = c;
}

/* ------------------------------------------------------------------ */
/* basketball sprite (built once, pebbles and all)                     */
/* ------------------------------------------------------------------ */

const SPRITE_SCALE = 4;
let ballSprite = null;

function buildBallSprite() {
  const r = P.BALL_R;
  const size = Math.ceil(r * 2 * SPRITE_SCALE);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  g.scale(SPRITE_SCALE, SPRITE_SCALE);
  g.translate(r, r);

  const grad = g.createRadialGradient(-r * 0.36, -r * 0.44, r * 0.1, 0, 0, r * 1.14);
  grad.addColorStop(0, '#ffc77e');
  grad.addColorStop(0.45, '#f4842a');
  grad.addColorStop(1, '#c65a0f');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  g.fill();

  // pebbled grain
  g.save();
  g.beginPath();
  g.arc(0, 0, r - 0.5, 0, TAU);
  g.clip();
  const cell = r / 17;
  for (let row = 0, y = -r; y <= r; y += cell, row++) {
    for (let x = -r; x <= r; x += cell) {
      const px = x + (row % 2 ? cell / 2 : 0);
      if (Math.hypot(px, y) > r - 1) continue;
      g.fillStyle = 'rgba(112, 46, 4, 0.2)';
      g.beginPath();
      g.arc(px, y, r * 0.045, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(255, 212, 158, 0.26)';
      g.beginPath();
      g.arc(px - r * 0.022, y - r * 0.022, r * 0.026, 0, TAU);
      g.fill();
    }
  }

  // seams, clipped to the ball: two poles, a belt, and the curved panels
  g.strokeStyle = '#3b1b04';
  g.lineCap = 'round';
  g.lineWidth = r * 0.062;
  g.beginPath();
  g.moveTo(0, -r * 0.995);
  g.lineTo(0, r * 0.995);
  g.moveTo(-r * 0.995, 0);
  g.lineTo(r * 0.995, 0);
  g.stroke();

  g.lineWidth = r * 0.055;
  for (const dir of [-1, 1]) {
    g.beginPath();
    g.moveTo(dir * r * 0.26, -r * 0.965);
    g.quadraticCurveTo(dir * r * 1.22, 0, dir * r * 0.26, r * 0.965);
    g.stroke();
  }
  g.restore();

  g.strokeStyle = 'rgba(88, 36, 4, 0.45)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(0, 0, r - 0.5, 0, TAU);
  g.stroke();

  ballSprite = c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

/** Net rows: each row gathers as it drops, and odd rows are offset half a
 *  cell so the strands cross into the classic diamond mesh. */
const NET_CELLS = 10;
const NET_ROWS = [
  { y: 4, w: 1.0 },
  { y: 14, w: 0.97 },
  { y: 24, w: 0.9 },
  { y: 34, w: 0.79 },
  { y: 44, w: 0.64 },
  { y: 53, w: 0.47 },
  { y: 59, w: 0.34 },
];

function drawNet() {
  const cx = P.RIM_MID_X + netDrift;
  const squash = 1 - netSway * 0.07;
  // odd rows sit half a cell over, so each node links to the two nodes that
  // straddle it and the strands cross into diamonds
  const node = (row, i) => {
    const u = clampNum((i + (row % 2) * 0.5) / NET_CELLS, 0, 1);
    const w = NET_ROWS[row].w * P.RIM_LEN * squash;
    return {
      x: cx - w / 2 + u * w,
      y: P.RIM_Y + NET_ROWS[row].y + netSway * 5,
    };
  };

  ctx.save();
  ctx.strokeStyle = 'rgba(66, 78, 96, 0.55)';
  ctx.lineCap = 'round';

  // band that wraps the rim
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(P.RIM_LEFT_X + 3, P.RIM_Y + 4);
  ctx.lineTo(P.RIM_RIGHT_X - 3, P.RIM_Y + 4);
  ctx.stroke();

  // diamond mesh
  ctx.lineWidth = 1.1;
  for (let r = 0; r < NET_ROWS.length - 1; r++) {
    for (let i = 0; i <= NET_CELLS; i++) {
      const a = node(r, i);
      const left = node(r + 1, i - 1);
      const right = node(r + 1, i);
      ctx.beginPath();
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(a.x, a.y);
      ctx.lineTo(right.x, right.y);
      ctx.stroke();
    }
  }

  // the opening at the bottom
  const bottom = NET_ROWS.length - 1;
  const l = node(bottom, 0);
  const r = node(bottom, NET_CELLS);
  ctx.beginPath();
  ctx.ellipse((l.x + r.x) / 2, l.y, Math.max(2, (r.x - l.x) / 2), 4, 0, 0, Math.PI);
  ctx.stroke();
  ctx.restore();
}

function drawBall() {
  const d = ball.r * 2;
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.rotate(ball.rot);
  if (holding) ctx.globalAlpha = 0.94;
  if (ballSprite) ctx.drawImage(ballSprite, -d / 2, -d / 2, d, d);
  ctx.restore();
}

function powerColor(p) {
  const stops = [
    [0.0, [42, 168, 107]],
    [0.55, [242, 176, 26]],
    [1.0, [226, 80, 58]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i][0] && p <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const t = (p - a[0]) / (b[0] - a[0] || 1);
  const rgb = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * t));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function drawShadow() {
  const height = Math.max(0, P.FLOOR_Y - (ball.y + ball.r));
  const k = P.clamp01(1 - height / 420);
  const x = P.clamp(ball.x, 22, P.WALL_X - 22);
  ctx.save();
  ctx.translate(x, P.FLOOR_Y + 9);
  ctx.scale(1, 0.26);
  ctx.fillStyle = `rgba(28, 38, 54, ${0.2 * k})`;
  ctx.beginPath();
  ctx.arc(0, 0, ball.r * (0.62 + 0.55 * k), 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawTrail() {
  if (trail.length < 2) return;
  ctx.save();
  for (let i = 1; i < trail.length; i++) {
    const t = i / trail.length;
    ctx.fillStyle = `rgba(242, 132, 42, ${0.2 * t})`;
    ctx.beginPath();
    ctx.arc(trail[i].x, trail[i].y, ball.r * 0.5 * t, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawAim() {
  const shot = P.shotVelocity(pointer.x - ball.x, pointer.y - ball.y);
  if (!shot) return;
  const col = powerColor(shot.power);

  // drag line: ball -> pointer
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.9;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(ball.x, ball.y);
  ctx.lineTo(pointer.x, pointer.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // arrow head
  const ang = Math.atan2(pointer.y - ball.y, pointer.x - ball.x);
  const tip = 14;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(pointer.x, pointer.y);
  ctx.lineTo(pointer.x - Math.cos(ang - 0.45) * tip, pointer.y - Math.sin(ang - 0.45) * tip);
  ctx.lineTo(pointer.x - Math.cos(ang + 0.45) * tip, pointer.y - Math.sin(ang + 0.45) * tip);
  ctx.closePath();
  ctx.fill();

  // power ring around the ball
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(20, 28, 40, 0.12)';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.r + 11, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(
    ball.x,
    ball.y,
    ball.r + 11,
    -Math.PI / 2,
    -Math.PI / 2 + Math.max(0.02, shot.power) * TAU
  );
  ctx.stroke();
  ctx.restore();

  // honest predicted flight path
  if (showAim) {
    const pts = P.traceShot(ball.x, ball.y, shot.vx, shot.vy);
    ctx.save();
    for (let i = 0; i < pts.length; i += 2) {
      const t = 1 - i / pts.length;
      ctx.fillStyle = `rgba(226, 118, 42, ${0.5 * t + 0.06})`;
      ctx.beginPath();
      ctx.arc(pts[i], pts[i + 1], 1.2 + 3 * t, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // power readout
  ctx.save();
  ctx.font = '650 15px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = col;
  ctx.fillText(Math.round(shot.power * 100) + '%', pointer.x, pointer.y - 14);
  ctx.restore();
}

function drawParticles() {
  ctx.save();
  for (const p of particles) {
    const t = P.clamp01(p.life * 2);
    ctx.globalAlpha = t;
    ctx.fillStyle = p.color;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    ctx.restore();
  }
  ctx.restore();
}

function drawPops() {
  ctx.save();
  ctx.textAlign = 'center';
  for (const p of pops) {
    const t = P.clamp01(p.life);
    ctx.globalAlpha = t;
    ctx.font = '700 30px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#c2540a';
    ctx.fillText(p.text, p.x, p.y - (1 - t) * 34);
    if (p.label) {
      ctx.font = '650 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(80, 92, 110, 0.9)';
      ctx.fillText(p.label, p.x, p.y + 14 - (1 - t) * 34);
    }
  }
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, P.WORLD_W, P.WORLD_H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, P.WORLD_W, P.WORLD_H);
  if (bg) ctx.drawImage(bg, 0, 0);

  ctx.save();
  if (shake > 0.08) {
    const s = shake;
    ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }
  drawNet();
  drawShadow();
  drawTrail();
  if (holding) drawAim();
  drawBall();
  drawParticles();
  drawPops();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* hud                                                                 */
/* ------------------------------------------------------------------ */

let lastScore = -1;

function syncHud(bump = false) {
  el.score.textContent = String(shots.score);
  el.makes.textContent = `${shots.made} / ${shots.taken}`;
  el.streak.textContent = String(shots.streak);
  el.best.textContent = String(best);
  if (bump && shots.score !== lastScore) {
    const box = el.score.parentElement;
    box.classList.remove('bump');
    void box.offsetWidth;
    box.classList.add('bump');
  }
  lastScore = shots.score;
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

canvas.addEventListener('pointerdown', (e) => {
  sfx.resume();
  const p = toWorld(e);
  pointer.x = p.x;
  pointer.y = p.y;
  pointer.inside = true;
  if (phase === 'serve' || !hitTest(p)) return;
  holding = true;
  ball.vx = 0;
  ball.vy = 0;
  canvas.classList.add('grabbing');
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* capture is a nicety, not a requirement */
  }
  sfx.catch_();
});

canvas.addEventListener('pointermove', (e) => {
  const p = toWorld(e);
  pointer.x = p.x;
  pointer.y = p.y;
  pointer.inside = true;
});

function releaseDrag(e) {
  if (!holding) return;
  const p = toWorld(e);
  canvas.classList.remove('grabbing');
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  shootAt(p);
}

canvas.addEventListener('pointerup', releaseDrag);
canvas.addEventListener('pointercancel', releaseDrag);
canvas.addEventListener('pointerleave', () => {
  if (!holding) pointer.inside = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
globalThis.addEventListener('blur', () => {
  holding = false;
  canvas.classList.remove('grabbing');
});

function setAim(on) {
  showAim = on;
  el.btnAim.textContent = `Aim guide: ${on ? 'on' : 'off'}`;
  el.btnAim.setAttribute('aria-pressed', String(on));
}

function setSound(on) {
  sfx.setEnabled(on);
  el.btnSound.textContent = `Sound: ${on ? 'on' : 'off'}`;
  el.btnSound.setAttribute('aria-pressed', String(on));
}

el.btnAim.addEventListener('click', () => setAim(!showAim));
el.btnSound.addEventListener('click', () => setSound(!sfx.isEnabled()));
el.btnReset.addEventListener('click', () => {
  resetGame();
});

globalThis.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') resetGame();
  else if (e.key === 't' || e.key === 'T') setAim(!showAim);
  else if (e.key === 'm' || e.key === 'M') setSound(!sfx.isEnabled());
});

globalThis.addEventListener('resize', resize);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(resize).observe(stage);
}

/* ------------------------------------------------------------------ */
/* loop                                                                */
/* ------------------------------------------------------------------ */

let last = 0;
let acc = 0;

function frame(now) {
  if (!last) last = now;
  acc += Math.min((now - last) / 1000, 0.05);
  last = now;
  while (acc >= FIXED_DT) {
    fixedUpdate(FIXED_DT);
    acc -= FIXED_DT;
  }
  render();
  requestAnimationFrame(frame);
}

buildBackground();
buildBallSprite();
resize();
serveBall();
syncHud();
setAim(true);
setSound(true);
requestAnimationFrame(frame);
