# Hoops

A small 2D basketball game that runs entirely on your machine. Nothing is
deployed, nothing is uploaded — it is served from `127.0.0.1` only.

## Play

```
node server.mjs          # then open http://127.0.0.1:5173
node server.mjs 8080     # or pick another port
```

## How to shoot

1. **Click and hold the ball** — on the floor, or in mid air while it is flying.
2. **Drag toward the hoop.** The line you draw is the direction of the shot and
   its length is the power (the ring around the ball and the `%` label show it).
3. **Release.** The ball flies, hits the rim/backboard/boards realistically, and
   a new ball is served automatically once it settles.

Because the ball can be grabbed **at any point in its flight**, a bad shot is
never the end of it: catch it and drag it somewhere else. That is the fastest way
to learn the rim.

| Key | Action |
| --- | --- |
| `R` | reset the scoreboard |
| `T` | toggle the predicted-trajectory dots |
| `M` | mute / unmute |

## Scoring

- `10` for a basket, `15` for a swish (no rim, no backboard)
- `+2` per streak level, up to a `+10` streak bonus
- best score is kept in `localStorage`

## Files

| File | What it is |
| --- | --- |
| `index.html` | page shell + HUD |
| `styles.css` | chrome around the canvas |
| `physics.js` | all ball/rim/board physics — no DOM, runs in Node too |
| `game.js` | rendering, pointer input, game loop |
| `server.mjs` | zero-dependency static server bound to `127.0.0.1` |
| `tools/smoke.mjs` | headless test: shot sweep + a scripted play-through |

## Tuning the game

Everything gameplay-related lives at the top of `physics.js`:

```js
export const RIM_Y = 285;          // rim height above the floor
export const RIM_R = 46;           // rim half-width (ball radius is 24)
export const MAX_SHOT_SPEED = 1450; // px/s at full power
export const MAX_DRAG = 240;       // px of drag for full power
export const SERVE_X = [270, 400, 200, 330];
```

After changing any of them, run the test to make sure the hoop is still
reachable from every serve spot:

```
node tools/smoke.mjs
```
