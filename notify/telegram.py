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
