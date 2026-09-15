from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, TypeVar

logger = logging.getLogger("discount_monitor.scrapers")

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class ScrapeError(Exception):
    """Raised when a scraper cannot retrieve or parse a product page."""

    def __init__(self, site: str, target: str, reason: str):
        self.site = site
        self.target = target
        self.reason = reason
        super().__init__(f"[{site}] failed to scrape {target!r}: {reason}")


@dataclass
class ProductInfo:
    site: str
    product_id: str
    name: str
    url: str
    currency: str
    current_price: float
    original_price: float | None
    in_stock: bool
    fetched_at: datetime

    @property
    def discount_pct(self) -> float:
        if not self.original_price or self.original_price <= self.current_price:
            return 0.0
        return round((1 - self.current_price / self.original_price) * 100, 1)

    @property
    def is_discounted(self) -> bool:
        return self.discount_pct > 0


T = TypeVar("T")


def retry(fn: Callable[[], T], *, attempts: int = 3, delay: float = 2.0, site: str = "", target: str = "") -> T:
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - deliberately broad, re-raised as ScrapeError below
            last_exc = exc
            logger.warning("attempt %d/%d failed for %s %s: %s", attempt, attempts, site, target, exc)
            if attempt < attempts:
                time.sleep(delay * attempt)
    raise ScrapeError(site, target, str(last_exc))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)
