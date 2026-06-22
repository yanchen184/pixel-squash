# 物理積分收斂實作計畫（Phase 1：殺「球不跟虛線」）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散在 5 處的球體物理積分收斂成唯一的 `stepShuttle()`，讓 preview 虛線、落點預測、live rally 用同一份物理 → 消除「球不跟虛線走」的分岔。

**Architecture:** 抽出一個純函數 `stepShuttle(s, opts)`，內部依序呼叫既有的 `stepBall` 積分 + `applyWalls` + `applyFloorBounce`（這三個已存在，只是沒被全部路徑共用）。`opts` 用參數表達 live/preview/predict 的差異（子步比例、地板摩擦）。然後把 `previewPhysicsStep`、`predictLanding`、`sampleServePath` 改成呼叫 `stepShuttle`，刪掉各自抄的物理。

**Tech Stack:** TypeScript、Vitest（純 Node 物理測試，不需瀏覽器）。設計文件：`docs/superpowers/specs/2026-06-22-physics-convergence-design.md`。

**關鍵不變式（CLAUDE.md 紅線，違反即失敗）：** `GRAVITY=0.42`、`SHUTTLE_PACE=1.8`、`SWING_REACH=100`、`FLOOR_BOUNCE=0.58`、`SHUTTLE_DRAG`、`FRONT_WALL_BOUNCE`、`WALL_BOUNCE` 數值全部不改。既有 92 測試（physics-audit / simulate / practice-* / serve-trajectory）必須維持全綠。

---

## File Structure

- `src/game/sim/simulate.ts` — 主戰場。新增 `stepShuttle()` + `StepOpts`，改寫 `previewPhysicsStep`/`predictLanding`/`sampleServePath` 內部改呼叫它。**這是唯一改 code 的檔。**
- `tests/trajectory-coherence.test.ts` — 新建。AC1 軌跡一致性測試（虛線 vs live 逐點 <1px）。
- 既有 `tests/*` — 不改，僅作為回歸守門（AC3）。

**為什麼不另開檔放 `stepShuttle`：** 它與既有 `stepBall`/`applyWalls`/`applyFloorBounce` 在同一檔、同一物理域，拆出去反而割裂。simulate.ts 雖大（1405 行），但物理函數群本就聚在 405–632 行區段，就地收斂最小驚訝。

---

## Task 1：抽出唯一的 `stepShuttle()`

**Files:**
- Modify: `src/game/sim/simulate.ts`（在 `applyFloorBounce` 之後、`previewPhysicsStep` 之前插入，約 545 行附近）
- Test: `tests/trajectory-coherence.test.ts`（建立）

- [ ] **Step 1: 寫會紅的軌跡一致性測試**

建立 `tests/trajectory-coherence.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { stepShuttle, sampleServePath, type StepOpts } from '@/game/sim/simulate';
import { FLOOR_FRICTION, type ShuttleState } from '@/data/gameState';

/**
 * AC1：虛線(sampleServePath) 與 live 逐 tick(stepShuttle) 必須用同一份物理。
 * 同一發球，把 sampleServePath 取 sampleEvery=1（逐 tick）的點，
 * 對照 stepShuttle 逐 tick 推進的位置，逐點誤差必須 < 1px。
 */
describe('AC1: dashed preview vs live trajectory coherence', () => {
  it('sampleServePath(every=1) matches stepShuttle tick-by-tick within 1px', () => {
    const start = { x: 300, y: 600 };
    const startZ = 80;
    const vel = { x: -2, y: -8 };
    const vz = 7;

    // 虛線：逐 tick 取樣（sampleEvery=1），用 live 的地板摩擦
    const dashed = sampleServePath(start, startZ, vel, vz, 1, FLOOR_FRICTION);

    // live：用 stepShuttle 逐 tick 推進同一發球
    let s: ShuttleState = {
      pos: { ...start }, z: startZ, vel: { ...vel }, vz,
      inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
      hitFrontWall: false, lastWall: null, deadReason: null,
      landing: null, landingEta: 0,
    };
    const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };

    // dashed[0] 是起點；逐 tick 比對到第一個地板事件前
    let maxErr = 0;
    for (let i = 1; i < Math.min(dashed.length, 60); i++) {
      s = stepShuttle(s, opts);
      const d = dashed[i];
      if (d.wall === 'tin' || d.wall === 'out' || d.wall === 'floor') break;
      const err = Math.hypot(s.pos.x - d.x, s.pos.y - d.y);
      maxErr = Math.max(maxErr, err);
    }
    expect(maxErr).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: 跑測試確認它紅**

Run: `npx vitest run tests/trajectory-coherence.test.ts`
Expected: FAIL — `stepShuttle` 與 `StepOpts` 尚未 export（import error），或斷言 maxErr ≥ 1。

- [ ] **Step 3: 實作 `stepShuttle` + `StepOpts`**

在 `src/game/sim/simulate.ts` 的 `applyFloorBounce` 函數結束後（約 544 行之後）插入。**注意：** 既有 `stepBall`(409)、`applyWalls`(430)、`applyFloorBounce`(515) 直接重用，不複製其邏輯。

```typescript
/**
 * 唯一的球體前進一步。所有路徑（live rally / M-preview / 落點預測 / 虛線取樣）都呼叫它，
 * 不准有第二份積分。dt<1 = 慢動作子步（位移與重力增量按 dt 縮放，阻力用 SHUTTLE_DRAG^dt
 * 確保 1/dt 個子步乘回來剛好等於每 tick 的 SHUTTLE_DRAG）。
 */
export interface StepOpts {
  dt: number;            // 子步比例：live=1，slowmo preview=PRACTICE_PREVIEW_SLOWMO
  floorFriction: number; // live=FLOOR_FRICTION，practice=PRACTICE_FLOOR_FRICTION
}

export function stepShuttle(s: ShuttleState, opts: StepOpts): ShuttleState {
  if (!s.inPlay) return s;
  const { dt, floorFriction } = opts;
  // 1) 積分（dt 縮放位移與重力；阻力按 dt 開根確保 per-tick 一致）
  const vz = s.vz - GRAVITY * dt;
  const subDrag = dt === 1 ? SHUTTLE_DRAG : Math.pow(SHUTTLE_DRAG, dt);
  const moved: ShuttleState = {
    ...s,
    pos: { x: s.pos.x + s.vel.x * dt, y: s.pos.y + s.vel.y * dt },
    vel: { x: s.vel.x * subDrag, y: s.vel.y * subDrag },
    z: s.z + vz * dt,
    vz,
    deadReason: null,
  };
  // 2) 牆反彈（重用既有函數，prev = 進入本 tick 前的狀態）
  const walled = applyWalls(moved, s);
  // 3) 地板反彈（重用既有函數）
  return applyFloorBounce(walled, s, floorFriction);
}
```

> **為什麼 dt=1 時 subDrag 直接取 SHUTTLE_DRAG：** `Math.pow(x,1)` 理論等於 x，但顯式分支避免浮點微差，保證 live 路徑與舊 `stepBall` 逐位元一致 → 守住 AC3。

- [ ] **Step 4: 跑測試確認轉綠**

Run: `npx vitest run tests/trajectory-coherence.test.ts`
Expected: PASS（maxErr < 1）。若仍紅，比對 `sampleServePath` 的積分順序（先 `curVz -= GRAVITY` 再移動，行 928-933）與 `stepShuttle` 是否一致；不一致處以 `stepShuttle` 為準，下一個 task 會讓 sampleServePath 改呼叫它。

- [ ] **Step 5: Commit**

```bash
git add tests/trajectory-coherence.test.ts src/game/sim/simulate.ts
git commit -m "feat(sim): add unified stepShuttle() physics integrator + AC1 coherence test"
```

---

## Task 2：`previewPhysicsStep` 改呼叫 `stepShuttle`

**Files:**
- Modify: `src/game/sim/simulate.ts:555-574`（`previewPhysicsStep`）

- [ ] **Step 1: 跑既有 preview 測試建立基準**

Run: `npx vitest run tests/practice-freeze-step.test.ts tests/practice-rally.test.ts`
Expected: PASS（記下目前綠，作為改寫後的對照）。

- [ ] **Step 2: 改寫 `previewPhysicsStep` 內部**

把 `simulate.ts:555-574` 整個函數體換成委派給 `stepShuttle`：

```typescript
function previewPhysicsStep(s: ShuttleState, slowmo: number): ShuttleState {
  if (!s.inPlay) return s;
  return stepShuttle(s, { dt: slowmo, floorFriction: PRACTICE_FLOOR_FRICTION });
}
```

> 刪掉原本手抄的 `subDrag`/`moved`/`applyWalls`/`applyFloorBounce` 那段——邏輯已搬進 `stepShuttle`，這裡只是薄包裝（保留函數名以免動到呼叫端）。

- [ ] **Step 3: 跑測試確認沒回歸**

Run: `npx vitest run tests/practice-freeze-step.test.ts tests/practice-rally.test.ts tests/trajectory-coherence.test.ts`
Expected: PASS（全綠）。

- [ ] **Step 4: Commit**

```bash
git add src/game/sim/simulate.ts
git commit -m "refactor(sim): previewPhysicsStep delegates to stepShuttle"
```

---

## Task 3：`sampleServePath` 的積分核心改用 `stepShuttle`

**Files:**
- Modify: `src/game/sim/simulate.ts:913-991`（`sampleServePath`）

> **注意：** `sampleServePath` 除了積分，還負責「在牆/地板事件點插入 PathPoint + 標 wall 類型 + tin/out 提早結束」。本 task 只把**積分那幾行**（928-933 的 `curVz -= GRAVITY; x+=vx; ...; vx*=SHUTTLE_DRAG`）換成呼叫 `stepShuttle`，事件偵測與取樣邏輯保留。這樣虛線與 live 用同一積分，但虛線仍能畫出 wall 標記。

- [ ] **Step 1: 強化 AC1 測試覆蓋牆反彈段**

在 `tests/trajectory-coherence.test.ts` 加第二個 it，發一顆會打到前牆反彈的球，比對反彈後 live 與虛線仍 <1px：

```typescript
it('matches through a front-wall bounce within 1px', () => {
  const start = { x: 640, y: 600 };
  const startZ = 90;
  const vel = { x: 0, y: -12 }; // 直衝前牆
  const vz = 5;
  const dashed = sampleServePath(start, startZ, vel, vz, 1, FLOOR_FRICTION);
  let s: ShuttleState = {
    pos: { ...start }, z: startZ, vel: { ...vel }, vz,
    inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
    hitFrontWall: false, lastWall: null, deadReason: null,
    landing: null, landingEta: 0,
  };
  const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };
  let sawFrontWall = false;
  let maxErr = 0;
  for (let i = 1; i < Math.min(dashed.length, 80); i++) {
    s = stepShuttle(s, opts);
    const d = dashed[i];
    if (d.wall === 'front') sawFrontWall = true;
    if (d.wall === 'tin' || d.wall === 'out' || d.wall === 'floor') break;
    // 只比對非事件點（事件點 y 被鎖到 0/EPS，會與 live 的 EPS inset 有設計性微差）
    if (!d.wall) maxErr = Math.max(maxErr, Math.hypot(s.pos.x - d.x, s.pos.y - d.y));
  }
  expect(sawFrontWall).toBe(true);
  expect(maxErr).toBeLessThan(1);
});
```

- [ ] **Step 2: 跑新測試確認它紅（或暴露現存分岔）**

Run: `npx vitest run tests/trajectory-coherence.test.ts`
Expected: 第二個 it FAIL（反彈後分岔，maxErr ≥ 1）——因為 sampleServePath 此時還用自己抄的積分。

- [ ] **Step 3: 把 sampleServePath 積分核心換成 stepShuttle**

改寫 `simulate.ts:913-991`。核心：迴圈內維護一個 `ShuttleState`，每步呼叫 `stepShuttle`，再從回傳的 state 讀 wall 事件來插點。完整新版：

```typescript
export function sampleServePath(
  startPos: { x: number; y: number },
  startZ: number,
  vel: { x: number; y: number },
  vz: number,
  sampleEvery = 3,
  floorFriction: number = FLOOR_FRICTION,
): PathPoint[] {
  const points: PathPoint[] = [{ x: startPos.x, y: startPos.y, z: startZ }];
  let s: ShuttleState = {
    pos: { x: startPos.x, y: startPos.y }, z: startZ,
    vel: { x: vel.x, y: vel.y }, vz,
    inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
    hitFrontWall: false, lastWall: null, deadReason: null,
    landing: null, landingEta: 0,
  };
  const opts: StepOpts = { dt: 1, floorFriction };
  const MAX = 400;
  for (let t = 1; t <= MAX; t++) {
    const prevWall = s.lastWall;
    const prevBounces = s.bouncesSinceWall;
    s = stepShuttle(s, opts);

    // tin / out：stepShuttle 已透過 applyWalls 標 deadReason；畫標記並結束
    if (s.deadReason === 'tin') { points.push({ x: s.pos.x, y: 0, z: s.z, wall: 'tin' }); break; }
    if (s.deadReason === 'out') { points.push({ x: s.pos.x, y: 0, z: s.z, wall: 'out' }); break; }

    // 牆事件：lastWall 變了 → 插一個帶 wall 標記的點
    if (s.lastWall !== prevWall && s.lastWall != null) {
      points.push({ x: s.pos.x, y: s.pos.y, z: s.z, wall: s.lastWall });
    }
    // 地板事件：bouncesSinceWall 增加 → 插 floor 點；第 2 次彈或 dead 結束
    if (s.bouncesSinceWall > prevBounces) {
      points.push({ x: s.pos.x, y: s.pos.y, z: 0, wall: 'floor' });
      if (s.bouncesSinceWall >= 2 || s.deadReason != null) break;
    }
    if (s.deadReason != null) break;

    if (t % sampleEvery === 0) points.push({ x: s.pos.x, y: s.pos.y, z: s.z });
  }
  return points;
}
```

> **行為變更說明：** 舊版 OUT 會「讓球飛出去再補 8 個下墜點」（行 944-948）——那是純視覺，與 live 物理無關。新版交給 stepShuttle 的 deadReason='out' 直接結束。若 e2e 的虛線視覺測試（serve-trajectory.test.ts）依賴那 8 點，Step 4 會抓到。

- [ ] **Step 4: 跑全套測試確認 AC1 綠 + 無回歸**

Run: `npx vitest run`
Expected: 全綠，含 trajectory-coherence 兩個 it + 既有 92 測試。
若 `tests/serve-trajectory.test.ts` 紅 → 讀它斷言什麼，判斷是「斷言了舊的 OUT 視覺 8 點」（則該測試需更新成新行為）還是「真的物理錯了」（則修 stepShuttle）。**不要為了過測試亂改物理常數。**

- [ ] **Step 5: Commit**

```bash
git add src/game/sim/simulate.ts tests/trajectory-coherence.test.ts
git commit -m "refactor(sim): sampleServePath integrates via stepShuttle (kills dashed/live divergence)"
```

---

## Task 4：`predictLanding` 改用 `stepShuttle`

**Files:**
- Modify: `src/game/sim/simulate.ts:581-632`（`predictLanding`）

> `predictLanding` 目前手抄一整套迴圈（含牆反彈），且**地板碰到就 break、完全沒摩擦反彈**——與虛線/live 不一致（設計文件 §1 第 1 點）。改成用 stepShuttle 推進。

- [ ] **Step 1: 寫 AC2 落點一致性測試**

在 `tests/trajectory-coherence.test.ts` 加：

```typescript
import { predictLanding } from '@/game/sim/simulate'; // 若未 export 需在 Step 3 補

it('AC2: predictLanding lands where stepShuttle actually lands (<2px)', () => {
  const base: ShuttleState = {
    pos: { x: 400, y: 200 }, z: 150, vel: { x: 1, y: 6 }, vz: 3,
    inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
    hitFrontWall: true, lastWall: 'front', deadReason: null,
    landing: null, landingEta: 0,
  };
  const predicted = predictLanding(base).landing!;
  // 用 stepShuttle 跑到第一次地板落點
  let s = { ...base };
  const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };
  let landed = s.pos;
  for (let i = 0; i < 300; i++) {
    const prevB = s.bouncesSinceWall;
    s = stepShuttle(s, opts);
    if (s.bouncesSinceWall > prevB) { landed = s.pos; break; }
  }
  expect(Math.hypot(predicted.x - landed.x, predicted.y - landed.y)).toBeLessThan(2);
});
```

- [ ] **Step 2: 跑確認紅**

Run: `npx vitest run tests/trajectory-coherence.test.ts -t AC2`
Expected: FAIL（predictLanding 無摩擦、與 stepShuttle 落點不同），或 import error（predictLanding 未 export）。

- [ ] **Step 3: 改寫 predictLanding + export**

把 `simulate.ts:581-632` 換成（保留簽名與回傳 `{...s, landing, landingEta}`）：

```typescript
export function predictLanding(s: ShuttleState): ShuttleState {
  if (!s.inPlay) return { ...s, landing: null, landingEta: 0 };
  let cur = { ...s };
  const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };
  const MAX = 300;
  for (let t = 1; t <= MAX; t++) {
    const prevBounces = cur.bouncesSinceWall;
    cur = stepShuttle(cur, opts);
    // 第一次地板落點即落點
    if (cur.bouncesSinceWall > prevBounces) {
      return { ...s, landing: { x: cur.pos.x, y: cur.pos.y }, landingEta: t };
    }
    if (cur.deadReason != null) {
      return { ...s, landing: { x: cur.pos.x, y: cur.pos.y }, landingEta: t };
    }
  }
  return { ...s, landing: { x: cur.pos.x, y: cur.pos.y }, landingEta: MAX };
}
```

> 注意：原 `predictLanding` 用 `FLOOR_FRICTION`（match 模式）。AI 跑位/落點標記在 match 與 practice 都用，若 practice 落點需 practice 摩擦，後續可加 opts 參數——但**本 task 維持原行為（match FLOOR_FRICTION）**，避免擴大範圍。

- [ ] **Step 4: 跑全套確認綠 + 無回歸**

Run: `npx vitest run`
Expected: 全綠。特別看 `tests/physics-audit.test.ts` 的 AI rally / landing 相關斷言——predictLanding 改了摩擦行為可能微調落點。若紅，判斷是「測試斷言了舊的無摩擦落點」（更新測試）還是物理錯（修）。

- [ ] **Step 5: Commit**

```bash
git add src/game/sim/simulate.ts tests/trajectory-coherence.test.ts
git commit -m "refactor(sim): predictLanding integrates via stepShuttle (consistent landing)"
```

---

## Task 5：瀏覽器 round-trip 驗收（收口）

> CLAUDE.md 硬約束：視覺/動畫一定要開 browser 實際操作截圖，不接受「邏輯上應該可以」。

- [ ] **Step 1: 確認 dev server**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:5174`（或實際 port，npm run dev 會印出）
Expected: 200。若沒跑，`npm run dev`（背景）。

- [ ] **Step 2: 開練習模式，發球，逐 tick 比對虛線 vs 球**

用 MCP（background tab 可）導航到 dev URL → 練習模式 → 用 `window.__squash.state()` 讀 `previewPath` 與 `shuttle.pos`，注入發球後逐 tick 抓 shuttle 位置，比對它是否落在 previewPath 的點上（誤差肉眼 + 數值 <2px）。

- [ ] **Step 3: 截圖存證**

球飛行中截一張，確認球視覺上貼著虛線。存檔。

- [ ] **Step 4: 回報驗收結果**

格式：`AC1 虛線vs live <1px → ✅/❌`、`AC2 落點 <2px → ✅/❌`、`AC3 既有92測試 → ✅/❌`、`瀏覽器球貼虛線 → ✅/❌（附截圖）`。沒全過先修再重跑。

---

## 後續階段（本計畫不含，待 Phase 1 綠後另開計畫）

- **Phase 2：揮拍撞球**。`resolveSwing` 的「按鍵+近身單幀判定」改成球拍掃動體積 vs 球的逐 tick 碰撞。依賴 Phase 1 收斂後的 stepShuttle 最終簽名，故不在此寫死。
- **Phase 3：深度非線性投影**。`projection.ts:70-73` 線性 `d` 套非線性 remap（近快遠慢）。獨立於物理，可平行。

## Self-Review 紀錄

- **Spec 覆蓋**：§1 診斷→Task1-4 對應 5 處收斂（preview/sampleServePath/predictLanding 已含；主 stepBall 行 409 與 airborne 行 1084 在 Phase 1 後若仍重複，Phase 2 順手收）。§2 stepShuttle→Task1。AC1→Task1/3，AC2→Task4，AC3→每 task 末 `npx vitest run`，AC5 紅線→開頭不變式聲明 + 各 task 不動常數。§3 揮拍、§3.5 深度→明列後續階段。
- **Placeholder 掃描**：無 TBD/TODO；每個 code step 有完整 code；測試有實際斷言。
- **型別一致**：`StepOpts { dt, floorFriction }`、`stepShuttle(s, opts)`、`ShuttleState` 欄位（pos/z/vel/vz/inPlay/lastHitBy/bouncesSinceWall/hitFrontWall/lastWall/deadReason/landing/landingEta）全程一致。⚠️ 實作 Task1 Step1 前需先 `Read src/data/gameState.ts` 確認 ShuttleState 完整欄位名，測試 fixture 才不會缺欄位編譯錯。
