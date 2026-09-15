/**
 * Instant Telegram command handler for the discount monitor watchlist.
 *
 * Deployed as a Cloudflare Worker and registered as the Telegram bot's
 * webhook. Handles /list, /remove, and "here's a product link" messages by
 * editing config/watchlist.yaml directly via the GitHub Contents API and
 * replying in Telegram - all within one HTTP request, so it feels instant.
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
  return lines.join("\n");
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

  const { text: watchlistText, sha } = await githubGetFile(env, WATCHLIST_PATH);
  const { header, items } = parseWatchlist(watchlistText);

  if (cmd === "/list") {
    await sendTelegramMessage(env, handleList(items));
    return;
  }

  if (cmd === "/remove") {
    const result = handleRemove(items, rest.join(" "));
    await sendTelegramMessage(env, result.reply);
    if (result.changed) {
      await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, result.items), sha, "chore: remove watchlist item via Telegram bot");
    }
    return;
  }

  const urls = text.match(URL_RE);
  if (!urls) return;

  let currentItems = items;
  let dirty = false;
  for (const url of urls) {
    const result = handleAddUrl(currentItems, url);
    await sendTelegramMessage(env, result.reply);
    if (result.changed) {
      currentItems = result.items;
      dirty = true;
    }
  }
  if (dirty) {
    await githubPutFile(env, WATCHLIST_PATH, serializeWatchlist(header, currentItems), sha, "chore: add watchlist item(s) via Telegram bot");
  }
}

// Named exports (in addition to the default fetch handler below) exist
// purely so the pure logic functions can be unit tested with plain Node,
// without needing the Workers runtime.
export { detectSite, parseWatchlist, serializeWatchlist, handleList, handleRemove, handleAddUrl };

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
