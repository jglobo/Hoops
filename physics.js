/**
 * Hoops — pure 2D physics for the basketball game.
 *
 * This module has no DOM dependencies on purpose: the browser game imports it,
 * and the Node smoke test imports the exact same code to verify that shots can
 * actually be made.
 *
 * World layout (logical units, 960 x 600 stage):
 *   - floor surface at y = FLOOR_Y, ball rests on it
 *   - back wall on the right (left face at x = WALL_X)
 *   - rim bolted straight onto that wall, no backboard
 */

export const WORLD_W = 960;
export const WORLD_H = 600;

/* ---- level geometry ---- */
export const FLOOR_Y = 520;
export const WALL_X = 910;
export const WALL_W = WORLD_W - WALL_X;

/** No backboard: the rim is bolted straight onto the wall. */
export const RIM_Y = 285;
export const RIM_R = 46;
export const RIM_T = 7;
export const RIM_RIGHT_X = WALL_X;
export const RIM_LEFT_X = WALL_X - RIM_R * 2;
export const RIM_LEN = RIM_R * 2;
export const RIM_MID_X = (RIM_LEFT_X + RIM_RIGHT_X) / 2;
export const RIM_ENDS = [
  { x: RIM_LEFT_X, y: RIM_Y },
  { x: RIM_RIGHT_X, y: RIM_Y },
];
/** Half-width of the scoring window (ball centre) when crossing the rim plane. */
export const SCORE_HALF = RIM_R * 0.8;

/** Alternate serve spots so the same shot isn't memorised. */
export const SERVE_X = [270, 400, 200, 330];

/* ---- tuning ---- */
export const BALL_R = 24;
export const GRAVITY = 1750;
export const AIR_DRAG = 0.06;

export const FLOOR_REST = 0.55;
export const WALL_REST = 0.62;
export const RIM_REST = 0.46;

export const MAX_DRAG = 240;
export const MIN_SHOT_SPEED = 150;
/**
 * Tuned so every serve spot can still reach the rim after the hoop moved onto
 * the wall — the deepest serve needs ~1350 px/s, so the cap keeps a margin.
 */
export const MAX_SHOT_SPEED = 1450;

export const CONTACT = { FLOOR: 1, WALL: 2, RIM: 4 };

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);

/* ------------------------------------------------------------------ */
/* shot helpers                                                        */
/* ------------------------------------------------------------------ */

export function powerFromDrag(len) {
  return clamp01((len - 6) / (MAX_DRAG - 6));
}

export function speedFromPower(power) {
  return MIN_SHOT_SPEED + power * (MAX_SHOT_SPEED - MIN_SHOT_SPEED);
}

/**
 * Turn a drag vector (ball -> pointer) into a shot.
 * Direction follows the drag, power follows its length.
 * Returns null when the drag is too short to be a shot.
 */
export function shotVelocity(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 6) return null;
  const power = powerFromDrag(len);
  const speed = speedFromPower(power);
  return { vx: (dx / len) * speed, vy: (dy / len) * speed, power, len };
}

/* ------------------------------------------------------------------ */
/* ball                                                                */
/* ------------------------------------------------------------------ */

export function makeBall(x, y) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    r: BALL_R,
    rot: 0,
    speed: 0,
    onFloor: false,
    contact: 0,
    scored: false,
    swish: false,
  };
}

export function makeShots() {
  return { score: 0, made: 0, taken: 0, streak: 0 };
}

export function resetShotFlags(b) {
  b.contact = 0;
  b.scored = false;
  b.swish = false;
}

/**
 * Advance the ball by one small timestep.
 * `fx` is an optional hook object: { onBounce(impact), onRim(impact) }.
 */
export function stepBall(b, dt, fx) {
  const prevY = b.y;

  b.vy += GRAVITY * dt;
  const damp = Math.exp(-AIR_DRAG * dt);
  b.vx *= damp;
  b.vy *= damp;

  b.x += b.vx * dt;
  b.y += b.vy * dt;

  collide(b, fx);

  // Scored when the centre crosses the rim plane downwards inside the rim.
  if (
    !b.scored &&
    b.vy > 0 &&
    prevY < RIM_Y &&
    b.y >= RIM_Y &&
    Math.abs(b.x - RIM_MID_X) <= SCORE_HALF
  ) {
    b.scored = true;
    b.swish = (b.contact & CONTACT.RIM) === 0;
    if (fx && fx.onScore) fx.onScore(b.swish, b.x, RIM_Y);
  }

  b.speed = Math.hypot(b.vx, b.vy);

  // Roll on the floor, gentle backspin in the air.
  if (b.onFloor) {
    b.rot += (b.vx / b.r) * dt;
    b.vx *= Math.exp(-3.0 * dt);
  } else {
    b.rot += (-b.vy / b.r) * 0.32 * dt;
  }
}

function collide(b, fx) {
  b.onFloor = false;

  // Floor
  if (b.y + b.r > FLOOR_Y) {
    b.y = FLOOR_Y - b.r;
    if (b.vy > 0) {
      const impact = b.vy;
      if (impact > 150 && fx && fx.onBounce) fx.onBounce(clamp01(impact / 900));
      b.vy = impact > 70 ? -impact * FLOOR_REST : 0;
      b.vx *= 0.86;
      b.contact |= CONTACT.FLOOR;
    }
    b.onFloor = true;
  }

  // Side walls
  if (b.x - b.r < 0) {
    b.x = b.r;
    if (b.vx < 0) {
      if (-b.vx > 150 && fx && fx.onBounce) fx.onBounce(clamp01(-b.vx / 900));
      b.vx = -b.vx * WALL_REST;
      b.contact |= CONTACT.WALL;
    }
  }
  if (b.x + b.r > WALL_X) {
    b.x = WALL_X - b.r;
    if (b.vx > 0) {
      if (b.vx > 150 && fx && fx.onBounce) fx.onBounce(clamp01(b.vx / 900));
      b.vx = -b.vx * WALL_REST;
      b.contact |= CONTACT.WALL;
    }
  }

  // Ceiling
  if (b.y - b.r < 0) {
    b.y = b.r;
    if (b.vy < 0) {
      b.vy = -b.vy * WALL_REST;
      b.contact |= CONTACT.WALL;
    }
  }

  // Rim ends
  for (const end of RIM_ENDS) {
    const dx = b.x - end.x;
    const dy = b.y - end.y;
    const d = Math.hypot(dx, dy);
    const min = RIM_T + b.r;
    if (d > 0 && d < min) {
      const nx = dx / d;
      const ny = dy / d;
      b.x += nx * (min - d);
      b.y += ny * (min - d);
      const vn = b.vx * nx + b.vy * ny;
      if (vn < 0) {
        const impact = -vn;
        b.vx -= (1 + RIM_REST) * vn * nx;
        b.vy -= (1 + RIM_REST) * vn * ny;
        // Rim eats tangential energy — that's what makes shots rattle out.
        const tx = -ny;
        const ty = nx;
        const vt = b.vx * tx + b.vy * ty;
        b.vx -= 0.22 * vt * tx;
        b.vy -= 0.22 * vt * ty;
        b.contact |= CONTACT.RIM;
        if (fx && fx.onRim) fx.onRim(clamp01(impact / 900));
      }
    }
  }
}

/**
 * Predict a flight path for the aim guide. Uses the real integrator, so the
 * dots are honest. Stops on rim contact, a score, or leaving the stage.
 */
export function traceShot(x, y, vx, vy, seconds = 2.6, sampleEvery = 8) {
  const b = makeBall(x, y);
  b.vx = vx;
  b.vy = vy;
  const dt = 1 / 240; // same step as the live sim, so the dots stay honest
  const total = Math.round(seconds / dt);
  const pts = [];
  for (let i = 0; i < total; i++) {
    stepBall(b, dt, null);
    if (i % sampleEvery === 0) pts.push(b.x, b.y);
    if (b.scored) {
      pts.push(b.x, b.y);
      break;
    }
    if (b.contact & CONTACT.RIM) {
      pts.push(b.x, b.y);
      break;
    }
    if (b.y > FLOOR_Y || b.x < 0 || b.x > WALL_X) break;
  }
  return pts;
}
