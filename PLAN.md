# Pixel Squash — 可重建引擎規格書

> **這份文件的目標：拿到它的人，不看原始碼也能把這個壁球遊戲重寫出來。** 每個數字都是具體可照抄的工程值（不是設計願望）；改了 code 就回來改這份。
>
> **血緣**：本專案是 **pixel-badminton（羽球）的姊妹遊戲**，以羽球引擎為基底 fork 而來、獨立 repo、各自演化。共用四根設計支柱與整套接縫框架（InputSource / SimRunner / 決定性 60Hz / React 殼 / 測試法），改寫集中在 **物理（四牆反彈 vs 過網）+ 球路 + 計分 + 投影**。每節標 🟰（沿用羽球，幾乎不動）/ 🆕（壁球專屬，需從頭寫）。羽球對照見羽球專案 `PLAN.md`。
>
> **現況（2026-06-12）**：fork 基底剛建立，程式碼仍為羽球邏輯，**尚未改寫成壁球**。本規格書即改寫藍圖。
>
> **產品目標**：上 Steam / Web 的壁球對戰遊戲（行動裝置 via Capacitor，非 React Native）。路線 = 先用無皮幾何把「手感 / 牆反彈 / 對打」調對，再貼 chibi 二頭身皮。
>
> 專案根：`/Users/yanchen/workspace/boardgame/pixel-squash/`

---

## 0. 設計支柱（與羽球共用，壁球完全沿用）🟰

四根支柱，跟羽球一字不改：

1. **邏輯 3 軸、渲染 2 軸分離**。Sim 在乾淨的 3D 盒狀球場算（`x` 橫向、`y` 離前牆縱深、`z` 離地高度），渲染層才把 (x,y,z) 投影成螢幕。z 軸是命門——沒有它，高球（lob）/ 低殺（kill）/ 觸牆高度無法區分。**壁球的牆面反彈尤其靠 z 軸才成立**（球撞前牆的高度決定是 kill 還是 lob）。
2. **真實球物理弧線**。重力不衰減（垂直陡降）。**壁球是橡膠彈性球：水平 drag 接近 1（幾乎不減速）**，能量靠「撞牆衰減 + 重力做功」消耗，不是空氣阻力。這跟羽球（drag 0.988、球陡降）相反——羽球球軟、壁球球彈。
3. **打擊手感三件套**：timing 視窗（perfect/good/early/late/miss）+ hit-stop（命中瞬間全 sim 凍結幾幀，給「重量」）+ swing-timing 控落點（早揮 / 晚揮影響球打到前牆的位置與品質）。三者都活在純 sim 裡，沒有渲染器也能單元測試斷言。
4. **決定性純函數 sim**：`step(state, inA, inB)` 固定 60Hz、無 `Math.random` / `Date`、不可變 state。同 input 序列 → 逐幀完全一致。這是 Phase 2 netcode 的地基。

> ⚠️ **沒有蓄力（charge）系統。** 力量完全來自 swing timing 的品質分級（perfect 最強），不是 hold 蓄力。

**驗收標準**：不是「畫面有東西」（handshake），是 round-trip——AI 對 AI 自打一局能維持多拍來回（平均 >3 拍、有競爭比分），人類進去能跟 AI 打完一局有分數。

---

## 1. 技術棧 🟰

| 項目 | 選擇 | 備註 |
|---|---|---|
| 語言 | TypeScript（strict） | |
| 框架 | React 18 | 只負責選單 / HUD overlay，**不碰遊戲迴圈** |
| 建置 | Vite | dev server + build |
| 渲染 | **Canvas 2D**（原生 `getContext('2d')`） | 無遊戲引擎、無 Phaser |
| 單元測試 | Vitest | sim 純函數可完整覆蓋 |
| E2E | Playwright | 選單→難度→對戰→計分 round-trip |
| 部署 | Firebase Hosting（GitHub Actions auto-deploy on push master/main） | `firebase.json`、target `pixel-squash`、project `game-hub-d2bbf` |

**runtime 相依只有 `react` + `react-dom`**。

`package.json` scripts：`dev` / `build`（`tsc -b && vite build`）/ `typecheck`（`tsc -b --noEmit`）/ `test`（`vitest run`）/ `e2e`（`playwright test`）。

**CI/CD**：`.github/workflows/deploy.yml`，`on: push [master, main]` + `workflow_dispatch`。流程：checkout → setup-node@22 → `npm ci` → typecheck → test → build → `npx firebase-tools deploy --only hosting:pixel-squash --project game-hub-d2bbf --token "$FIREBASE_TOKEN" --non-interactive`。`FIREBASE_TOKEN` 走 repo secret。

> **部署前置（業務層，需手動）**：Firebase console 須先建一個 hosting site id = `pixel-squash`（同 project `game-hub-d2bbf`），`.firebaserc` 的 target 才接得上。GitHub repo 需設 `FIREBASE_TOKEN` secret。這兩步是雲端資源異動，建立壁球 GitHub repo 時一併處理。

---

## 2. 座標系（**最容易搞混，先寫死**）🆕

### 2.1 Sim 邏輯空間（`src/data/gameState.ts`）

盒狀球場（壁球是封閉四牆房間），三軸：

```
x ∈ [0, COURT.width]   左牆 → 右牆
y ∈ [0, COURT.depth]   前牆(0) → 後牆(depth)         ← 與羽球語意不同！前牆在 y=0
z（僅球）              離地高度，+ 為上；亦是「撞前牆的高度」
```

- `COURT = { width: 640, depth: 980 }`（真實壁球場 6.4m × 9.75m 等比，1px≈1cm）。
- `WALL_HEIGHT = 480`（前牆有效打擊區高 4.8m；後牆較矮但模型統一用此上界）。
- **無 `NET_Y`、無 `NET_HEIGHT`、無「兩半場」概念。** 兩名玩家共用整個地板，都面對前牆（y=0 方向）。
- `FLOOR_Z = 0`。落地 = `shuttle.z <= 0`。
- **前牆 = `y <= 0` 那一面**；球撞前牆 = `pos.y` 在某 tick 跨越 0。撞擊高度 = 該 tick 的 `z`。
- **tin（鐵皮下界紅線）**：`TIN_HEIGHT = 48`（0.48m）。球撞前牆時 `z < TIN_HEIGHT` → 觸 tin → 失分（等價羽球的「掛網」）。
- **out line（上界）**：球撞前牆時 `z > FRONT_OUT_HEIGHT(456)` → 出界失分。
- 有效前牆區：`TIN_HEIGHT <= z <= FRONT_OUT_HEIGHT`。

> **任何把 `pos.y` 當成「高度」的程式碼 = bug。** 高度只在 `shuttle.z`。玩家 `pos` 永遠是地板平面 (x,y)。

### 2.2 渲染投影（`src/game/court/projection.ts`）

壁球視角 = **第一/第三人稱面對前牆**（不是羽球的俯視梯形）。前牆是畫面主體（一面大牆 + tin 紅線 + 服務框），地板往觀眾方向延伸，左右側牆收斂成透視梯形。

| sim 軸 | 螢幕對應 | 說明 |
|---|---|---|
| 邏輯 `x`（0→width，左右牆） | 螢幕 **左↔右**，前牆處窄、靠近鏡頭處寬 | 房間透視 |
| 邏輯 `y`（0→depth，前牆→後牆） | 螢幕 **上→下**：y=0（前牆）在畫面上方、y=depth（後牆/鏡頭）在下方 | 縱深 |
| 邏輯 `z`（高度） | 螢幕 y 抬高 `z * HEIGHT_LIFT(0.9)` | 越高畫越上 |

梯形錨點 `DEFAULT_PROJECTION`（面向前牆的房間透視）：
- `farY: 120`（前牆在畫面上方）、`nearY: 680`（鏡頭側在下方）。
- `farHalf: 300`（前牆半寬，較窄）、`nearHalf: 600`（鏡頭側半寬，較寬）。**注意：壁球前牆在遠處看起來窄，但比羽球網寬，因為整面牆都是場地。**
- `centerX: 640`。

`makeProjector()` 介面與羽球**完全相同**（只換錨點數值）：
- `toScreen(p, height=0)`：`cy = clamp01(y / depth)`（0 前牆…1 後牆，縱深）、`cx = clamp01(x / width)`（左右）。`half = farHalf + (nearHalf-farHalf)*cy`、`screenY = farY + (nearY-farY)*cy`。回 `{x: centerX + (cx-0.5)*2*half, y: screenY - height*0.9}`。
- `depthScale(y)`：近大遠小。`t = farHalf/nearHalf`，回 `t + (1-t)*cy`（前牆處=t 小、鏡頭側=1 大）。

渲染 canvas 邏輯尺寸 `GAME_WIDTH=1280 × GAME_HEIGHT=720`。

> **前牆是「畫面上方一整片」**，不是羽球的「中央一條垂直網」。球飛向前牆 = 往畫面上方飛、變小；球反彈回來 = 往下、變大。

---

## 3. 核心資料模型（`src/data/gameState.ts`）🆕

全部不可變；`step` 產生新 state，不改舊的。

```ts
type Vec2 = { x: number; y: number };
type Side = 0 | 1;                          // 0=玩家  1=AI（壁球同場，僅區分歸屬與發球權）
type Facing4 = 'down' | 'up' | 'left' | 'right';  // 面向前牆預設 'up'
type SwingQuality = 'perfect' | 'good' | 'early' | 'late' | 'miss';
type RallyPhase = 'serve' | 'rally' | 'point';
type Wall = 'front' | 'back' | 'left' | 'right';   // 球最近撞到的牆

type PlayerState = {
  pos: Vec2; vel: Vec2;
  swingCooldown: number;     // 揮拍後冷卻幀；0=可揮
  stamina: number;           // 0..STAMINA_MAX
  facing: Facing4;
  lastStroke: StrokeId | null;
  justHit: boolean;          // 僅命中那一 tick 為 true（驅動 FX）
  diveFrames: number;        // 魚躍進行中剩餘幀
  diveDir: Vec2;
  diveRecovery: number;      // 魚躍後趴地鎖定幀
  lastQuality: SwingQuality | null;
  // ⚠️ 沒有 chargeFrames。力量來自 timing 品質。
};

type BallState = {           // 壁球用 ball（羽球叫 shuttle）
  pos: Vec2; z: number;      // 地板平面 + 高度
  vel: Vec2; vz: number;     // 平面速度 + 垂直速度
  lastHitBy: Side | null;
  inPlay: boolean;
  bouncesSinceWall: number;  // 觸前牆後在地板的落地次數（壁球：第 2 次落地 = 死球）🆕
  hitFrontWall: boolean;     // 自上次被擊出後，是否已碰到前牆有效區 🆕
  lastWall: Wall | null;     // 最近反彈的牆（渲染/AI 用）
  landing: Vec2 | null;      // 預測第一落點（含牆反彈）
  landingEta: number;        // 距落點幀數
};

type GameState = {
  frame: number;
  p1: PlayerState; p2: PlayerState;
  ball: BallState;
  scores: [number, number];
  phase: RallyPhase;
  server: Side;
  serveBox: 0 | 1;           // 發球員站左(0)/右(1)發球框，每得分換邊 🆕
  phaseTimer: number;
  winner: Side | null;
  hitstop: number;           // >0 時全 sim 凍結
  momentum: number;          // AI 橡皮筋計數，clamp [-MOMENTUM_MAX, MOMENTUM_MAX]
};
```

### 3.1 常數表（重建時照抄；🆕 = 壁球新值，與羽球不同）

| 常數 | 值 | 檔案 | 意義 |
|---|---|---|---|
| `COURT` | `{width:640, depth:980}` 🆕 | gameState | 邏輯場地（6.4×9.75m 等比） |
| `WALL_HEIGHT` | 480 🆕 | gameState | 牆高上界 |
| `TIN_HEIGHT` | 48 🆕 | gameState | 前牆鐵皮下界（球須打在其上） |
| `FRONT_OUT_HEIGHT` | 456 🆕 | gameState | 前牆出界上界 |
| `SERVE_LINE_Y` | 549 🆕 | gameState | 短發球線（前牆距 5.49m）：發球第一落地須過此線 |
| `FLOOR_Z` | 0 | gameState | 地板高度 |
| `STAMINA_MAX` | 100 | gameState | |
| `POINTS_TO_WIN` | 11 🆕 | gameState | PAR-11，需淨勝 2 分（見 §4.4） |
| `WIN_BY` | 2 🆕 | gameState | 淨勝分 |
| `PLAYER_SPEED` | 9.5 | gameState | 每 tick 邏輯 px（雙軸） |
| `SWING_COOLDOWN_FRAMES` | 14 | gameState | 揮拍冷卻 |
| `SWING_REACH` | 100 🆕 | gameState | 可擊球的地面距離（球場較大，略增） |
| `SWING_REACH_Z` | 160 🆕 | gameState | 可擊球的最高球高 |
| `RACKET_REACH_OFFSET` | 48 | gameState | 拍頭領先身體往「擊球朝向」偏移（見 §3.2） |
| `SWING_MAGNET_RANGE` | 160 🆕 | gameState | 磁吸對位生效範圍 |
| `SWING_MAGNET_PULL` | 0.18 | gameState | 每 tick 拉近缺口比例 |
| `TIMING_PERFECT` | 3 | gameState | \|Δtick\| ≤3 → perfect |
| `TIMING_GOOD` | 7 | gameState | ≤7 → good |
| `TIMING_WINDOW` | 12 | gameState | ≤12 → early/late |
| `STRIKE_Z` | 55 | gameState | timing 對準的理想接觸高度 |
| `BALL_DRAG` | 0.998 🆕 | gameState | 水平阻力（橡膠球幾乎不減速；羽球是 0.988） |
| `BALL_PACE` | 1.6 🆕 | gameState | 全域節奏撥盤（飛行時間倍率，壁球比羽球快） |
| `APEX_CEIL` | 460 🆕 | gameState | 弧頂硬上限（≈牆高，防球飛出畫面） |
| `WALL_BOUNCE` | 0.92 🆕 | gameState | 側/後牆反彈速度保留率 |
| `FRONT_WALL_BOUNCE` | 0.88 🆕 | gameState | 前牆反彈保留率（吃掉較多能量） |
| `FLOOR_BOUNCE` | 0.55 🆕 | gameState | 地板反彈保留率（球落地後彈起） |
| `HITSTOP_PERFECT/GOOD/WEAK` | 6 / 3 / 1 | gameState | 各品質凍結幀 |
| `MOMENTUM_MAX` | 4 | gameState | 橡皮筋計數上限 |
| `DIVE_FRAMES` | 10 | gameState | 魚躍滑行長度 |
| `DIVE_SPEED` | 17 | gameState | 魚躍滑速 |
| `DIVE_REACH_BONUS` | 90 | gameState | 魚躍時額外擊球距離 |
| `DIVE_RECOVERY_FRAMES` | 30 | gameState | 魚躍後趴地鎖定 |
| `DIVE_STAMINA_COST` | 25 | gameState | 魚躍體力消耗 |
| `DIVE_MIN_STAMINA` | 10 | gameState | 低於此無法魚躍 |
| `PLAYER_MARGIN` | 30 🆕 | gameState | 玩家可移動範圍離牆邊距 |
| `GRAVITY` | 0.42 🆕 | simulate | 高度 px/tick²，**AIInput 須 import 同步**（球場大略降） |
| `SWING_COST` | 8 | simulate | 揮拍體力消耗 |
| `STAMINA_REGEN` | 0.5 | simulate | 每 tick 體力回復 |
| `OUT_OVERSHOOT` | 300 🆕 | simulate | 最嚴重 early 過揮把前牆瞄準點往上（出界）推的 px |
| `TIN_DIP_MAX` | 0.55 | simulate | 最嚴重 late 揮拍殺掉的 vz 比例（打中 tin 以下） |

`createInitialState()`：兩名玩家在後半場左右分開（p1 `x=width*0.35`、p2 `x=width*0.65`，`y=depth*0.7` 後場），phase=`serve`、server=0、serveBox=1（壁球首發從右框）、scores=[0,0]、momentum=0。`makePlayer(side)`：兩人都 facing `up`（面對前牆）。`resetForServe(state, server)` 把球停在發球員手邊 `z=110`、`phaseTimer=45`、清魚躍狀態、`ball.hitFrontWall=false`、`ball.bouncesSinceWall=0`。

### 3.2 拍頭擊球幾何（`racketCenter`）🆕

擊球判定圈以拍頭為心。壁球無網，拍頭偏移方向 = **朝球當前所在的相對方位**（簡化：朝前牆方向 `y` 減小，因為主要擊球動作是把球往前牆送）。

```ts
function racketCenter(pos, side, offset = RACKET_REACH_OFFSET=48): Vec2 {
  // 壁球：拍頭朝前牆（y 變小）伸，兩名玩家同向（都打前牆）
  return { x: pos.x, y: pos.y - offset };
}
```

> 與羽球差異：羽球 `toward` 由 side 決定（兩人面對面、各朝對方）；壁球兩人同朝前牆，所以 `toward` 恆為 `-1`。**sim 的 hit test 與渲染的 reach 圈共用此函數，永不漂移。**

---

## 4. Sim 主迴圈（`src/game/sim/simulate.ts` 的 `step`）🆕

純函數 `step(state, inA, inB) → nextState`，固定 60Hz。流程（與羽球同骨架，物理段不同）：

1. `winner !== null` → 原樣回傳。
2. `frame++`。
3. **hit-stop**：`hitstop > 0` → 只回 `{...state, frame, hitstop: hitstop-1}`，不動移動/物理。
4. **serve / point phase**：`phaseTimer--`；歸零時 point→`resetForServe`、serve→`launchServe`。
5. **rally tick**：
   - `p1 = movePlayer(p1, inA, 0, ball)`、`p2 = movePlayer(p2, inB, 1, ball)`
   - `ball = stepBall(ball)`：重力 + 水平阻力推進
   - `ball = applyWalls(ball, prevBall)`：撞四牆反彈、標記 `hitFrontWall` 🆕
   - `resolveSwing` 各方一次（命中改球速度向量、設 `justHit`、算 hitstop、重置 `hitFrontWall=false`），取兩者 hitstop 最大值
   - `ball = applyFloorBounce(ball, prevBall)`：z 跨 0 → 彈起 + `bouncesSinceWall++` 🆕
   - `ball = predictLanding(ball)`：前向積分（含牆反彈）填 `landing`/`landingEta`
   - 死球判定（見 §4.4）→ `scorePoint`

### 4.1 移動（`movePlayer`）🆕（骨架🟰、半場判定改）

優先序（早 return）：
1. 冷卻 `swingCooldown = max(0, -1)`；`facing` 通常 `up`（面前牆）；`justHit=false`。
2. **趴地**（`diveRecovery>0`）：不能動/不能揮，`vel=0`，體力慢回，`diveRecovery--`。
3. **魚躍中**（`diveFrames>0`）：沿 `diveDir` 以 `DIVE_SPEED` 滑（`clampX`/`clampY` 整場界內），無視移動 input；`diveFrames--`，歸零那幀設 `diveRecovery`。
4. **觸發魚躍**（`input.dive && stamina >= DIVE_MIN_STAMINA`）：朝 `diveDirection` lunge，扣體力，`diveFrames=DIVE_FRAMES`。
5. **一般移動**：`speed = PLAYER_SPEED * (stamina>0 ? 1 : 0.5)`，`pos += move * speed`。
   - **磁吸對位（壁球版）**🆕：球 `inPlay`、`z<=SWING_REACH_Z`、**且「該我接」**（見下）、且我離球地面點 `<=SWING_MAGNET_RANGE` 時，`pos += gap * SWING_MAGNET_PULL`。
   - **「該我接」判定**🆕：壁球兩人同場，用「誰離球的預測落點近、且球是對方打的」決定。`ball.lastHitBy !== mySide`（對方剛打、輪我接）且我比隊友更靠近 `ball.landing` → 磁吸生效。避免兩人同時撲同一球互相卡死。
   - 最後 `clampX` + `clampY`（**整場界內**，非半場）。`vel = move*speed`，體力 `+STAMINA_REGEN`。

`clampX(x) = clamp(x, PLAYER_MARGIN, COURT.width-PLAYER_MARGIN)`。
`clampY(y) = clamp(y, PLAYER_MARGIN, COURT.depth-PLAYER_MARGIN)`。🆕 **兩人共用整場**——需處理互相遮擋（§7 渲染 z-sort）與讓位（AI 不站死擋人路徑，medium 以上 AI 接完球後往 T 點 `(width/2, depth*0.5)` 回位）。

### 4.2 揮拍判定（`resolveSwing`）— 手感核心 🆕

- 趴地不能揮，原樣回。
- `diving = diveFrames>0`。魚躍每幀自動揮；非魚躍要 `input.swing` edge + `swingCooldown==0`。
- **stroke 解析**：人類（`input.timingAim==true`）對不合法 stroke 自動降級成 `drive`（最安全的直打前牆）；AI 保留原 stroke（`pickStroke` 已 gate 合法性）。
- 擊球幾何：`hitFrom = diving ? pos : racketCenter(pos, side)`。`dist = |ball.pos - hitFrom|`。`reach = diving ? SWING_REACH+DIVE_REACH_BONUS : SWING_REACH`，`reachZ = diving ? SWING_REACH_Z+DIVE_REACH_BONUS : SWING_REACH_Z`。`reachable = dist<=reach && z<=reachZ`。
- 魚躍回球一律當 `drive`（潦草救球）。
- **不可及**：魚躍中→繼續 lunge 不算 whiff；一般揮空→仍扣 cooldown + 體力、`lastQuality='miss'`。
- **timing**：`timingDelta(ball)` 算 signed Δtick（球 z 落到 `STRIKE_Z` 的時刻；正=早揮、負=晚揮）。`qualityFromDelta` 分桶。魚躍 `dt=0`、`quality='good'`。
- `accuracy = ACCURACY[quality]`、`power = POWER[quality]`（無蓄力乘項）。
- **fault 誤擊**（非魚躍）：`faultMisfire(stroke, pl, ball)` true（如球太低想 kill、角度不對想 boast）→ 球軟掉（`vel*=0.3, vz=-2`），這拍打不成有效回擊（多半導致死球）。
- **前牆瞄準落點**🆕：擊球目標是**前牆上的一個撞擊點** `(wallX, wallZ)`：
  - 人類：左右 `wallX = aimXFromTiming(dt)`（早揮往左牆、晚揮往右牆，`clamp(-dt/TIMING_WINDOW,-1,1)` 映射到前牆 x 範圍）；高度 `wallZ` 由 stroke 決定（lob 高、kill 低）。
  - AI：用 explicit `input.aimX`（前牆左右）+ stroke 的 `wallZ`。
- **timing fault 全鏈**🆕（壁球版 in/out 由 timing 決定）：
  - `faultDt = timingAim ? dt : (input.faultBias ?? 0)`。
  - **early（dt>0）過揮 → 前牆撞擊點往上推**（`wallZ += OUT_OVERSHOOT * mistimeSeverity`），超過 `FRONT_OUT_HEIGHT` → 打出界（撞前牆上界外）。
  - **late（faultDt<0）→ 殺 vz / 壓低撞擊點**：`wallZ *= 1 - TIN_DIP_MAX*mistimeSeverity`，低於 `TIN_HEIGHT` → 打中 tin（死球）。
  - 乾淨球（good/perfect、AI faultBias=0）兩條都不動。
- 命中：`launch = solveArcToWall(ball.pos, z, wallTarget, stroke, power)` → 球 `vel/vz` 設為 launch，`lastHitBy=side`，`justHit=true`，`ball.hitFrontWall=false`（重新計算這拍是否觸前牆），`hitstop = diving ? HITSTOP_WEAK : HITSTOP[quality]`。

分級表（同羽球，不改）：

| quality | ACCURACY | POWER | HITSTOP |
|---|---|---|---|
| perfect | 1.0 | 1.15 | 6 |
| good | 0.8 | 1.0 | 3 |
| early | 0.45 | 0.78 | 1 |
| late | 0.45 | 0.78 | 1 |
| miss | 0.2 | 0.6 | 0 |

### 4.3 球飛行（`stepBall` / `solveArcToWall` / `applyWalls` / `applyFloorBounce`）🆕

- **`stepBall`**：`vz -= GRAVITY`；`pos += vel`；`vel *= BALL_DRAG(0.998)`；`z += vz`。橡膠球水平幾乎不衰減，靠撞牆/重力耗能。
- **`applyWalls(b, prev)`**🆕 — 四牆反彈，核心物理：
  - **前牆**（`prev.y>0 && b.y<=0`，球往 y 減小方向穿過 0）：
    - 撞擊高度 `hitZ = b.z`（用穿越瞬間 z；可線性內插 prev→cur 求精確交點）。
    - `hitZ < TIN_HEIGHT` → 觸 tin，標記死球原因 `tin`（不反彈，球往下掉，§4.4 判失分）。
    - `hitZ > FRONT_OUT_HEIGHT` → 出界，標記 `out`。
    - 有效區內 → 反彈：`b.vel.y = -b.vel.y * FRONT_WALL_BOUNCE`，`b.pos.y = 0 + ε`，`b.hitFrontWall = true`，`b.bouncesSinceWall = 0`（重置地板落地計數），`lastWall='front'`。
  - **後牆**（`b.y >= depth`）：`b.vel.y = -|b.vel.y| * WALL_BOUNCE`，`b.pos.y = depth-ε`，`lastWall='back'`。後牆反彈不影響 `hitFrontWall`。
  - **左牆**（`b.x <= 0`）/ **右牆**（`b.x >= width`）：`b.vel.x = -b.vel.x * WALL_BOUNCE`，夾回界內，`lastWall='left'/'right'`。側牆反彈是 boast/角球的基礎。
  - 一個 tick 可能同時撞兩面（角落）：依序處理 x 牆、y 牆。
- **`applyFloorBounce(b, prev)`**🆕：`prev.z>0 && b.z<=0`（落地）：
  - `b.bouncesSinceWall++`。
  - 若這是「有效回擊後第一落地」且球已 `hitFrontWall` → 正常彈起：`b.vz = -b.vz * FLOOR_BOUNCE`，`b.z = ε`。讓對手有機會在第一落地後回擊（壁球允許 volley 或第一落地後擊球）。
  - `bouncesSinceWall >= 2`（第二次落地）→ 死球（§4.4）。
- **`predictLanding`**🆕：複製球，鏡像 `stepBall`+`applyWalls`+`applyFloorBounce` 前向積分到「第一落地」或 `t>=MAX(300)`，填 `landing/landingEta`。**含牆反彈**——AI 與渲染都靠它知道球反彈後會落哪。
- **`solveArcToWall(pos, z0, wallTarget{x,z}, stroke, power)`**🆕 — 把球送到前牆指定點：
  - 目標是前牆平面 `y=0` 上的點 `(wallTarget.x, wallTarget.z)`。
  - 水平：`dy = 0 - pos.y`（往前牆）、`dx = wallTarget.x - pos.x`。飛到前牆的時間 `tWall = clamp(stroke 期望飛時, stroke.tof) * BALL_PACE * stroke.pace / power`。
  - `vx = dx / tWall`、`vy = dy / tWall`（注意 vy 為負，往前牆）。
  - 垂直：解 `z(tWall) = wallTarget.z`，即 `z0 + vz*tWall - 0.5*GRAVITY*tWall² = wallTarget.z` → `vz = (wallTarget.z - z0 + 0.5*GRAVITY*tWall²) / tWall`。
  - **APEX_CEIL 夾頂**：若軌跡頂點 `z0 + vz²/(2g) > APEX_CEIL` → 壓低 `vz`（球太高會超出畫面/牆頂），重算到合理弧。
  - 回 `{vx, vy, vz}`。
  - lob = 高 wallZ + 慢 pace（高弧打前牆上方，反彈到後場）；kill = 低 wallZ（貼 tin 上緣）+ 快；boast = 先瞄側牆（特例：目標改側牆點，§5）。

> tof/apex/pace 針對 `GRAVITY=0.42` 調，**改重力要整套重調**。

### 4.4 發球與計分（`launchServe` / `serveTarget` / `scorePoint`）🆕

- **`serveTarget(server, serveBox)`**🆕：壁球發球規則——球先打**前牆**（撞擊點在前牆中上區、發球線以上），反彈後**第一落地須落在對角發球框內**（後場、與發球員相反的左/右側）。`wallTarget = { x: 前牆中央偏對角, z: WALL_HEIGHT*0.55 }`，預測落點落在對角後場 quarter。**這是 rally 能起來的關鍵**——發球必須可回。
- **`launchServe`**：從發球員位置 `z=110` 用 `STROKES.serve` 解 `solveArcToWall` 發出，`predictLanding`，phase→`rally`，`ball.hitFrontWall` 待 `applyWalls` 觸前牆時設 true。
- **`scorePoint`**（死球觸發後判歸屬）🆕：死球原因有四種：
  1. **`tin`**：擊球者打中 tin → **擊球者失分**。
  2. **`out`**：球出界（前牆上界外 / 撞牆前先出頂） → **擊球者失分**。
  3. **第二落地 `double-bounce`**：球第二次落地時還沒被回擊 → **該接球方失分**（沒接到）。判「該接球方」= `ball.lastHitBy` 的對手（上一拍是誰打的，對手沒接到）。
  4. **`not-front-wall`**：球落地前的整段飛行沒碰到前牆有效區（直接打側/後牆又落地、或打到 tin 下） → **擊球者失分**。
  - PAR 計分（每球得分制，rally point）：得分方 `scores[winnerSide]++`。
  - **發球權與換框**：得分方成為下一個發球員（PAR 規則）。`serveBox` 每次自己得分換邊（左↔右）。
  - **勝負**：`scores[s] >= POINTS_TO_WIN(11)` 且 `scores[s]-scores[other] >= WIN_BY(2)` → `winner=s`。否則 10-10 進 deuce 打到淨勝 2 分。
  - `server=winnerSide`、`phaseTimer=60`、phase→`point`。
  - **momentum**：玩家（side 0）得分 +1、AI 得分 -1，`clamp[-4,4]`。

---

## 5. 球路系統（`src/data/strokes.ts`）🆕

`StrokeId = 'drive' | 'boast' | 'lob' | 'drop' | 'kill' | 'serve'`。六種壁球擊法，全部對齊 `GRAVITY=0.42` 調出。每路定義「前牆撞擊點高度 `wallZ`、飛行時間 `tof`、節奏 `pace`、瞄準型態 `aim`、fault 閘」：

| stroke | label | wallZ（前牆撞擊高度） | tof | pace | aim | fault 閘 | 手感 |
|---|---|---|---|---|---|---|---|
| drive | 直球 | 中（`WALL_HEIGHT*0.30`≈144） | [16,26] | 1.0 | 直打前牆、落後場 | 無 | 預設安全球，平打前牆深彈到後場長度球 |
| boast | 反角球 | 經側牆再到前牆（特例） | [22,34] | 1.1 | 先瞄側牆角 | `need-angle`：球位需在側牆側 | 防守救球/變線，球撞側牆繞到前牆低點 |
| lob | 高吊 | 高（`WALL_HEIGHT*0.78`≈374） | [30,46] | 1.25 | 前牆高處 | 無 | 高弧打前牆上方，反彈深墜後場角，reset 節奏 |
| drop | 放小球 | 貼 tin 上（`TIN_HEIGHT+24`≈72） | [20,30] | 1.15 | 前牆低、靠近 tin | `max-front-dist`：離前牆 ≤ 360 才打得出貼牆短球 | 前牆低點輕放，球死在前場角 |
| kill | 低殺 | 貼 tin（`TIN_HEIGHT+12`≈60） | [12,20] | 0.6 | 前牆極低、強力 | `min-contact-z`：球高 z>=70 才能下壓殺 | 最快最平，貼 tin 上緣砸下，球幾乎不彈 |
| serve | 發球 | 高（`WALL_HEIGHT*0.55`≈264） | [26,40] | 1.0 | 對角發球框 | 無 | 打前牆中上，反彈落對角後場框，可回 |

- `DEFAULT_STROKE = 'drive'`。`StrokeFault` 種類：`min-contact-z`（球高 ≥ z 才能打，kill 用）/ `max-front-dist`（離前牆 ≤ dist 才打，drop 用）/ `need-angle`（球需在側牆側，boast 用）。
- **`aimWallTarget(stroke, pos, aimX=0, aimY=0, accuracy=1)`** → 前牆撞擊點 `{x, z}`：
  - `z = stroke.wallZ`（再被 §4.2 timing fault 修正）。
  - `x`：`drive/kill` 預設前牆中央偏向「遠離對手」一側；`aimX` 連續 [-1,+1] 從中央 lerp 到前牆左右邊（`width*0.08` ↔ `width*0.92`）。`boast` 的 x 是側牆撞擊點（特例分支）。
  - **accuracy blend**：`x = lerp(centerX, x, accuracy)`、`z = lerp(WALL_HEIGHT*0.4, z, accuracy)`——mistimed 揮拍往安全中段收。
- `distToFrontWall(pos) = pos.y`（drop fault 用）。
- **boast 特例**：目標不是前牆，是**同側側牆的一點**，撞側牆後物理自然把球帶向前牆。`solveArcToWall` 傳側牆目標，後續 `applyWalls` 完成側牆→前牆兩段反彈。

> tof 與 wallZ 針對 `GRAVITY=0.42`、`BALL_DRAG=0.998` 調，**改物理參數要整套重調**。

---

## 6. 輸入系統（`src/game/input/`）🟰（介面不動，AI 擇法改）

### 6.1 `InputSource` 介面（`InputSource.ts`）— Phase 2 接縫，與羽球**完全相同**

```ts
type InputFrame = {
  moveX: -1|0|1; moveY: -1|0|1;
  swing: boolean;        // EDGE（just-pressed）
  stroke: StrokeId;      // 永遠 explicit
  timingAim: boolean;    // true=人類，sim 由 swing timing 推前牆左右
  aimX: number;          // 連續 -1左…+1右（前牆撞擊點左右），僅 AI 用
  aimY: number;          // 連續，AI 用的深淺微調；人類留 0
  dive: boolean;
  faultBias: number;     // AI-only 合成 mistime：+ 過高出界 / − 打中 tin / 0 乾淨
};

interface InputSource {
  readonly side: Side;
  sample(state: GameState): InputFrame;
  reset?(): void;
}
```

> ⚠️ **沒有 `charge` 欄位。** 力量/落點全來自 timing。`LocalInput` 與 `AIInput` 都實作此介面，sim 不知道差別。Phase 2 換 `NetworkedInputSource` 即連網，零改 sim。

### 6.2 `LocalInput`（鍵盤 + 觸控，P1）🟰（鍵位語意對應壁球球路）

- 移動：WASD / 方向鍵。
- **球路由 stroke 鍵決定**（各自 press-edge）：`J=低殺 kill`、`K=放小球 drop`、`L=直球 drive`、`U=反角 boast`、`Space=高吊 lob`。本 tick 第一個按下勝；`swing=(stroke!==null)`。觸控用 `touch.stroke`。
- 魚躍：`Shift` 或觸控 dive 鈕。
- **螢幕軸 vs 邏輯軸**：壁球面向前牆，螢幕上下 → 邏輯 `moveY`（上=往前牆 y 減）、螢幕左右 → 邏輯 `moveX`。（比羽球直覺，因為沒轉軸。）
- **落點**：`timingAim=true`，前牆左右由 sim 從 timing 推，高度由 stroke 決定，故 `aimX=0, aimY=0, faultBias=0`。

### 6.3 `AIInput`（3 難度，P2）— rally 修復核心 🆕（pickStroke 改，結構🟰）

決定性 seeded LCG（**非 `Math.random`**）。`import { GRAVITY } from '@/game/sim/simulate'` 同步物理。三難度調**五**參數（沿用羽球結構與數值）：

| 參數 | easy | medium | hard | 意義 |
|---|---|---|---|---|
| `reactionDelay`（tick） | 10 | 5 | 2 | 偵測新球後反應倒數 |
| `predictionAccuracy` | 0.5 | 0.82 | 1.0 | 落點預測精度（含牆反彈的 errX/errY 反比） |
| `fumbleRate` | 0.22 | 0.09 | 0.02 | 整球不揮拍機率 |
| `faultRate` | 0.2 | 0.08 | 0.02 | 接觸但打壞（出界/中 tin）機率，注入 `faultBias` |
| `deadzone`（px） | 28 | 18 | 10 | 目標附近不再挪移容差 |

決策迴圈：偵測新球 → `reactionDelay` 倒數 → 用 `predictLanding`（**含牆反彈**）取落點、加隨機誤差 → 移過去（含「該不該我接、要不要讓 T 點」邏輯）→ 進 reach 且冷卻 0 且不 fumble → **`pickStroke`（壁球擇法）** → 揮拍；不在 reach 但在魚躍範圍內則救球。

**`pickStroke`（壁球版）**🆕：依球位/球高選——
- 球高且在前場 → `kill`（下壓殺）。
- 球低且貼前牆 → `drop`（放小球）。
- 球在側牆側、防守被動 → `boast`（變線救球）。
- 球深、想 reset → `lob`（高吊到後場）。
- 其餘預設 `drive`。
- **鏡像 sim 的 fault 閘**（kill 需高球 z>=70、drop 需近前牆、boast 需角度），絕不選必失球。

> **rally-collapse 核心修復（從羽球繼承，務必保留）**：「新球偵測」不能只看球速翻號——發球若同向 sign 永不翻、殘留 `fumbleThisShuttle` 卡住 → 接發球方每球必失。修法：新增 `wasInPlay` 狀態，把「`inPlay` false→true 的發球瞬間」當第二觸發條件 OR 進去。**壁球同樣靠它，不可省。**

### 6.4 `SimRunner`（`src/game/sim/SimRunner.ts`）🟰

固定 60Hz accumulator，與羽球一字不改。`TICK_MS=1000/60`、`MAX_STEPS_PER_FRAME=5`。`update(deltaMs)` 累積、每滿 TICK_MS 跑一次 `step`，單幀最多 5 步。`current` getter 給渲染讀最新 state；`reset()` 重置並呼叫 input 的 `reset?()`。

---

## 7. 渲染（`src/game/render/CanvasRenderer.ts`）🆕

**Greybox→sprite 過渡**：純 Canvas 2D 幾何 → chibi sprite drawImage（§11）。擁有 RAF 迴圈，驅動 `SimRunner` 畫最新 state；gameplay 數學全在純 sim，這層只投影 + 畫。透過 `eventBus` 與 React 溝通。

- `start()` 啟 RAF：`dt=min(100, now-lastTime)` → `runner.update(dt)` → `advanceFx` → `draw` → `syncHud`。
- **畫順序**🆕（壁球面向前牆）：bg → **前牆（含 tin 紅線、out line、發球框、服務線）** → 地板梯形 + 邊線 → 側牆/後牆透視框 → 落點預測縮圈 → 兩玩家影子 + 球影 → **z-sort 兩玩家**（誰 `y` 大（離鏡頭近）後畫）→ 球（含拖尾指示方向）→ 命中 burst → hit-stop 白閃。
- **前牆繪製**🆕：畫面上方一整片牆。tin 在 `z=TIN_HEIGHT` 投影出的水平紅線；out line 在 `z=FRONT_OUT_HEIGHT`；中間是有效擊球區（可上淡色）。球撞前牆時在撞擊點畫一圈衝擊波。
- **`drawPlayer`**：`foot = toScreen(pos, 0)`（腳底中心錨點）、`scale = depthScale(pos.y)`。sprite 腳底正中對 `foot`，高度 `~76*scale`。兩人同朝前牆，無需翻轉（除非加左右手）。
- **`drawRacket`**：揮拍弧由 `swingCooldown/SWING_COOLDOWN_FRAMES` 驅動，朝前牆方向揮。
- **遮擋**🆕：兩人 + 球在同一空間，靠 `y`（縱深）z-sort；球若被前方玩家擋住可加半透明描邊。
- FX：命中 burst、品質分級閃色、screen-shake（perfect 9/good 5/其他 2，每幀 *0.82 衰減）。
- `syncHud` 只在變化時 emit：`score:changed` / `stamina:changed` / `match:over`。`debugState()` 回 `runner.current`。

> **RAF 注意**：Chrome 分頁 `document.hidden` 時 RAF throttle 到 ~0，自動化測試分頁在背景會看似凍結——可用 `runner.update(16.67)` 手動步進繞過。

`src/game/eventBus.ts` = 本地 pub/sub，Phase 2 被 server socket 取代的接縫。

---

## 8. React 殼層（`src/ui/`、`src/main.tsx`）🟰

React 只做選單與 HUD overlay，**不碰遊戲迴圈**，與羽球同：

- `App.tsx`：畫面狀態機（menu → 難度選擇 → match → 結算）。
- `GameView.tsx`：掛 `<canvas>`、`new CanvasRenderer(canvas, {difficulty})`、`start()/stop()`。
- `Hud.tsx`：比分 / 體力 / 勝負 / **發球員與發球框指示**🆕，訂閱 `eventBus`。
- `Controls.tsx` + `useOrientation.ts`：操作說明（壁球五擊法鍵位）/ 觸控 / 橫豎屏。

---

## 9. 測試（`tests/`）🆕（框架🟰、不變量改壁球）

`vitest run`，3 檔：

- **`simulate.test.ts`**：決定性、frame 遞增、發球流程、PAR 計分、勝負凍結，playfield 不變量改壁球版——**球永遠在四牆界內、球落地前必先觸前牆有效區才算有效回擊、第二落地判死球**。以及 **rally-feel 回歸測**：`playMatch(seedA,seedB)` 跑完整 AI-vs-AI 局，數每回合擊球數，斷言 `rallyHits.length>=5`、`avg>3`、兩拍局 `<50%`。**rally-collapse 回歸網，從羽球繼承。**
- **`feel.test.ts`**：timing 視窗（sweet-spot=perfect）、hit-stop（perfect 凍結 `HITSTOP_PERFECT` 幀、凍結期間球不動只有 frame 進）。純 sim 斷言。
- **`strokes.test.ts`**：6 球路 profile + 前牆撞擊點解析 + **牆反彈守恆測**（撞牆後速度方向翻號、量值 ×bounce 係數）+ tin/out 判定。

> 新功能照 TDD：先寫測試（RED）→ 最小實作（GREEN）→ 重構。sim 純函數，幾乎所有機制都能在這層斷言。**壁球物理（牆反彈、tin、第二落地）特別需要單元測試鎖死，因為視覺上不好驗。**

---

## 10. 重建步驟（從零，或從羽球 fork 改）

### 從羽球 fork 改（本專案實際路徑）
1. （已完成）`rsync` 羽球專案、刪 `.git`、`git init` 獨立 repo、改 package/firebase/deploy/index 設定。
2. **改 `gameState.ts`**：刪 NET 常數 → 加 TIN/WALL/SERVE_LINE 常數（§3.1）；改 COURT 為 `{640,980}` 與 y 語意（前牆=0）；`BallState` 加 `bouncesSinceWall`/`hitFrontWall`/`lastWall`；`GameState` 加 `serveBox`；改 `racketCenter` 朝前牆；`clampY` 改整場。
3. **改 `simulate.ts`**：`applyNet`→`applyWalls`（§4.3 四牆反彈，核心）；加 `applyFloorBounce`；`SHUTTLE_DRAG`→`BALL_DRAG=0.998`、`GRAVITY=0.42`；`stepShuttle`→`stepBall`；`solveArc`→`solveArcToWall`（前牆瞄準）；`predictLanding` 含牆反彈；`serveTarget` 對角發球；`scorePoint` 四種死球 + PAR 計分。**先寫 `strokes.test.ts` 的牆反彈守恆 + `simulate.test.ts` 的第二落地測，再實作**（TDD）。
4. **改 `strokes.ts`**：六球路（§5）+ `aimWallTarget`（前牆撞擊點）+ `distToFrontWall` + boast 側牆特例。
5. **改 `AIInput.ts`**：`pickStroke` 壁球擇法（§6.3），**保留 `wasInPlay` 修復 + 5 參數結構 + GRAVITY import**。
6. **改 `LocalInput.ts`** + `touchControls.ts`：五擊法鍵位（J=kill/K=drop/L=drive/U=boast/Space=lob）、軸對應（§6.2）。
7. **改 `projection.ts`**：面向前牆的房間透視錨點（§2.2）。
8. **改 `CanvasRenderer.ts`**：畫前牆（tin/out/發球框）、四牆透視、兩人同場 z-sort、撞牆衝擊波、sprite（§11）。
9. **`tests/`**：壁球不變量 + 牆反彈守恆 + PAR 計分（§9）。
10. round-trip：`npm test` 綠 + `tsc -b` 乾淨 + 瀏覽器 AI-vs-AI 多拍、人類能打完一局。

**驗收依賴順序**：座標/投影（§2）→ 牆物理 sim（§4.3）→ AI pickStroke（§6.3）→ 渲染前牆（§7）→ UI（§8）。座標契約（前牆=y=0、z=撞牆高度）沒立好，後面全是猜。

---

## 11. 美術：chibi 二頭身 sprite（沿用羽球規格）🟰

> 與羽球共用同一套 chibi 二頭身 pixel sprite 規格與接圖座標。

- **比例**：二頭身（頭 ≈ 身高一半），大眼可愛 mascot、pixel-art、透明底。
- **隊色**：p1 藍（`#4a9ad0`）、p2 紅（`#d04a6a`）。
- **接圖規格**（對齊 §7 `drawPlayer`）：sprite 腳底正中對 `foot=toScreen(pos,0)`；`dx=foot.x-w/2`、`dy=foot.y-h`；尺寸隨 `depthScale(pos.y)` 縮放。**壁球兩人同朝前牆，預設不翻轉**（羽球需翻是因兩人面對面）。
- **動作幀**（由 state 推）：待命 / 揮拍（`swingCooldown>0`）/ 撲救（`diveFrames>0`）/ 倒地（`diveRecovery>0`）。
- **球拍**：第一版畫進 sprite；或保留程式 `drawRacket` 疊上。
- 素材目錄：`public/assets/players/`。生成走 codex `image_gen`（透明底、絕對路徑落地、round-trip 驗 file+sips+Read）。

---

## 12. 路線圖

### 待完成（fork 改寫，§10 步驟）
- [ ] `gameState.ts` 壁球常數/型別
- [ ] `simulate.ts` 四牆反彈 + 地板彈 + PAR 計分（核心）
- [ ] `strokes.ts` 六球路 + 前牆瞄準
- [ ] `AIInput.ts` pickStroke 壁球擇法（保留 rally 修復）
- [ ] `projection.ts` 面向前牆透視
- [ ] `CanvasRenderer.ts` 前牆/tin/四牆/兩人同場
- [ ] tests 壁球不變量 + 牆反彈守恆
- [ ] chibi sprite 接圖（與羽球共用素材規格）

### 下一步
- [ ] 人類試玩手感校準（牆反彈節奏、tin 判定容差）
- [ ] 觸控行動裝置 round-trip（Capacitor 打包）
- [ ] 音效（撞牆「叩」聲是壁球靈魂）/ 粒子
- [ ] 賽制（目前單局 PAR-11，可加 best-of-5）

### Phase 2 — 連網 server-authoritative（延後，接縫已備）
三個接縫讓連網不是重寫：`InputSource`（換 NetworkedInputSource + client prediction）、`eventBus`（→server socket）、決定性靠自有 fixed-60Hz loop + 量化座標 + 無引擎物理保證。**與羽球共用同一套接縫設計。**

---

## 附錄 A — 與羽球的物理差異速查

| 面向 | 羽球（pixel-badminton） | 壁球（本專案） |
|---|---|---|
| 球性 | 羽毛球，水平 drag 0.988 陡降 | 橡膠球，drag 0.998 幾乎不減速 |
| 場地 | 兩半場 + 中央網 | 封閉四牆房間，兩人共用整場 |
| y 語意 | 0=遠底線、depth=近底線、網在 depth/2 | **0=前牆、depth=後牆，無網** |
| 障礙 | 網（z<70 掛網） | tin（前牆 z<48 死球）+ 四牆反彈 |
| 主軸物理 | 過網 + 落地 | **撞前牆有效區 + 牆反彈 + 第二落地死球** |
| 球路 | clear/smash/drop/drive/serve | drive/boast/lob/drop/kill/serve |
| 瞄準 | 對方半場落點 | 前牆撞擊點（高度+左右） |
| 計分 | 球落哪半場那方輸 | PAR-11 每球得分、淨勝 2、四種死球 |
| 重力 | 0.45 | 0.42 |
| 投影 | 俯視梯形（網中央垂直） | 面向前牆房間透視 |
| GRAVITY 共用率 | — | 物理框架 ~70% 沿用，牆反彈/計分/球路重寫 |

> **共用率 ~70%**：四支柱、InputSource/SimRunner、React 殼、測試框架、sprite 接圖、決定性 60Hz loop、timing/hit-stop 手感全照搬。重寫集中在 §4.3 牆物理 + §5 球路 + §4.4 計分 + §2.2 投影。
