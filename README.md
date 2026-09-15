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

兩種方式都可以：

**A. 傳 Telegram 訊息給機器人（推薦）**

直接把商品頁網址貼給你的 Telegram 機器人，它會判斷是 iHerb / momo / Coupang，加進 `config/watchlist.yaml` 並回覆確認訊息（已經追蹤過的會提示重複、看不出網站的會提示略過）。

機器人也支援兩個指令：

- `/list` — 列出目前追蹤清單，附編號
- `/remove <編號>` — 取消追蹤該筆（先傳 `/list` 看編號）。也可以用 `/remove <網址或關鍵字的一部分>`，例如 `/remove momoshop`，符合超過一筆時會請你改用編號

這些指令是**即時**回覆的（見下面第 6 節設定 Cloudflare Worker），不用等排程。設定好 Worker 之前，這些訊息不會被處理，也不會排到下次排程自動補上（見第 6 節的技術限制說明）。

用 `target_price` / `target_discount_pct` 設價格門檻，目前還是要編輯 `config/watchlist.yaml`。

**B. 直接編輯 `config/watchlist.yaml`**

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

## 6. 設定即時的 Telegram 指令（Cloudflare Worker）

`/list`、`/remove`、傳網址新增商品這三件事，是由一個獨立的 Cloudflare Worker（免費）即時處理的，跟第 5 節的排程爬蟲是兩件事：Worker 只負責編輯 `config/watchlist.yaml` 並秒回你，實際的折扣爬蟲還是照舊每 6 小時跑一次（Worker 沒辦法跑瀏覽器爬蟲）。這步驟是選用的，不設定的話，Telegram 訊息不會被處理（沒有排程輪詢的備援機制了）。

**A. 建立 GitHub Token**

到 GitHub → 右上角頭像 → Settings → Developer settings → Fine-grained tokens → Generate new token：
- Repository access 選 **Only select repositories** → 選這個 repo
- Permissions → Contents → **Read and write**
- 產生後複製 token（只會顯示一次）

**B. 建立 Cloudflare Worker**

1. 到 [dash.cloudflare.com](https://dash.cloudflare.com) 註冊/登入（免費）
2. 左側選 **Workers & Pages** → **Create** → **Create Worker**，取個名字（例如 `discount-monitor-bot`）→ Deploy
3. 點 **Edit code**，把預設的範例程式碼全部刪掉，貼上 [cloudflare-worker/worker.js](cloudflare-worker/worker.js) 的完整內容 → **Save and deploy**
4. 回到 Worker 頁面 → **Settings** → **Variables and Secrets** → 新增以下 5 個，全部選 **Secret** 類型：
   - `TELEGRAM_BOT_TOKEN`（跟 GitHub Secrets 裡的同一個）
   - `TELEGRAM_CHAT_ID`（同上）
   - `GITHUB_TOKEN`（上一步產生的 GitHub token）
   - `GITHUB_REPO`（格式：`你的帳號/repo名稱`，例如 `freshrogerchang-dev/grocery-tracer`）
   - `WEBHOOK_SECRET`（自己隨便打一串英數字，當作驗證密碼，例如用密碼產生器生一組）
5. 記下 Worker 的網址（Settings 頁上方會顯示，長得像 `https://discount-monitor-bot.你的帳號.workers.dev`）

**C. 註冊 Telegram Webhook**

瀏覽器打開這個網址（把 `<TOKEN>`、`<WORKER_URL>`、`<WEBHOOK_SECRET>` 換成你剛剛的值）：

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>
```

回傳 `{"ok":true,"result":true,"description":"Webhook was set"}` 就代表成功。之後傳 `/list` 給機器人測試看看，應該幾秒內就有回覆。

**還原成排程輪詢模式**：如果之後想拆掉 Worker，到 `https://api.telegram.org/bot<TOKEN>/deleteWebhook` 取消 webhook 即可；但拆掉後 Telegram 指令會完全沒有人處理（沒有輪詢備援），只剩下第 5 節的排程爬蟲還會正常運作。

## 運作邏輯

- 每次排程執行都會把當下抓到的價格寫進 `data/state.json`。
- 判斷「要不要通知」：
  1. 如果商品有設定 `target_price` 或 `target_discount_pct`，用門檻判斷。
  2. 沒設定的話，若網站本身有標示原價/劃線價，只要現在是折扣價就通知。
  3. 網站沒標示原價（例如搜尋結果列表），改用「這次抓到的價格比上次記錄的價格低」當作折扣訊號。
- 同一個商品在同一個價格只會通知一次，除非價格又更低，或距離上次通知已超過 7 天。
- `/list`、`/remove`、新增商品連結由 Cloudflare Worker 即時處理（見第 6 節），跟排程爬蟲互相獨立。
