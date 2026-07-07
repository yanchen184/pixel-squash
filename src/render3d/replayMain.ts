/**
 * P3 重播檢視器入口(/replay.html)。
 *
 * 決定性重播 = 種子 + bot 等級就是完整重播檔:同 URL 重載,逐 tick bit 相同
 * (HUD 顯示鏈式 hash,肉眼可對)。L5 管線:Playwright 開這頁錄影 → 精華影片。
 *
 * URL 參數:?seed=42&a=medium&b=medium&rallies=6&speed=1&autoplay=1
 */
import { hashBall, hashNumbers } from '../engine/replay';
import { BOT_MEDIUM, BOT_STRONG, BOT_WEAK, type BotSkill } from '../engine/bot';
import { createPrng } from '../engine/prng';
import { createGame, IDLE_INPUT, stepGame, type Controller } from '../engine/sim';
import { Render3D, type RenderState } from './render3d';

interface Frame {
  readonly state: RenderState;
  readonly scoreA: number;
  readonly scoreB: number;
  /** 這 tick 發生的事(得分/擊球註記),沒有為 null */
  readonly note: string | null;
}

const SKILLS: Record<string, BotSkill> = {
  strong: BOT_STRONG,
  medium: BOT_MEDIUM,
  weak: BOT_WEAK,
};

const REASON_LABEL: Record<string, string> = {
  tin: '打中 tin',
  out: '出界',
  'not-front-wall': '沒到前牆',
  'double-bounce': '兩彈未接',
  'serve-fault-front': '發球失誤',
  'serve-fault-box': '發球落點失誤',
};

interface ReplayData {
  readonly frames: readonly Frame[];
  readonly finalHash: number;
}

/** 預模擬:跑 bot 對打,錄每 tick 的渲染切面 + 鏈式 hash */
function simulate(seed: number, skillA: BotSkill, skillB: BotSkill, ralliesTarget: number): ReplayData {
  const prng = createPrng(seed);
  const controllers: { A: Controller; B: Controller } = {
    A: { type: 'bot', skill: skillA },
    B: { type: 'bot', skill: skillB },
  };
  const inputs = { A: IDLE_INPUT, B: IDLE_INPUT };
  let sim = createGame('A');
  const frames: Frame[] = [];
  let hash = 0x811c9dc5;
  let rallies = 0;
  const MAX_TICKS = 60 * 60 * 5; // 5 分鐘保險絲

  for (let t = 0; t < MAX_TICKS && rallies < ralliesTarget; t++) {
    const out = stepGame(sim, controllers, inputs, prng);
    sim = out.sim;
    if (sim.ball !== null) hash = hashBall(sim.ball, hash);
    hash = hashNumbers([sim.playerA.pos.x, sim.playerA.pos.y, sim.playerB.pos.x, sim.playerB.pos.y], hash);
    let note: string | null = null;
    for (const ev of out.events) {
      if (ev.type === 'rally-end') {
        rallies += 1;
        note = `${ev.winner} 得分(${REASON_LABEL[ev.reason] ?? ev.reason})`;
      } else if (ev.type === 'match-end') {
        note = `比賽結束:${ev.winner} 勝`;
        rallies = ralliesTarget;
      }
    }
    frames.push({
      state: {
        ball: sim.ball === null ? null : { ...sim.ball.pos },
        playerA: sim.playerA.pos,
        playerB: sim.playerB.pos,
      },
      scoreA: sim.match.scoreA,
      scoreB: sim.match.scoreB,
      note,
    });
    if (sim.match.phase === 'match-over') break;
  }
  return { frames, finalHash: hash >>> 0 };
}

// ---------- DOM / 播放 ----------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? '20260707') >>> 0;
  const skillA = SKILLS[params.get('a') ?? 'medium'] ?? BOT_MEDIUM;
  const skillB = SKILLS[params.get('b') ?? 'medium'] ?? BOT_MEDIUM;
  const rallies = Math.max(1, Number(params.get('rallies') ?? '6') | 0);
  let speed = Number(params.get('speed') ?? '1') || 1;
  let playing = params.get('autoplay') === '1';

  const data = simulate(seed, skillA, skillB, rallies);
  const total = data.frames.length;

  const canvas = el<HTMLCanvasElement>('view');
  const view = new Render3D(canvas);
  const fit = (): void => view.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', fit);
  fit();

  const scoreEl = el<HTMLDivElement>('score');
  const noteEl = el<HTMLDivElement>('note');
  const metaEl = el<HTMLDivElement>('meta');
  const playBtn = el<HTMLButtonElement>('play');
  const speedSel = el<HTMLSelectElement>('speedSel');
  const seek = el<HTMLInputElement>('seek');
  seek.max = String(total - 1);
  speedSel.value = String(speed);
  metaEl.textContent = `seed ${seed} · ${total} ticks · hash ${data.finalHash.toString(16).padStart(8, '0')}`;

  let head = 0; // 播放頭(浮點 tick)
  let lastNote = '';
  let noteAge = 0;

  function show(tickIdx: number): void {
    const f = data.frames[tickIdx];
    view.sync(f.state);
    view.render();
    scoreEl.textContent = `${f.scoreA} : ${f.scoreB}`;
    if (f.note !== null) {
      lastNote = f.note;
      noteAge = 0;
    }
    noteEl.textContent = noteAge < 150 ? lastNote : '';
    seek.value = String(tickIdx);
  }

  playBtn.addEventListener('click', () => {
    playing = !playing;
    if (playing && head >= total - 1) head = 0;
    playBtn.textContent = playing ? '⏸' : '▶';
  });
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value) || 1;
  });
  seek.addEventListener('input', () => {
    head = Number(seek.value) || 0;
    playing = false;
    playBtn.textContent = '▶';
    show(Math.floor(head));
  });
  playBtn.textContent = playing ? '⏸' : '▶';

  function loop(): void {
    if (playing) {
      head += speed;
      noteAge += speed;
      if (head >= total - 1) {
        head = total - 1;
        playing = false;
        playBtn.textContent = '▶';
      }
    }
    show(Math.floor(head));
    requestAnimationFrame(loop);
  }
  show(0);
  requestAnimationFrame(loop);

  // e2e / L5 管線探針
  (window as unknown as Record<string, unknown>).__replay = {
    ready: true,
    seed,
    totalTicks: total,
    finalHash: data.finalHash,
  };
  (window as unknown as Record<string, unknown>).__replayTickNow = (): number => Math.floor(head);
}

main();
