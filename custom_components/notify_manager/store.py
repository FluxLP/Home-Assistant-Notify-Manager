"""Persistent storage and schemas for Notify Manager."""
from __future__ import annotations

import re
from typing import Any
import uuid

import voluptuous as vol

from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.util import slugify

from .const import (
    ALEXA_MODE_ANNOUNCE,
    ALEXA_MODE_TTS,
    PRIORITIES,
    PRIORITY_NORMAL,
    RESERVED_SERVICES,
    STORAGE_KEY,
    STORAGE_VERSION,
)

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _time(value: Any) -> str:
    value = str(value or "")
    if not TIME_RE.match(value):
        raise vol.Invalid(f"Ungültige Uhrzeit: {value}")
    return value


def _key(value: Any) -> str:
    key = slugify(str(value or ""))
    if not key:
        raise vol.Invalid("Aktions-Schlüssel darf nicht leer sein")
    return key


def _strings(value: Any) -> list[str]:
    return [str(v) for v in cv.ensure_list(value) if str(v).strip()]


ACTION_SCHEMA = vol.Schema(
    {
        vol.Required("key"): _key,
        vol.Required("title"): cv.string,
        vol.Optional("destructive", default=False): cv.boolean,
        vol.Optional("text_input", default=False): cv.boolean,
    },
    extra=vol.REMOVE_EXTRA,
)

TEMPLATE_SCHEMA = vol.Schema(
    {
        vol.Required("id"): cv.string,
        vol.Required("name"): cv.string,
        vol.Optional("icon", default="mdi:bell"): cv.string,
        vol.Optional("description", default=""): vol.Any(None, cv.string),
        vol.Optional("service", default=""): vol.Any(None, cv.string),
        vol.Optional("title", default=""): vol.Any(None, cv.string),
        vol.Optional("message", default=""): vol.Any(None, cv.string),
        vol.Optional("tts_message", default=""): vol.Any(None, cv.string),
        vol.Optional("variables", default=list): _strings,
        vol.Optional("recipients", default=list): _strings,
        vol.Optional("push_devices", default=list): _strings,
        vol.Optional("priority", default=PRIORITY_NORMAL): vol.In(PRIORITIES),
        vol.Optional("critical_volume", default=1.0): vol.All(
            vol.Coerce(float), vol.Range(min=0, max=1)
        ),
        vol.Optional("actions", default=list): [ACTION_SCHEMA],
        vol.Optional("wait", default=False): cv.boolean,
        vol.Optional("timeout", default=300): vol.All(
            vol.Coerce(int), vol.Range(min=0, max=86400)
        ),
        vol.Optional("clear_on_response", default=True): cv.boolean,
        vol.Optional("url", default=""): vol.Any(None, cv.string),
        vol.Optional("image", default=""): vol.Any(None, cv.string),
        vol.Optional("group", default=""): vol.Any(None, cv.string),
        vol.Optional("alexa", default=dict): vol.Schema(
            {
                vol.Optional("entities", default=list): _strings,
                vol.Optional("mode", default=ALEXA_MODE_ANNOUNCE): vol.In(
                    [ALEXA_MODE_ANNOUNCE, ALEXA_MODE_TTS]
                ),
            },
            extra=vol.REMOVE_EXTRA,
        ),
        vol.Optional("music_assistant", default=dict): vol.Schema(
            {
                vol.Optional("entities", default=list): _strings,
                vol.Optional("volume", default=None): vol.Any(
                    None, vol.All(vol.Coerce(int), vol.Range(min=0, max=100))
                ),
            },
            extra=vol.REMOVE_EXTRA,
        ),
        vol.Optional("tts", default=dict): vol.Schema(
            {
                vol.Optional("engine", default=""): vol.Any(None, cv.string),
                vol.Optional("entities", default=list): _strings,
            },
            extra=vol.REMOVE_EXTRA,
        ),
        vol.Optional("persistent", default=False): cv.boolean,
        vol.Optional("quiet_hours", default=dict): vol.Schema(
            {
                vol.Optional("enabled", default=False): cv.boolean,
                vol.Optional("start", default="22:00"): _time,
                vol.Optional("end", default="07:00"): _time,
            },
            extra=vol.REMOVE_EXTRA,
        ),
        vol.Optional("speakers_only_when_home", default=False): cv.boolean,
    },
    extra=vol.REMOVE_EXTRA,
)

RECIPIENT_SCHEMA = vol.Schema(
    {
        vol.Required("id"): cv.string,
        vol.Required("name"): cv.string,
        vol.Optional("person", default=""): vol.Any(None, cv.string),
        vol.Optional("push_devices", default=list): _strings,
    },
    extra=vol.REMOVE_EXTRA,
)


def new_id() -> str:
    return uuid.uuid4().hex[:10]


class NotifyManagerStore:
    """Holds recipients and templates."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.templates: dict[str, dict[str, Any]] = {}
        self.recipients: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.templates = {}
        self.recipients = {}
        for raw in data.get("recipients", []):
            rec = RECIPIENT_SCHEMA(raw)
            self.recipients[rec["id"]] = rec
        for raw in data.get("templates", []):
            tpl = TEMPLATE_SCHEMA(raw)
            self.templates[tpl["id"]] = tpl

    async def _async_save(self) -> None:
        await self._store.async_save(
            {
                "recipients": list(self.recipients.values()),
                "templates": list(self.templates.values()),
            }
        )

    def _unique_service(self, tpl: dict[str, Any]) -> str:
        base = slugify(tpl.get("service") or tpl["name"]) or "vorlage"
        if base in RESERVED_SERVICES:
            base = f"{base}_vorlage"
        taken = {
            t["service"] for t in self.templates.values() if t["id"] != tpl["id"]
        }
        service, i = base, 2
        while service in taken:
            service, i = f"{base}_{i}", i + 1
        return service

    async def async_save_template(self, raw: dict[str, Any]) -> dict[str, Any]:
        raw = dict(raw)
        raw.setdefault("id", new_id())
        if not raw["id"]:
            raw["id"] = new_id()
        tpl = TEMPLATE_SCHEMA(raw)
        keys = [a["key"] for a in tpl["actions"]]
        if len(keys) != len(set(keys)):
            raise vol.Invalid("Aktions-Schlüssel müssen eindeutig sein")
        tpl["variables"] = [slugify(v) for v in tpl["variables"] if slugify(v)]
        tpl["service"] = self._unique_service(tpl)
        self.templates[tpl["id"]] = tpl
        await self._async_save()
        return tpl

    async def async_delete_template(self, template_id: str) -> None:
        self.templates.pop(template_id, None)
        await self._async_save()

    async def async_save_recipient(self, raw: dict[str, Any]) -> dict[str, Any]:
        raw = dict(raw)
        if not raw.get("id"):
            raw["id"] = new_id()
        rec = RECIPIENT_SCHEMA(raw)
        self.recipients[rec["id"]] = rec
        await self._async_save()
        return rec

    async def async_delete_recipient(self, recipient_id: str) -> None:
        self.recipients.pop(recipient_id, None)
        for tpl in self.templates.values():
            if recipient_id in tpl["recipients"]:
                tpl["recipients"].remove(recipient_id)
        await self._async_save()

    def find_template(self, ref: str) -> dict[str, Any] | None:
        """Find a template by id, service name or name."""
        if ref in self.templates:
            return self.templates[ref]
        slug = slugify(ref)
        for tpl in self.templates.values():
            if tpl["service"] == ref or slugify(tpl["name"]) == slug:
                return tpl
        return None
