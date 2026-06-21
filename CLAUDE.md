# pixel-squash — 專案規範

## Git

- **寫完就直接推**:這個專案的 commit 不用問,寫完、驗過(typecheck/build 綠)就 `git push`。push 後 CI 驗證一次性走完即可,不要無限輪詢。

## 狀態頁維護(硬約束)

- **單一事實來源**:`D:\projects\frontend\pixel-squash\status.html` — 條列式功能清單 + 25 項驗收目標(各自驗法 A/B/C + 通過狀態)+ 三層測試金字塔總覽。
- **常駐站台**:已部署到 `https://html.yanchen.app/pixel-squash/`(同後端 pages.dev:`https://html-yanchen-app.pages.dev/pixel-squash/`)。
- **觸發條件 — 只要專案有以下任一改動,當輪就同步維護 status.html 並重新部署**:
  1. 新增/移除/改名功能(球路、移動、體力、發球、計分、練習模式、視覺回饋、平台能力…)。
  2. 驗收項變動(新增驗收目標、某項 ❌→✅ 或反之、驗法改變)。
  3. 測試檔增減或 `vitest` 測試數變動(目前 9 檔 88 測;改動後重跑 `npx vitest run` 取真實數字,不憑印象寫)。
- **維護步驟**:(1) 改 `status.html` 內對應段落 + 更新 `#updated` 日期;(2) 重跑 `npx vitest run` 對齊測試數;(3) 重新部署(走 `/html-deploy` 或直接 `curl POST /api/upload-single` 帶 `force=1` 覆蓋,token 在 memory `credentials.md`,絕不印出/commit);(4) round-trip 驗 `https://html.yanchen.app/pixel-squash/` 回 200 且內容真的更新。
- **數字一律來自實跑**:驗收狀態抄 `PLAN.md` §8.6 表、測試數抄 `vitest` 輸出,不以「應該是」代替執行。
