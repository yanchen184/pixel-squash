# Pixel Squash

A pixel-art squash game in the browser — TypeScript + React + native Canvas 2D, no
game engine. Two players share one floor, both facing the front wall; the ball lives
in a real 3D box (`x` across, `y` depth-from-front-wall, `z` height) and the renderer
projects it into a third-person room perspective.

Forked from [pixel-badminton](https://github.com/yanchen184/pixel-badminton): same
deterministic-sim / input-seam / React-shell skeleton, rewritten physics (4-wall
bounce instead of a net), shot set, scoring, and projection.

## Quick start

```bash
npm install
npm run dev        # Vite dev server (http://localhost:5180)
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm test` | Vitest unit + physics suite |
| `npm run e2e` | Playwright E2E (headed — RAF freezes in hidden tabs) |

## How to play

Left hand moves, right hand swings. The shot you pick sets the depth/height — there is
**no charge meter**, power comes purely from swing-timing quality.

| Input | Action |
|---|---|
| `W A S D` / arrows | Move |
| `A` / `D` (on serve) | Pick the left / right service box |
| `J` | Kill — flat hard rail just above the tin (needs a high ball) |
| `K` | Drop — feathered touch into the front corner (from near the front) |
| `L` | Drive — the straight rail, safe default |
| `U` | Boast — angle off a side wall (when trapped near a side wall) |
| `Space` | Lob — float high to the back corners (the reset) |
| `Shift` | Dive (魚躍救球) — extended-reach lunge to save an out-of-reach ball |

Illegal shots auto-downgrade (a kill on a low ball becomes a drive). Touch controls
(on-screen joystick + stroke buttons + dive) mirror the keyboard on mobile.

Scoring is PAR-11, win by 2. The ball dies on a tin strike (front wall below the tin)
or a second floor bounce.

**Practice mode** has a front-wall trainer: press `M` to step the ball along its
predicted trajectory to the next wall stop.

## Architecture

The simulation is a deterministic pure function — `step(state, inA, inB)` at a fixed
60 Hz, no `Math.random` / `Date`, immutable state — so it is fully unit-testable and
replay-stable. React only draws the menu and HUD overlay; it never touches the game loop.

```
src/
  data/        gameState, strokes — the sim's data model
  game/
    sim/       step() physics, SimRunner (owns the 60Hz loop)
    input/     LocalInput (keyboard), AIInput, touch singleton
    court/     projection (3D logic → screen)
    render/    CanvasRenderer (match), PracticeRenderer (practice)
  ui/          React shell: GameView, Hud, Controls
```

See **[PLAN.md](./PLAN.md)** for the full engine spec — every physics constant,
coordinate system, scoring rule, and the three-layer test plan — written so the game
can be rebuilt from the document alone.

## Testing

Three layers (detailed in PLAN.md §9):

- **L1 — unit / physics** (`tests/`, Vitest): the deterministic sim at full headless
  speed. Scoring, win-by-2, wall energy retention, tin / double-bounce death, AI rally
  quality.
- **L2 — E2E** (`e2e/`, Playwright): round-trip against the real React app + Canvas 2D
  + RAF loop, reading sim state through a DEV-only `window.__squash` seam. Menu boot,
  competitive two-way rallies, the dive save, and non-blank rendering.
- **L3 — playtest**: manual screenshot review of match and practice modes.

## Deploy

Pushing to `master` / `main` triggers GitHub Actions
(`.github/workflows/deploy.yml`): typecheck → test → build → Firebase Hosting
(`pixel-squash`).
