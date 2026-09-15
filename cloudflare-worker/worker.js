/**
 * Instant Telegram command handler for the discount monitor watchlist.
 *
 * Deployed as a Cloudflare Worker and registered as the Telegram bot's
 * webhook. Handles /list, /remove, /reset, and "here's a product link"
 * messages by editing config/watchlist.yaml directly via the GitHub
 * Contents API and replying in Telegram - all within one HTTP request, so
 * it feels instant.
 *
 * Actual price scraping is NOT done here (Workers can't run a headless
 * browser) - that still happens on the existing GitHub Actions cron
 * schedule in main.py. This Worker only edits the watchlist and answers
 * chat commands.
 *
 * Required Worker secrets/vars (set in the Cloudflare dashboard):
 *   TELEGRAM_BOT_TOKEN  - same bot token used by the GitHub Actions job
 *   TELEGRAM_CHAT_ID    - your Telegram chat id (only this chat is honored)
 *   GITHUB_TOKEN        - a fine-grained GitHub PAT scoped to this repo, with
 *                         Contents: Read and write AND Actions: Read and
 *                         write permission (the latter is needed for
 *                         /search, which triggers a GitHub Actions run)
 *   GITHUB_REPO         - "owner/repo", e.g. "freshrogerchang-dev/grocery-tracer"
 *   WEBHOOK_SECRET       - a random string you make up; must match the
 *                         secret_token used when registering the webhook
 */

const SITE_DOMAINS = {
  "iherb.com": "iherb",
  "iherb.co": "iherb", // short link domain used by iHerb's app "share" button
  "momoshop.com.tw": "momo",
  "coupang.com": "coupang",
};

const URL_RE = /https?:\/\/\S+/g;
const WATCHLIST_PATH = "config/watchlist.yaml";
const STATE_PATH = "data/state.json";

const HELP_TEXT = [
  "可用指令：",
  "/list — 列出目前追蹤清單",
  "/search <關鍵字> — 到 iHerb / momo / Coupang 搜尋商品，約 1-2 分鐘後回覆結果（不是即時的，會觸發 GitHub Actions 執行）",
  "/price <編號> — 查看該商品上次排程檢查到的價格（不是即時的，是排程爬蟲最近一次、最長 6 小時內抓到的資料），有 2 筆以上歷史價格會附上走勢圖網址",
  "/price all — 一次列出所有商品的價格",
  "/setprice <編號> <價格> — 設定價格門檻，價格<=這個數字才通知（傳 off 取消）",
  "/setdiscount <編號> <百分比> — 設定折扣門檻，折扣>=這個百分比才通知（傳 off 取消）",
  "/remove <編號 或 網址/關鍵字片段> — 取消追蹤該筆",
  "/remove all confirm — 取消追蹤全部（等同 /reset confirm）",
  "/reset confirm — 清空整個追蹤清單",
  "/help — 顯示這則說明",
  "",
  "直接貼商品連結（iHerb / momo / Coupang）就會自動加入追蹤。",
].join("\n");

function detectSite(url) {
  for (const [domain, site] of Object.entries(SITE_DOMAINS)) {
    if (url.includes(domain)) return site;
  }
  return null;
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ""))));
}

// --- watchlist.yaml parsing / formatting ------------------------------

function parseWatchlist(text) {
  const marker = "items:";
  const idx = text.indexOf(marker);
  const header = text.slice(0, idx + marker.length);
  const body = text.slice(idx + marker.length);

  const items = [];
  let current = null;
  for (const line of body.split("\n")) {
    const siteMatch = line.match(/^\s*-\s*site:\s*(.+?)\s*$/);
    if (siteMatch) {
      if (current) items.push(current);
      current = { site: siteMatch[1] };
      continue;
    }
    if (!current) continue;
    const urlMatch = line.match(/^\s*url:\s*(.+?)\s*$/);
    if (urlMatch) {
      current.url = urlMatch[1];
      continue;
    }
    const kwMatch = line.match(/^\s*keyword:\s*"?([^"]*)"?\s*$/);
    if (kwMatch) {
      current.keyword = kwMatch[1];
      continue;
    }
    const tpMatch = line.match(/^\s*target_price:\s*([\d.]+)\s*$/);
    if (tpMatch) {
      current.target_price = tpMatch[1];
      continue;
    }
    const tdMatch = line.match(/^\s*target_discount_pct:\s*([\d.]+)\s*$/);
    if (tdMatch) {
      current.target_discount_pct = tdMatch[1];
      continue;
    }
  }
  if (current) items.push(current);

  return { header, items };
}

function formatItemBlock(item) {
  const lines = [`  - site: ${item.site}`];
  if (item.url) lines.push(`    url: ${item.url}`);
  if (item.keyword) lines.push(`    keyword: "${item.keyword}"`);
  if (item.target_price !== undefined) lines.push(`    target_price: ${item.target_price}`);
  if (item.target_discount_pct !== undefined) lines.push(`    target_discount_pct: ${item.target_discount_pct}`);
  return lines.join("\n");
}

function serializeWatchlist(header, items) {
  if (items.length === 0) return header + "\n";
  return header + "\n" + items.map(formatItemBlock).join("\n\n") + "\n";
}

// --- GitHub Contents API ------------------------------------------------

async function githubGetFile(env, path) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "discount-monitor-worker",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub getFile ${path} failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { text: b64DecodeUtf8(data.content), sha: data.sha };
}

async function githubPutFile(env, path, newText, sha, message) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "discount-monitor-worker",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message,
      content: b64EncodeUtf8(newText),
      sha,
      branch: "main",
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub putFile ${path} failed: ${res.status} ${await res.text()}`);
  }
}

const WORKFLOW_FILE = "monitor.yml";

async function githubDispatchWorkflow(env, inputs) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "discount-monitor-worker",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub workflow dispatch failed: ${res.status} ${await res.text()}`);
  }
}

// --- Telegram -------------------------------------------------------------

async function sendTelegramMessage(env, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });
}

// --- command handlers -------------------------------------------------

function describeItem(index, item, entries) {
  const conditions = [];
  if (item.target_price !== undefined) conditions.push(`價格<=${item.target_price}`);
  if (item.target_discount_pct !== undefined) conditions.push(`折扣>=${item.target_discount_pct}%`);
  const suffix = conditions.length ? `（${conditions.join(", ")}）` : "";
  if (item.url) {
    const entry = entries && entries.find((e) => e.url === item.url);
    const name = entry && entry.name;
    return name
      ? `${index}. [${item.site}] ${name}${suffix}\n    ${item.url}`
      : `${index}. [${item.site}] ${item.url}${suffix}`;
  }
  if (item.keyword) return `${index}. [${item.site}] 關鍵字「${item.keyword}」${suffix}`;
  return `${index}. [${item.site}] (無法辨識的設定)`;
}

async function handleList(env, items) {
  if (items.length === 0) return "目前沒有追蹤任何商品。";
  const entries = await loadStateEntries(env);
  const lines = ["📋 目前追蹤清單："];
  items.forEach((item, i) => lines.push(describeItem(i + 1, item, entries)));
  lines.push("\n要取消追蹤，傳 /remove 加編號，例如：/remove 2");
  lines.push("要查價格，傳 /price 加編號，例如：/price 1（或 /price all 查全部）");
  lines.push("要清空全部，傳 /reset confirm（或 /remove all confirm）");
  return lines.join("\n");
}

async function loadStateEntries(env) {
  try {
    const { text } = await githubGetFile(env, STATE_PATH);
    const data = JSON.parse(text);
    return Object.entries(data)
      .filter(([key]) => !key.startsWith("failtrack:"))
      .map(([, value]) => value);
  } catch (err) {
    console.error("loadStateEntries failed:", err);
    return [];
  }
}

const IHERB_COUPON_REMINDER =
  "💡 這是公開售價，沒有套用個人優惠碼。iHerb 常有首購折扣碼（例如 NEW20），登入你的帳號查看頁面上是否有適用的優惠碼，可能比這裡顯示的價格更低。";

function formatPriceText(entry) {
  const currency = entry.currency || "";
  if (entry.last_original_price && entry.last_original_price > entry.last_price) {
    const pct = Math.round((1 - entry.last_price / entry.last_original_price) * 100);
    return `${currency} ${entry.last_price}（原價 ${currency} ${entry.last_original_price}，折 ${pct}%）`;
  }
  return `${currency} ${entry.last_price}`;
}

function isAllTimeLow(entry) {
  if (!entry.history || entry.history.length < 2) return false;
  const minPrice = Math.min(...entry.history.map((h) => h.price));
  return entry.last_price <= minPrice;
}

function formatPriceEntry(item, entry, baseUrl, index) {
  const lines = [
    `💰 <b>${(entry && entry.name) || item.url}</b>`,
    `網站：${item.site}`,
    `價格：${formatPriceText(entry)}`,
  ];
  if (isAllTimeLow(entry)) lines.push("🏆 這是目前記錄到的最低價！");
  if (entry.last_seen_at) lines.push(`上次檢查：${entry.last_seen_at}`);
  lines.push(item.url);
  if (baseUrl && index != null && entry.history && entry.history.length > 1) {
    lines.push(`📈 價格走勢：${baseUrl}/chart?item=${index}`);
  }
  if (item.site === "iherb") lines.push(IHERB_COUPON_REMINDER);
  return lines.join("\n");
}

async function handlePrice(env, items, arg, baseUrl) {
  arg = (arg || "").trim();
  if (items.length === 0) {
    return "目前沒有追蹤任何商品。";
  }
  if (arg.toLowerCase() === "all") {
    return handlePriceAll(env, items, baseUrl);
  }
  if (!/^\d+$/.test(arg)) {
    return "請指定要查詢的編號，例如：/price 1（或 /price all 查全部）\n先傳 /list 查看編號。";
  }
  const n = parseInt(arg, 10);
  if (n < 1 || n > items.length) {
    return `編號 ${n} 不存在，目前清單有 1~${items.length} 筆，先傳 /list 確認。`;
  }
  const item = items[n - 1];
  if (!item.url) {
    return `[${item.site}] 關鍵字「${item.keyword}」是關鍵字搜尋型追蹤，沒有單一價格可查，用 /list 看目前設定。`;
  }
  const entries = await loadStateEntries(env);
  const entry = entries.find((e) => e.url === item.url);
  if (!entry) {
    return `還沒有這個商品的價格資料，可能還沒排程檢查過、或抓取一直失敗：\n${item.url}`;
  }
  return formatPriceEntry(item, entry, baseUrl, n);
}

async function handlePriceAll(env, items, baseUrl) {
  const entries = await loadStateEntries(env);
  const lines = ["📊 目前所有商品價格："];
  let hasIherb = false;

  items.forEach((item, i) => {
    const idx = i + 1;
    if (!item.url) {
      lines.push(`${idx}. [${item.site}] 關鍵字「${item.keyword}」— 沒有單一價格`);
      return;
    }
    if (item.site === "iherb") hasIherb = true;
    const entry = entries.find((e) => e.url === item.url);
    if (!entry) {
      lines.push(`${idx}. [${item.site}] ${item.url} — 還沒有資料`);
      return;
    }
    const lowBadge = isAllTimeLow(entry) ? " 🏆最低" : "";
    lines.push(`${idx}. [${item.site}] ${entry.name || item.url}：${formatPriceText(entry)}${lowBadge}`);
  });

  if (baseUrl) lines.push("\n要看個別商品的價格走勢圖，傳 /price 加編號，例如：/price 1");
  if (hasIherb) lines.push(IHERB_COUPON_REMINDER);
  return lines.join("\n");
}

function errorReplyText(err) {
  return `❌ 儲存到 GitHub 失敗，稍後再試。\n錯誤訊息：${String((err && err.message) || err).slice(0, 300)}`;
}

async function performReset(env, header, items, sha) {
  if (items.length === 0) {
    return "目前清單本來就是空的。";
  }
  try {
    await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, []), sha, "chore: clear watchlist via Telegram bot");
    return `🧹 已清空追蹤清單（原本有 ${items.length} 筆）。`;
  } catch (err) {
    return errorReplyText(err);
  }
}

function handleSetTarget(items, argText, { field, exampleCmd, exampleValue, describeValue }) {
  const parts = (argText || "").trim().split(/\s+/).filter(Boolean);
  const [numStr, valueStr] = parts;
  if (!numStr || !valueStr) {
    return {
      reply: `用法：${exampleCmd} 編號 ${exampleValue}（或傳 off 取消門檻），例如：${exampleCmd} 1 ${exampleValue}\n先傳 /list 查看編號。`,
      items,
      changed: false,
    };
  }
  if (!/^\d+$/.test(numStr)) {
    return { reply: `編號要是數字，例如：${exampleCmd} 1 ${exampleValue}`, items, changed: false };
  }
  const n = parseInt(numStr, 10);
  if (n < 1 || n > items.length) {
    return { reply: `編號 ${n} 不存在，目前清單有 1~${items.length} 筆，先傳 /list 確認。`, items, changed: false };
  }

  const item = items[n - 1];
  const desc = item.url || `關鍵字「${item.keyword}」`;
  const updated = { ...item };
  let reply;

  if (valueStr.toLowerCase() === "off") {
    delete updated.target_price;
    delete updated.target_discount_pct;
    reply = `✅ 已取消第 ${n} 筆的門檻設定：\n${desc}`;
  } else {
    if (!/^\d+(\.\d+)?$/.test(valueStr)) {
      return { reply: `數值格式錯誤：${valueStr}`, items, changed: false };
    }
    delete updated.target_price;
    delete updated.target_discount_pct;
    updated[field] = valueStr;
    reply = `✅ 第 ${n} 筆已設定：${describeValue(valueStr)}\n${desc}`;
  }

  const newItems = items.slice();
  newItems[n - 1] = updated;
  return { reply, items: newItems, changed: true };
}

function handleSetPrice(items, argText) {
  return handleSetTarget(items, argText, {
    field: "target_price",
    exampleCmd: "/setprice",
    exampleValue: "500",
    describeValue: (v) => `價格 <= ${v} 才通知`,
  });
}

function handleSetDiscount(items, argText) {
  return handleSetTarget(items, argText, {
    field: "target_discount_pct",
    exampleCmd: "/setdiscount",
    exampleValue: "20",
    describeValue: (v) => `折扣 >= ${v}% 才通知`,
  });
}

function handleRemove(items, arg) {
  arg = (arg || "").trim();
  if (!arg) {
    return { reply: "請指定要取消的編號或網址關鍵字，例如：/remove 2\n先傳 /list 查看目前的編號。", items, changed: false };
  }
  if (items.length === 0) {
    return { reply: "目前沒有追蹤任何商品可以取消。", items, changed: false };
  }

  let targetIndex;
  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    if (n < 1 || n > items.length) {
      return { reply: `編號 ${n} 不存在，目前清單有 1~${items.length} 筆，先傳 /list 確認。`, items, changed: false };
    }
    targetIndex = n - 1;
  } else {
    const matches = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => (item.url && item.url.includes(arg)) || (item.keyword && item.keyword.includes(arg)));
    if (matches.length === 0) {
      return { reply: `找不到符合「${arg}」的項目，先傳 /list 確認清單。`, items, changed: false };
    }
    if (matches.length > 1) {
      return { reply: `「${arg}」符合超過一筆，請改傳編號取消（先傳 /list 查看編號）。`, items, changed: false };
    }
    targetIndex = matches[0].i;
  }

  const removed = items[targetIndex];
  const newItems = items.slice(0, targetIndex).concat(items.slice(targetIndex + 1));
  const desc = removed.url || removed.keyword || "?";
  return { reply: `🗑 已取消追蹤：\n${desc}`, items: newItems, changed: true };
}

function handleAddUrl(items, rawUrl) {
  const url = rawUrl.replace(/[)>,.。）]+$/, "");
  if (items.some((item) => item.url === url)) {
    return { reply: `⏭ 已經在追蹤清單裡了：\n${url}`, items, changed: false };
  }
  const site = detectSite(url);
  if (!site) {
    return { reply: `❓ 看不出這是 iHerb / momo / Coupang 的商品連結，先略過：\n${url}`, items, changed: false };
  }
  const newItems = items.concat([{ site, url }]);
  return { reply: `✅ 已加入追蹤（${site}）：\n${url}\n\n下次檢查時就會一起確認有沒有折扣。`, items: newItems, changed: true };
}

// --- request handling ---------------------------------------------------

async function handleUpdate(env, update, baseUrl) {
  const message = update.message;
  const text = (message && message.text ? message.text : "").trim();
  if (!text) return;

  if (String(message.chat.id) !== String(env.TELEGRAM_CHAT_ID)) {
    return; // ignore messages from anyone other than the configured chat
  }

  const [command, ...rest] = text.split(" ");
  const cmd = command.split("@")[0].toLowerCase();

  if (cmd === "/help" || cmd === "/start") {
    await sendTelegramMessage(env, HELP_TEXT);
    return;
  }

  if (cmd === "/search") {
    const keyword = rest.join(" ").trim();
    if (!keyword) {
      await sendTelegramMessage(env, "請指定搜尋關鍵字，例如：/search 無線滑鼠");
      return;
    }
    try {
      await githubDispatchWorkflow(env, { search: keyword });
      await sendTelegramMessage(env, `🔍 已開始搜尋「${keyword}」，會到 iHerb / momo / Coupang 找，大概 1-2 分鐘後把結果傳給你。`);
    } catch (err) {
      await sendTelegramMessage(
        env,
        `❌ 觸發搜尋失敗，稍後再試。\n錯誤訊息：${String((err && err.message) || err).slice(0, 300)}\n（如果是 403，檢查 GITHUB_TOKEN 有沒有 Actions: Read and write 權限）`
      );
    }
    return;
  }

  const { text: watchlistText, sha } = await githubGetFile(env, WATCHLIST_PATH);
  const { header, items } = parseWatchlist(watchlistText);

  if (cmd === "/list") {
    await sendTelegramMessage(env, await handleList(env, items));
    return;
  }

  if (cmd === "/price") {
    await sendTelegramMessage(env, await handlePrice(env, items, rest.join(" "), baseUrl));
    return;
  }

  if (cmd === "/setprice" || cmd === "/setdiscount") {
    const result = cmd === "/setprice" ? handleSetPrice(items, rest.join(" ")) : handleSetDiscount(items, rest.join(" "));
    if (!result.changed) {
      await sendTelegramMessage(env, result.reply);
      return;
    }
    try {
      await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, result.items), sha, "chore: update notify threshold via Telegram bot");
      await sendTelegramMessage(env, result.reply);
    } catch (err) {
      await sendTelegramMessage(env, errorReplyText(err));
    }
    return;
  }

  if (cmd === "/reset") {
    if (rest.join(" ").trim().toLowerCase() !== "confirm") {
      await sendTelegramMessage(env, "⚠️ 這會清空整個追蹤清單，確定的話傳：/reset confirm");
      return;
    }
    await sendTelegramMessage(env, await performReset(env, header, items, sha));
    return;
  }

  if (cmd === "/remove") {
    const argText = rest.join(" ").trim();

    if (argText.toLowerCase() === "all" || argText.toLowerCase() === "all confirm") {
      if (argText.toLowerCase() !== "all confirm") {
        await sendTelegramMessage(env, "⚠️ 這會取消追蹤全部商品，確定的話傳：/remove all confirm");
        return;
      }
      await sendTelegramMessage(env, await performReset(env, header, items, sha));
      return;
    }

    const result = handleRemove(items, argText);
    if (!result.changed) {
      await sendTelegramMessage(env, result.reply);
      return;
    }
    try {
      await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, result.items), sha, "chore: remove watchlist item via Telegram bot");
      await sendTelegramMessage(env, result.reply);
    } catch (err) {
      await sendTelegramMessage(env, errorReplyText(err));
    }
    return;
  }

  const urls = text.match(URL_RE);
  if (!urls) return;

  let currentItems = items;
  const results = [];
  for (const url of urls) {
    const result = handleAddUrl(currentItems, url);
    results.push(result);
    if (result.changed) currentItems = result.items;
  }

  const dirty = results.some((r) => r.changed);
  if (!dirty) {
    for (const r of results) await sendTelegramMessage(env, r.reply);
    return;
  }

  try {
    await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, currentItems), sha, "chore: add watchlist item(s) via Telegram bot");
    for (const r of results) await sendTelegramMessage(env, r.reply);
  } catch (err) {
    const errText = errorReplyText(err);
    for (const r of results) await sendTelegramMessage(env, r.changed ? errText : r.reply);
  }
}

// --- price history chart (served as a plain GET page) -------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderChartSVG(history) {
  const width = 700;
  const height = 320;
  const padding = { top: 20, right: 20, bottom: 30, left: 70 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const times = history.map((h) => new Date(h.date).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const prices = history.map((h) => h.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const padP = Math.max((maxP - minP) * 0.15, maxP * 0.02, 1);
  const yMin = Math.max(0, minP - padP);
  const yMax = maxP + padP;

  const x = (t) => padding.left + (maxT === minT ? plotW / 2 : ((t - minT) / (maxT - minT)) * plotW);
  const y = (p) => padding.top + plotH - ((p - yMin) / (yMax - yMin)) * plotH;

  const points = history.map((h) => `${x(new Date(h.date).getTime()).toFixed(1)},${y(h.price).toFixed(1)}`).join(" ");

  const dots = history
    .map((h) => {
      const cx = x(new Date(h.date).getTime()).toFixed(1);
      const cy = y(h.price).toFixed(1);
      const discounted = h.original_price && h.original_price > h.price;
      const label = escapeHtml(`${h.date.slice(0, 10)}: ${h.price}${discounted ? ` (原價 ${h.original_price})` : ""}`);
      return `<circle cx="${cx}" cy="${cy}" r="4" fill="${discounted ? "#e11d48" : "#2563eb"}"><title>${label}</title></circle>`;
    })
    .join("");

  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const yLabels = yTicks
    .map((v) => `<text x="${padding.left - 10}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="12" fill="#666">${Math.round(v)}</text>`)
    .join("");
  const gridLines = yTicks
    .map((v) => `<line x1="${padding.left}" y1="${y(v).toFixed(1)}" x2="${width - padding.right}" y2="${y(v).toFixed(1)}" stroke="#eee"/>`)
    .join("");

  const firstDate = escapeHtml(history[0].date.slice(0, 10));
  const lastDate = escapeHtml(history[history.length - 1].date.slice(0, 10));

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:system-ui,sans-serif;">
    ${gridLines}
    ${yLabels}
    <polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="2"/>
    ${dots}
    <text x="${padding.left}" y="${height - 8}" font-size="12" fill="#666">${firstDate}</text>
    <text x="${width - padding.right}" y="${height - 8}" text-anchor="end" font-size="12" fill="#666">${lastDate}</text>
  </svg>`;
}

function renderChartPage(item, entry) {
  const history = (entry && entry.history) || [];
  const title = escapeHtml((entry && entry.name) || item.url);
  const body =
    history.length < 2
      ? `<p>這個商品目前還沒有足夠的歷史資料可以畫圖（至少要 2 個不同的價格點）。</p>`
      : renderChartSVG(history);

  return `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - 價格走勢</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 1.2rem; }
  .legend { color: #666; font-size: 0.85rem; margin-top: 8px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
</style>
</head><body>
<h1>${title}</h1>
<p>網站：${escapeHtml(item.site)} ｜ <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">商品連結</a></p>
${body}
<p class="legend"><span class="dot" style="background:#2563eb"></span>一般價格　<span class="dot" style="background:#e11d48"></span>有折扣時</p>
</body></html>`;
}

async function handleChartRequest(env, url) {
  const idxParam = url.searchParams.get("item");
  const n = parseInt(idxParam, 10);
  if (!idxParam || Number.isNaN(n)) {
    return new Response("缺少或錯誤的 item 參數，網址格式：/chart?item=1", { status: 400 });
  }

  const { text: watchlistText } = await githubGetFile(env, WATCHLIST_PATH);
  const { items } = parseWatchlist(watchlistText);
  if (n < 1 || n > items.length) {
    return new Response(`編號 ${n} 不存在，目前清單有 1~${items.length} 筆。`, { status: 404 });
  }
  const item = items[n - 1];
  if (!item.url) {
    return new Response("這是關鍵字搜尋型追蹤，沒有單一商品的價格走勢可畫。", { status: 400 });
  }

  const entries = await loadStateEntries(env);
  const entry = entries.find((e) => e.url === item.url);

  return new Response(renderChartPage(item, entry || {}), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Named exports (in addition to the default fetch handler below) exist
// purely so the pure logic functions can be unit tested with plain Node,
// without needing the Workers runtime.
export {
  detectSite,
  parseWatchlist,
  serializeWatchlist,
  handleList,
  handleRemove,
  handleAddUrl,
  handleSetPrice,
  handleSetDiscount,
  handlePrice,
  handlePriceAll,
  formatPriceEntry,
  isAllTimeLow,
  performReset,
  handleUpdate,
  renderChartSVG,
  renderChartPage,
  handleChartRequest,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/chart") {
      try {
        return await handleChartRequest(env, url);
      } catch (err) {
        console.error(err);
        return new Response("讀取價格資料失敗，稍後再試。", { status: 500 });
      }
    }

    if (request.method !== "POST") {
      return new Response("OK");
    }

    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      await handleUpdate(env, update, url.origin);
    } catch (err) {
      console.error(err);
      // Still return 200 so Telegram doesn't retry-storm us over a bug.
    }

    return new Response("OK");
  },
};
