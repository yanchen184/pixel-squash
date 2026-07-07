/**
 * P5 正式遊戲入口(/):你(A,藍)對 AI(B,橘),PAR-11。
 * 固定 60Hz 步進 stepGame(與 L1-L5 測的完全同一條路徑),渲染層 rAF 插播。
 * 這層在渲染側,允許 Date/Math.random(引擎決定性 lint 只管 src/engine/)。
 */
import { DT } from '../engine/ball';
import { BOT_MEDIUM, BOT_STRONG, BOT_WEAK, type BotSkill } from '../engine/bot';
import { createPrng } from '../engine/prng';
import {
  createGame,
  IDLE_INPUT,
  stepGame,
  type Controller,
  type GameSim,
} from '../engine/sim';
import { REASON_LABEL } from '../render3d/labels';
import { Render3D } from '../render3d/render3d';
import { HumanInput } from './input';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>('view');
const scoreEl = el<HTMLDivElement>('score');
const noteEl = el<HTMLDivElement>('note');
const serveHintEl = el<HTMLDivElement>('serveHint');
const menuEl = el<HTMLDivElement>('menu');
const endTitleEl = el<HTMLDivElement>('endTitle');
const shotsEl = el<HTMLDivElement>('shots');

const view = new Render3D(canvas);
const fit = (): void => view.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', fit);
fit();

const input = new HumanInput(canvas);
if (navigator.maxTouchPoints > 0) shotsEl.hidden = false;
el<HTMLButtonElement>('btnDrive').addEventListener('pointerdown', () => input.pressShot('drive'));
el<HTMLButtonElement>('btnLob').addEventListener('pointerdown', () => input.pressShot('lob'));
el<HTMLButtonElement>('btnDrop').addEventListener('pointerdown', () => input.pressShot('drop'));
el<HTMLButtonElement>('btnKill').addEventListener('pointerdown', () => input.pressShot('kill'));

let sim: GameSim | null = null;
let controllers: { readonly A: Controller; readonly B: Controller } | null = null;
let prng = createPrng(1);
let noteUntil = 0; // 事件標語顯示到的時刻(秒)
let acc = 0;
let lastTime: number | null = null;

function start(skill: BotSkill): void {
  prng = createPrng(Date.now() >>> 0);
  controllers = { A: { type: 'external' }, B: { type: 'bot', skill } };
  sim = createGame('A');
  acc = 0;
  lastTime = null;
  noteEl.textContent = '';
  scoreEl.textContent = '0 : 0';
  menuEl.style.display = 'none';
  endTitleEl.style.display = 'none';
  for (const b of ['btnWeak', 'btnMedium', 'btnStrong']) {
    el<HTMLButtonElement>(b).textContent = el<HTMLButtonElement>(b).textContent!.replace(/^再來一場:/, '');
  }
}

el<HTMLButtonElement>('btnWeak').addEventListener('click', () => start(BOT_WEAK));
el<HTMLButtonElement>('btnMedium').addEventListener('click', () => start(BOT_MEDIUM));
el<HTMLButtonElement>('btnStrong').addEventListener('click', () => start(BOT_STRONG));

function onMatchEnd(winner: 'A' | 'B', s: GameSim): void {
  const title =
    winner === 'A'
      ? `🏆 你贏了 ${s.match.scoreA} : ${s.match.scoreB}`
      : `AI 獲勝 ${s.match.scoreA} : ${s.match.scoreB} — 再接再厲`;
  endTitleEl.textContent = title;
  endTitleEl.style.display = 'block';
  for (const b of ['btnWeak', 'btnMedium', 'btnStrong']) {
    const btn = el<HTMLButtonElement>(b);
    if (!btn.textContent!.startsWith('再來一場:')) btn.textContent = `再來一場:${btn.textContent}`;
  }
  menuEl.style.display = 'flex';
}

function stepOnce(): void {
  if (sim === null || controllers === null) return;
  const out = stepGame(sim, controllers, { A: input.next(), B: IDLE_INPUT }, prng);
  sim = out.sim;
  let hitBy: 'A' | 'B' | null = null;
  for (const ev of out.events) {
    if (ev.type === 'hit') {
      hitBy = ev.player;
      if (ev.player === 'A') input.onHit();
    } else if (ev.type === 'rally-end') {
      const who = ev.winner === 'A' ? '你' : 'AI';
      noteEl.textContent = `${who}得分(${REASON_LABEL[ev.reason]})`;
      noteUntil = performance.now() / 1000 + 2.5;
    } else {
      onMatchEnd(ev.winner, sim);
    }
  }
  view.sync({
    ball: sim.ball === null ? null : sim.ball.pos,
    playerA: sim.playerA.pos,
    playerB: sim.playerB.pos,
    hitBy,
  });
}

function updateHud(): void {
  if (sim === null) return;
  const m = sim.match;
  const dotA = m.server === 'A' ? '●' : '';
  const dotB = m.server === 'B' ? '●' : '';
  scoreEl.textContent = `你 ${dotA}${m.scoreA} : ${m.scoreB}${dotB} AI`;
  if (performance.now() / 1000 > noteUntil) noteEl.textContent = '';
  if (m.phase === 'awaiting-serve' && m.server === 'A' && m.matchWinner === null) {
    serveHintEl.textContent =
      sim.serveCountdown <= 0 ? '輪到你發球:按 空白鍵(或擊球鈕)' : '準備發球…';
  } else {
    serveHintEl.textContent = '';
  }
}

function loop(): void {
  const now = performance.now() / 1000;
  if (lastTime === null) lastTime = now;
  acc += Math.min(now - lastTime, 0.25); // 切分頁回來不補跑一大串
  lastTime = now;
  let steps = 0;
  while (acc >= DT && steps < 6) {
    stepOnce();
    acc -= DT;
    steps += 1;
  }
  updateHud();
  view.render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// e2e 探針
(window as unknown as Record<string, unknown>).__gameState = (): unknown => {
  if (sim === null) return { started: false };
  return {
    started: true,
    scoreA: sim.match.scoreA,
    scoreB: sim.match.scoreB,
    phase: sim.match.phase,
    server: sim.match.server,
    tick: sim.tick,
    posA: sim.playerA.pos,
  };
};
