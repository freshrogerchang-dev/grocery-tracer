from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from notify.telegram import send_message
from scrapers import ProductInfo, ScrapeError

if sys.platform == "win32":
    # Local Windows terminals often default to a non-UTF-8 codepage, which
    # mangles the Chinese product names/messages we print. GitHub Actions'
    # Linux runners are UTF-8 by default so this is a no-op there.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("discount_monitor")

ROOT = Path(__file__).parent
WATCHLIST_PATH = ROOT / "config" / "watchlist.yaml"
STATE_PATH = ROOT / "data" / "state.json"

RENOTIFY_COOLDOWN = timedelta(days=7)
FAILURE_NOTIFY_THRESHOLD = 3
FAILURE_RENOTIFY_COOLDOWN = timedelta(days=3)
MAX_HISTORY_ENTRIES = 200

SCRAPERS = {}


def _load_scrapers():
    """Import scraper modules lazily so --dry-run --help etc. don't require
    Playwright to be installed just to parse arguments."""
    if SCRAPERS:
        return SCRAPERS
    from scrapers import coupang, iherb, momo

    SCRAPERS.update({"iherb": iherb, "momo": momo, "coupang": coupang})
    return SCRAPERS


def load_watchlist() -> dict:
    with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)


def collect_products(item: dict) -> list[ProductInfo]:
    scrapers = _load_scrapers()
    site = item["site"]
    if site not in scrapers:
        logger.error("unknown site in watchlist: %s", site)
        return []
    scraper = scrapers[site]

    try:
        if "url" in item:
            return [scraper.fetch_product(item["url"])]
        if "keyword" in item:
            return scraper.search(item["keyword"])
        logger.error("watchlist item missing both 'url' and 'keyword': %s", item)
        return []
    except ScrapeError as exc:
        logger.warning(str(exc))
        return []


def should_notify(product: ProductInfo, item: dict, global_cfg: dict, state_entry: dict | None) -> bool:
    target_price = item.get("target_price")
    target_discount_pct = item.get("target_discount_pct")

    if target_price is not None:
        triggered = product.current_price <= target_price
    elif target_discount_pct is not None:
        triggered = product.discount_pct >= target_discount_pct
    elif product.original_price is not None:
        triggered = global_cfg.get("notify_on_any_discount", True) and product.is_discounted
    elif state_entry and state_entry.get("last_price") is not None:
        # No original/list price available from the site (e.g. a search
        # result list) - fall back to "did the price actually drop since we
        # last checked" as the discount signal.
        triggered = product.current_price < state_entry["last_price"]
    else:
        triggered = False

    if not triggered:
        return False

    if state_entry and state_entry.get("last_notified_price") is not None:
        already_notified_at_this_price = product.current_price >= state_entry["last_notified_price"]
        if already_notified_at_this_price:
            last_notified_at = state_entry.get("last_notified_at")
            if last_notified_at:
                elapsed = datetime.now(timezone.utc) - datetime.fromisoformat(last_notified_at)
                if elapsed < RENOTIFY_COOLDOWN:
                    return False

    return True


IHERB_COUPON_REMINDER = (
    "💡 這是公開售價，沒有套用個人優惠碼。iHerb 常有首購折扣碼（例如 NEW20），"
    "登入你的帳號查看頁面上是否有適用的優惠碼，可能比這裡顯示的價格更低。"
)


def format_notification(product: ProductInfo) -> str:
    lines = [f"🔻 <b>{product.name}</b>", f"網站：{product.site}"]
    if product.original_price and product.original_price > product.current_price:
        lines.append(
            f"價格：{product.currency} {product.current_price:,.0f}"
            f"（原價 {product.original_price:,.0f}，折 {product.discount_pct:.0f}%）"
        )
    else:
        lines.append(f"價格：{product.currency} {product.current_price:,.0f}")
    lines.append(product.url)
    if product.site == "iherb":
        lines.append(IHERB_COUPON_REMINDER)
    return "\n".join(lines)


def failure_key(item: dict) -> str:
    identity = item.get("url") or item.get("keyword") or "?"
    return f"failtrack:{item.get('site')}:{identity}"


def format_failure_notice(item: dict, count: int) -> str:
    target = item.get("url") or f"關鍵字「{item.get('keyword')}」"
    return f"⚠️ [{item.get('site')}] 已連續 {count} 次抓取失敗：\n{target}"


def run(dry_run: bool = False) -> None:
    # Telegram commands (/list, /remove, adding a link) are handled instantly
    # by the Cloudflare Worker webhook (see cloudflare-worker/worker.js), not
    # here - Telegram only allows a webhook OR getUpdates polling, not both,
    # so this script no longer touches Telegram's inbox at all.
    watchlist = load_watchlist()
    state = load_state()
    items = watchlist.get("items", [])
    global_cfg = {k: v for k, v in watchlist.items() if k != "items"}

    notifications: list[str] = []
    failure_notices: list[str] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for item in items:
        products = collect_products(item)
        fkey = failure_key(item)
        fail_entry = state.get(fkey, {})

        if not products:
            count = fail_entry.get("count", 0) + 1
            last_notified_at = fail_entry.get("last_notified_at")
            cooled_down = (
                last_notified_at is None
                or datetime.now(timezone.utc) - datetime.fromisoformat(last_notified_at) >= FAILURE_RENOTIFY_COOLDOWN
            )
            if count >= FAILURE_NOTIFY_THRESHOLD and cooled_down:
                failure_notices.append(format_failure_notice(item, count))
                fail_entry["last_notified_at"] = now_iso
            fail_entry["count"] = count
            state[fkey] = fail_entry
        elif fail_entry:
            state[fkey] = {"count": 0, "last_notified_at": None}

        for product in products:
            key = f"{product.site}:{product.product_id}"
            state_entry = state.get(key)

            notify = should_notify(product, item, global_cfg, state_entry)
            if notify:
                notifications.append(format_notification(product))
                logger.info("discount found: %s -> %s %s", product.name, product.currency, product.current_price)

            history = list(state_entry.get("history", [])) if state_entry else []
            last_point = history[-1] if history else None
            if (
                last_point is None
                or last_point["price"] != product.current_price
                or last_point.get("original_price") != product.original_price
            ):
                history.append(
                    {
                        "date": now_iso,
                        "price": product.current_price,
                        "original_price": product.original_price,
                    }
                )
                history = history[-MAX_HISTORY_ENTRIES:]

            new_entry = {
                "name": product.name,
                "url": product.url,
                "currency": product.currency,
                "last_price": product.current_price,
                "last_original_price": product.original_price,
                "last_seen_at": now_iso,
                "last_notified_price": state_entry.get("last_notified_price") if state_entry else None,
                "last_notified_at": state_entry.get("last_notified_at") if state_entry else None,
                "history": history,
            }
            if notify:
                new_entry["last_notified_price"] = product.current_price
                new_entry["last_notified_at"] = now_iso
            state[key] = new_entry

    if not notifications:
        logger.info("no new discounts this run (%d watchlist entries checked)", len(items))
    elif dry_run:
        logger.info("--dry-run: would send %d notification(s):\n\n%s", len(notifications), "\n\n".join(notifications))
    else:
        message = f"發現 {len(notifications)} 個折扣商品：\n\n" + "\n\n".join(notifications)
        send_message(message)
        logger.info("sent Telegram notification with %d discount(s)", len(notifications))

    if failure_notices:
        message = "以下商品抓取持續失敗，可能是網站擋爬蟲或頁面改版：\n\n" + "\n\n".join(failure_notices)
        if dry_run:
            logger.info("--dry-run: would send failure alert:\n\n%s", message)
        else:
            send_message(message)
            logger.info("sent failure alert for %d item(s)", len(failure_notices))

    if not dry_run:
        save_state(state)


SEARCH_MAX_RESULTS_PER_SITE = 5
SEARCH_MESSAGE_LIMIT = 4000  # Telegram caps messages at 4096 chars


def format_search_results(keyword: str, results_by_site: dict[str, list[ProductInfo]]) -> str:
    lines = [f"🔍 搜尋「{keyword}」結果："]
    any_found = False

    for site, products in results_by_site.items():
        if not products:
            lines.append(f"\n[{site}] 沒有找到符合的商品，或抓取失敗")
            continue
        any_found = True
        lines.append(f"\n[{site}]")
        for product in products:
            price_txt = f"{product.currency} {product.current_price:,.0f}"
            if product.original_price and product.original_price > product.current_price:
                price_txt += f"（原價 {product.original_price:,.0f}，折 {product.discount_pct:.0f}%）"
            name = product.name[:60]
            lines.append(f"• {name}\n  {price_txt}\n  {product.url}")

    if not any_found:
        lines.append("\n三個網站都沒有找到符合的商品，或都抓取失敗。")

    message = "\n".join(lines)
    if len(message) > SEARCH_MESSAGE_LIMIT:
        message = message[:SEARCH_MESSAGE_LIMIT] + "\n…（結果太多，已截斷）"
    return message


def run_search(keyword: str, dry_run: bool = False) -> None:
    scrapers = _load_scrapers()
    results_by_site: dict[str, list[ProductInfo]] = {}
    for site_name, scraper in scrapers.items():
        try:
            results_by_site[site_name] = scraper.search(keyword, max_results=SEARCH_MAX_RESULTS_PER_SITE)
        except Exception as exc:  # noqa: BLE001 - a search failing on one site shouldn't kill the others
            logger.warning("search failed for %s: %s", site_name, exc)
            results_by_site[site_name] = []

    message = format_search_results(keyword, results_by_site)
    if dry_run:
        logger.info("--dry-run: would send search results:\n\n%s", message)
    else:
        send_message(message)
        logger.info("sent search results for keyword=%r", keyword)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check iHerb / momo / Coupang watchlist for discounts.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scrape and print results without sending notifications or writing state.",
    )
    parser.add_argument(
        "--search",
        metavar="KEYWORD",
        default=None,
        help="Search all sites for KEYWORD and report results via Telegram, instead of running the normal watchlist check.",
    )
    args = parser.parse_args()
    if args.search:
        run_search(args.search, dry_run=args.dry_run)
    else:
        run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
