"""iHerb scraper.

iHerb blocks plain HTTP requests (bot protection returns 403 even with
browser-like headers), so this module renders the page with a real headless
browser via Playwright and then parses the resulting HTML with
BeautifulSoup. Two data sources are combined:

1. A ``<script type="application/ld+json">`` block with ``@type: "Product"``
   which reliably gives the *list price* (``offers.price``) - this is NOT
   necessarily the price a shopper actually pays, see below.
2. A set of "pricing panel" ``<div>``/``<section>`` elements iHerb ships for
   every possible pricing scenario (regular, cart-only discount, coupon
   strike-through, ...) and toggles visibility with a `hide`/`show` class.
   Only one panel is ever visible at a time; that is today's *actual* price.

If the panel structure ever changes and can't be parsed, we fall back to the
JSON-LD list price with no discount detected, rather than crashing the run.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from . import DEFAULT_USER_AGENT, ProductInfo, ScrapeError, now_utc, retry

SITE = "iherb"
SEARCH_URL = "https://tw.iherb.com/search?kw={kw}"

# iHerb's own product-id URLs ignore the slug text (only the trailing number
# matters), so once we know the id we can force the Taiwan/TWD storefront
# directly instead of trusting whatever region a redirect or IP-geolocation
# lookup picked - GitHub Actions runners have US IPs, so without this,
# iHerb happily serves the .com/USD experience even for a tw.iherb.com link.
PRODUCT_ID_RE = re.compile(r"/pr/[^/]+/(\d+)")


def _new_page(browser):
    context = browser.new_context(user_agent=DEFAULT_USER_AGENT, locale="zh-TW")
    page = context.new_page()
    return context, page


def _get_soup(url: str) -> BeautifulSoup:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context, page = _new_page(browser)
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)

            if "tw.iherb.com" not in page.url:
                match = PRODUCT_ID_RE.search(page.url)
                if match:
                    tw_url = f"https://tw.iherb.com/pr/x/{match.group(1)}"
                    page.goto(tw_url, wait_until="domcontentloaded", timeout=30000)

            # script tags are never "visible", so wait for them to be attached instead
            page.wait_for_selector('script[type="application/ld+json"]', timeout=15000, state="attached")
            html = page.content()
        finally:
            context.close()
            browser.close()
    return BeautifulSoup(html, "html.parser")


def _extract_json_ld_product(soup: BeautifulSoup) -> dict:
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        if data.get("@type") == "Product":
            return data
    raise ValueError("no Product JSON-LD block found")


def _parse_price_text(text: str) -> float | None:
    match = re.search(r"[\d,]+(?:\.\d+)?", text)
    if not match:
        return None
    return float(match.group(0).replace(",", ""))


def _find_active_price_panel(soup: BeautifulSoup):
    """Return the one pricing panel iHerb currently shows (class ends with
    '-config' and also has a 'show' class), or None if the structure changed.
    """
    for el in soup.find_all(class_=True):
        classes = el.get("class", [])
        if "show" in classes and any(c.endswith("-config") for c in classes):
            return el, classes
    return None, []


def _current_and_original_price(soup: BeautifulSoup, list_price: float) -> tuple[float, float | None]:
    panel, classes = _find_active_price_panel(soup)
    if panel is None:
        return list_price, None

    panel_kind = next((c for c in classes if c.endswith("-config")), "")

    if panel_kind.startswith("strike-through"):
        discount_el = panel.find(class_="discount-price")
        list_el = panel.find(class_="list-price")
        current = _parse_price_text(discount_el.get_text()) if discount_el else None
        original = _parse_price_text(list_el.get_text()) if list_el else list_price
        if current is not None:
            return current, original or list_price
        return list_price, None

    if panel_kind.startswith("save-in-cart"):
        pct_match = re.search(r"(\d+)\s*%", panel.get_text())
        if pct_match:
            pct = float(pct_match.group(1))
            return round(list_price * (1 - pct / 100), 2), list_price
        return list_price, None

    # "original-price-config" (no discount) or "see-price-in-cart-config"
    # (price hidden until added to cart) - neither gives us a real discount.
    return list_price, None


def fetch_product(url: str) -> ProductInfo:
    def _do() -> ProductInfo:
        soup = _get_soup(url)
        try:
            product = _extract_json_ld_product(soup)
        except ValueError as exc:
            raise ScrapeError(SITE, url, str(exc)) from exc

        offers = product.get("offers", {})
        list_price = _parse_price_text(str(offers.get("price", "")))
        if list_price is None:
            raise ScrapeError(SITE, url, "could not parse list price from JSON-LD")
        currency = offers.get("priceCurrency", "TWD")
        availability = str(offers.get("availability", ""))

        current, original = _current_and_original_price(soup, list_price)

        return ProductInfo(
            site=SITE,
            product_id=str(product.get("productID") or product.get("sku") or url),
            name=product.get("name", "Unknown iHerb product"),
            url=url,
            currency=currency,
            current_price=current,
            original_price=original,
            in_stock="InStock" in availability or availability == "",
            fetched_at=now_utc(),
        )

    return retry(_do, site=SITE, target=url)


def search(keyword: str, max_results: int = 10) -> list[ProductInfo]:
    def _do() -> list[str]:
        soup = _get_soup(SEARCH_URL.format(kw=keyword))
        links = []
        for a in soup.select('a[href*="/pr/"]'):
            href = a.get("href")
            if href:
                links.append(urljoin("https://tw.iherb.com", href))
        # de-dupe while preserving order
        seen = set()
        unique = []
        for link in links:
            if link not in seen:
                seen.add(link)
                unique.append(link)
        return unique[:max_results]

    urls = retry(_do, site=SITE, target=f"search:{keyword}")

    results = []
    for url in urls:
        try:
            results.append(fetch_product(url))
        except ScrapeError:
            continue
    return results
