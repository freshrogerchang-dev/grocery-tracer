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


def _get_soup(url: str, *, wait_selector: str = 'script[type="application/ld+json"]', wait_for_promo: bool = True) -> BeautifulSoup:
    """Render a page with Playwright and return its parsed HTML.

    ``wait_selector``/``wait_for_promo`` default to product-page behavior
    (see below); search-result pages don't have a per-product JSON-LD block
    or the async promo widget, so ``search()`` passes lighter-weight values.
    """
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
            page.wait_for_selector(wait_selector, timeout=15000, state="attached")

            if wait_for_promo:
                # The pricing widget starts in a default "no discount" state
                # and only flips to a strike-through/discount state after an
                # async JS call (promo/coupon eligibility) resolves -
                # domcontentloaded fires well before that, so we'd otherwise
                # always see "no discount" even when one is active.
                try:
                    page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass  # best effort - proceed with whatever state we have
                page.wait_for_timeout(1000)

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


# iHerb sometimes renders the pricing widget TWICE on the same page (looks
# like a desktop/mobile duplicate), and the two copies' 'show' flags can
# disagree - one showing an active discount, the other showing none. When
# that happens we prefer whichever result actually indicates a promotion,
# since silently missing a real discount is worse than a harmless recheck.
PANEL_PRIORITY = [
    "strike-through-config",
    "save-in-cart-config",
    "original-price-config",
    "see-price-in-cart-config",
]


def _find_active_price_panels(soup: BeautifulSoup) -> list[tuple[str, object]]:
    """Return every pricing panel iHerb currently shows (class ends with
    '-config' and also has a 'show' class) as (panel_kind, element) pairs.
    """
    panels = []
    for el in soup.find_all(class_=True):
        classes = el.get("class", [])
        if "show" in classes and any(c.endswith("-config") for c in classes):
            panel_kind = next(c for c in classes if c.endswith("-config"))
            panels.append((panel_kind, el))
    return panels


def _current_and_original_price(soup: BeautifulSoup, list_price: float) -> tuple[float, float | None]:
    panels = _find_active_price_panels(soup)
    if not panels:
        return list_price, None

    for preferred_kind in PANEL_PRIORITY:
        panel = next((el for kind, el in panels if kind == preferred_kind), None)
        if panel is None:
            continue

        if preferred_kind == "strike-through-config":
            discount_el = panel.find(class_="discount-price")
            list_el = panel.find(class_="list-price")
            current = _parse_price_text(discount_el.get_text()) if discount_el else None
            original = _parse_price_text(list_el.get_text()) if list_el else list_price
            if current is not None:
                return current, original or list_price
            return list_price, None

        if preferred_kind == "save-in-cart-config":
            pct_match = re.search(r"(\d+)\s*%", panel.get_text())
            if pct_match:
                pct = float(pct_match.group(1))
                return round(list_price * (1 - pct / 100), 2), list_price
            return list_price, None

        # "original-price-config" (no discount) or "see-price-in-cart-config"
        # (price hidden until added to cart) - neither gives us a real discount.
        return list_price, None

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
        soup = _get_soup(SEARCH_URL.format(kw=keyword), wait_selector='a[href*="/pr/"]', wait_for_promo=False)
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
