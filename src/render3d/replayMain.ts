/**
 * P3 重播檢視器入口(/replay.html)。
 *
 * 決定性重播 = 種子 + bot 等級就是完整重播檔:同 URL 重載,逐 tick bit 相同
 * (HUD 顯示鏈式 hash,肉眼可對)。L5 管線:Playwright 開這頁錄影 → 精華影片。
 * 錄製本體在 src/engine/selfplayReplay.ts(與黃金重播 blessing 測試共用)。
 *
 * URL 參數:?seed=42&a=medium&b=medium&rallies=6&speed=1&autoplay=1
 */
import { BOT_MEDIUM, BOT_STRONG, BOT_WEAK, type BotSkill } from '../engine/bot';
import { recordSelfplay, type ReplayFrame } from '../engine/selfplayReplay';
import { Render3D } from './render3d';

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

function noteOf(f: ReplayFrame): string | null {
  if (f.matchWinner !== null) return `比賽結束:${f.matchWinner} 勝`;
  if (f.rallyEnd !== null) {
    return `${f.rallyEnd.winner} 得分(${REASON_LABEL[f.rallyEnd.reason] ?? f.rallyEnd.reason})`;
  }
  return null;
}

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

  const data = recordSelfplay(seed, skillA, skillB, rallies);
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
  let shownTick = -1;
  let lastNote = '';
  let noteAge = 0;

  function show(tickIdx: number): void {
    const f = data.frames[tickIdx];
    // 揮拍事件逐 tick 觸發:跳幀時掃過中間 tick,不漏動畫
    if (tickIdx > shownTick && tickIdx - shownTick <= 8) {
      for (let t = shownTick + 1; t <= tickIdx; t++) {
        const g = data.frames[t];
        if (g.hitBy !== null) view.sync({ ...g, hitBy: g.hitBy });
      }
    }
    shownTick = tickIdx;
    view.sync({ ball: f.ball, playerA: f.playerA, playerB: f.playerB, hitBy: null });
    view.render();
    scoreEl.textContent = `${f.scoreA} : ${f.scoreB}`;
    const note = noteOf(f);
    if (note !== null) {
      lastNote = note;
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
