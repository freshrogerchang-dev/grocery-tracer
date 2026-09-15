from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger("discount_monitor.notify")

API_URL = "https://api.telegram.org/bot{token}/sendMessage"


class TelegramConfigError(Exception):
    pass


def send_message(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        raise TelegramConfigError(
            "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID environment variables are not set"
        )

    resp = requests.post(
        API_URL.format(token=token),
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
