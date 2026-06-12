# Pixel Badminton — 可重建引擎規格書

> **這份文件的目標：拿到它的人，不看現有原始碼也能把這個專案重寫出來；而且能拿它當基底 fork 出姊妹遊戲（pixel-squash 壁球）。** 每個數字都對齊 `src/` 實際實作（**非設計願望值**）；改了 code 就要回來改這份。
>
> **現況（2026-06-12）**：可玩的 **Canvas 2D greybox**（純幾何、零美術素材）。羽球物理、打擊手感、3 難度 AI、完整對打計分、人類對戰 AI 全部跑通。`vitest` 綠燈、`tsc -b` 乾淨。chibi sprite 美術正在並行進行（見 §12）。
>
> **產品目標**：上 Steam / Web 的羽球對戰遊戲（行動裝置 via Capacitor，非 React Native）。當前路線 = **先把「手感 / 機制」用無皮幾何調對，貼皮中**。
>
> **姊妹遊戲**：pixel-squash（壁球）以本規格書為基底 fork，獨立 repo、各自演化。本文每節標 🟰（壁球共用，幾乎不改）/ 🔀（壁球要改寫）/ 🆕（壁球專屬新增），方便對照改寫。差異總表見 §13。
>
> 專案根：`/Users/yanchen/workspace/boardgame/pixel-badminton/`

---

## 0. 設計支柱（為什麼這樣做，不只是做了什麼）🟰

舊版（Phaser 側視 + 固定速度拋物線）被否決的根因：**球軌跡假、對打不成立、手感平**。重做圍繞四根支柱（壁球完全沿用這四根）：

1. **邏輯 3 軸、渲染 2 軸分離**。Sim 在乾淨的 3D 矩形場地算（`x` 橫向、`y` 縱深、`z` 離地高度），渲染層才把 (x,y,z) 投影成螢幕梯形。z 軸是命門——沒有它，殺球 / 高遠 / 切球無法區分（全是同一條平面線）。**壁球的牆面反彈一樣靠 z 軸才成立。**
2. **真實減速弧線**。羽球離拍快、空氣阻力讓水平速度每 tick 衰減（`SHUTTLE_DRAG`），重力不衰減 → 球「衝出去再陡降」。**壁球改成彈性球：drag 接近 1（橡膠球幾乎不減速）、撞牆反彈，但 z 軸重力模型同一套。**
3. **打擊手感三件套**：timing 視窗（perfect/good/early/late/miss）+ hit-stop（命中瞬間全 sim 凍結幾幀，給「重量」）+ swing-timing 控落點（早揮往左、晚揮往右；早揮過長出界、晚揮掛網/出底線）。這三個都活在純 sim 裡，所以能在沒有渲染器時就用單元測試斷言。**壁球沿用 timing/hit-stop，落點規則改成對牆瞄準。**
4. **決定性純函數 sim**：`step(state, inA, inB)` 固定 60Hz、無 `Math.random` / `Date`、不可變 state。同 seed + 同 input 序列 → 逐幀完全一致。這是 Phase 2 netcode 的地基。

> ⚠️ **沒有蓄力（charge）系統。** 力量完全來自 swing timing 的品質分級（perfect 最強），不是 hold 蓄力。任何文件/code 提到 `chargeFrames`/`CHARGE_FULL` 都是舊設計殘留，應刪。

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
| 部署 | Firebase Hosting（GitHub Actions auto-deploy on push master/main） | `firebase.json`、target `pixel-badminton`、project `game-hub-d2bbf` |

**runtime 相依只有 `react` + `react-dom`**。Phaser 與 zod 已移除（greybox 不需引擎、邊界驗證在 sim 內以閾值測試取代）。

`package.json` scripts：`dev` / `build`（`tsc -b && vite build`）/ `typecheck`（`tsc -b --noEmit`）/ `test`（`vitest run`）/ `e2e`（`playwright test`）。

**CI/CD**：`.github/workflows/deploy.yml`，`on: push [master, main]` + `workflow_dispatch`。流程：checkout → setup-node@22 → `npm ci` → typecheck → test → build → `npx firebase-tools deploy --only hosting:<target> --project <id> --token "$FIREBASE_TOKEN" --non-interactive`。`FIREBASE_TOKEN` 走 repo secret。**壁球 fork 改 target + project + secret 即可。**

---

## 2. 座標系（**最容易搞混，先寫死**）🟰

### 2.1 Sim 邏輯空間（`src/data/gameState.ts`）

矩形場地，三軸：

```
x ∈ [0, COURT.width]   左 → 右（橫越網）
y ∈ [0, COURT.depth]   遠 → 近（遠端底線 0 → 近端底線 depth）
z（僅球）              離地高度，+ 為上
```

- `COURT = { width: 850, depth: 500 }`
- `NET_Y = COURT.depth / 2 = 250`：網橫跨整個 y=250 那條線。
- **side 0（近端、玩家）擁有 `y > NET_Y`；side 1（遠端、AI）擁有 `y < NET_Y`。**
- `FLOOR_Z = 0`。落地 = `shuttle.z <= 0`（不是某條地板 y 線）。
- 過網 = `shuttle.pos.y` 在某一 tick 跨越 `NET_Y` 時，檢查 `z >= NET_HEIGHT(70)`，否則掛網。

> **任何把 `pos.y` 當成「高度」的程式碼 = bug。** 高度只在 `shuttle.z`。玩家 `pos` 永遠是場地平面 (x,y)，沒有高度。

🔀 **壁球差異**：無 `NET_Y`、無 `NET_HEIGHT`、無「兩半場」概念。兩名玩家共用**同一側**面對前牆。座標改成：`x` 左右、`y` 離前牆距離（前牆 y=0、後牆 y=depth）、`z` 高度。詳見 §13。

### 2.2 渲染投影（`src/game/court/projection.ts`）

Sim 軸 → 螢幕的對應**刻意跟直覺相反**（投影層為了畫面佈局把軸轉了向）：

| sim 軸 | 螢幕軸 | 說明 |
|---|---|---|
| 邏輯 `x`（0→width，橫越網方向） | 螢幕 **上→下**（depth），上窄下寬 | 梯形透視的縱深 |
| 邏輯 `y`（0→depth，遠近方向） | 螢幕 **左↔右**：`NET_Y`=畫面中央，`y<NET` 在左、`y>NET` 在右 | 網在畫面中央垂直站立 |
| 邏輯 `z`（高度） | 螢幕 y 抬高 `z * HEIGHT_LIFT(0.9)` | 越高離地畫得越上面 |

梯形錨點 `DEFAULT_PROJECTION`：`farY:250`（頂、遠底線 x=0）、`nearY:660`（底、近底線 x=width）、`farHalf:230`（頂半寬，窄）、`nearHalf:430`（底半寬，寬）、`centerX:640`（畫面中央，網所在）。

`makeProjector()` 回傳：
- `toScreen(p, height=0)`：`cx=clamp01(x/width)`（0 頂遠…1 底近，DEPTH）、`cy=clamp01(y/depth)`（0 左 side1…1 右 side0，ACROSS NET）。`half = farHalf+(nearHalf-farHalf)*cx`、`y = farY+(nearY-farY)*cx`。回 `{x: centerX+(cy-0.5)*2*half, y: y - height*0.9}`。
- `depthScale(x)`：近大遠小的 sprite 縮放。`t = farHalf/nearHalf`，回 `t+(1-t)*cx`（頂部=t、線性放大到底部 1）。

渲染 canvas 邏輯尺寸 `GAME_WIDTH=1280 × GAME_HEIGHT=720`。

🔀 **壁球差異**：俯視/側視單面牆，投影梯形改成「面向前牆」的透視；壁球可能改用側視（球在前牆上的撞擊點）。但 `toScreen`/`depthScale` 介面不變，只換錨點數值。

---

## 3. 核心資料模型（`src/data/gameState.ts`）🔀

全部不可變；`step` 產生新 state，不改舊的。

```ts
type Vec2 = { x: number; y: number };
type Side = 0 | 1;                          // 0=近(玩家)  1=遠(AI)
type Facing4 = 'down' | 'up' | 'left' | 'right';
type SwingQuality = 'perfect' | 'good' | 'early' | 'late' | 'miss';
type RallyPhase = 'serve' | 'rally' | 'point';

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
  // ⚠️ 沒有 chargeFrames。力量來自 timing 品質，不是蓄力。
};

type ShuttleState = {
  pos: Vec2; z: number;      // 場地平面 + 高度
  vel: Vec2; vz: number;     // 平面速度 + 垂直速度
  lastHitBy: Side | null;
  inPlay: boolean;
  landing: Vec2 | null;      // 預測落點（渲染畫縮圈用）
  landingEta: number;        // 距落點幀數
};

type GameState = {
  frame: number;
  p1: PlayerState; p2: PlayerState;
  shuttle: ShuttleState;
  scores: [number, number];
  phase: RallyPhase;
  server: Side;
  phaseTimer: number;
  winner: Side | null;
  hitstop: number;           // >0 時全 sim 凍結
  momentum: number;          // AI 橡皮筋計數，clamp [-MOMENTUM_MAX, MOMENTUM_MAX]
};
```

### 3.1 常數表（全部來自 `gameState.ts` / `simulate.ts`，重建時照抄）

| 常數 | 值 | 檔案 | 意義 |
|---|---|---|---|
| `COURT` | `{width:850, depth:500}` | gameState | 邏輯場地 |
| `NET_Y` | 250 | gameState | 網線（depth/2） |
| `NET_HEIGHT` | 70 | gameState | 過網最低高度 |
| `FLOOR_Z` | 0 | gameState | 地板高度 |
| `STAMINA_MAX` | 100 | gameState | |
| `POINTS_TO_WIN` | 11 | gameState | 先到 11 分勝 |
| `PLAYER_SPEED` | 9.5 | gameState | 每 tick 邏輯 px（雙軸） |
| `SWING_COOLDOWN_FRAMES` | 14 | gameState | 揮拍冷卻 |
| `SWING_REACH` | 95 | gameState | 可擊球的地面距離 |
| `SWING_REACH_Z` | 150 | gameState | 可擊球的最高球高 |
| `RACKET_REACH_OFFSET` | 48 | gameState | 拍頭領先身體往網方向的偏移（見 §3.2） |
| `SWING_MAGNET_RANGE` | 150 | gameState | 磁吸對位生效範圍 |
| `SWING_MAGNET_PULL` | 0.18 | gameState | 每 tick 拉近缺口比例 |
| `TIMING_PERFECT` | 3 | gameState | \|Δtick\| ≤3 → perfect |
| `TIMING_GOOD` | 7 | gameState | ≤7 → good |
| `TIMING_WINDOW` | 12 | gameState | ≤12 → early/late |
| `STRIKE_Z` | 55 | gameState | timing 對準的理想接觸高度 |
| `SHUTTLE_DRAG` | 0.988 | gameState | 水平空氣阻力（每 tick 乘） |
| `SHUTTLE_PACE` | 1.9 | gameState | 全域節奏撥盤（飛行時間倍率，越大越慢越好讀） |
| `APEX_CEIL` | 190 | gameState | 弧頂硬上限（防球飛出畫面頂） |
| `HITSTOP_PERFECT/GOOD/WEAK` | 6 / 3 / 1 | gameState | 各品質凍結幀 |
| `MOMENTUM_MAX` | 4 | gameState | 橡皮筋計數上限 |
| `DIVE_FRAMES` | 10 | gameState | 魚躍滑行長度 |
| `DIVE_SPEED` | 17 | gameState | 魚躍滑速（≈1.8× 跑速） |
| `DIVE_REACH_BONUS` | 90 | gameState | 魚躍時額外擊球距離 |
| `DIVE_RECOVERY_FRAMES` | 30 | gameState | 魚躍後趴地鎖定 |
| `DIVE_STAMINA_COST` | 25 | gameState | 魚躍體力消耗 |
| `DIVE_MIN_STAMINA` | 10 | gameState | 低於此無法魚躍 |
| `PLAYER_MARGIN` | 40 | gameState | 玩家可移動範圍離界邊距 |
| `GRAVITY` | 0.45 | simulate | 高度 px/tick²，**AIInput 須 import 同步** |
| `SWING_COST` | 8 | simulate | 揮拍體力消耗 |
| `STAMINA_REGEN` | 0.5 | simulate | 每 tick 體力回復 |
| `OUT_OVERSHOOT` | 360 | simulate | 最嚴重 early 過揮瞄準超出底線的 px（pre-drag） |
| `NET_DIP_MAX` | 0.55 | simulate | 最嚴重 late 揮拍殺掉的 vz 比例（掛網） |

`createInitialState()`：兩名玩家在各半場（近 `y=depth*0.78`、遠 `y=depth*0.22`，x 置中），phase=`serve`、server=0、scores=[0,0]、momentum=0。`makePlayer(side)`：近 side 0 facing `left`（畫在右、面左）、遠 side 1 facing `right`（畫在左、面右）。`resetForServe(state, server)` 把球停在發球員上方 `z=90`、`phaseTimer=45`、清魚躍狀態。

### 3.2 拍頭擊球幾何（`racketCenter`）🔀

擊球判定圈**不以腳底為心，以拍頭為心**——拍子握在身體前方（往網方向）。

```ts
function racketCenter(pos, side, offset = RACKET_REACH_OFFSET=48): Vec2 {
  const toward = side === 0 ? -1 : 1; // 把 y 往網方向移的符號
  return { x: pos.x, y: pos.y + toward * offset };
}
```

近 side 0 擁有 `y > NET_Y`，其網在較小 y → `toward=-1`（拍頭往小 y 伸）。所以「身前的球伸手可及、背後的球更難打」。**sim 的 hit test 與渲染的 reach 圈共用這個函數，永不漂移。** 🔀 壁球無網，拍頭偏移改成「朝前牆方向」。

---

## 4. Sim 主迴圈（`src/game/sim/simulate.ts` 的 `step`）🔀

純函數 `step(state, inA, inB) → nextState`，固定 60Hz。流程：

1. `winner !== null` → 原樣回傳（凍結已結束的比賽）。
2. `frame++`。
3. **hit-stop**：`hitstop > 0` → 只回傳 `{...state, frame, hitstop: hitstop-1}`，**不動任何移動 / 物理**（frame 仍進，讓渲染與 FX 繼續）。
4. **serve / point phase**：`phaseTimer--`；歸零時 point→`resetForServe`、serve→`launchServe`。
5. **rally tick**：
   - `p1 = movePlayer(p1, inA, 0, shuttle)`、`p2 = movePlayer(p2, inB, 1, shuttle)`
   - `shuttle = stepShuttle(shuttle)`：重力 + 水平阻力推進
   - `resolveSwing` 各方一次（命中改球速度向量、設 `justHit`、算 hitstop），取兩者 hitstop 最大值
   - `shuttle = applyNet(shuttle, prevShuttle)`：跨網時若 `z < NET_HEIGHT` 掛網落己方 🔀
   - `shuttle = predictLanding(shuttle)`：前向積分一份複本到 `z<=0`，填 `landing`/`landingEta`
   - `shuttle.inPlay && shuttle.z <= 0` → `scorePoint`

### 4.1 移動（`movePlayer`）🟰

優先序（早 return）：
1. 冷卻 `swingCooldown = max(0, -1)`；`facing` 由 side 決定（0=left, 1=right）；`justHit=false`。
2. **趴地**（`diveRecovery>0`）：不能動 / 不能揮，`vel=0`，體力慢回 `+STAMINA_REGEN`，`diveRecovery--`。
3. **魚躍中**（`diveFrames>0`）：沿 `diveDir` 以 `DIVE_SPEED` 滑（`clampX`/`clampY`），無視移動 input；`diveFrames--`，歸零那幀設 `diveRecovery=DIVE_RECOVERY_FRAMES`（趴地）。
4. **觸發魚躍**（`input.dive && stamina >= DIVE_MIN_STAMINA`）：朝 `diveDirection`（有移動 input 用之，靜止時朝球）lunge，扣 `DIVE_STAMINA_COST`，`diveFrames=DIVE_FRAMES`。
5. **一般移動**：`speed = PLAYER_SPEED * (stamina>0 ? 1 : 0.5)`，`pos += move * speed`。
   - **磁吸對位**：球在我方半場（side 0：`shuttle.y>NET_Y`）、`inPlay`、`z<=SWING_REACH_Z`、且我離球地面點 `<=SWING_MAGNET_RANGE` 時，`pos += gap * SWING_MAGNET_PULL`。「跑到區域就夠，不必像素級對位」，小幅拉力不瞬移、好對位仍勝。
   - 最後 `clampX`（界內 margin）+ `clampY`（自己半場內，可觸網不可越網 🔀）。`vel` 記為 `move*speed`，體力 `+STAMINA_REGEN`。

`clampX(x) = clamp(x, PLAYER_MARGIN, COURT.width-PLAYER_MARGIN)`。
`clampY(y, side)`：side 0 → `clamp(y, NET_Y+MARGIN, depth-MARGIN)`；side 1 → `clamp(y, MARGIN, NET_Y-MARGIN)`。🔀 壁球兩人共用整場，clampY 改成整場界內。

### 4.2 揮拍判定（`resolveSwing`）— 手感核心 🔀

- 趴地（`diveRecovery>0`）不能揮，原樣回。
- `diving = diveFrames>0`。**魚躍每幀自動揮**（lunge 即救球嘗試）；非魚躍要 `input.swing` edge + `swingCooldown==0`。
- **stroke 解析**：人類（`input.timingAim==true`）對「不合法的 stroke 自動降級成 clear」（低球殺/遠處切 → 改 clear 而非揮空被罰）；AI 保留原 stroke（其 `pickStroke` 已 gate 合法性）。
- 擊球幾何：`hitFrom = diving ? pos : racketCenter(pos, side)`。`dist = |shuttle.pos - hitFrom|`。`reach = diving ? SWING_REACH+DIVE_REACH_BONUS : SWING_REACH`，`reachZ = diving ? SWING_REACH_Z+DIVE_REACH_BONUS : SWING_REACH_Z`。`reachable = dist<=reach && z<=reachZ`。
- 魚躍回球一律當 `drive`（潦草平抽救球）。
- **不可及**：魚躍中→繼續 lunge 不算 whiff；一般揮空→仍扣 `SWING_COOLDOWN_FRAMES` + `SWING_COST` 體力、`lastQuality='miss'`（commitment 懲罰）。
- **timing**：`timingDelta(shuttle)` 算 signed Δtick（球距 z 落到 `STRIKE_Z` 的時刻；**正=早揮（球還在上方/上升）、負=晚揮**）。`qualityFromDelta` 分桶：`|dt|≤TIMING_PERFECT` perfect、`≤TIMING_GOOD` good、否則 early（dt>0 或上升）/ late。魚躍 `dt=0`、`quality='good'`。
- `accuracy = ACCURACY[quality]`、`power = POWER[quality]`（**無蓄力乘項**）。
- **fault 誤擊**（非魚躍）：`faultMisfire(stroke, pl, shuttle)` true → 球軟掉落己方（`vel=0, vz=-2`），輸這球。
- **左右落點**：人類 `aimX = aimXFromTiming(dt) = clamp(-dt/TIMING_WINDOW, -1, 1)`（**早揮往左、晚揮往右**）；AI 用 explicit `input.aimX`。
- **深度 fault**（in/out 由 timing 決定，PLAN 舊版漏的精華）：
  - `faultDt = timingAim ? dt : (input.faultBias ?? 0)`（AI 無 timing，注入合成 mistime）。
  - `applyDepthError(target, faultDt, side)`：**early（dt>0）過揮 → 落點往對方底線外 lerp（出界）**，severity 由 `mistimeSeverity`（超出 good 視窗才 ramp）。late 不在此推（移動目標無法讓球落短）。
  - **late（faultDt<0）→ 殺 vz**：`launch.vz *= 1 - NET_DIP_MAX*mistimeSeverity`（過網不過 → **掛網**）。
  - 乾淨球（good/perfect、AI faultBias=0）這兩條都不動。
- 命中：`target = aimTargetForStroke(...)` → `solveArc(shuttle.pos, z, aimed, stroke, power)` → 球 `vel/vz` 設為 launch，`lastHitBy=side`，`justHit=true`，`hitstop = diving ? HITSTOP_WEAK : HITSTOP[quality]`。

分級表（`simulate.ts`）：

| quality | ACCURACY | POWER | HITSTOP |
|---|---|---|---|
| perfect | 1.0 | 1.15 | 6 |
| good | 0.8 | 1.0 | 3 |
| early | 0.45 | 0.78 | 1 |
| late | 0.45 | 0.78 | 1 |
| miss | 0.2 | 0.6 | 0 |

### 4.3 球飛行（`stepShuttle` / `solveArc` / `applyNet`）🔀

- **`stepShuttle`**：`vz -= GRAVITY`；`pos += vel`；`vel *= SHUTTLE_DRAG`（水平衰減）；`z += vz`。重力不衰減 → 垂直陡降、水平軟化 = 羽球弧線。🔀 **壁球**：`SHUTTLE_DRAG≈0.998`（橡膠球幾乎不減速）+ 撞牆反彈（見 §13）。
- **`predictLanding`**：複製一份球，鏡像 `stepShuttle`（同 drag+gravity）前向積分到 `z<=0` 或 `t>=MAX(240)`，填 `landing/landingEta`。**純 look-ahead 不改 live 球**，渲染畫縮圈。🔀 壁球的落點預測要含牆反彈。
- **`solveArc(pos, z0, target, stroke, power=1)`**：
  - `apex = max(stroke.apex, z0+12)`、`baseVz = sqrt(2·GRAVITY·(apex-z0))`、`tRise = baseVz/GRAVITY`、`tFall = sqrt(2·apex/GRAVITY)`。
  - `tofRaw = clamp(tRise+tFall, stroke.tof[0], stroke.tof[1])`；`tof = tofRaw * SHUTTLE_PACE * stroke.pace / power`（power 越高飛行越短越平）。
  - `vz = (0.5·GRAVITY·tof² - z0) / tof`（解 z(tof)=0，保證落地落在 target 水平位置）。
  - **APEX_CEIL 夾頂**：若 `vz>0 && z0+vz²/(2g) > APEX_CEIL` → `vz = sqrt(2·GRAVITY·(APEX_CEIL-z0))`，`tof` 重解為較大的落地根。防飄球衝出畫面頂。
  - 回 `{vx: dx/tof, vy: dy/tof, vz}`。
- **`applyNet(s, prev)`** 🔀：本 tick 跨網（`(prev.y-NET_Y)*(s.y-NET_Y)<0`）且 `z<NET_HEIGHT` → 掛網：球落打者那側（`NET_Y±6`）、`vel=0`、`vz=-|vz|*0.3`。**壁球無此函數，改成 `applyWalls`（四面牆反彈）。**

### 4.4 發球與計分（`launchServe` / `serveTarget` / `scorePoint`）🔀

- **`serveTarget(server)`**：發到接球方半場**中段**（server 0 → `y=depth*0.4`、server 1 → `y=depth*0.6`），x 置中。**這是 rally-collapse 修復的一半**——舊版發深球會飛過接球員頭頂，每球必失。
- **`launchServe`**：從發球員位置 `z=90` 用 `STROKES.serve` 解弧線發出，`predictLanding`，phase→`rally`。
- **`scorePoint`**：
  - 取落點 (x,y) 與 `lastHitBy`。
  - **出界**（`x<0||x>width||y<0||y>depth`）且有 hitter → **hitter 輸**（他打出界）。
  - **界內** → 球落在哪半場（`y>NET_Y` 為 side 0 半場），那半場的人**輸**，對方得分。
  - `scores[scoringSide]++`；`>=POINTS_TO_WIN` 設 `winner`。`server=scoringSide`、`phaseTimer=60`、phase→`point`。
  - **momentum**：人類（side 0）得分 +1、AI 得分 -1，`clamp[-4,4]`。
- 🔀 **壁球計分**：無「兩半場落地」概念。改成壁球規則：球第二次落地、或沒打到前牆有效區、或出界 → 失分（英式/美式 PAR 計分擇一，見 §13）。

---

## 5. 球路系統（`src/data/strokes.ts`）🔀

`StrokeId = 'clear' | 'smash' | 'drop' | 'drive' | 'serve'`。每路一個「手感」，全部對齊 `GRAVITY=0.45`、`NET_HEIGHT=70` 調出：

| stroke | label | apex | tof | pace | aim | fault 閘 | frames | 手感 |
|---|---|---|---|---|---|---|---|---|
| clear | 高遠球 | `NET_HEIGHT+70`=**140** | [24,44] | 1.0 | deep | 無 | 4 | 最高最飄、深到底線的安全 reset（預設） |
| smash | 殺球 | `NET_HEIGHT+5`=**75** | [16,24] | **0.6** | bodyline | `min-contact-z: z>=70` | 5 | 最平最快，剛過 tape 就砸對手身體；低球只能改 clear |
| drop | 切球 | `NET_HEIGHT+45`=**115** | [40,56] | **1.15** | net | `max-net-dist: dist<=200` | 5 | 過網即墜前場；離網太遠掛網 |
| drive | 平抽 | `NET_HEIGHT+18`=**88** | [18,28] | 0.78 | **deep** | 無 | 4 | 低快平抽到後場角落（非身體線） |
| serve | 發球 | `NET_HEIGHT+25`=**95** | [24,40] | 1.0 | deep | 無 | 6 | 剛過網落進接球區，公平可回 |

- `DEFAULT_STROKE = 'clear'`。`StrokeFault` 兩種：`min-contact-z`（球高 ≥ z 才能打，smash 用）/ `max-net-dist`（離網距離 ≤ dist 才能打，drop 用）。
- **`aimTargetForStroke(aim, side, opponent, aimX=0, aimY=0, accuracy=1)`** → 落點 Vec2：
  - 對方場角：`deep`（side 0→`depth*0.04`、貼底線）、`front`（`NET_Y∓70`、剛過網）、`mid=(deep+front)/2`；`xEdgeL=width*0.08`、`xEdgeR=width*0.92`、`centerX=width*0.5`。
  - 自然 y 由 aim 決定（net/frontcourt/deep/bodyline）。`aimY` 連續 [-1,+1] 從自然區 lerp 到 net 或底線。
  - `aimX` 連續 [-1,+1] 從 center lerp 到 sideline；無 aim（=0）時 bodyline 打對手身體、其餘打遠離對手側。
  - **accuracy blend**：`targetX = lerp(centerX, targetX, accuracy)`、`targetY = lerp(centerY, targetY, accuracy)`——mistimed 揮拍往安全中心收，perfect 精準落角。
- `distToNet(pos) = |pos.y - NET_Y|`（drop fault 用）。

🔀 **壁球球路**：clear/smash/drop/drive 概念換成壁球擊法——**drive（直球打前牆）、boast（打側牆繞）、lob（高球到後場）、drop（前牆低點輕放）、kill（低殺）、serve**。aim 改成「前牆上的撞擊高度 + 左右」。fault 改成「未過 tin（前牆下界紅線）= 掛網等價」。

> tof 與 apex 是針對 `GRAVITY=0.45` 調的，**改重力要整套重調**。

---

## 6. 輸入系統（`src/game/input/`）🟰

### 6.1 `InputSource` 介面（`InputSource.ts`）— Phase 2 接縫

```ts
type InputFrame = {
  moveX: -1|0|1; moveY: -1|0|1;
  swing: boolean;        // EDGE（just-pressed），非 held
  stroke: StrokeId;      // 永遠 explicit（按鍵選 / AI 命名）
  timingAim: boolean;    // true=人類，sim 由 swing timing 推 aimX（早左晚右），忽略 aimX 欄
  aimX: number;          // 連續 -1左…+1右，僅 timingAim=false（AI）時用
  aimY: number;          // 連續 -1近網…+1深，AI 用；人類深度來自 stroke 故留 0
  dive: boolean;
  faultBias: number;     // AI-only 合成 mistime：+ 過長出界 / − 掛網 / 0 乾淨；人類恆 0
};

interface InputSource {
  readonly side: Side;
  sample(state: GameState): InputFrame;  // AI 會讀 state
  reset?(): void;
}
```

> ⚠️ **沒有 `charge` 欄位。** 人類的力量 / 落點全來自 `swing` 的 timing；AI 用 `aimX/aimY/faultBias`。`LocalInput` 與 `AIInput` 都實作此介面，sim 不知道差別。Phase 2 換 `NetworkedInputSource` 即連網，零改 sim。

### 6.2 `LocalInput`（鍵盤 + 觸控，P1）

- 移動：WASD / 方向鍵。
- **球路由 stroke 鍵決定**（各自 press-edge）：`J=殺球 smash`、`K=吊球 drop`、`L=平抽 drive`、`Space=高遠球 clear`。本 tick 第一個按下的鍵勝；`swing = (stroke !== null)`。觸控用 `touch.stroke`。
- 魚躍：`Shift`（K 現在是 drop）或觸控 dive 鈕。
- **螢幕軸 vs 邏輯軸**：螢幕上下 → 邏輯 `moveX`（`down&&!up→1`、`up&&!down→-1`）；螢幕左右 → 邏輯 `moveY`（因為投影把軸轉了，見 §2.2）。
- **落點**：`timingAim=true`，左右由 sim 從 timing 推，深度由 stroke 決定，故 `aimX=0, aimY=0, faultBias=0`。

### 6.3 `AIInput`（3 難度，P2）— rally 修復的核心檔

決定性 seeded LCG（**非 `Math.random`**）。`import { GRAVITY } from '@/game/sim/simulate'` 保持物理同步。三難度調**五**參數：

| 參數 | easy | medium | hard | 意義 |
|---|---|---|---|---|
| `reactionDelay`（tick） | 10 | 5 | 2 | 偵測新球後反應倒數 |
| `predictionAccuracy` | 0.5 | 0.82 | 1.0 | 落點預測精度（errX/errY 反比） |
| `fumbleRate` | 0.22 | 0.09 | 0.02 | 整球不揮拍（漏球）機率 |
| `faultRate` | 0.2 | 0.08 | 0.02 | 接觸但打壞（出界/掛網）機率，注入 `faultBias` |
| `deadzone`（px） | 28 | 18 | 10 | 目標附近不再挪移的容差 |

> `fumble` = 沒接觸；`fault` = 有接觸但球壞掉（走 §4.2 同一條 depth-error/net-dip path）。

決策迴圈：偵測新球 → `reactionDelay` 倒數 → 預測落點（`0.5·GRAVITY` 反解 z，加 `predictionAccuracy` 反比的隨機 errX(`width*0.12`)/errY(`depth*0.1`)）移過去（`deadzone` 容差）→ 進 reach 且冷卻 0 且不 fumble → 揮拍（`pickStroke` 依球高選 smash/drop/clear，**鏡像 sim 的 fault 閘所以絕不選必失球**）→ 不在 reach 但在魚躍範圍內則救球。

> **rally-collapse 核心 bug（已修）**：「新球偵測」原本只在球速 y 方向**翻號**時觸發。發球若方向跟上一拍同向，sign 永不翻 → 殘留的 `fumbleThisShuttle=true` 卡住 → 接發球方**每球必失誤**（屠殺局）。修法：新增 `wasInPlay` 狀態，把「`inPlay` false→true 的發球瞬間」當第二觸發條件 OR 進去。修後對打平均 >3 拍、比分競爭。🟰 **壁球 fork 務必保留此修復。**

### 6.4 `SimRunner`（`src/game/sim/SimRunner.ts`）🟰

固定 60Hz accumulator，與渲染 framerate 解耦。`TICK_MS=1000/60`、`MAX_STEPS_PER_FRAME=5`。`update(deltaMs)` 累積時間、每滿 TICK_MS 跑一次 `step`，單幀最多 5 步（避免長卡頓後死亡螺旋；達上限歸零 accumulator）。`current` getter 給渲染讀最新 state；`reset()` 重置並呼叫兩 input 的 `reset?()`。

---

## 7. 渲染（`src/game/render/CanvasRenderer.ts`）🔀

**Greybox→sprite 過渡中**：原本純 Canvas 2D 幾何圖元（capsule 身體 + arc 頭 + 程式畫球拍），正換成 chibi sprite drawImage（見 §12）。擁有 runtime 迴圈（RAF），驅動 `SimRunner` 並畫最新 state；所有 gameplay 數學留在純 sim，這層只投影 (x,y,z) → 梯形螢幕 + 畫。透過 `eventBus` 與 React 溝通（HUD 接縫）。

- `start()` 啟 RAF：`dt=min(100, now-lastTime)`（夾切分頁尖峰）→ `runner.update(dt)` → `advanceFx` → `draw` → `syncHud`。
- 畫順序（far→near）：bg → 球場梯形 + 線 → 網背面 mesh+posts → 落點縮圈 → 兩玩家影子 + 球影 → `drawPlayer(p2)` → `drawPlayer(p1)`（近後畫，正確遮擋）→ 網正面 tape → 球（含羽毛尾巴指示方向）→ 命中 burst → hit-stop 白閃。
- **`drawPlayer`**：`foot = toScreen(pos, 0)`（**腳底中心錨點**）、`scale = depthScale(pos.x)`。目前 `bodyH=64*scale`、`bodyW=30*scale`。sprite 化後 sprite 腳底正中對 `foot`，高度 `~76*scale`。`facing` left（近）水平翻轉。
- **`drawRacket`**：揮拍弧由 `swingCooldown/SWING_COOLDOWN_FRAMES` 驅動（1=剛揮、0=待命）；`faceSign` 由 facing 決定，兩邊都朝網揮。
- FX 純渲染端（不回饋 sim）：命中 edge spawn burst、品質分級閃色（perfect 加十字火花）、screen-shake（perfect 9 / good 5 / 其他 2，每幀 *0.82 衰減）。
- `syncHud` 只在變化時 emit：`score:changed` / `stamina:changed` / `match:over`。測試接縫 `debugState()` 回 `runner.current`。

> **RAF 注意**：Chrome 在分頁 `document.hidden` 時把 RAF throttle 到 ~0。瀏覽器自動化測試若分頁在背景，sim 看似凍結——測試 artifact 非 bug，可用 `runner.update(16.67)` 手動步進繞過。

`src/game/eventBus.ts` = 本地 pub/sub，正是 Phase 2 被 server socket 取代的接縫。

---

## 8. React 殼層（`src/ui/`、`src/main.tsx`）🟰

React 只做選單與 HUD overlay，**不碰遊戲迴圈**：

- `App.tsx`：畫面狀態機（menu → 難度選擇 → match → 結算）。
- `GameView.tsx`：掛 `<canvas>`、`new CanvasRenderer(canvas, {difficulty})`、`start()/stop()` 生命週期。
- `Hud.tsx`：比分 / 體力 / 勝負，訂閱 `eventBus`（含 CSS chibi 頭像）。
- `Controls.tsx` + `useOrientation.ts`：操作說明 / 觸控按鈕 / 橫豎屏。

---

## 9. 測試（`tests/`）🟰

`vitest run`，3 檔：

- **`simulate.test.ts`**：決定性（同 input 同 state）、frame 遞增、發球流程、計分、勝負凍結、playfield 不變量（球界內、玩家不越網），以及 **rally-feel 回歸測**：`playMatch(seedA,seedB)` 跑完整 AI-vs-AI 局、用 `swingCooldown` 0→nonzero edge 數每回合擊球數，斷言 `rallyHits.length>=5`、`avg>3`、兩拍局 `<50%`。**這是 rally-collapse 的回歸網**。
- **`feel.test.ts`**：timing 視窗（sweet-spot 揮拍=perfect、上升球=非 perfect）、hit-stop（perfect 凍結 `HITSTOP_PERFECT` 幀、凍結期間球不動只有 frame 進）。純 sim 斷言，無需渲染器。
- **`strokes.test.ts`**：5 球路 profile + 落點解析。

> 寫新功能照 TDD：先寫測試（RED）→ 最小實作（GREEN）→ 重構。sim 是純函數，幾乎所有機制都能在這層斷言。

---

## 10. 重建步驟（從零）

1. `npm create vite@latest`（react-ts）；裝 vitest + @playwright/test。`tsconfig` 設 `@/*` → `src/*` path alias，`vite.config.ts` 對應 resolve.alias。
2. **`src/data/gameState.ts`**：照 §3 型別 + §3.1 常數 + §3.2 `racketCenter` + `createInitialState`/`resetForServe`。
3. **`src/data/strokes.ts`**：照 §5 五 profile + `aimTargetForStroke` + `distToNet`。
4. **`src/game/input/InputSource.ts`**：照 §6.1 介面（**含 `timingAim` / `faultBias`，無 `charge`**）。
5. **`src/game/sim/simulate.ts`**：照 §4 純 `step`（move → shuttle → swing → net → landing → score）。**先把 `feel.test.ts` 與 `simulate.test.ts` 寫出來再實作**（TDD）。注意 timing→落點/fault 全鏈（§4.2）。
6. **`src/game/input/AIInput.ts`**：照 §6.3，**務必含 `wasInPlay` 發球邊偵測** + 5 參數 + `faultBias` 注入，否則 rally-feel 測必掛。
7. **`src/game/input/LocalInput.ts`** + `touchControls.ts`：照 §6.2（J/K/L/Space 選 stroke、timingAim=true）。
8. **`src/game/sim/SimRunner.ts`**：照 §6.4 accumulator。
9. **`src/game/court/projection.ts`**：照 §2.2 梯形投影。
10. **`src/game/render/CanvasRenderer.ts`** + `eventBus.ts`：照 §7。
11. **`src/ui/*` + `main.tsx`**：照 §8 React 殼。
12. 跑 `npm test`（綠）+ `npm run typecheck`（乾淨）+ 瀏覽器 round-trip（AI-vs-AI 多拍、人類能打完一局）。

**驗收依賴順序**：座標/投影（§2）→ sim（§4）→ AI（§6.3）→ 渲染（§7）→ UI（§8）。座標契約沒立好，後面全是猜。

---

## 11. 路線圖

### 已完成
- [x] 邏輯 3 軸 sim + 真實減速弧線（drag + 不衰減重力）
- [x] timing / hit-stop 手感（純 sim、單元測試覆蓋）
- [x] swing-timing 控落點（早左晚右）+ early 出界 / late 掛網 fault 全鏈
- [x] 5 球路 + fault 閘 + 玩家控落點 + accuracy blend
- [x] 3 難度決定性 AI（5 參數）+ 橡皮筋 momentum + faultBias
- [x] 魚躍救球
- [x] Canvas 2D greybox 渲染 + RAF 迴圈 + 拍頭擊球幾何
- [x] rally-collapse 修復 + 回歸測
- [x] React 選單 / HUD + Firebase auto-deploy

### 進行中
- [ ] chibi 二頭身 sprite 美術接圖（§12）

### 下一步
- [ ] 人類實際試玩手感校準
- [ ] 觸控操作行動裝置 round-trip（Capacitor 打包）
- [ ] 音效 / 簡單粒子
- [ ] 局數 / 賽制（目前單局 11 分）

### Phase 2 — 連網 server-authoritative（延後，但接縫已備）
三個接縫讓連網不是重寫：`InputSource`（換 NetworkedInputSource + client prediction）、`eventBus`（→server socket listener）、決定性靠自有 fixed-60Hz loop + 量化座標 + 無引擎物理保證。

---

## 12. 美術：chibi 二頭身 sprite（進行中）🔀

> 2026-06-12 起。原 greybox 用純幾何畫球員（capsule+arc+程式球拍）。改用 **可愛 chibi 二頭身 pixel sprite**，`drawImage` 取代幾何。換裝娃娃機制已廢棄（孤兒資產目錄已清）。

- **比例**：二頭身（頭 ≈ 身高一半），大眼可愛 mascot。pixel-art、透明底。
- **隊色**：p1 藍（`#4a9ad0`）、p2 紅（`#d04a6a`）。
- **接圖規格**（對齊 §7 `drawPlayer`）：sprite 腳底正中對 `foot = toScreen(pos,0)`；`dx=foot.x - w/2`、`dy=foot.y - h`；尺寸隨 `depthScale` 縮放。sprite 統一畫**面朝右**，近 side 0（facing left）用 `ctx.scale(-1,1)` 水平翻轉。
- **動作幀**（由 state 推）：待命 / 揮拍（`swingCooldown>0`）/ 撲救（`diveFrames>0`）/ 倒地（`diveRecovery>0`）。
- **球拍**：第一版畫進 sprite（少一層對齊）；或保留程式 `drawRacket` 疊上。
- 素材目錄：`public/assets/players/`。生成走 codex `image_gen`（透明底、絕對路徑落地、round-trip 驗 file+sips+Read）。

---

## 13. 壁球 fork 差異總表（pixel-squash 改寫指引）🆕

> pixel-squash 複製本專案整包當基底後，照下表逐項改。**沒列在下表的一律照搬**（§0/§1/§6/§8/§9/§12 框架幾乎不動）。

| 面向 | 羽球（本專案） | 壁球（pixel-squash） |
|---|---|---|
| 場地拓樸 | 兩半場 + 中間網，雙方各守一半 | **單面前牆 + 四面牆，兩人共用整場**面對前牆 |
| 座標 y | 0=遠底線…depth=近底線，網在 depth/2 | 0=前牆…depth=後牆，**無網線** |
| `NET_Y/NET_HEIGHT` | 250 / 70 | **刪除**，改 `TIN_HEIGHT`（前牆下界紅線，球須打在其上）+ `FRONT_WALL` 有效區 |
| `applyNet` | 跨網 z<70 掛網 | **改 `applyWalls`**：球撞四面牆反彈（`vel.x/y` 翻號 × 反彈衰減係數 `WALL_BOUNCE≈0.9`），撞前牆才算有效回擊 |
| `SHUTTLE_DRAG` | 0.988（羽球陡降） | **≈0.998**（橡膠球幾乎不減速，靠撞牆與重力耗能） |
| 球物理重點 | 過網 + 落地 | **第一落地前須先觸前牆有效區**；可吃側牆/後牆反彈 |
| 球路 strokes | clear/smash/drop/drive/serve（過網） | **drive/boast/lob/drop/kill/serve**（瞄前牆撞擊高度+左右） |
| stroke.aim | 對方半場 deep/net/bodyline | **前牆撞擊點**（高 lob、低 kill、側 boast） |
| fault 閘 | smash 需高球、drop 需近網 | kill 需低球、boast 需角度、**未過 tin = 失分** |
| `clampY` | 鎖自己半場 | **整場界內**（兩人共用，需處理互相遮擋/讓位） |
| `movePlayer` 半場判定 | side 0 守 y>NET | **兩人同場**，磁吸對位以「誰離球近」決定該誰接 |
| 發球 `serveTarget` | 發到對方半場中段 | **發球打前牆 → 反彈落對角發球區**（壁球發球規則） |
| 計分 `scorePoint` | 球落哪半場那方輸 | **壁球 PAR 計分**：球第二次落地/未觸前牆有效區/出界 → 失分；建議美式 PAR-11（每球得分制，先 11、需淨勝 2 分）|
| 投影 | 俯視梯形（網在中央垂直） | **面向前牆的透視**（前牆為畫面主體，可側視或第三人稱） |
| 渲染遮擋 | far→near 一前一後 | 兩人同場 + 牆，需 z-sort 或半透明處理擋球 |
| AI `pickStroke` | 依球高選 smash/drop/clear | 依球位選 kill/boast/lob/drop |
| 部署 target | pixel-badminton / game-hub-d2bbf | **pixel-squash 新 site/project** |

**壁球 fork 步驟**：
1. `cp -r pixel-badminton pixel-squash`，刪 `.git`，`git init` 獨立 repo。
2. 改 `package.json` name、`firebase.json` target、`.github/workflows/deploy.yml` target/project/secret、README。
3. **改 `gameState.ts`**：刪 NET 常數、加 TIN/WALL 常數、改 COURT 語意（y=前牆距離）、改 `racketCenter` 偏移朝前牆、改 `clampY` 為整場。
4. **改 `simulate.ts`**：`applyNet`→`applyWalls`（四牆反彈）、`SHUTTLE_DRAG`、`predictLanding` 含牆反彈、`scorePoint` 壁球規則、`serveTarget` 對角發球。
5. **改 `strokes.ts`**：六種壁球球路 + 前牆瞄準。
6. **改 `AIInput.ts`**：`pickStroke` 壁球擇法（保留 `wasInPlay` 修復 + 5 參數結構）。
7. **改 `projection.ts`**：面向前牆的梯形錨點。
8. **改 `CanvasRenderer.ts`**：畫前牆 tin/有效區、四牆、兩人同場、sprite（沿用 §12 chibi）。
9. `tests/` 改成壁球不變量（球須先觸前牆、牆反彈守恆、PAR 計分）。
10. round-trip：AI-vs-AI 多拍、人類能打完一局。

> **核心可複用率 ~70%**：§0 四支柱、§6 InputSource/SimRunner、§8 React 殼、§9 測試框架、§12 sprite 接圖規格、決定性 60Hz loop 全部照搬。改寫集中在 sim 物理（牆 vs 網）+ strokes + 計分 + 投影錨點。

---

## 附錄 A — 已廢棄的美術 pipeline（封存）

> 早期研究過 paper-doll 換裝系統（`public/assets/{parts,anim,courts,sprites}/`），**已全數刪除**（從未接線進 greybox）。現行美術走 §12 chibi sprite 直繪，不走 paper-doll。RPG-Maker 俯視 45° 參考方向亦封存。日後若要上皮，沿用 §2.2 梯形投影錨點可對齊像素。
