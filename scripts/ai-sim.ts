/**
 * AI-vs-AI simulation harness for tuning difficulty parameters.
 *
 * Usage:
 *   npx tsx scripts/ai-sim.ts [matches] [mode]
 *   npx tsx scripts/ai-sim.ts 2000 report   # report current params vs human-baseline
 *   npx tsx scripts/ai-sim.ts 500  mirror   # same difficulty both sides, check fairness
 *   npx tsx scripts/ai-sim.ts 80   tune     # grid search (slow — runs thousands of evals)
 */

import { step } from '../src/game/sim/simulate';
import { NO_INPUT } from '../src/game/input/InputSource';
import { AIInput } from '../src/game/input/AIInput';
import type { Difficulty } from '../src/game/input/AIInput';
import { createInitialState, type GameState } from '../src/data/gameState';

// ---- Types ----------------------------------------------------------------

type AIParams = {
  reactionDelay: number;
  predictionAccuracy: number;
  speedFactor: number;
  idleRate: number;
  fumbleRate: number;
  faultRate: number;
  deadzone: number;
  aggression: number;
};

type MatchResult = {
  winner: 0 | 1;
  scores: [number, number];
  rallyLengths: number[];
  totalFrames: number;
  pointCount: number;
};

type Stats = {
  winRate0: number;
  avgRallyHits: number;
  medianRallyHits: number;
  p90RallyHits: number;
  shortRallyPct: number;   // ≤2 hits
  longRallyPct: number;    // ≥6 hits
  avgMatchPoints: number;
  avgGameLength: number;
  matchCount: number;
};

// ---- Core runner ----------------------------------------------------------

const SERVE_LEFT = { ...NO_INPUT, serveLeft: true };

function runMatch(
  diff0: Difficulty | AIParams,
  diff1: Difficulty | AIParams,
  seed0 = 0x2545f491,
  seed1 = 0x6c62272e,
  maxFrames = 18000,
): MatchResult {
  const ai0 = typeof diff0 === 'string'
    ? new AIInput(diff0, 0, seed0)
    : new AIInputCustom(diff0, 0, seed0);
  const ai1 = typeof diff1 === 'string'
    ? new AIInput(diff1, 1, seed1)
    : new AIInputCustom(diff1, 1, seed1);

  let s = createInitialState();
  const rallyLengths: number[] = [];
  let curHits = 0;
  let prevCd0 = 0;
  let prevCd1 = 0;
  let prevPhase = s.phase;
  let frames = 0;

  for (frames = 0; frames < maxFrames && s.winner === null; frames++) {
    const inA = s.awaitingServeChoice ? SERVE_LEFT : ai0.sample(s);
    const inB = ai1.sample(s);
    s = step(s, inA, inB);

    if (s.phase === 'rally') {
      if (prevCd0 === 0 && s.p1.swingCooldown > 0) curHits++;
      if (prevCd1 === 0 && s.p2.swingCooldown > 0) curHits++;
    }
    prevCd0 = s.p1.swingCooldown;
    prevCd1 = s.p2.swingCooldown;

    if (s.phase === 'point' && prevPhase === 'rally') {
      rallyLengths.push(curHits);
      curHits = 0;
    }
    prevPhase = s.phase;
  }

  const winner = s.winner ?? (s.scores[0] >= s.scores[1] ? 0 : 1);
  return {
    winner: winner as 0 | 1,
    scores: [...s.scores] as [number, number],
    rallyLengths,
    totalFrames: frames,
    pointCount: s.scores[0] + s.scores[1],
  };
}

function computeStats(results: MatchResult[]): Stats {
  const n = results.length;
  const wins0 = results.filter(r => r.winner === 0).length;
  const allRallies = results.flatMap(r => r.rallyLengths).sort((a, b) => a - b);
  const avg = (arr: number[]) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const pct = (arr: number[], p: number) => arr.length ? arr[Math.floor((arr.length - 1) * p)] : 0;

  return {
    winRate0: wins0 / n,
    avgRallyHits: avg(allRallies),
    medianRallyHits: pct(allRallies, 0.5),
    p90RallyHits: pct(allRallies, 0.9),
    shortRallyPct: allRallies.filter(h => h <= 2).length / (allRallies.length || 1),
    longRallyPct: allRallies.filter(h => h >= 6).length / (allRallies.length || 1),
    avgMatchPoints: avg(results.map(r => r.pointCount)),
    avgGameLength: avg(results.map(r => r.totalFrames)),
    matchCount: n,
  };
}

// ---- Custom-param AI shim -------------------------------------------------

class AIInputCustom {
  private inner: AIInput;
  constructor(params: AIParams, side: 0 | 1, seed: number) {
    this.inner = new AIInput('medium', side, seed);
    (this.inner as unknown as { p: AIParams }).p = params;
  }
  sample(s: GameState) { return this.inner.sample(s); }
  reset() { this.inner.reset?.(); }
}

// ---- Current & candidate params -------------------------------------------

// Baseline reference (aggression=1.0 for all = old behavior).
const CURRENT_PARAMS: Record<Difficulty, AIParams> = {
  easy:   { reactionDelay: 10, predictionAccuracy: 0.50, speedFactor: 1.00, idleRate: 0.00, fumbleRate: 0.22, faultRate: 0.20, deadzone: 28, aggression: 1.00 },
  medium: { reactionDelay:  5, predictionAccuracy: 0.82, speedFactor: 1.00, idleRate: 0.00, fumbleRate: 0.09, faultRate: 0.08, deadzone: 18, aggression: 1.00 },
  hard:   { reactionDelay:  2, predictionAccuracy: 1.00, speedFactor: 1.00, idleRate: 0.00, fumbleRate: 0.02, faultRate: 0.02, deadzone: 10, aggression: 1.00 },
};

// Kept in sync with AIInput.ts PARAMS. aggression=1 for all (sim uses full tactics baseline).
// Targets: easy-easy 40-60%, med-med 40-60%, hard-hard 40-60%
//          easy-med 20-38%, easy-hard 8-25%, med-hard 28-42%
// Key: reaction delay is primary systematic differentiator; prediction error is secondary.
// Hard needs moderate fumble/fault so medium can win 28-42%.
const CANDIDATE_PARAMS: Record<Difficulty, AIParams> = {
  easy:   { reactionDelay: 28, predictionAccuracy: 0.32, speedFactor: 0.75, idleRate: 0.00, fumbleRate: 0.10, faultRate: 0.10, deadzone: 38, aggression: 1.00 },
  medium: { reactionDelay:  8, predictionAccuracy: 0.78, speedFactor: 0.92, idleRate: 0.00, fumbleRate: 0.05, faultRate: 0.04, deadzone: 22, aggression: 1.00 },
  hard:   { reactionDelay:  2, predictionAccuracy: 0.96, speedFactor: 1.00, idleRate: 0.00, fumbleRate: 0.09, faultRate: 0.08, deadzone: 12, aggression: 1.00 },
};

// ---- Helpers ---------------------------------------------------------------

function printStats(label: string, stats: Stats, targetWinRange?: [number, number]) {
  const pass = targetWinRange
    ? stats.winRate0 >= targetWinRange[0] && stats.winRate0 <= targetWinRange[1]
    : null;
  const marker = pass === null ? '' : pass ? ' ✓' : ' ✗';
  console.log(`\n  ${label}${marker}`);
  console.log(`    win0=${pc(stats.winRate0)}  rally avg=${stats.avgRallyHits.toFixed(1)} med=${stats.medianRallyHits} p90=${stats.p90RallyHits}`);
  console.log(`    short≤2=${pc(stats.shortRallyPct)}  long≥6=${pc(stats.longRallyPct)}  pts/match=${stats.avgMatchPoints.toFixed(1)}  frames=${stats.avgGameLength.toFixed(0)}`);
  if (targetWinRange) {
    console.log(`    target win0: ${pc(targetWinRange[0])}–${pc(targetWinRange[1])}`);
  }
}

function pc(v: number) { return (v * 100).toFixed(1) + '%'; }

function runPairs(
  params: Record<Difficulty, AIParams | Difficulty>,
  n: number,
  label: string,
) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${label} (${n} matches each)`);
  console.log('─'.repeat(60));

  const pairs: Array<[Difficulty, Difficulty, string, [number, number]]> = [
    ['easy',   'easy',   'easy   vs easy  ',  [0.40, 0.60]],
    ['medium', 'medium', 'medium vs medium',  [0.40, 0.60]],
    ['hard',   'hard',   'hard   vs hard  ',  [0.40, 0.60]],
    ['easy',   'medium', 'easy   vs medium',  [0.20, 0.38]],
    ['easy',   'hard',   'easy   vs hard  ',  [0.08, 0.25]],
    ['medium', 'hard',   'medium vs hard  ',  [0.28, 0.42]],
  ];

  let totalScore = 0;
  let passCount = 0;
  for (const [d0, d1, lbl, range] of pairs) {
    const p0 = params[d0];
    const p1 = params[d1];
    const results: MatchResult[] = [];
    for (let i = 0; i < n; i++) {
      results.push(runMatch(
        typeof p0 === 'string' ? p0 : p0,
        typeof p1 === 'string' ? p1 : p1,
        0x2545f491 + i * 0x31337,
        0x6c62272e + i * 0x1337,
      ));
    }
    const stats = computeStats(results);
    printStats(lbl, stats, range);
    const pass = stats.winRate0 >= range[0] && stats.winRate0 <= range[1];
    if (pass) passCount++;
    // Score: win-rate proximity + rally health
    const midWin = (range[0] + range[1]) / 2;
    totalScore += Math.max(0, 1 - Math.abs(stats.winRate0 - midWin) * 8);
    totalScore += stats.avgRallyHits > 2 ? 1 : 0;
    totalScore -= stats.shortRallyPct > 0.6 ? 1 : 0;
  }
  console.log(`\n  Pairs passing win-rate target: ${passCount}/6  total score: ${totalScore.toFixed(1)}`);
  return totalScore;
}

// ---- Modes ----------------------------------------------------------------

function modeReport(n: number) {
  console.log('\n══ REPORT: current params ══');
  runPairs(CURRENT_PARAMS, n, 'Current params');
  console.log('\n══ REPORT: candidate params (from grid-search) ══');
  runPairs(CANDIDATE_PARAMS, n, 'Candidate params');
}

function modeMirror(n: number) {
  console.log('\n══ MIRROR: fairness check ══');
  for (const d of ['easy', 'medium', 'hard'] as Difficulty[]) {
    const results: MatchResult[] = [];
    for (let i = 0; i < n; i++) {
      results.push(runMatch(d, d, 0x2545f491 + i * 0x31337, 0x6c62272e + i * 0x1337));
    }
    printStats(`${d} vs ${d}`, computeStats(results), [0.40, 0.60]);
  }
}

function modeTune(n: number) {
  console.log('\n══ TUNE: cross-validated grid search ══');
  console.log('Evaluating ALL difficulty pairs for each candidate combo...\n');

  // Tune easy and hard; medium stays fixed at CANDIDATE_PARAMS.medium.
  const easyGrid = {
    reactionDelay:      [12, 16, 20],
    predictionAccuracy: [0.30, 0.40, 0.50],
    speedFactor:        [0.60, 0.70, 0.80],
    idleRate:           [0.20, 0.28, 0.36],
    fumbleRate:         [0.14, 0.18, 0.22],
    faultRate:          [0.14, 0.18, 0.22],
    deadzone:           [28, 34, 40],
  };
  const hardGrid = {
    reactionDelay:      [1, 2, 3],
    predictionAccuracy: [0.90, 0.95, 1.00],
    speedFactor:        [0.95, 1.00],
    idleRate:           [0.00, 0.02],
    fumbleRate:         [0.00, 0.01, 0.02],
    faultRate:          [0.00, 0.01, 0.02],
    deadzone:           [10, 12, 14],
  };

  // Use medium as-is from candidate (it self-tested well)
  const mediumFixed = CANDIDATE_PARAMS.medium;

  function evalCombo(easy: AIParams, hard: AIParams): number {
    const pairs: Array<[AIParams | Difficulty, AIParams | Difficulty, [number, number]]> = [
      [easy,   easy,        [0.40, 0.60]],
      [mediumFixed, mediumFixed, [0.40, 0.60]],
      [hard,   hard,        [0.40, 0.60]],
      [easy,   mediumFixed, [0.20, 0.38]],
      [easy,   hard,        [0.08, 0.25]],
      [mediumFixed, hard,   [0.28, 0.42]],
    ];
    let score = 0;
    for (const [p0, p1, range] of pairs) {
      const results: MatchResult[] = [];
      for (let i = 0; i < n; i++) {
        results.push(runMatch(p0, p1, 0x2545f491 + i * 0x31337, 0x6c62272e + i * 0x1337));
      }
      const st = computeStats(results);
      const mid = (range[0] + range[1]) / 2;
      score += Math.max(0, 1 - Math.abs(st.winRate0 - mid) * 8);
      score += st.avgRallyHits > 2 ? 0.5 : 0;
      score -= st.shortRallyPct > 0.6 ? 1 : 0;
      score += st.longRallyPct > 0.15 ? 0.3 : 0;
    }
    return score;
  }

  let bestScore = -Infinity;
  let bestEasy = CURRENT_PARAMS.easy;
  let bestHard = CURRENT_PARAMS.hard;
  let combos = 0;

  const easyKeys = Object.keys(easyGrid) as (keyof typeof easyGrid)[];
  const hardKeys = Object.keys(hardGrid) as (keyof typeof hardGrid)[];

  function recurseEasy(idx: number, cur: Partial<AIParams>) {
    if (idx === easyKeys.length) {
      recurseHard(0, {}, cur as AIParams);
      return;
    }
    for (const v of easyGrid[easyKeys[idx]]) {
      recurseEasy(idx + 1, { ...cur, [easyKeys[idx]]: v });
    }
  }

  function recurseHard(idx: number, cur: Partial<AIParams>, easy: AIParams) {
    if (idx === hardKeys.length) {
      const hard = cur as AIParams;
      combos++;
      const score = evalCombo(easy, hard);
      if (score > bestScore) {
        bestScore = score;
        bestEasy = { ...easy };
        bestHard = { ...hard };
        console.log(`  combo ${combos}: score=${score.toFixed(2)}`);
        console.log(`    easy: ${JSON.stringify(easy)}`);
        console.log(`    hard: ${JSON.stringify(hard)}`);
      }
      return;
    }
    for (const v of hardGrid[hardKeys[idx]]) {
      recurseHard(idx + 1, { ...cur, [hardKeys[idx]]: v }, easy);
    }
  }

  recurseEasy(0, {});

  console.log(`\n════ FINAL BEST (${combos} combos) score=${bestScore.toFixed(2)} ════`);
  console.log(`easy:   ${JSON.stringify(bestEasy)}`);
  console.log(`medium: ${JSON.stringify(mediumFixed)}`);
  console.log(`hard:   ${JSON.stringify(bestHard)}`);

  // Verify final params
  console.log('\n── Verification run ──');
  runPairs({ easy: bestEasy, medium: mediumFixed, hard: bestHard }, n * 3, 'Best params x3');
}

// ---- Entry ----------------------------------------------------------------

const args = process.argv.slice(2);
const matchCount = parseInt(args[0] ?? '300', 10);
const mode = args[1] ?? 'report';

console.log(`Pixel Squash AI Sim  mode=${mode}  matches/cell=${matchCount}`);
console.log(`${new Date().toISOString()}`);

if (mode === 'report')       modeReport(matchCount);
else if (mode === 'mirror')  modeMirror(matchCount);
else if (mode === 'tune')    modeTune(matchCount);
else { console.error(`Unknown mode: ${mode}`); process.exit(1); }

console.log(`\n${new Date().toISOString()}  done`);
