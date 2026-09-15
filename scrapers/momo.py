"""momo購物網 scraper.

momo's pages are client-rendered enough (search results, lazy widgets) that a
plain HTTP GET misses content, so this module drives a real headless browser
via Playwright.

Product detail pages expose:
- A JSON-LD ``ProductGroup`` block with the product name.
- The current price in ``span.font-price`` (no ``line-through`` class) and,
  when the item is discounted, the original price in another
  ``span.font-price`` that DOES have a ``line-through`` class.

Search result pages list items as ``li[id^="search-goods-item-"]`` with a
``a.prdName`` link to the product detail page; momo does not show the
original price in the search list, so ``search()`` re-visits each candidate
product page via ``fetch_product`` to get an accurate before/after price.
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote

from playwright.sync_api import sync_playwright

from . import DEFAULT_USER_AGENT, ProductInfo, ScrapeError, now_utc, retry

SITE = "momo"
SEARCH_URL = "https://www.momoshop.com.tw/search/{kw}?searchType=1"
PRODUCT_ID_RE = re.compile(r"i_code=(\d+)|/product/(\d+)")


def _parse_price_text(text: str) -> float | None:
    match = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not match:
        return None
    return float(match.group(0).replace(",", ""))


def _product_id_from_url(url: str) -> str:
    match = PRODUCT_ID_RE.search(url)
    if match:
        return match.group(1) or match.group(2)
    return url


def _new_page(browser):
    context = browser.new_context(user_agent=DEFAULT_USER_AGENT, locale="zh-TW")
    page = context.new_page()
    return context, page


def fetch_product(url: str) -> ProductInfo:
    def _do() -> ProductInfo:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context, page = _new_page(browser)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_selector(".font-price", timeout=15000)

                name = None
                for ld in page.query_selector_all('script[type="application/ld+json"]'):
                    try:
                        data = json.loads(ld.inner_text())
                    except (json.JSONDecodeError, TypeError):
                        continue
                    graph = data.get("@graph", [data]) if isinstance(data, dict) else []
                    for node in graph:
                        if node.get("@type") in ("ProductGroup", "Product"):
                            name = node.get("name")
                            break
                    if name:
                        break

                current_price = None
                original_price = None
                for el in page.query_selector_all(".font-price"):
                    cls = el.get_attribute("class") or ""
                    price = _parse_price_text(el.inner_text())
                    if price is None:
                        continue
                    if "line-through" in cls:
                        original_price = price
                    elif current_price is None:
                        current_price = price

                if current_price is None:
                    raise ScrapeError(SITE, url, "could not find current price on page")

                return ProductInfo(
                    site=SITE,
                    product_id=_product_id_from_url(page.url),
                    name=name or "Unknown momo product",
                    url=url,
                    currency="TWD",
                    current_price=current_price,
                    original_price=original_price,
                    in_stock=True,
                    fetched_at=now_utc(),
                )
            finally:
                context.close()
                browser.close()

    return retry(_do, site=SITE, target=url)


def search(keyword: str, max_results: int = 10) -> list[ProductInfo]:
    def _do() -> list[str]:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context, page = _new_page(browser)
            try:
                page.goto(SEARCH_URL.format(kw=quote(keyword)), wait_until="domcontentloaded", timeout=30000)
                page.wait_for_selector('li[id^="search-goods-item-"]', timeout=15000)
                hrefs = page.eval_on_selector_all(
                    'li[id^="search-goods-item-"] a.prdName[href]',
                    "els => els.map(e => e.href)",
                )
                seen = set()
                unique = []
                for href in hrefs:
                    if href not in seen:
                        seen.add(href)
                        unique.append(href)
                return unique[:max_results]
            finally:
                context.close()
                browser.close()

    urls = retry(_do, site=SITE, target=f"search:{keyword}")

    results = []
    for url in urls:
        try:
            results.append(fetch_product(url))
        except ScrapeError:
            continue
    return results
