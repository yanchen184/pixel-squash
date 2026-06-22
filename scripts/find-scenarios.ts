/**
 * Search the REAL pure physics (simulate.ts) for launch vectors that produce each
 * manual scenario. Run with vite-node so the `@/` alias + ESM resolve.
 *
 * Scenarios:
 *  - three-star: ball touches LEFT + RIGHT side walls AND the FRONT wall before its
 *    first floor landing (squash "nick / 3-wall" rally — three distinct walls).
 *  - hit-glass-continue: a LEGAL front-wall hit that rebounds and stays in play (the
 *    ball "hits the glass front wall then the rally continues"). We capture mid-rebound.
 *  - too-high-out: an OUT fault — the ball crosses the front-wall plane ABOVE the out
 *    line (deadReason='out').
 *  - tin: struck the board below the tin (deadReason='tin').
 *
 * For each we print a launch vector + the frame index at which to capture, plus the
 * full wall-touch sequence so we can eyeball correctness.
 */
import {
  stepShuttle, type StepOpts,
} from '@/game/sim/simulate';
import {
  COURT, WALL_HEIGHT, TIN_HEIGHT, FRONT_OUT_HEIGHT,
  type ShuttleState,
} from '@/data/gameState';
import { FLOOR_FRICTION } from '@/data/gameState';

const OPTS: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };

function fresh(x: number, y: number, z: number, vx: number, vy: number, vz: number): ShuttleState {
  return {
    pos: { x, y }, z, vel: { x: vx, y: vy }, vz,
    inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
    hitFrontWall: false, lastWall: null, deadReason: null,
    landing: null, landingEta: 0,
  };
}

interface Trace { walls: string[]; firstFloorFrame: number; deadFrame: number; deadReason: string | null; frames: ShuttleState[]; }

function trace(s0: ShuttleState, maxF = 400): Trace {
  let s = s0;
  const walls: string[] = [];
  const frames: ShuttleState[] = [s];
  let firstFloorFrame = -1, deadFrame = -1, deadReason: string | null = null;
  let prevWall = s.lastWall, prevBounces = s.bouncesSinceWall;
  for (let f = 1; f <= maxF; f++) {
    s = stepShuttle(s, OPTS);
    frames.push(s);
    if (s.lastWall !== prevWall && s.lastWall != null) { walls.push(`${f}:${s.lastWall}`); prevWall = s.lastWall; }
    if (s.bouncesSinceWall > prevBounces) { if (firstFloorFrame < 0) firstFloorFrame = f; prevBounces = s.bouncesSinceWall; }
    if (s.deadReason && deadFrame < 0) { deadFrame = f; deadReason = s.deadReason; }
    if (s.deadReason) break;
    if (s.bouncesSinceWall >= 2) break;
  }
  return { walls, firstFloorFrame, deadFrame, deadReason, frames };
}

// --- THREE-STAR: left + right + front before the rally ends ---
// A squash "three-wall" boast: ball grazes one side wall, crosses to the other, then the
// front wall. Allow it to happen across the whole flight (incl. after a legal floor bounce)
// as long as all three walls appear and the ball never dies. Higher launch + strong vx.
// mode 'clean' → tightest readable boast (side→side→front, NO floor bounce before front,
//                small total span so it reads as ONE clean 3-corner arc).
// mode 'rich'  → widest multi-wall spread (busy net of segments — the physics showcase).
function findThreeStar(mode: 'clean' | 'rich' = 'rich') {
  let best: any = null;
  for (let sx = 40; sx <= 600; sx += 30) {
    for (let sy = 250; sy <= 850; sy += 50) {
      for (let vx = -22; vx <= 22; vx += 2) {
        if (Math.abs(vx) < 6) continue;
        for (let vy = -18; vy <= -6; vy += 2) {
          for (let vz = 4; vz <= 16; vz += 2) {
            const tr = trace(fresh(sx, sy, 150, vx, vy, vz));
            // A normal rally shot eventually double-bounces (no returner) — that's fine.
            // We only reject early FAULTS (tin/out/not-front-wall) that kill the shot.
            if (tr.deadReason && tr.deadReason !== 'double-bounce' && tr.deadReason !== 'dead-after-bounce') continue;
            const starWalls = tr.walls.filter(w => ['left','right','front'].includes(w.split(':')[1]));
            const kinds = new Set(starWalls.map(w => w.split(':')[1]));
            if (kinds.has('left') && kinds.has('right') && kinds.has('front')) {
              // frame index of each of the three FIRST touches, in time order
              const firstOf = (k: string) => Math.min(...tr.walls.filter(w=>w.endsWith(':'+k)).map(w=>+w.split(':')[0]));
              const fl = firstOf('left'), fr = firstOf('right'), ff = firstOf('front');
              const seq = [fl, fr, ff].sort((a,b)=>a-b);
              if (seq[0] < 4) continue;                       // visible leg into first corner
              if (ff < fl || ff < fr) continue;               // front last (classic boast)
              const lastWallFrame = seq[2];
              if (tr.deadFrame >= 0 && lastWallFrame >= tr.deadFrame) continue;
              const spread = seq[2] - seq[0];
              if (mode === 'clean') {
                // the three corners must complete BEFORE the first floor bounce (one clean arc),
                // and stay tight so the segments don't overlap into a net.
                if (tr.firstFloorFrame >= 0 && lastWallFrame > tr.firstFloorFrame) continue;
                if (seq[1] - seq[0] < 3 || seq[2] - seq[1] < 3) continue; // distinct corners
                if (spread > 45) continue;                    // tight, single readable arc
                const capF = lastWallFrame + 5;
                const score = spread;                         // smallest tight spread wins
                if (!best || score < best.score) best = { sx, sy, z:150, vx, vy, vz, walls: tr.walls, capF, firstFloorFrame: tr.firstFloorFrame, score, seq };
              } else {
                if (seq[1] - seq[0] < 4 || seq[2] - seq[1] < 4) continue;
                const capF = lastWallFrame + 5;
                const score = -spread + seq[0] * 0.1;         // widest spread wins
                if (!best || score < best.score) best = { sx, sy, z:150, vx, vy, vz, walls: tr.walls, capF, firstFloorFrame: tr.firstFloorFrame, score, seq };
              }
            }
          }
        }
      }
    }
  }
  return best;
}

// --- HIT-GLASS-CONTINUE: legal front-wall hit, rebounds, still in play. Capture a few
// frames AFTER the front-wall touch so the ball is visibly coming back off the glass. ---
function findGlassContinue() {
  // The GLASS is the BACK wall (y >= COURT.depth) — the audience sits behind it, and the sim
  // bounces the ball off it (lastWall='back', WALL_BOUNCE) WITHOUT ending the rally. So this
  // is "打到玻璃後還能繼續擊球". Launch from the front/mid court driving DEEP (vy>0, toward the
  // back), hit the glass, then capture ~3 frames after so the ball is still hugging the glass
  // (top-centre far rect) with its tail pointing back AT the glass it just struck.
  let best:any = null;
  for (let sx = 200; sx <= 440; sx += 40) {
    for (let sy = 250; sy <= 600; sy += 50) {
      for (let vx = -8; vx <= 8; vx += 2) {
        for (let vy = 8; vy <= 22; vy += 2) {       // POSITIVE vy = toward the back glass
          for (let vz = 2; vz <= 12; vz += 2) {
            const tr = trace(fresh(sx, sy, 120, vx, vy, vz));
            const back = tr.walls.find(w => w.endsWith(':back'));
            if (!back) continue;
            const bF = +back.split(':')[0];
            // back wall must be the FIRST wall it touches (clean drive into the glass)
            if (tr.walls[0] !== back) continue;
            // not a fault before/at the hit, and still airborne a few frames after
            const capF = bF + 3;
            const aliveAtCap = tr.deadFrame < 0 || capF < tr.deadFrame;
            if (capF >= tr.frames.length) continue;
            const zHit = tr.frames[bF].z;
            if (zHit < 60 || zHit > WALL_HEIGHT - 60) continue;   // mid-height glass strike
            if (tr.frames[capF].z > 30 && aliveAtCap) {
              // prefer an earlier, cleaner hit; mild side angle so rebound peels visibly
              const score = bF + Math.abs(vx) * 0.1;
              if (!best || score < best.score) best = { sx, sy, z:120, vx, vy, vz, backFrame:bF, capF, walls: tr.walls, firstFloorFrame: tr.firstFloorFrame, score, zHit: Math.round(zHit) };
            }
          }
        }
      }
    }
  }
  return best;
}

// --- TOO-HIGH-OUT: ball crosses front plane above OUT line ---
function findOut() {
  for (let vz = 14; vz <= 30; vz += 1) {
    const tr = trace(fresh(320, 520, 200, 0, -10, vz));
    if (tr.deadReason === 'out') {
      return { sx:320, sy:520, z:200, vx:0, vy:-10, vz, deadFrame: tr.deadFrame, capF: tr.deadFrame, walls: tr.walls };
    }
  }
  return null;
}

// --- TIN: struck below tin ---
function findTin() {
  // Reach the front-wall plane (y=0) while z < TIN (50): launch from near the front, low and
  // flat, descending so the strike height interpolates below the tin.
  for (let sy = 120; sy <= 360; sy += 30) {
    for (let vy = -16; vy <= -8; vy += 1) {
      for (let vz = 2; vz >= -10; vz -= 1) {
        const tr = trace(fresh(320, sy, 70, 0, vy, vz));
        if (tr.deadReason === 'tin') {
          return { sx:320, sy, z:70, vx:0, vy, vz, deadFrame: tr.deadFrame, capF: tr.deadFrame, walls: tr.walls };
        }
      }
    }
  }
  return null;
}

// Emit the full per-frame shuttle array up to (and a little past) the capture frame, so the
// browser harness can replay the EXACT physics frames through the renderer (authentic tail).
function framesUpTo(scn: any, pad = 6) {
  const s0 = fresh(scn.sx, scn.sy, scn.z, scn.vx, scn.vy, scn.vz);
  const tr = trace(s0, scn.capF + pad);
  return tr.frames.slice(0, scn.capF + pad + 1).map(f => ({
    pos: { x: +f.pos.x.toFixed(2), y: +f.pos.y.toFixed(2) }, z: +f.z.toFixed(2),
    vel: { x: +f.vel.x.toFixed(3), y: +f.vel.y.toFixed(3) }, vz: +f.vz.toFixed(3),
    inPlay: f.inPlay, lastHitBy: f.lastHitBy, bouncesSinceWall: f.bouncesSinceWall,
    hitFrontWall: f.hitFrontWall, lastWall: f.lastWall, deadReason: f.deadReason,
    landing: f.landing, landingEta: f.landingEta,
  }));
}

const threeStar = findThreeStar('rich');
const threeStarClean = findThreeStar('clean');
const glass = findGlassContinue();
const out = findOut();
const tin = findTin();

const bundle = {
  meta: { COURT, WALL_HEIGHT, TIN: TIN_HEIGHT, OUT: FRONT_OUT_HEIGHT },
  scenarios: {
    threeStar:      { ...threeStar,      frames: framesUpTo(threeStar) },
    threeStarClean: { ...threeStarClean, frames: framesUpTo(threeStarClean) },
    glass:          { ...glass,          frames: framesUpTo(glass) },
    out:            { ...out,            frames: framesUpTo(out) },
    tin:            { ...tin,            frames: framesUpTo(tin) },
  },
};
console.log('SCENARIO_BUNDLE_START');
console.log(JSON.stringify(bundle));
console.log('SCENARIO_BUNDLE_END');
console.error('three-star(rich) walls', JSON.stringify(threeStar.walls), 'capF', threeStar.capF);
console.error('three-star(clean) walls', threeStarClean ? JSON.stringify(threeStarClean.walls) : 'NULL', 'capF', threeStarClean && threeStarClean.capF, 'seq', threeStarClean && JSON.stringify(threeStarClean.seq));
console.error('glass walls', JSON.stringify(glass.walls), 'capF', glass.capF);
console.error('out capF', out.capF, 'tin capF', tin.capF);
