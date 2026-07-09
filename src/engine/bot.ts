/**
 * v2 AI 機器人:世界模型 = 引擎本體 predictLanding(零第二份物理)。
 * 技術旋鈕(reaction / aimNoise / moveSpeed / weights)同時服務:
 * 難度分級(市場功能)與 L4 技術梯度、公平性測試(測試基建)。
 * 決定性:噪音只來自帶種子 prng。
 */

import type { BallState, Vec3 } from './ball';
import { COURT_W, predictLanding } from './ball';
import type { Prng } from './prng';
import type { ShotKind } from './shot';
import { solveShot } from './shot';

export interface BotSkill {
  /** 對手擊球後幾 tick 才開始移動/反應 */
  readonly reactionTicks: number;
  /** 目標點均勻噪音半徑(m),越大越不準 */
  readonly aimNoise: number;
  /** 揮拍執行誤差:解出的速度向量再加 ±execNoise·|v| 的均勻擾動 → 失誤的真實來源 */
  readonly execNoise: number;
  /** 移動速度(m/s) */
  readonly moveSpeed: number;
  /** 選球權重(不含 serve) */
  readonly weights: Readonly<Partial<Record<ShotKind, number>>>;
  /** 站位偏好:非回擊時回防的點(省略 = T 點)。前場型/龜後場型個性由此而來 */
  readonly home?: Vec3;
  /** 風險傾向:橫向目標離牆邊距倍率。<1 貼牆更兇(易出界)、>1 留安全邊(好接),省略 = 1 */
  readonly aimTight?: number;
  /**
   * 戰術意識(下棋感核心):讀對手站位往空檔打的傾向 0..1。
   * 0 = 盲打(只靠權重與固定直/對角),1 = 強力把球往對手遠側空檔送(調虎離山)。
   * 高手高、菜鳥近 0,同時強化天梯技術梯度。省略 = 0。
   */
  readonly tactical?: number;
}

export const BOT_STRONG: BotSkill = {
  reactionTicks: 4,
  aimNoise: 0.25,
  execNoise: 0.02,
  moveSpeed: 5.2,
  weights: { drive: 4, kill: 2, drop: 1.5, lob: 1.5, boast: 1 },
  tactical: 0.85, // 高手讀站位,狠打空檔
};

export const BOT_MEDIUM: BotSkill = {
  reactionTicks: 12,
  aimNoise: 0.55,
  execNoise: 0.045,
  moveSpeed: 3.4,
  weights: { drive: 2.5, kill: 2, drop: 1.5, lob: 1.5, boast: 1.2 },
  tactical: 0.45, // 中手偶爾看空檔
};

export const BOT_WEAK: BotSkill = {
  reactionTicks: 16,
  aimNoise: 1.0,
  execNoise: 0.09,
  moveSpeed: 3.2,
  weights: { drive: 5, kill: 0.5, drop: 0.5, lob: 1.5, boast: 0.5 },
  // tactical 省略(0):菜鳥盲打,球送到哪算哪
};

/** 球員可回擊的水平半徑與最高觸球高度 */
export const REACH_RADIUS = 1.15; // m
export const REACH_HEIGHT = 2.5; // m

/** 帶噪音挑選球路(權重輪盤,prng 決定) */
export function pickShot(skill: BotSkill, prng: Prng): ShotKind {
  const entries = Object.entries(skill.weights) as [ShotKind, number][];
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = prng.next() * total;
  for (const [kind, w] of entries) {
    r -= w;
    if (r <= 0) return kind;
  }
  return 'drive';
}

/** 對手擊球後,bot 該跑去哪:預測落點(截彎取直,不逐 tick 追) */
export function interceptPoint(ball: BallState): Vec3 | null {
  const landing = predictLanding(ball);
  return landing === null ? null : landing.point;
}

export interface BotShot {
  readonly kind: ShotKind;
  readonly velocity: Vec3;
}

/**
 * 從 ballPos 出手:挑球路 → 解仰角;無解逐級 fallback(drive → lob),
 * 全部無解回 null(讓 sim 做最後的 shovel 救球)。
 * targetX 加均勻噪音(aimNoise 半徑)。
 *
 * opponentX(下棋感):對手當前橫向位置。有值且 skill.tactical>0 時,落點往
 * 「對手遠側空檔」偏移(調虎離山),偏移量 = tactical × 對手偏離中線的程度。
 * 省略時退回純球路傾向(舊行為 + 決定性不變:不多抽 prng)。
 */
export function decideShot(
  skill: BotSkill,
  ballPos: Vec3,
  prng: Prng,
  opponentX?: number,
): BotShot | null {
  const kinds: ShotKind[] = [];
  kinds.push(pickShot(skill, prng));
  if (!kinds.includes('drive')) kinds.push('drive');
  if (!kinds.includes('lob')) kinds.push('lob');
  const tight = skill.aimTight === undefined ? 1 : skill.aimTight;
  const tactical = skill.tactical === undefined ? 0 : skill.tactical;
  // 空檔偏移:對手偏離中線多遠,就把球往反側推多少(受 tactical 縮放)。
  // 對手在右半(openX>0)→ 往左打(offset<0);限幅避免蓋掉球路直/對角個性。
  let openOffset = 0;
  if (opponentX !== undefined && tactical > 0) {
    const openFromCenter = COURT_W / 2 - opponentX; // 對手離中線的反向量(對手右 → 正,要往左送)
    openOffset = openFromCenter * tactical * 0.7; // 0.7:留餘裕,不打成純鏡射對手
  }
  for (const kind of kinds) {
    // 落點橫向目標:drive/kill 打直線(靠擊球側),drop/boast 打對角,lob 打開
    // 邊距 × aimTight:風險傾向低於 1 會更貼牆
    const base =
      kind === 'drive' || kind === 'kill'
        ? ballPos.x < COURT_W / 2
          ? 1.3 * tight
          : COURT_W - 1.3 * tight
        : ballPos.x < COURT_W / 2
          ? COURT_W - 1.6 * tight
          : 1.6 * tight;
    // kill/drop 是收尾球,空檔加成加倍狠;lob 是過渡球,不太吃空檔
    const openW = kind === 'kill' || kind === 'drop' ? 1.3 : kind === 'lob' ? 0.4 : 1.0;
    const aimed = base + openOffset * openW;
    const noisyX = aimed + (prng.next() * 2 - 1) * skill.aimNoise;
    const targetX = noisyX < 0.3 ? 0.3 : noisyX > COURT_W - 0.3 ? COURT_W - 0.3 : noisyX;
    const v = solveShot(ballPos, targetX, kind);
    if (v !== null) return { kind, velocity: applyExecNoise(v, skill, prng) };
  }
  return null;
}

/** 揮拍執行誤差:每個分量加 ±execNoise·|v| 均勻擾動(帶種子 → 決定性) */
export function applyExecNoise(v: Vec3, skill: BotSkill, prng: Prng): Vec3 {
  const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const e = skill.execNoise * s;
  return {
    x: v.x + (prng.next() * 2 - 1) * e,
    y: v.y + (prng.next() * 2 - 1) * e,
    z: v.z + (prng.next() * 2 - 1) * e,
  };
}
