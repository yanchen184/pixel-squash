# 設計：物理積分收斂 + 揮拍撞球（測試導向重構）

> 日期：2026-06-22
> 範圍：`src/game/sim/simulate.ts`（主），不動接縫框架（SimRunner / InputSource / 投影 / 決定性 60Hz）
> 決策：**不換物理引擎**。2.5D 三軸（左右 x / 深度 y / 高度 z）不適合 2D 引擎（Matter.js）。病根是「同一物理被抄 5 份」與「缺自動驗收」，不是「手寫」本身。

---

## 1. 病灶診斷（已驗證，附行號）

物理積分目前散在 **至少 5 處**，各寫一遍同樣的「重力 + 阻力 + 牆反彈 + 地板彈跳」：

| 處 | 函數 | 用途 | 行號 | 差異點 |
|---|---|---|---|---|
| A | 主 step | live rally 真實步 | `simulate.ts:411` | `vz = s.vz - GRAVITY`；`vel *= SHUTTLE_DRAG` |
| B | `previewPhysicsStep` | M 鍵 preview 慢動作 | `simulate.ts:555` | 有 `slowmo` 子步、`subDrag = SHUTTLE_DRAG^slowmo`、`PRACTICE_FLOOR_FRICTION` |
| C | `predictLanding` | 預測落點（AI 跑位 + 落點標記） | `simulate.ts:581` | **自己寫一整套迴圈**，牆反彈也自己抄一遍 |
| D | `sampleServePath` | **虛線 preview path** | `simulate.ts:913` | 又一套，畫虛線用 |
| E | airborne slowmo | 練習拋球滯空 | `simulate.ts:1084` | `PRACTICE_SLOWMO` |

**「球不跟虛線走」的數學根因**：虛線是 D（`sampleServePath`）算的，live ball 是 A（主 step）算的。兩份副本只要有任何一個常數、運算順序、或子步處理不一致，軌跡就分岔。這不是「調參數」能根治的，是**同一份邏輯有 5 個會各自漂移的副本**。

### 已坐實的具體分岔（瀏覽器 + 讀碼實證，2026-06-22）

對比 `sampleServePath`（虛線, `simulate.ts:913`）vs `predictLanding`（落點預測, `simulate.ts:595`）vs 主 step：

1. **地板摩擦不一致**：`sampleServePath` 地板反彈時 `vx *= floorFriction; vy *= floorFriction`（`simulate.ts:982-983`），但 `predictLanding` 的地板碰到就 `break`、**完全沒摩擦**（`simulate.ts:622-625`）。→ 預測落點與虛線落點本就對不上。
2. **取樣 vs 逐 tick**：虛線每 `sampleEvery` tick 記一點 + 牆事件點插入（`simulate.ts:986`）；live 逐 tick。牆反彈的 `EPS` inset / `Math.abs` 雖相似，但兩份各抄一遍 → 任何一行不同步就漂。
3. **流程**：練習發球在 `inA.swing` 那刻呼叫 `computePreviewPath`→`sampleServePath` 畫虛線（`simulate.ts:1099`），同刻 `launchPracticeRally` 把球用主迴圈物理打 live。兩條路從第 1 tick 就用不同積分。

這三點是「收斂成唯一 stepShuttle()」要消滅的對象。

## 2. 核心修法：唯一真相來源（Single Source of Truth）

把所有物理積分收斂成**唯一一個純函數**：

```ts
// 唯一的球體前進一步。所有地方都呼叫它，不准有第二份積分。
function stepShuttle(s: ShuttleState, opts: StepOpts): ShuttleState
```

`StepOpts` 涵蓋目前 5 處的差異，用參數表達而非各寫一份：

```ts
interface StepOpts {
  dt: number;              // 子步比例：live=1，slowmo preview=0.18
  floorFriction: number;   // live 用 FLOOR_BOUNCE，practice 用 PRACTICE_FLOOR_FRICTION
}
```

- **阻力一致性**：slowmo 時 `drag = SHUTTLE_DRAG^dt`，確保 1/dt 個子步乘回來剛好等於每 tick 的 `SHUTTLE_DRAG`（這個邏輯目前只在 B 正確、D 可能不一致 → 收斂後天生一致）。
- **牆/地板反彈**：沿用既有 `applyWalls`（`simulate.ts:430`）和 `applyFloorBounce`（`simulate.ts:515`），它們本來就是函數，只是沒被 C、D 共用 → 改成所有路徑都走它們。

收斂後，5 處全部改成呼叫 `stepShuttle`：

| 處 | 改後 |
|---|---|
| A live | `stepShuttle(s, { dt: 1, floorFriction: FLOOR_BOUNCE })` |
| B preview | `stepShuttle(s, { dt: PRACTICE_PREVIEW_SLOWMO, floorFriction: PRACTICE_FLOOR_FRICTION })` |
| C predictLanding | 迴圈裡每步呼叫 `stepShuttle`，刪掉手抄的牆反彈 |
| D sampleServePath（虛線） | 迴圈裡每步呼叫 `stepShuttle`，**與 live 同源** |
| E airborne | `stepShuttle` slowmo |

**結果**：虛線(D) 和 live(A) 用同一個 `stepShuttle` → **數學上不可能分岔**。

## 3. 揮拍撞球：從「近身判定」改成「球拍掃動 vs 球」

現狀（`resolveSwing`, `simulate.ts:636`）：按鍵 → 算球到球拍中心的距離 `dist <= reach`（行 665）→ 用 timing quality 算出反彈 → `solveArcToWall` 解析算目標反彈速度。**球的反彈是「解析算出的目標」，不是球拍撞出來的**。

改法（保守、可測，不引入 2D 引擎）：

- 球拍是一段**掃動弧線**（swing arc）：揮拍期間球拍佔據一個隨時間移動的位置 + 半徑。
- 碰撞判定：球的 (x, y, z) 與球拍掃動體積的距離，**逐 tick** 檢查（而非單幀近身），這樣快球也不會穿過。
- 命中時：仍用 stroke 設計（kill/lob/drop/...）決定反彈方向與力道，但**接觸點 + 接觸時機**由球與球拍的真實相對位置決定 → timing quality 變成「球拍掃到球時，球在掃動弧的哪個相位」，比現在的 `timingDelta` 更物理。
- `SWING_REACH`(100) / `SWING_REACH_Z` / `PRACTICE_HIT_RANGE`(150) 收斂成「球拍掃動體積」的尺寸參數。

> 注意：CLAUDE.md 明列 `SWING_REACH = 100` 不能亂改。本設計**不改其數值**，只改「如何用它」——把單幀點判定改成掃動體積的半徑。數值不變 → 接球手感的接球範圍不變。

## 3.5 視角 / 深度表現（Bob 指定一起處理）

現狀（瀏覽器實看，2026-06-22）：第一人稱透視 — 鏡頭在球場後方，前牆 = 畫面中央梯形玻璃牆 + 觀眾席，球員背影在畫面中下方，地板梯形透視往深處延伸，左右霓虹磚牆。**構圖本身有深度感，方向是對的**（與 Gaelco Squash 1992 後視相反：那款看球員背影朝遠處小前牆；你的是螢幕即前牆、球往螢幕深處飛再彈回）。

立即可見的問題（待確認是否在本次範圍）：

- **球員朝向疑似錯誤**：角色正面朝鏡頭站，但他要打前牆（畫面深處）→ 理應背對鏡頭。臉朝玩家與「往前打」矛盾。這可能與 task #4「跑步動畫」同源（facing 狀態錯）。
- **深度感由 `projection.ts` 的 z 高度 + 梯形投影表達**：球往深處飛時，靠 y(深度)→ 螢幕 y 的壓縮 + 球的大小變化傳達距離。手感「飄」可能部分來自**深度方向的速度感不足**（球往深處飛時螢幕位移變化太線性，缺乏近快遠慢的透視加速感）。

> 本次範圍界定（Bob 拍板：視角/深度納入第一階段）：物理收斂（§2）、揮拍碰撞（§3）、深度非線性（本節）皆為第一階段。
>
> **已查證的深度根因**：`projection.ts:70-73` 的深度映射是**線性**的——`d = p.y / COURT.depth`，且 `y`/`half`/`heightScale` 全部對 `d` 線性插值。真實透視是非線性（近快遠慢，~1/z）。球以等速往深處飛時螢幕位移均勻 → 缺「近快遠慢」的透視加速感 → 眼睛判讀成「飄/假」。
>
> **修法**：在 `toScreen` 的深度 `d` 上套一條非線性 remap（如 `d' = d^k` 或 perspective-correct `d' = d/(d + (1-d)·camDist)`），讓近處位移大、遠處位移小，貼近真實透視。需配 AC：給定球等速往深處飛，螢幕 y 位移應**遞減**（非線性），用斷言守住。
>
> **球員朝向**：`facing` 一直是 `'up'`（朝前牆，邏輯正確）；idle crop（`idleA`）若畫正面臉，是美術素材問題、非邏輯。本次先確認是否真的朝向錯（現場確認），美術替換另議，不在程式範圍。

## 4. 測試導向：先紅後綠（這是整個重構的驗收骨架）

每個改動都先寫**會紅的測試**，改完轉綠。純 Node（`npx vitest`），不需要瀏覽器。

### 驗收契約（acceptance criteria）

| # | 測試 | 斷言 | 對應痛點 |
|---|---|---|---|
| AC1 | 軌跡一致性 | 同一發球，`sampleServePath`(虛線) 每個點 vs `stepShuttle` 逐 tick live 位置，**逐點誤差 < 1px** | 球不跟虛線 |
| AC2 | predictLanding 一致 | `predictLanding` 算的落點 vs live ball 實際落點 **< 2px** | AI 跑位/落點標記準 |
| AC3 | 無回歸 | 既有 92 測試（physics-audit / simulate / practice-* / serve-trajectory）**全綠** | 不破現有物理 |
| AC4 | 揮拍碰撞 | 快球（高速）揮拍不穿透：逐 tick 掃動判定，球在球拍掃動弧內必命中 | 揮拍撞球 |
| AC5 | 常數不變 | `SHUTTLE_PACE=1.8`、`SWING_REACH=100`、`FLOOR_BOUNCE=0.58` 維持原值 | CLAUDE.md 紅線 |

### 收口定義（round-trip）

- AC1–AC5 全綠（`npx vitest run` 結果貼出來，不是「應該過」）。
- 開 `localhost:5174` 練習模式，M 鍵發球，**肉眼確認球貼著虛線走**（截圖）。
- 揮拍能擊到球（截圖 / console round-trip）。

## 5. 不做（YAGNI）

- 不換物理引擎（Matter.js / 3D 引擎）— 已否決。
- 不碰跑步動畫 — 那是純前端 sprite 切換，獨立任務（task #4），這份設計不含。
- 不重排介面 / 不改美術 — 另開議題。
- 不改 SimRunner / InputSource / 投影 / 決定性步長 — 接縫框架保留。

## 6. 風險

- **收斂積分可能改變現有手感數值**：5 份副本本來就不完全一致，收斂成 1 份等於選定其中一種行為。緩解：以 A（主 step / live rally）為基準，讓 preview/predict/虛線向 live 對齊（live 才是玩家真正體驗的），並用 AC3 守住既有測試。若 AC3 某條紅了 → 個案判斷是「測試斷言了錯誤的分岔行為」還是「我改壞了」。
- **揮拍掃動體積調參**：可能需要幾輪微調，用 AC4 + 瀏覽器截圖收斂。
