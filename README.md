# 折扣監控機器人

定期檢查 iHerb / momo購物網 / Coupang 上指定商品是否打折，有折扣就發 Telegram 通知。
每 6 小時透過 GitHub Actions 自動執行一次，不需要自己的電腦開機。

## 已知限制

- **Coupang 的爬蟲是最容易失敗的**：Coupang 對自動化流量的偵測很積極，這個專案連開發時用的瀏覽器工具都直接被 Coupang 擋下無法連線。`scrapers/coupang.py` 目前是根據一般電商網站的慣例寫的，**沒有實際驗證過**，請先用 `--dry-run` 本機測試，抓不到再自行調整或乾脆從 `watchlist.yaml` 移除。
- momo、iHerb 的抓取邏輯已經對照真實頁面結構驗證過，穩定性應該好很多，但網站改版仍可能讓程式失效。
- 這個工具只做「查詢公開頁面上的價格資訊」，請自行拿捏合理的查詢頻率、遵守各網站的服務條款，僅供個人使用。

## 1. 設定 Telegram 通知

1. 在 Telegram 搜尋 `@BotFather`，傳送 `/newbot`，依指示取得一組 **Bot Token**（長得像 `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`）。
2. 跟你剛建立的 Bot 傳一句話（隨便打字），讓它在你的對話紀錄裡出現。
3. 瀏覽器打開 `https://api.telegram.org/bot<你的Token>/getUpdates`，在回傳的 JSON 裡找 `"chat":{"id":數字}`，那個數字就是你的 **Chat ID**。

## 2. 設定 GitHub Secrets

到你的 GitHub repo → Settings → Secrets and variables → Actions，新增兩個 secret：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## 3. 編輯追蹤清單

打開 [config/watchlist.yaml](config/watchlist.yaml)：

```yaml
notify_on_any_discount: true    # 全域預設：有折扣就通知

items:
  - site: iherb                 # iherb | momo | coupang
    url: 商品頁網址               # 網址追蹤：最準確
    target_price: 500           # 選填：價格 <= 500 才通知（不填就是「有折扣就通知」）

  - site: momo
    keyword: "無線滑鼠"           # 關鍵字搜尋：涵蓋面廣但較不精準
    target_discount_pct: 20     # 選填：折扣 >= 20% 才通知（預設沒設定的話會用「比上次抓到的價格更低」判斷）
```

新增/刪除商品直接編輯這個檔案、commit、push 就會生效。

## 4. 本機測試

```bash
pip install -r requirements.txt
playwright install --with-deps chromium
python main.py --dry-run
```

`--dry-run` 只會印出結果，不會發 Telegram 訊息、也不會更新 `data/state.json`。確認每個網站都能正確抓到商品名稱與價格後，再把 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 設成環境變數，拿掉 `--dry-run` 跑一次，確認真的能收到 Telegram 訊息。

## 5. 部署到 GitHub Actions

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create <repo-name> --private --source=. --push
```

建議設為 **private repo**，因為 `data/state.json` 的 commit 歷史會留下你追蹤商品的價格紀錄。

推上去之後，到 repo 的 Actions 頁籤手動觸發一次 `Discount Monitor` workflow（`workflow_dispatch`），確認執行成功、`data/state.json` 有被自動 commit 回來。之後就會照 `.github/workflows/monitor.yml` 裡的 cron 設定（預設每 6 小時）自動執行。

## 運作邏輯

- 每次執行都會把當下抓到的價格寫進 `data/state.json`。
- 判斷「要不要通知」：
  1. 如果商品有設定 `target_price` 或 `target_discount_pct`，用門檻判斷。
  2. 沒設定的話，若網站本身有標示原價/劃線價，只要現在是折扣價就通知。
  3. 網站沒標示原價（例如搜尋結果列表），改用「這次抓到的價格比上次記錄的價格低」當作折扣訊號。
- 同一個商品在同一個價格只會通知一次，除非價格又更低，或距離上次通知已超過 7 天。
