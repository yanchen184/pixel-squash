/**
 * v2 飛行層:SI 單位(公尺、秒、m/s)、固定 60Hz、半隱式 Euler。
 *
 * 決定性契約(L1 測試強制):
 * - 本檔只准 + − × ÷ Math.sqrt / Math.imul(IEEE-754 跨引擎 byte 相同);
 *   禁 Math.sin/cos/tan/hypot/pow/exp/log/random、Date —— 由 determinism-lint 測試機械化把關。
 * - 狀態不可變:step 回傳新物件。
 *
 * 座標契約(沿用 PLAN.md §2):x ∈ [0,COURT_W] 左→右牆、y ∈ [0,COURT_D] 前牆(0)→後牆、
 * z ∈ [0,COURT_H] 離地高度。牆是純物理平面;tin/out line 是規則層的事,這裡只發事件。
 */

export const G = 9.81; // m/s²
export const AIR_DRAG = 0.15; // 1/s,線性空氣阻力
export const E_WALL = 0.78; // 牆面法向恢復係數
export const E_FLOOR = 0.6; // 地板法向恢復係數
export const FLOOR_GRIP = 0.8; // 地板彈跳時切向速度保留比
export const MAX_HIT_SPEED = 50; // m/s,任何擊球出手速度上限
export const DT = 1 / 60; // s

export const COURT_W = 6.4; // m,單打球場寬
export const COURT_D = 9.75; // m,球場縱深
export const COURT_H = 5.64; // m,物理天花板

// 滾動減速度:滾動摩擦係數 μ≈0.1(橡膠球對木地板)× g,現實推導、不是第 7 顆旋鈕
const ROLL_DECEL = 0.1 * G; // ≈0.98 m/s²
const REST_SPEED = 0.05; // m/s,低於此速即靜止
const BOUNCE_MIN = 0.75; // m/s,落地垂直速低於此改為滾動
const MAX_CONTACTS_PER_TICK = 8; // 角落連續碰撞保險

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type WallId = 'front' | 'back' | 'left' | 'right' | 'ceiling';

export interface BallState {
  readonly pos: Vec3;
  readonly vel: Vec3;
  /** 已貼地滾動(z=0、vz=0),只剩水平減速 */
  readonly rolling: boolean;
  /** 完全靜止,step 為 no-op */
  readonly resting: boolean;
}

export type BallEvent =
  | { readonly type: 'wall-hit'; readonly wall: WallId; readonly point: Vec3; readonly speed: number }
  | { readonly type: 'floor-bounce'; readonly point: Vec3; readonly speed: number }
  | { readonly type: 'rest'; readonly point: Vec3 };

export interface StepResult {
  readonly ball: BallState;
  readonly events: readonly BallEvent[];
}

export function createBall(pos: Vec3, vel: Vec3): BallState {
  return { pos, vel, rolling: false, resting: false };
}

function speedOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** 出手速度夾限:任何擊球產生的初速都必須經過這裡 */
export function clampHitVelocity(v: Vec3): Vec3 {
  const s = speedOf(v);
  if (s <= MAX_HIT_SPEED) return v;
  const k = MAX_HIT_SPEED / s;
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

interface PlaneHit {
  frac: number; // 本段位移的碰撞比例 (0,1]
  wall: WallId | 'floor';
}

/**
 * 掃掠檢測:找本段位移最先穿越的平面。
 * from 保證在盒內(含邊界),to 是無碰撞情況下的終點。
 */
function earliestContact(from: Vec3, to: Vec3): PlaneHit | null {
  let best: PlaneHit | null = null;
  const consider = (frac: number, wall: WallId | 'floor'): void => {
    if (frac >= 0 && frac <= 1 && (best === null || frac < best.frac)) {
      best = { frac, wall };
    }
  };
  if (to.y < 0 && from.y > 0) consider(from.y / (from.y - to.y), 'front');
  if (to.y > COURT_D && from.y < COURT_D) consider((COURT_D - from.y) / (to.y - from.y), 'back');
  if (to.x < 0 && from.x > 0) consider(from.x / (from.x - to.x), 'left');
  if (to.x > COURT_W && from.x < COURT_W) consider((COURT_W - from.x) / (to.x - from.x), 'right');
  if (to.z > COURT_H && from.z < COURT_H) consider((COURT_H - from.z) / (to.z - from.z), 'ceiling');
  if (to.z < 0 && from.z > 0) consider(from.z / (from.z - to.z), 'floor');
  // 貼在邊界上仍朝外(from 正好在 0 且繼續向負):立即接觸
  if (best === null) {
    if (to.y < 0) consider(0, 'front');
    else if (to.y > COURT_D) consider(0, 'back');
    else if (to.x < 0) consider(0, 'left');
    else if (to.x > COURT_W) consider(0, 'right');
    else if (to.z > COURT_H) consider(0, 'ceiling');
    else if (to.z < 0) consider(0, 'floor');
  }
  return best;
}

function clampToCourt(p: Vec3): Vec3 {
  const cx = p.x < 0 ? 0 : p.x > COURT_W ? COURT_W : p.x;
  const cy = p.y < 0 ? 0 : p.y > COURT_D ? COURT_D : p.y;
  const cz = p.z < 0 ? 0 : p.z > COURT_H ? COURT_H : p.z;
  return cx === p.x && cy === p.y && cz === p.z ? p : { x: cx, y: cy, z: cz };
}

function stepRolling(ball: BallState, events: BallEvent[]): BallState {
  // 水平滾動:固定減速度,牆仍反彈
  const sp = Math.sqrt(ball.vel.x * ball.vel.x + ball.vel.y * ball.vel.y);
  if (sp <= REST_SPEED) {
    events.push({ type: 'rest', point: ball.pos });
    return { ...ball, vel: { x: 0, y: 0, z: 0 }, resting: true };
  }
  const newSp = sp - ROLL_DECEL * DT;
  const k = newSp > 0 ? newSp / sp : 0;
  let vel: Vec3 = { x: ball.vel.x * k, y: ball.vel.y * k, z: 0 };
  let pos: Vec3 = ball.pos;
  let remaining = 1; // 本 tick 尚未消化的位移比例
  for (let i = 0; i < MAX_CONTACTS_PER_TICK; i++) {
    const target: Vec3 = {
      x: pos.x + vel.x * DT * remaining,
      y: pos.y + vel.y * DT * remaining,
      z: 0,
    };
    const hit = earliestContact(pos, target);
    if (hit === null || hit.wall === 'floor' || hit.wall === 'ceiling') {
      pos = clampToCourt(target);
      break;
    }
    const contact: Vec3 = {
      x: pos.x + (target.x - pos.x) * hit.frac,
      y: pos.y + (target.y - pos.y) * hit.frac,
      z: 0,
    };
    events.push({ type: 'wall-hit', wall: hit.wall, point: contact, speed: speedOf(vel) });
    vel =
      hit.wall === 'front' || hit.wall === 'back'
        ? { x: vel.x, y: -vel.y * E_WALL, z: 0 }
        : { x: -vel.x * E_WALL, y: vel.y, z: 0 };
    pos = clampToCourt(contact);
    remaining *= 1 - hit.frac;
    if (remaining <= 0) break;
  }
  return { pos, vel, rolling: true, resting: false };
}

/**
 * 前進一個 tick(1/60s)。純函數:回傳新 state + 本 tick 事件。
 */
export function stepBall(ball: BallState): StepResult {
  if (ball.resting) return { ball, events: [] };
  const events: BallEvent[] = [];
  if (ball.rolling) return { ball: stepRolling(ball, events), events };

  // 半隱式 Euler:先更新速度(重力 + 線性阻力),再用新速度更新位置
  const drag = 1 - AIR_DRAG * DT;
  let vel: Vec3 = {
    x: ball.vel.x * drag,
    y: ball.vel.y * drag,
    z: (ball.vel.z - G * DT) * drag,
  };
  let pos: Vec3 = ball.pos;
  let rolling = false;
  let remaining = 1;

  for (let i = 0; i < MAX_CONTACTS_PER_TICK; i++) {
    const target: Vec3 = {
      x: pos.x + vel.x * DT * remaining,
      y: pos.y + vel.y * DT * remaining,
      z: pos.z + vel.z * DT * remaining,
    };
    const hit = earliestContact(pos, target);
    if (hit === null) {
      pos = clampToCourt(target);
      break;
    }
    const contact: Vec3 = clampToCourt({
      x: pos.x + (target.x - pos.x) * hit.frac,
      y: pos.y + (target.y - pos.y) * hit.frac,
      z: pos.z + (target.z - pos.z) * hit.frac,
    });
    const impactSpeed = speedOf(vel);
    if (hit.wall === 'floor') {
      events.push({ type: 'floor-bounce', point: contact, speed: impactSpeed });
      const vzUp = -vel.z; // 撞地時 vel.z < 0
      if (vzUp * E_FLOOR < BOUNCE_MIN) {
        // 彈不起來了 → 轉滾動,剩餘時間下 tick 消化
        pos = { x: contact.x, y: contact.y, z: 0 };
        vel = { x: vel.x * FLOOR_GRIP, y: vel.y * FLOOR_GRIP, z: 0 };
        rolling = true;
        break;
      }
      vel = { x: vel.x * FLOOR_GRIP, y: vel.y * FLOOR_GRIP, z: vzUp * E_FLOOR };
    } else {
      events.push({ type: 'wall-hit', wall: hit.wall, point: contact, speed: impactSpeed });
      if (hit.wall === 'front') vel = { x: vel.x, y: -vel.y * E_WALL, z: vel.z };
      else if (hit.wall === 'back') vel = { x: vel.x, y: -vel.y * E_WALL, z: vel.z };
      else if (hit.wall === 'ceiling') vel = { x: vel.x, y: vel.y, z: -vel.z * E_WALL };
      else if (hit.wall === 'left') vel = { x: -vel.x * E_WALL, y: vel.y, z: vel.z };
      else vel = { x: -vel.x * E_WALL, y: vel.y, z: vel.z };
    }
    pos = contact;
    remaining *= 1 - hit.frac;
    if (remaining <= 0) break;
  }

  return { ball: { pos, vel, rolling, resting: false }, events };
}

export interface Landing {
  readonly point: Vec3;
  readonly ticks: number;
  /** 落地前撞過的牆(規則層判 tin/out 用) */
  readonly wallsHit: readonly WallId[];
}

/**
 * 前瞻預測第一次落地。**與 stepBall 走同一條程式路徑**,零第二份物理 →
 * L1 斷言 predictLanding ≡ 實跑,bit 相同。bot 的世界模型也用這個。
 */
export function predictLanding(ball: BallState, maxTicks = 60 * 30): Landing | null {
  let cur = ball;
  const walls: WallId[] = [];
  for (let t = 1; t <= maxTicks; t++) {
    const { ball: next, events } = stepBall(cur);
    for (const ev of events) {
      if (ev.type === 'wall-hit') walls.push(ev.wall);
      if (ev.type === 'floor-bounce') return { point: ev.point, ticks: t, wallsHit: walls };
      if (ev.type === 'rest') return { point: ev.point, ticks: t, wallsHit: walls };
    }
    cur = next;
  }
  return null;
}
