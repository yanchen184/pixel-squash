# Pixel Squash — 引擎規格書（現況版）

> **目標：拿到此文件，不看原始碼也能重建這個壁球遊戲。** 所有數字均為實際程式碼值，非設計願望。
>
> **最後同步：2026-06-16**（同步至 commit 截止全部實作）
>
> **血緣**：從 pixel-badminton（羽球）fork 而來，獨立 repo。共用四根設計支柱與整套接縫框架（InputSource / SimRunner / 決定性 60Hz / React 殼 / 測試法），改寫集中在物理（四牆反彈 vs 過網）+ 球路 + 計分 + 投影。
>
> 專案根：`/Users/yanchen/workspace/boardgame/pixel-squash/`

---

## 0. 設計支柱（與羽球共用）

1. **邏輯 3 軸、渲染 2 軸分離**。Sim 在乾淨的 3D 盒狀球場算（`x` 橫向、`y` 離前牆縱深、`z` 離地高度），渲染層才把 (x,y,z) 投影成螢幕。
2. **真實球物理弧線**。橡膠球水平 drag 接近 1（幾乎不減速），能量靠「撞牆衰減 + 重力做功」消耗。
3. **打擊手感三件套**：timing 視窗（perfect/good/early/late/miss）+ hit-stop（命中瞬間全 sim 凍結幾幀）+ swing-timing 控落點（早揮往前牆左、晚揮往右）。三者都活在純 sim 裡。
4. **決定性純函數 sim**：`step(state, inA, inB)` 固定 60Hz、無 `Math.random` / `Date`、不可變 state。

> ⚠️ **沒有蓄力系統。** 力量完全來自 swing timing 品質分級。

---

## 1. 技術棧

| 項目 | 選擇 | 備註 |
|---|---|---|
| 語言 | TypeScript（strict） | |
| 框架 | React 18 | 只負責選單 / HUD overlay，不碰遊戲迴圈 |
| 建置 | Vite | dev server + build |
| 渲染 | Canvas 2D（原生 `getContext('2d')`） | 無遊戲引擎、無 Phaser |
| 單元測試 | Vitest | sim 純函數可完整覆蓋 |
| E2E | Playwright | 選單→難度→對戰→計分 round-trip |
| 部署 | Firebase Hosting（GitHub Actions auto-deploy on push master/main） | target `pixel-squash`、project `game-hub-d2bbf` |

**runtime 相依只有 `react` + `react-dom`**。

`package.json` scripts：`dev` / `build`（`tsc -b && vite build`）/ `typecheck`（`tsc -b --noEmit`）/ `test`（`vitest run`）/ `e2e`（`playwright test`）。

**CI/CD**：`.github/workflows/deploy.yml`，`on: push [master, main]` + `workflow_dispatch`。流程：checkout → setup-node@22 → `npm ci` → typecheck → test → build → `npx firebase-tools deploy --only hosting:pixel-squash --project game-hub-d2bbf --token "$FIREBASE_TOKEN" --non-interactive`。

---

## 2. 座標系

### 2.1 Sim 邏輯空間（`src/data/gameState.ts`）

```
x ∈ [0, COURT.width]   左牆 → 右牆
y ∈ [0, COURT.depth]   前牆(0) → 後牆(depth)   ← 前牆在 y=0
z（僅球）              離地高度，+ 為上；亦是「撞前牆的高度」
```

- `COURT = { width: 640, depth: 980 }`（6.4m × 9.75m 等比，1px≈1cm）
- **無 `NET_Y`**。兩名玩家共用整個地板，都面對前牆（y=0 方向）。
- 前牆 = `y <= 0` 那一面；球撞前牆 = `pos.y` 穿越 0。撞擊高度 = 該 tick 的 `z`。

> **任何把 `pos.y` 當成「高度」的程式碼 = bug。** 高度只在 `shuttle.z`。

### 2.2 渲染投影（`src/game/court/projection.ts`）

壁球視角 = 第三人稱面對前牆（房間透視），不是羽球的俯視梯形。

| sim 軸 | 螢幕對應 |
|---|---|
| 邏輯 `x`（左右牆） | 螢幕左↔右，前牆處窄、鏡頭處寬 |
| 邏輯 `y`（前牆→後牆） | 螢幕上→下：y=0 在畫面上方、y=depth 在下方 |
| 邏輯 `z`（高度） | 螢幕 y 抬高 `z * HEIGHT_LIFT(0.9)` |

梯形錨點：`farY:120`、`nearY:680`、`farHalf:300`、`nearHalf:600`、`centerX:640`。

`makeProjector()` 介面：
- `toScreen(p, height=0)`：把邏輯座標投影為螢幕像素。
- `depthScale(y)`：近大遠小，前牆處 ≈ `farHalf/nearHalf`（小），鏡頭側 = 1。

渲染 canvas：`GAME_WIDTH=1280 × GAME_HEIGHT=720`。

---

## 3. 核心資料模型（`src/data/gameState.ts`）

全部不可變；`step` 產生新 state，不改舊的。

```ts
type PlayerState = {
  pos: Vec2; vel: Vec2;
  swingCooldown: number;
  stamina: number;
  facing: Facing4;        // squash 兩人恆為 'up'（面前牆）
  lastStroke: StrokeId | null;
  justHit: boolean;
  diveFrames: number;
  diveDir: Vec2;
  diveRecovery: number;
  lastQuality: SwingQuality | null;
};

type ShuttleState = {    // 名稱沿用羽球 fork，視為「球」
  pos: Vec2; z: number;
  vel: Vec2; vz: number;
  lastHitBy: Side | null;
  inPlay: boolean;
  bouncesSinceWall: number;  // 觸前牆後地板落地次數（第 2 次 = 死球）
  hitFrontWall: boolean;     // 自上次被擊出後，是否已碰到前牆有效區
  lastWall: Wall | null;
  deadReason: DeadReason | null;
  landing: Vec2 | null;
  landingEta: number;
};

type GameState = {
  frame: number;
  p1: PlayerState; p2: PlayerState;
  shuttle: ShuttleState;
  scores: [number, number];
  phase: RallyPhase;         // 'serve' | 'rally' | 'point'
  server: Side;
  serveBox: 0 | 1;           // 發球員站左(0)/右(1)發球框
  awaitingServeChoice: boolean;  // 人類發球時等選框
  phaseTimer: number;
  winner: Side | null;
  hitstop: number;
  momentum: number;          // AI 橡皮筋計數 [-MOMENTUM_MAX, MOMENTUM_MAX]
  rallyHitCount: number;     // 本回合已擊球次數（動態球速用）
  gameMode: GameMode;        // 'match' | 'practice'
};
```

### 3.1 常數表（實際程式碼值）

| 常數 | 實際值 | 意義 |
|---|---|---|
| `COURT` | `{width:640, depth:980}` | 邏輯場地 |
| `WALL_HEIGHT` | 480 | 牆高上界 |
| `TIN_HEIGHT` | **80** | 前牆鐵皮下界 |
| `FRONT_OUT_HEIGHT` | 456 | 前牆出界上界 |
| `SERVE_LINE_Y` | 549 | 短發球線 |
| `FLOOR_Z` | 0 | 地板高度 |
| `STAMINA_MAX` | 100 | |
| `POINTS_TO_WIN` | 11 | PAR-11 |
| `WIN_BY` | 2 | 淨勝分 |
| `PLAYER_SPEED` | 9.5 | 每 tick 移動 px |
| `SWING_COOLDOWN_FRAMES` | 14 | 揮拍冷卻 |
| `SWING_REACH` | 100 | 擊球地面距離 |
| `SWING_REACH_Z` | 160 | 擊球最高球高 |
| `RACKET_REACH_OFFSET` | 48 | 拍頭偏移（朝前牆方向） |
| `SWING_MAGNET_RANGE` | 160 | 磁吸對位生效範圍 |
| `SWING_MAGNET_PULL` | 0.18 | 每 tick 磁吸比例 |
| `TIMING_PERFECT` | 3 | \|dt\| ≤3 → perfect |
| `TIMING_GOOD` | 7 | \|dt\| ≤7 → good |
| `TIMING_WINDOW` | 12 | \|dt\| ≤12 → early/late |
| `STRIKE_Z` | 55 | 理想接觸高度 |
| `SHUTTLE_DRAG` | 0.998 | 水平阻力（橡膠球） |
| `SHUTTLE_PACE` | **1.8** | 全域節奏撥盤（飛行時間倍率） |
| `APEX_CEIL` | 460 | 弧頂硬上限 |
| `WALL_BOUNCE` | 0.92 | 側/後牆反彈保留率 |
| `FRONT_WALL_BOUNCE` | **0.95** | 前牆反彈保留率 |
| `FLOOR_BOUNCE` | **0.58** | 地板反彈保留率 |
| `HITSTOP_PERFECT/GOOD/WEAK` | 6 / 3 / 1 | 各品質凍結幀 |
| `MOMENTUM_MAX` | 4 | 橡皮筋計數上限 |
| `DIVE_FRAMES` | 10 | 魚躍滑行幀 |
| `DIVE_SPEED` | 17 | 魚躍滑速 |
| `DIVE_REACH_BONUS` | 90 | 魚躍額外擊球距離 |
| `DIVE_RECOVERY_FRAMES` | 30 | 魚躍後趴地鎖定 |
| `DIVE_STAMINA_COST` | 25 | 魚躍體力消耗 |
| `DIVE_MIN_STAMINA` | 10 | 低於此無法魚躍 |
| `PLAYER_MARGIN` | 30 | 玩家離牆最小邊距 |
| `T_SPOT` | `{x:320, y:490}` | T 點（AI 回位目標） |
| `GRAVITY` | 0.42 | 高度 px/tick²（simulate.ts 匯出） |

`createInitialState()`：p1 在 `(width*0.35, depth*0.7)`、p2 在 `(width*0.65, depth*0.7)`，phase=`serve`、server=0、serveBox=1、`awaitingServeChoice=true`、`rallyHitCount=0`、`gameMode='match'`。

`resetForServe(state, server)` ：phase→`serve`、`awaitingServeChoice=false`（不再次觸發選框）、`phaseTimer=45`、清魚躍狀態、`rallyHitCount=0`、球停在發球員手邊 `z=110`、`hitFrontWall=false`、`bouncesSinceWall=0`。

### 3.2 `racketCenter`（拍頭位置）

```ts
function racketCenter(pos: Vec2, _side: Side, offset = 48): Vec2 {
  return { x: pos.x, y: pos.y - offset }; // 朝前牆（y 減小）伸
}
```

兩人同朝前牆，offset 方向恆為 `-y`（與羽球不同，羽球 side=1 往另一方向）。

---

## 4. Sim 主迴圈（`src/game/sim/simulate.ts`）

純函數 `step(state, inA, inB) → nextState`，固定 60Hz。

### 流程

1. `winner !== null` → 原樣回傳。
2. `frame++`。
3. **hit-stop**：`hitstop > 0` → 只回 `{...state, frame, hitstop-1}`，全 sim 凍結。
4. **serve / point phase**：
   - `phaseTimer--`；timer > 0 時，serve phase 允許玩家在發球框內移動（`movePlayer` 含框約束）。
   - timer 歸零：point→`resetForServe`、serve：若 `awaitingServeChoice` 則等 `inA.serveLeft/serveRight`（選框後 `phaseTimer=40`），選完 → `launchServe`。
5. **rally tick**：
   - `movePlayer(p1, inA, 0, shuttle, state)`、`movePlayer(p2, inB, 1, shuttle, state)`
   - `stepBall(shuttle)`：重力 + 水平阻力
   - `resolveSwing` x2（p1 先、p2 後），取 hitstop 最大值；`rallyHitCount` 在命中 tick +1
   - `applyWalls(shuttle, prev)`：四牆反彈 + tin/out 死球標記
   - `applyFloorBounce(shuttle, prev)`：地板彈 + `bouncesSinceWall` + 第二落地死球
   - `predictLanding(shuttle)`：前向積分填 `landing/landingEta`
   - 死球判定：practice mode → `resetForServe`（不計分）；match mode → `scorePoint`

### 4.1 `movePlayer`（含發球框約束）

優先序（早 return）：
1. 更新 `swingCooldown`、`facing='up'`、`justHit=false`。
2. **趴地**（`diveRecovery>0`）：不動、體力慢回。
3. **魚躍中**（`diveFrames>0`）：沿 `diveDir` 以 DIVE_SPEED 滑。
4. **觸發魚躍**（`input.dive && stamina>=DIVE_MIN_STAMINA`）：扣體力、啟動 lunge。
5. **一般移動 + 磁吸對位**：`ball.lastHitBy !== mySide` 且在範圍內 → 向 landing 拉近。
6. **發球框約束**（`state.phase==='serve' && state.phaseTimer>0`）：
   - 發球員：`y >= SERVE_LINE_Y + PLAYER_MARGIN`、左框=`x < midX-MARGIN`、右框=`x > midX+MARGIN`。
   - 接球員：對角框同樣約束。

### 4.2 `resolveSwing`（手感核心）

- 趴地不能揮。
- 魚躍中每幀自動揮（stroke 固定 `drive`、quality=`good`）。
- 非魚躍：需 `input.swing` edge + `swingCooldown==0`。
- 人類（`timingAim=true`）：`downgradeIfFaulted` 把不合法 stroke 降級為 `drive`。
- **Timing fault 鏈**：
  - `dt = timingDelta(shuttle)`（正=早揮、負=晚揮）。
  - `applyTimingFault(wallTarget, dt)`：`dt>0` 過揮 → 前牆撞擊 z 往上推（超 `FRONT_OUT_HEIGHT+300` → 出界）；`dt<0` 晚揮 → z 往下壓（低於 `TIN_HEIGHT-30` → 打中 tin）。severity 在 good~window 之間線性爬升。
- **動態球速**（`rallyHitCount` 用）：超過 8 拍後每拍縮短 3% 飛行時間（最多 -18%），增加對打張力。
- `aimXFromTiming(dt) = clamp(-dt/TIMING_WINDOW, -1, 1)`：早揮→左、晚揮→右。
- AI 用 explicit `input.aimX`（`timingAim=false`），注入 `faultBias` 合成失誤。

### 4.3 球飛行物理

**`stepBall`**：`vz -= GRAVITY(0.42)`；`pos += vel`；`vel *= SHUTTLE_DRAG(0.998)`；`z += vz`。

**`applyWalls`（四牆反彈）**：
- 前牆（`prev.y>0 && y<=0`）：內插撞擊 z；`z<TIN_HEIGHT`→`deadReason='tin'`；`z>FRONT_OUT_HEIGHT`→`deadReason='out'`；有效→`vy*=FRONT_WALL_BOUNCE(0.95)`、`hitFrontWall=true`、`bouncesSinceWall=0`。
- 後牆：`vy = -|vy|*WALL_BOUNCE(0.92)`。
- 左/右牆：`vx` 翻號 × `WALL_BOUNCE`。

**`applyFloorBounce`**：
- 落地（`z<=0 && vz<=0`）：`bouncesSinceWall++`。
- `!hitFrontWall` → `deadReason='not-front-wall'`。
- `bouncesSinceWall>=2` → `deadReason='double-bounce'`。
- 第一落地且合法 → 彈起：`vz = |vz| * FLOOR_BOUNCE(0.58)`。

**`predictLanding`**：鏡像 stepBall+applyWalls+applyFloorBounce 前向積分（最多 300 tick），找第一合法落地點。含牆反彈。

**`solveArcToWall(pos, z0, target, stroke, power, rallySpeedMod)`**：
- `tof = (stroke.tof 中值 × SHUTTLE_PACE × stroke.pace × rallySpeedMod) / power`
- `vx = dx/tof`、`vy = dy/tof`。
- `vz = (target.z - z0 + 0.5*GRAVITY*tof²) / tof`。
- `APEX_CEIL` 夾頂（只對合法 target.z 生效，故意過揮不夾）。

### 4.4 發球與計分

**`launchServe`**：從發球員位置 `z=110` 用 `STROKES.serve` + `serveTarget(server, serveBox)` 發出，phase→`rally`。

**`serveTarget`**：serveBox=1（右）→ 前牆 x=`width*0.35`（朝左反彈到左後場）；serveBox=0（左）→ `width*0.65`。前牆高度 = `WALL_HEIGHT*0.55`。

**`scorePoint`**：
- `tin/out/not-front-wall` → 擊球者失分。
- `double-bounce` → 應接球方失分（`lastHitBy` 的對手）。
- PAR 計分：`scores[winnerSide]++`；`scores[s]>=11 && lead>=2` → `winner=s`。
- 發球框每得分翻邊：`serveBox` = 1-0 互換。
- momentum：玩家(0)得分 +1、AI(1)得分 -1，clamp[-4,4]。

**Practice mode（`gameMode==='practice'`）**：死球觸發時呼叫 `resetForServe` 而非 `scorePoint`，比分不動，自由對打。

---

## 5. 球路系統（`src/data/strokes.ts`）

`StrokeId = 'drive' | 'boast' | 'lob' | 'drop' | 'kill' | 'serve'`。

| stroke | label | wallZ（前牆撞擊高度） | tof | pace | fault 閘 |
|---|---|---|---|---|---|
| drive | 直球 | `WALL_HEIGHT*0.30`≈144 | [16,26] | 1.0 | 無 |
| boast | 反角 | 側牆特例 | [22,34] | 1.1 | `need-angle`（nearSide ≤ maxX） |
| lob | 高吊 | `WALL_HEIGHT*0.78`≈374 | [30,46] | 1.25 | 無 |
| drop | 放小球 | `TIN_HEIGHT+24`≈104 | [20,30] | 1.15 | `max-front-dist`（離前牆≤360） |
| kill | 低殺 | `TIN_HEIGHT+12`≈92 | [12,20] | 0.6 | `min-contact-z`（球高z≥70） |
| serve | 發球 | `WALL_HEIGHT*0.55`≈264 | [26,40] | 1.0 | 無 |

**`aimWallTarget(stroke, pos, aimX, aimY, accuracy)`** → 前牆撞擊點 `{x, z, wall}`：
- `z = stroke.wallZ`（被 timing fault 修正）。
- `x`：drive/kill 中央偏「遠離對手」；`aimX ∈[-1,1]` 線性到前牆左右邊（`width*0.08` ↔ `width*0.92`）。
- accuracy blend：低 accuracy 往中段收。
- boast：目標改為側牆點（`wall='side'`），物理自然帶向前牆。

---

## 6. 輸入系統（`src/game/input/`）

### 6.1 `InputSource` 介面（`InputSource.ts`）

```ts
type InputFrame = {
  moveX: -1|0|1; moveY: -1|0|1;
  swing: boolean;       // EDGE（just-pressed）
  stroke: StrokeId;
  timingAim: boolean;   // true=人類，前牆左右由 timing 推
  aimX: number;         // AI 用的前牆左右 [-1,1]
  aimY: number;         // AI 用深淺微調
  dive: boolean;
  faultBias: number;    // AI 合成失誤（+出界/-tin/0 乾淨）
  serveLeft: boolean;   // 選左格發球
  serveRight: boolean;  // 選右格發球
};
```

### 6.2 `LocalInput`（鍵盤 + 觸控）

- 移動：WASD / 方向鍵。
- 球路鍵（press-edge）：`J=kill`、`K=drop`、`L=drive`、`U=boast`、`Space=lob`。
- 魚躍：`Shift` 或觸控 dive 鈕。
- 發球選框：`A/ArrowLeft`→`serveLeft=true`、`D/ArrowRight`→`serveRight=true`。
- 觸控：`touchControls` singleton（`setTouchMove/setTouchSwing/setTouchDive`）。
- `timingAim=true`，`aimX=0, aimY=0, faultBias=0`。

### 6.3 `AIInput`（3 難度）

決定性 seeded LCG（非 `Math.random`）。`import { GRAVITY } from '@/game/sim/simulate'` 同步物理。

| 參數 | easy | medium | hard |
|---|---|---|---|
| `reactionDelay`（tick） | 10 | 5 | 2 |
| `predictionAccuracy` | 0.5 | 0.82 | 1.0 |
| `fumbleRate` | 0.22 | 0.09 | 0.02 |
| `faultRate` | 0.2 | 0.08 | 0.02 |
| `deadzone`（px） | 28 | 18 | 10 |

**新球偵測（rally-collapse 修復，務必保留）**：
- `hitterChanged`（striker 翻號）OR `serveLaunched`（`inPlay` false→true）→ 重新 react。
- 沒有 `serveLaunched` 分支 → 發球方相同 sign 不翻 → `fumbleThisShuttle` 殘留 → 接球方每球必失（確定性 rally-collapse bug）。

**`pickStroke`（對手位置策略）**：
- 先鏡像 sim fault 閘（`canKill/nearFront/nearSide`），絕不選必失球。
- momentum rubber-band：`momentum>2`（AI 落後）→ 更頻繁 kill/drop；`momentum<-2`（AI 領先）→ 多打 lob 保守。
- 對手在後場 + 我在前場 → kill 或 drop。
- 對手在 T 點 → boast 或 drop 逼角。
- 對手在前場 → lob 驅趕回後場。
- 對手與球同側 → cross-court drive。
- 預設 `drive`。

**`practiceMode`**：`setPracticeMode(true)` 後 `pickStroke` 一律回傳 `'lob'`，給人類穩定可回的球。

**`reset()`**：清 `reactCountdown`、`lastHitterSign`、`fumbleThisShuttle`、`faultBiasThisShuttle`、`wasInPlay`，回到 home（T 點）。

### 6.4 `SimRunner`（`src/game/sim/SimRunner.ts`）

固定 60Hz accumulator。`TICK_MS=1000/60`、`MAX_STEPS_PER_FRAME=5`。
- `setGameMode(mode)` → `this.gameMode`，`reset()` 時注入 `createInitialState()`。
- `current` getter 給渲染讀最新 state。

---

## 7. 渲染（`src/game/render/CanvasRenderer.ts`）

擁有 RAF 迴圈，驅動 `SimRunner` 畫最新 state；gameplay 數學全在純 sim，這層只投影 + 畫。

### 7.1 RAF 主迴圈

`start()` → RAF：`dt = min(100, now-lastTime)` → `runner.update(dt)` → `advanceFx` → `draw` → `syncHud`。

### 7.2 畫順序

bg → 前牆（tin 紅線 / out line / 發球框 / 服務線） → 地板梯形 + 邊線 → 側牆/後牆透視框 → 落點縮圈 marker → 兩玩家影子 + 球影 → **z-sort 兩玩家**（`y` 大者後畫）→ 球（拖尾）→ 命中 burst → hit-stop 白閃。

### 7.3 視覺 FX 方法

**`drawAimIndicator(shuttle)`**（aim indicator，#19）：
- 僅在 `phase==='rally' && shuttle.lastHitBy !== 0`（AI 最後打）顯示。
- 顏色：dt > 0（早揮）→ 綠色（← 往左）；dt < 0（晚揮）→ 琥珀色（往右→）；dt ≈ 0 → 藍色（中央）。
- 在前牆有效區畫色帶 + 亮點，隨球距前牆淡入，顯示標籤（← 左 / 右 → / 中央）。

**`drawServeGuideLine(serverPos, serveBox)`**（serve guide，#21）：
- 在 serve phase + `awaitingServeChoice=false` 時顯示。
- 從發球員位置到前牆預測撞擊點畫動態虛線；前牆撞擊點畫一個發光圓點。

**`drawLandingMarker(shuttle, practice)`**（落點縮圈）：
- 正常模式：隨 `landingEta` 縮小的地板圓。
- practice mode：亮青色十字準星，always-bright（不依距離淡化）。

**`drawWallImpactFX`**（撞牆衝擊波）：前牆撞擊點畫擴散圓圈。

**`drawQualityLabels`**（品質標籤）：命中後顯示 perfect/good/early/late 浮字。

**`drawRefAnnouncements`**（裁判播報）：死球後淡入裁判詞（「掛板！」/「出界！」等）。

### 7.4 `syncHud`

只在變化時 emit eventBus 事件：
- `score:changed`：比分變動。
- `stamina:changed`：體力變動。
- `match:over`：有 winner。
- **`serve:awaiting { waiting: boolean }`**（#30）：`awaitingServeChoice && server===0` 狀態改變時 emit，讓 React `Controls` 切換 `ServeBoxPicker`。

---

## 8. React 殼層（`src/ui/`）

React 只做選單與 HUD overlay，不碰遊戲迴圈。

### 8.1 `App.tsx`

畫面狀態機：`'menu' | 'howto' | 'difficulty' | 'match'`。

- 選單有三個按鈕：**開始遊戲**（→ howto → 難度選擇）、**練習模式**（直接 `startMatch('easy', 'practice')`）、怎麼玩？
- `startMatch(difficulty, gameMode)` → 設 `gameMode` state → screen='match'。
- `MatchConfig = { difficulty: Difficulty; gameMode?: GameMode }`。
- 豎屏手機：`useIsPortraitPhone()` 返回 `RotatePrompt`（轉橫提示）。

### 8.2 `GameView.tsx`

- `useEffect` 掛 `new CanvasRenderer(canvas, { difficulty, gameMode })`、`start()`。
- 疊 `<Hud>`、`<Controls>`（pointer events overlay）。
- `restart()` → `rendererRef.current?.restart()`。

### 8.3 `Controls.tsx`（觸控操作）

僅在 `pointer:coarse`（觸控裝置）顯示。

- **正常狀態**：Joystick（左下）+ DiveButton（右下偏左）+ StrokePad（右下，2×2 grid + 高吊）。
- **`awaitingServe` 狀態**（偵測 `serve:awaiting` eventBus）：顯示 `ServeBoxPicker`。

**`ServeBoxPicker`**（#30）：兩個大按鈕覆蓋下半螢幕，`onPointerDown` 發送 `KeyA/KeyD` DOM 事件，`LocalInput` 映射為 `serveLeft/serveRight`。

**StrokePad 五鍵**：`kill(J)` / `drop(K)` / `drive(L)` / `boast(U)` / `lob(空)`。

### 8.4 `Hud.tsx`

訂閱 `eventBus`：比分 / 體力 / 勝負 / 發球員指示。

### 8.5 `eventBus.ts`

本地 pub/sub，Phase 2 被 server socket 取代的接縫。

```ts
type GameEvents = {
  'score:changed': { scores: [number, number] };
  'stamina:changed': { p1: number; p2: number };
  'match:over': { winner: Side };
  'serve:awaiting': { waiting: boolean };   // #30 新增
  'sim:reset': {};
};
```

---

## 9. 測試（`tests/`）

`vitest run`，3 檔：

- **`simulate.test.ts`**：決定性、frame 遞增、發球流程、PAR 計分、勝負凍結、壁球不變量（球在四牆界內、第二落地死球）。rally-feel 回歸測：`playMatch` 跑 AI-vs-AI，斷言 `rallyHits.length>=5`、`avg>3`、兩拍局 `<50%`。
- **`feel.test.ts`**：timing 視窗、hit-stop（perfect 凍結 HITSTOP_PERFECT 幀、凍結期間球不動只有 frame 進）。
- **`strokes.test.ts`**：6 球路 profile + 前牆撞擊點 + 牆反彈守恆（撞牆後速度方向翻號）+ tin/out 判定。

---

## 10. 美術：chibi 二頭身 sprite

- **比例**：二頭身，大眼可愛 mascot、pixel-art、透明底。
- **隊色**：p1 藍（`#4a9ad0`）、p2 紅（`#d04a6a`）。
- **接圖規格**：腳底正中對 `foot=toScreen(pos,0)`；`dx=foot.x-w/2`、`dy=foot.y-h`；尺寸隨 `depthScale(pos.y)` 縮放。壁球兩人同朝前牆，預設不翻轉。
- **動作幀**：待命 / 揮拍（`swingCooldown>0`）/ 撲救（`diveFrames>0`）/ 倒地（`diveRecovery>0`）/ 左跑/右跑/往前牆跑 / 發球拋球。
- 素材目錄：`public/assets/players/`。
- 觀眾：`public/assets/audience/`。4×5 格 sheet。

---

## 11. 路線圖

### 已完成

- [x] `gameState.ts` 壁球常數/型別（TIN_HEIGHT=80、SHUTTLE_PACE=1.8、FRONT_WALL_BOUNCE=0.95 等）
- [x] `simulate.ts` 四牆反彈 + 地板彈 + PAR 計分（核心）
- [x] `strokes.ts` 六球路 + 前牆瞄準（`aimWallTarget`）
- [x] `AIInput.ts` pickStroke 壁球擇法 + rally-collapse 修復 + 對手位置策略 + momentum rubber-band + practiceMode
- [x] `projection.ts` 面向前牆房間透視
- [x] `CanvasRenderer.ts` 前牆/tin/四牆/兩人同場 z-sort
- [x] tests 壁球不變量 + 牆反彈守恆
- [x] 球速調整：`SHUTTLE_PACE=1.8`、`FRONT_WALL_BOUNCE=0.95`（#17）
- [x] 裁判播報（tin/out/double-bounce/not-front-wall）（#22）
- [x] 方向瞄準視覺化 `drawAimIndicator`（#19）
- [x] 發球系統重設計：service box 約束 + `awaitingServeChoice` + `serveLeft/serveRight` input + serve guide line（#21）
- [x] 觸控 HUD 發球選框 `ServeBoxPicker`（#30）
- [x] Practice mode（menu 入口 + `gameMode` + AI 只打 lob + 不計分 + 落點標記增強）（#34）
- [x] `rallyHitCount` 動態球速（8 拍後加速最多 18%）（#33）
- [x] AI momentum rubber-band（#18）
- [x] 魚躍救球（dive/diveRecovery）
- [x] 品質標籤 FX（perfect/good/early/late 浮字）
- [x] hit-stop 視覺強化
- [x] Firebase Hosting + GitHub Actions CI/CD

### 進行中 / 待完成

- [ ] 背面角色 sprite 生成並接入渲染器（#12）
- [ ] 場地改用生成圖片當背景（對齊透視座標）（#13）
- [ ] 補齊角色動作 sprite（#20，依賴 #12）
- [ ] 觀眾 sprite 生成並接入渲染器（#23）
- [ ] 觀眾歡呼觸發條件（#24，依賴 #23）

### Phase 2（接縫已備，延後實作）

三個接縫讓連網不是重寫：`InputSource`（換 NetworkedInputSource）、`eventBus`（→ server socket）、決定性 60Hz 保證無引擎物理漂移。

---

## 附錄 A — 與羽球的物理差異速查

| 面向 | 羽球（pixel-badminton） | 壁球（本專案） |
|---|---|---|
| 球性 | 羽毛球，drag 0.988 陡降 | 橡膠球，drag 0.998 幾乎不減速 |
| 場地 | 兩半場 + 中央網 | 封閉四牆，兩人共用整場 |
| y 語意 | 0=遠底線、網在 depth/2 | **0=前牆、depth=後牆，無網** |
| 障礙 | 網（z<70 掛網） | tin（z<80 死球）+ 四牆反彈 |
| 主軸物理 | 過網 + 落地 | 撞前牆有效區 + 牆反彈 + 第二落地死球 |
| 球路 | clear/smash/drop/drive/serve | drive/boast/lob/drop/kill/serve |
| 瞄準 | 對方半場落點 | 前牆撞擊點（高度+左右） |
| 計分 | 球落哪半場那方輸 | PAR-11 每球得分、四種死球 |
| 重力 | 0.45 | 0.42 |
| 投影 | 俯視梯形 | 面向前牆房間透視 |
| 球速調盤 | SHUTTLE_PACE=1.25 | **SHUTTLE_PACE=1.8**（比羽球慢） |
| 前牆反彈 | — | FRONT_WALL_BOUNCE=0.95（高保留） |
