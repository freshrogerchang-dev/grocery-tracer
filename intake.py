"""Turn incoming Telegram messages into watchlist entries.

Since this project runs on a GitHub Actions cron schedule rather than a
long-lived server, there's no webhook - each scheduled run polls Telegram's
``getUpdates`` for messages sent since the last run, pulls out any
iHerb/momo/Coupang product links, appends them to ``config/watchlist.yaml``,
and replies in Telegram confirming what was added. A newly-added product
gets checked for discounts in the same run.

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


def _existing_urls() -> set[str]:
    if not WATCHLIST_PATH.exists():
        return set()
    with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return {item["url"] for item in data.get("items", []) if "url" in item}


def _append_to_watchlist(site: str, url: str) -> None:
    # Appended as plain text (rather than re-serialized via yaml.safe_dump)
    # so the hand-written comments at the top of watchlist.yaml survive.
    with open(WATCHLIST_PATH, "a", encoding="utf-8") as f:
        f.write(f"\n  - site: {site}\n    url: {url}\n")


def sync_from_telegram() -> None:
    """Poll Telegram for new messages and add any product links found."""
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
        text = (update.get("message") or {}).get("text", "")
        if not text:
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
