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
 *   GITHUB_TOKEN        - a fine-grained GitHub PAT scoped to this repo,
 *                         with Contents: Read and write permission
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
  "/price <編號> — 查看該商品上次排程檢查到的價格（不是即時的，是排程爬蟲最近一次、最長 6 小時內抓到的資料）",
  "/remove <編號 或 網址/關鍵字片段> — 取消追蹤該筆",
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

function describeItem(index, item) {
  const conditions = [];
  if (item.target_price !== undefined) conditions.push(`價格<=${item.target_price}`);
  if (item.target_discount_pct !== undefined) conditions.push(`折扣>=${item.target_discount_pct}%`);
  const suffix = conditions.length ? `（${conditions.join(", ")}）` : "";
  if (item.url) return `${index}. [${item.site}] ${item.url}${suffix}`;
  if (item.keyword) return `${index}. [${item.site}] 關鍵字「${item.keyword}」${suffix}`;
  return `${index}. [${item.site}] (無法辨識的設定)`;
}

function handleList(items) {
  if (items.length === 0) return "目前沒有追蹤任何商品。";
  const lines = ["📋 目前追蹤清單："];
  items.forEach((item, i) => lines.push(describeItem(i + 1, item)));
  lines.push("\n要取消追蹤，傳 /remove 加編號，例如：/remove 2");
  lines.push("要查價格，傳 /price 加編號，例如：/price 1");
  lines.push("要清空全部，傳 /reset confirm");
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

function formatPriceEntry(item, entry) {
  const currency = entry.currency || "";
  const lines = [`💰 <b>${(entry && entry.name) || item.url}</b>`, `網站：${item.site}`];
  if (entry.last_original_price && entry.last_original_price > entry.last_price) {
    const pct = Math.round((1 - entry.last_price / entry.last_original_price) * 100);
    lines.push(`價格：${currency} ${entry.last_price}（原價 ${currency} ${entry.last_original_price}，折 ${pct}%）`);
  } else {
    lines.push(`價格：${currency} ${entry.last_price}`);
  }
  if (entry.last_seen_at) lines.push(`上次檢查：${entry.last_seen_at}`);
  lines.push(item.url);
  return lines.join("\n");
}

async function handlePrice(env, items, arg) {
  arg = (arg || "").trim();
  if (items.length === 0) {
    return "目前沒有追蹤任何商品。";
  }
  if (!/^\d+$/.test(arg)) {
    return "請指定要查詢的編號，例如：/price 1\n先傳 /list 查看編號。";
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
  return formatPriceEntry(item, entry);
}

function errorReplyText(err) {
  return `❌ 儲存到 GitHub 失敗，稍後再試。\n錯誤訊息：${String((err && err.message) || err).slice(0, 300)}`;
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

async function handleUpdate(env, update) {
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

  const { text: watchlistText, sha } = await githubGetFile(env, WATCHLIST_PATH);
  const { header, items } = parseWatchlist(watchlistText);

  if (cmd === "/list") {
    await sendTelegramMessage(env, handleList(items));
    return;
  }

  if (cmd === "/price") {
    await sendTelegramMessage(env, await handlePrice(env, items, rest.join(" ")));
    return;
  }

  if (cmd === "/reset") {
    if (rest.join(" ").trim().toLowerCase() !== "confirm") {
      await sendTelegramMessage(env, "⚠️ 這會清空整個追蹤清單，確定的話傳：/reset confirm");
      return;
    }
    if (items.length === 0) {
      await sendTelegramMessage(env, "目前清單本來就是空的。");
      return;
    }
    try {
      await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, []), sha, "chore: reset watchlist via Telegram bot");
      await sendTelegramMessage(env, `🧹 已清空追蹤清單（原本有 ${items.length} 筆）。`);
    } catch (err) {
      await sendTelegramMessage(env, errorReplyText(err));
    }
    return;
  }

  if (cmd === "/remove") {
    const result = handleRemove(items, rest.join(" "));
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
  handlePrice,
  formatPriceEntry,
  handleUpdate,
};

export default {
  async fetch(request, env) {
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
      await handleUpdate(env, update);
    } catch (err) {
      console.error(err);
      // Still return 200 so Telegram doesn't retry-storm us over a bug.
    }

    return new Response("OK");
  },
};
