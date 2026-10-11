"""Constants for Notify Manager."""
from __future__ import annotations

import logging

DOMAIN = "notify_manager"
NAME = "Notify Manager"
VERSION = "0.1.0"
LOGGER = logging.getLogger(__package__)

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

PANEL_URL_PATH = "notify-manager"
PANEL_COMPONENT = "notify-manager-panel"
PANEL_STATIC_URL = "/notify_manager_static"
PANEL_ICON = "mdi:bell-cog"

EVENT_RESPONSE = f"{DOMAIN}_response"
EVENT_SENT = f"{DOMAIN}_sent"
MOBILE_ACTION_EVENT = "mobile_app_notification_action"

ACTION_PREFIX = "NM"

PRIORITY_NORMAL = "normal"
PRIORITY_TIME_SENSITIVE = "time_sensitive"
PRIORITY_CRITICAL = "critical"
PRIORITIES = [PRIORITY_NORMAL, PRIORITY_TIME_SENSITIVE, PRIORITY_CRITICAL]

ALEXA_MODE_ANNOUNCE = "announce"
ALEXA_MODE_TTS = "tts"

RESPONSE_TIMEOUT = "timeout"
RESPONSE_SENT = "sent"

SERVICE_SEND = "send"
SERVICE_RELOAD = "reload"

# Service names that may not be used for template services.
RESERVED_SERVICES = {SERVICE_SEND, SERVICE_RELOAD}

LOG_SIZE = 50
