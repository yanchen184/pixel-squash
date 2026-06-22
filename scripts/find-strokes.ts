/**
 * Drive the REAL practice-serve flow (simulate.ts `step`) for each stroke type so we can
 * replay the authentic flight in-page and screenshot a labelled path. This uses the exact
 * same code path as the live game: toss → swing(stroke) → launchPracticeRally → live rally.
 *
 * For each stroke we emit the per-frame ShuttleState array (same shape as find-scenarios.ts)
 * plus the capture frame (when the ball completes its first front-wall arc and starts back),
 * so the existing in-page __replay.manualPlay harness can render it with an authentic tail.
 */
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import { COURT, createInitialState, type GameState } from '@/data/gameState';
import type { StrokeId } from '@/data/strokes';

// A practice serve state with player 0 ready to serve from a back corner of a service box.
function practiceServeState(serveBox: 0 | 1): GameState {
  let s = createInitialState();
  // Force practice mode + a serve phase for player 0.
  s = { ...s, gameMode: 'practice', phase: 'serve', server: 0, serveBox,
        awaitingServeChoice: true, serveSubPhase: null, phaseTimer: 1 };
  // Stand the player in the chosen service box (so toss locks that box in).
  const px = serveBox === 0 ? 100 : COURT.width - 100;
  s = { ...s, p1: { ...s.p1, pos: { x: px, y: 686 } } };
  return s;
}

const NO: InputFrame = NO_INPUT;

function launchStroke(stroke: StrokeId, serveBox: 0 | 1) {
  let s = practiceServeState(serveBox);
  // 1) tick through serve countdown + auto box-choice (practice skips the overlay).
  for (let i = 0; i < 6 && s.phase === 'serve' && s.serveSubPhase !== 'toss'; i++) {
    s = step(s, NO, NO);
  }
  // 2) toss: press M (nextStop) to lift the ball.
  s = step(s, { ...NO, nextStop: true }, NO);
  // 3) airborne: swing with the chosen stroke while the ball is near the body.
  //    The ball drifts in slow-mo; swing immediately (it tosses to PRACTICE_TOSS_Z right at
  //    the player, so it is within PRACTICE_HIT_RANGE on the next frame).
  let launched = false;
  for (let i = 0; i < 30 && !launched; i++) {
    s = step(s, { ...NO, swing: true, stroke }, NO);
    if (s.phase === 'rally' && s.previewStroke === stroke) launched = true;
  }
  if (!launched) return null;

  // 4) live rally: step until the ball has hit the front wall and started back (or dies / floors).
  const frames: any[] = [snap(s)];
  let frontFrame = -1, capF = -1;
  for (let f = 1; f <= 200; f++) {
    s = step(s, NO, NO);
    frames.push(snap(s));
    const sh = s.shuttle;
    if (frontFrame < 0 && sh.hitFrontWall) frontFrame = f;
    // capture a handful of frames after the FIRST front-wall touch so the tailed ball is
    // peeling off the front wall (the readable "this is a <stroke>" moment).
    if (frontFrame >= 0 && capF < 0 && f >= frontFrame + 8) capF = f;
    if (!sh.inPlay) { if (capF < 0) capF = Math.max(f - 1, frontFrame >= 0 ? frontFrame : f - 1); break; }
    if (capF >= 0 && f >= capF + 4) break;  // a little pad past capture, then stop
  }
  if (capF < 0) capF = frames.length - 1;
  // trim to capF + small pad
  const end = Math.min(frames.length, capF + 5);
  return { stroke, serveBox, frontFrame, capF, walls: wallSeq(frames), frames: frames.slice(0, end) };
}

function snap(s: GameState) {
  const f = s.shuttle;
  return {
    pos: { x: +f.pos.x.toFixed(2), y: +f.pos.y.toFixed(2) }, z: +f.z.toFixed(2),
    vel: { x: +f.vel.x.toFixed(3), y: +f.vel.y.toFixed(3) }, vz: +f.vz.toFixed(3),
    inPlay: f.inPlay, lastHitBy: f.lastHitBy, bouncesSinceWall: f.bouncesSinceWall,
    hitFrontWall: f.hitFrontWall, lastWall: f.lastWall, deadReason: f.deadReason,
    landing: f.landing, landingEta: f.landingEta,
  };
}

function wallSeq(frames: any[]): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  frames.forEach((f, i) => { if (f.lastWall !== prev && f.lastWall != null) { out.push(`${i}:${f.lastWall}`); prev = f.lastWall; } });
  return out;
}

const STROKES: { id: StrokeId; box: 0 | 1 }[] = [
  { id: 'drive', box: 0 },
  { id: 'kill',  box: 0 },
  { id: 'drop',  box: 0 },
  { id: 'lob',   box: 0 },
  { id: 'boast', box: 0 },
];

const scenarios: Record<string, any> = {};
for (const { id, box } of STROKES) {
  const r = launchStroke(id, box);
  scenarios[id] = r;
  console.error(id, r ? `frontF=${r.frontFrame} capF=${r.capF} frames=${r.frames.length} walls=${JSON.stringify(r.walls)}` : 'NULL');
}

const bundle = { meta: { COURT }, scenarios };
console.log('STROKE_BUNDLE_START');
console.log(JSON.stringify(bundle));
console.log('STROKE_BUNDLE_END');
