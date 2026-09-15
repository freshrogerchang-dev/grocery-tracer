from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger("discount_monitor.notify")

BASE_URL = "https://api.telegram.org/bot{token}"


class TelegramConfigError(Exception):
    pass


def _token() -> str:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise TelegramConfigError("TELEGRAM_BOT_TOKEN environment variable is not set")
    return token


def send_message(text: str) -> None:
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not chat_id:
        raise TelegramConfigError("TELEGRAM_CHAT_ID environment variable is not set")

    resp = requests.post(
        BASE_URL.format(token=_token()) + "/sendMessage",
        json={
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": False,
        },
        timeout=15,
    )
    if not resp.ok:
        logger.error("Telegram API error %s: %s", resp.status_code, resp.text)
        resp.raise_for_status()


def get_updates(offset: int | None = None, timeout: int = 0) -> list[dict]:
    """Fetch new incoming messages sent to the bot since ``offset``.

    Uses long-poll semantics but with ``timeout=0`` by default since this
    runs once per scheduled GitHub Actions job rather than as a long-lived
    process.
    """
    params: dict = {"timeout": timeout, "allowed_updates": '["message"]'}
    if offset is not None:
        params["offset"] = offset

    resp = requests.get(
        BASE_URL.format(token=_token()) + "/getUpdates",
        params=params,
        timeout=timeout + 15,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram getUpdates failed: {data}")
    return data.get("result", [])
