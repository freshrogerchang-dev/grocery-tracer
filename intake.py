"""Turn incoming Telegram messages into watchlist changes.

Since this project runs on a GitHub Actions cron schedule rather than a
long-lived server, there's no webhook - each scheduled run polls Telegram's
``getUpdates`` for messages sent since the last run and handles three kinds
of input:

- A product link (iHerb/momo/Coupang) -> added to config/watchlist.yaml.
- ``/list`` -> replies with the current numbered watchlist.
- ``/remove <number or url/keyword substring>`` -> removes that entry.

The offset of the last processed Telegram update is kept in
``data/telegram_offset.json`` so restarts don't reprocess old messages.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import yaml

from notify.telegram import get_updates, send_message

logger = logging.getLogger("discount_monitor.intake")

ROOT = Path(__file__).parent
WATCHLIST_PATH = ROOT / "config" / "watchlist.yaml"
OFFSET_PATH = ROOT / "data" / "telegram_offset.json"

URL_RE = re.compile(r"https?://\S+")

SITE_DOMAINS = {
    "iherb.com": "iherb",
    "iherb.co": "iherb",  # short link domain used by iHerb's app "share" button
    "momoshop.com.tw": "momo",
    "coupang.com": "coupang",
}


def _detect_site(url: str) -> str | None:
    for domain, site in SITE_DOMAINS.items():
        if domain in url:
            return site
    return None


def _load_offset() -> int | None:
    if not OFFSET_PATH.exists():
        return None
    with open(OFFSET_PATH, "r", encoding="utf-8") as f:
        return json.load(f).get("offset")


def _save_offset(offset: int) -> None:
    OFFSET_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OFFSET_PATH, "w", encoding="utf-8") as f:
        json.dump({"offset": offset}, f)


def _load_items() -> list[dict]:
    if not WATCHLIST_PATH.exists():
        return []
    with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data.get("items", []) or []


def _existing_urls() -> set[str]:
    return {item["url"] for item in _load_items() if "url" in item}


def _format_item_block(item: dict) -> str:
    lines = [f"  - site: {item['site']}"]
    if item.get("url"):
        lines.append(f"    url: {item['url']}")
    if item.get("keyword"):
        lines.append(f'    keyword: "{item["keyword"]}"')
    if item.get("target_price") is not None:
        lines.append(f"    target_price: {item['target_price']}")
    if item.get("target_discount_pct") is not None:
        lines.append(f"    target_discount_pct: {item['target_discount_pct']}")
    return "\n".join(lines)


def _append_to_watchlist(site: str, url: str) -> None:
    # Appended as plain text (rather than re-serialized via yaml.safe_dump)
    # so the hand-written comments at the top of watchlist.yaml survive.
    with open(WATCHLIST_PATH, "a", encoding="utf-8") as f:
        f.write("\n" + _format_item_block({"site": site, "url": url}) + "\n")


def _write_items(items: list[dict]) -> None:
    """Rewrite the ``items:`` section in place, keeping the header comments
    (everything up to and including the ``items:`` line) untouched."""
    text = WATCHLIST_PATH.read_text(encoding="utf-8")
    marker = "items:"
    idx = text.index(marker)
    header = text[: idx + len(marker)]

    if items:
        body = "\n\n".join(_format_item_block(item) for item in items)
        new_text = f"{header}\n{body}\n"
    else:
        new_text = f"{header}\n"

    WATCHLIST_PATH.write_text(new_text, encoding="utf-8")


def _describe_item(index: int, item: dict) -> str:
    site = item.get("site", "?")
    conditions = []
    if item.get("target_price") is not None:
        conditions.append(f"價格<={item['target_price']}")
    if item.get("target_discount_pct") is not None:
        conditions.append(f"折扣>={item['target_discount_pct']}%")
    suffix = f"（{', '.join(conditions)}）" if conditions else ""

    if item.get("url"):
        return f"{index}. [{site}] {item['url']}{suffix}"
    if item.get("keyword"):
        return f"{index}. [{site}] 關鍵字「{item['keyword']}」{suffix}"
    return f"{index}. [{site}] (無法辨識的設定)"


def _handle_list() -> str:
    items = _load_items()
    if not items:
        return "目前沒有追蹤任何商品。"
    lines = ["📋 目前追蹤清單："]
    lines.extend(_describe_item(i, item) for i, item in enumerate(items, start=1))
    lines.append("\n要取消追蹤，傳 /remove 加編號，例如：/remove 2")
    return "\n".join(lines)


def _handle_remove(arg: str) -> str:
    arg = arg.strip()
    if not arg:
        return "請指定要取消的編號或網址關鍵字，例如：/remove 2\n先傳 /list 查看目前的編號。"

    items = _load_items()
    if not items:
        return "目前沒有追蹤任何商品可以取消。"

    if arg.isdigit():
        n = int(arg)
        if not (1 <= n <= len(items)):
            return f"編號 {n} 不存在，目前清單有 1~{len(items)} 筆，先傳 /list 確認。"
        target_index = n - 1
    else:
        matches = [
            i for i, item in enumerate(items)
            if arg in (item.get("url") or "") or arg in (item.get("keyword") or "")
        ]
        if not matches:
            return f"找不到符合「{arg}」的項目，先傳 /list 確認清單。"
        if len(matches) > 1:
            return f"「{arg}」符合超過一筆，請改傳編號取消（先傳 /list 查看編號）。"
        target_index = matches[0]

    removed = items.pop(target_index)
    _write_items(items)
    desc = removed.get("url") or removed.get("keyword") or "?"
    return f"🗑 已取消追蹤：\n{desc}"


def sync_from_telegram() -> None:
    """Poll Telegram for new messages and act on links / commands found."""
    offset = _load_offset()
    try:
        updates = get_updates(offset=(offset + 1) if offset is not None else None)
    except Exception as exc:  # noqa: BLE001 - don't let a Telegram hiccup kill the whole run
        logger.warning("could not fetch Telegram updates: %s", exc)
        return

    if not updates:
        return

    existing = _existing_urls()
    highest_update_id = offset or 0

    for update in updates:
        highest_update_id = max(highest_update_id, update.get("update_id", 0))
        text = (update.get("message") or {}).get("text", "").strip()
        if not text:
            continue

        command, _, rest = text.partition(" ")
        command = command.split("@")[0].lower()

        if command == "/list":
            send_message(_handle_list())
            continue

        if command == "/remove":
            send_message(_handle_remove(rest))
            continue

        for url in URL_RE.findall(text):
            url = url.rstrip(")>,.。）")  # trim trailing punctuation from pasted links
            if url in existing:
                send_message(f"⏭ 已經在追蹤清單裡了：\n{url}")
                continue

            site = _detect_site(url)
            if site is None:
                send_message(
                    f"❓ 看不出這是 iHerb / momo / Coupang 的商品連結，先略過：\n{url}"
                )
                continue

            _append_to_watchlist(site, url)
            existing.add(url)
            logger.info("added new watchlist item from Telegram: %s %s", site, url)
            send_message(f"✅ 已加入追蹤（{site}）：\n{url}\n\n下次檢查時就會一起確認有沒有折扣。")

    _save_offset(highest_update_id)
