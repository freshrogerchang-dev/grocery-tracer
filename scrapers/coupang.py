"""Coupang (tw.coupang.com) scraper - BEST EFFORT, UNVERIFIED.

Coupang runs aggressive bot detection; this module's browser tooling itself
was refused access to tw.coupang.com when this project was built ("not
allowed due to safety restrictions"), so the selectors below were written
from general e-commerce conventions (JSON-LD / Open Graph price meta tags),
NOT confirmed against a live page. Expect this scraper to need adjustment -
run ``python main.py --dry-run`` locally first and inspect what it returns
(or fails with) before relying on it.

If Coupang keeps failing from GitHub Actions' shared IPs (likely, given how
aggressively it blocks datacenter traffic), remove its entries from
``config/watchlist.yaml`` and keep using iHerb + momo, which are more
scraper-friendly.
"""

from __future__ import annotations

import json
import re
from urllib.parse import quote

from playwright.sync_api import sync_playwright

from . import DEFAULT_USER_AGENT, ProductInfo, ScrapeError, now_utc, retry

SITE = "coupang"
SEARCH_URL = "https://www.tw.coupang.com/np/search?q={kw}"
PRODUCT_ID_RE = re.compile(r"/products/(\d+)")


def _parse_price_text(text: str) -> float | None:
    match = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not match:
        return None
    return float(match.group(0).replace(",", ""))


def _product_id_from_url(url: str) -> str:
    match = PRODUCT_ID_RE.search(url)
    return match.group(1) if match else url


def _extract_from_json_ld(page) -> dict | None:
    for ld in page.query_selector_all('script[type="application/ld+json"]'):
        try:
            data = json.loads(ld.inner_text())
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(data, dict) and data.get("@type") == "Product":
            return data
    return None


def _extract_from_meta(page) -> dict:
    def meta(prop: str) -> str | None:
        el = page.query_selector(f'meta[property="{prop}"], meta[name="{prop}"]')
        return el.get_attribute("content") if el else None

    return {
        "price": meta("product:price:amount") or meta("og:price:amount"),
        "currency": meta("product:price:currency") or meta("og:price:currency"),
        "name": meta("og:title"),
    }


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
                page.wait_for_timeout(1500)

                product = _extract_from_json_ld(page)
                name = None
                current_price = None
                original_price = None
                currency = "TWD"

                if product:
                    name = product.get("name")
                    offers = product.get("offers", {})
                    if isinstance(offers, list):
                        offers = offers[0] if offers else {}
                    current_price = _parse_price_text(str(offers.get("price", "")))
                    currency = offers.get("priceCurrency", currency)

                if current_price is None:
                    meta = _extract_from_meta(page)
                    name = name or meta.get("name")
                    current_price = _parse_price_text(str(meta.get("price") or ""))
                    currency = meta.get("currency") or currency

                if current_price is None:
                    # last-resort: any element that looks like a price on the page
                    for selector in ['[class*="price" i]', '[class*="Price"]']:
                        el = page.query_selector(selector)
                        if el:
                            current_price = _parse_price_text(el.inner_text())
                            if current_price is not None:
                                break

                if current_price is None:
                    raise ScrapeError(SITE, url, "could not locate a price on the page (page structure unknown / possibly blocked)")

                strike_el = page.query_selector('[class*="base-price" i], del, s, [class*="original" i]')
                if strike_el:
                    original_price = _parse_price_text(strike_el.inner_text())

                return ProductInfo(
                    site=SITE,
                    product_id=_product_id_from_url(page.url),
                    name=name or "Unknown Coupang product",
                    url=url,
                    currency=currency,
                    current_price=current_price,
                    original_price=original_price,
                    in_stock=True,
                    fetched_at=now_utc(),
                )
            finally:
                context.close()
                browser.close()

    return retry(_do, site=SITE, target=url, attempts=2)


def search(keyword: str, max_results: int = 10) -> list[ProductInfo]:
    def _do() -> list[str]:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context, page = _new_page(browser)
            try:
                page.goto(SEARCH_URL.format(kw=quote(keyword)), wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(1500)
                hrefs = page.eval_on_selector_all(
                    'a[href*="/products/"]',
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

    urls = retry(_do, site=SITE, target=f"search:{keyword}", attempts=2)

    results = []
    for url in urls:
        try:
            results.append(fetch_product(url))
        except ScrapeError:
            continue
    return results
