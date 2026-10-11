"""Sending notifications and collecting responses."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.template import Template
from homeassistant.util import dt as dt_util

from .const import (
    ACTION_PREFIX,
    ALEXA_MODE_ANNOUNCE,
    EVENT_RESPONSE,
    EVENT_SENT,
    LOG_SIZE,
    LOGGER,
    MOBILE_ACTION_EVENT,
    PRIORITY_CRITICAL,
    PRIORITY_TIME_SENSITIVE,
    RESPONSE_SENT,
    RESPONSE_TIMEOUT,
)
from .store import NotifyManagerStore, new_id


@dataclass
class Pending:
    """A sent notification that waits for an action button."""

    request_id: str
    template: dict[str, Any]
    push_services: list[str]
    tag: str
    log: dict[str, Any]
    variables: dict[str, Any]
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    # Set when a timeout is configured; cancelled once a response arrives.
    cancel_timeout: CALLBACK_TYPE | None = None


class NotifyManager:
    """Renders templates, dispatches them and tracks responses."""

    def __init__(self, hass: HomeAssistant, store: NotifyManagerStore) -> None:
        self.hass = hass
        self.store = store
        self.pending: dict[str, Pending] = {}
        self.log: deque[dict[str, Any]] = deque(maxlen=LOG_SIZE)
        self._unsub: CALLBACK_TYPE | None = None

    @callback
    def async_start(self) -> None:
        self._unsub = self.hass.bus.async_listen(MOBILE_ACTION_EVENT, self._handle_action)

    @callback
    def async_stop(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None
        for pending in list(self.pending.values()):
            if pending.cancel_timeout:
                pending.cancel_timeout()
            if not pending.future.done():
                pending.future.cancel()
        self.pending.clear()

    # ------------------------------------------------------------------ helpers

    def _render(self, text: str | None, variables: dict[str, Any]) -> str:
        if not text:
            return ""
        try:
            return str(Template(text, self.hass).async_render(variables, parse_result=False))
        except Exception as err:  # noqa: BLE001 - surface template errors to the user
            raise ServiceValidationError(f"Template-Fehler in '{text}': {err}") from err

    def _in_quiet_hours(self, tpl: dict[str, Any]) -> bool:
        quiet = tpl["quiet_hours"]
        if not quiet["enabled"]:
            return False
        now = dt_util.now().strftime("%H:%M")
        start, end = quiet["start"], quiet["end"]
        if start <= end:
            return start <= now < end
        return now >= start or now < end

    def _anyone_home(self) -> bool:
        return any(s.state == "home" for s in self.hass.states.async_all("person"))

    def _push_services(self, tpl: dict[str, Any], recipients: list[str] | None) -> list[str]:
        services: list[str] = []
        for rid in recipients if recipients is not None else tpl["recipients"]:
            rec = self.store.recipients.get(rid) or next(
                (r for r in self.store.recipients.values() if r["name"].lower() == str(rid).lower()),
                None,
            )
            if rec is None:
                LOGGER.warning("Unbekannter Empfänger: %s", rid)
                continue
            services.extend(rec["push_devices"])
        services.extend(tpl["push_devices"])
        # notify.<service> → <service>
        return list(dict.fromkeys(s.removeprefix("notify.") for s in services))

    def _push_data(self, tpl: dict[str, Any], request_id: str, tag: str, priority: str) -> dict[str, Any]:
        data: dict[str, Any] = {"tag": tag}
        if tpl["actions"]:
            data["actions"] = []
            for action in tpl["actions"]:
                entry: dict[str, Any] = {
                    "action": f"{ACTION_PREFIX}_{request_id}_{action['key']}",
                    "title": action["title"],
                }
                if action["destructive"]:
                    entry["destructive"] = True
                if action["text_input"]:
                    entry["behavior"] = "textInput"
                data["actions"].append(entry)
        if priority == PRIORITY_TIME_SENSITIVE:
            data["push"] = {"interruption-level": "time-sensitive"}
            data.update(priority="high", ttl=0)
        elif priority == PRIORITY_CRITICAL:
            data["push"] = {
                "interruption-level": "critical",
                "sound": {"name": "default", "critical": 1, "volume": tpl["critical_volume"]},
            }
            data.update(priority="high", ttl=0, channel="alarm_stream")
        if tpl["group"]:
            data["group"] = tpl["group"]
        if tpl["url"]:
            data["url"] = tpl["url"]
            data["clickAction"] = tpl["url"]
        if tpl["image"]:
            data["image"] = tpl["image"]
        return data

    async def _call(self, errors: list[str], domain: str, service: str, data: dict[str, Any]) -> None:
        try:
            await self.hass.services.async_call(domain, service, data, blocking=True)
        except Exception as err:  # noqa: BLE001 - one failing channel must not stop the others
            LOGGER.error("%s.%s fehlgeschlagen: %s", domain, service, err)
            errors.append(f"{domain}.{service}: {err}")

    def _tts_engine(self, engine: str | None) -> str | None:
        """Configured engine, else Home Assistant Cloud, else the first TTS entity."""
        engines = self.hass.states.async_entity_ids("tts")
        if engine:
            return engine
        if "tts.home_assistant_cloud" in engines:
            return "tts.home_assistant_cloud"
        return next(iter(sorted(engines)), None)

    async def _tts_url(self, engine: str | None, message: str) -> str:
        from homeassistant.components.media_player import async_process_play_media_url
        from homeassistant.components.media_source import async_resolve_media
        from homeassistant.components.tts import generate_media_source_id

        engine = self._tts_engine(engine)
        if not engine:
            raise HomeAssistantError("Keine TTS-Engine gefunden")
        media_id = generate_media_source_id(self.hass, message, engine)
        media = await async_resolve_media(self.hass, media_id, None)
        return async_process_play_media_url(self.hass, media.url)

    async def _music_assistant(self, errors: list[str], tpl: dict[str, Any], message: str) -> None:
        try:
            url = await self._tts_url(tpl["tts"]["engine"], message)
        except Exception as err:  # noqa: BLE001
            LOGGER.error("TTS für Music Assistant fehlgeschlagen: %s", err)
            errors.append(f"tts: {err}")
            return
        data: dict[str, Any] = {"entity_id": tpl["music_assistant"]["entities"], "url": url}
        if tpl["music_assistant"]["volume"] is not None:
            data["announce_volume"] = tpl["music_assistant"]["volume"]
        await self._call(errors, "music_assistant", "play_announcement", data)

    # --------------------------------------------------------------------- send

    async def async_send(
        self,
        template_ref: str,
        variables: dict[str, Any] | None = None,
        *,
        title: str | None = None,
        message: str | None = None,
        priority: str | None = None,
        recipients: list[str] | None = None,
        wait: bool | None = None,
        timeout: int | None = None,
        test: bool = False,
    ) -> dict[str, Any]:
        tpl = self.store.find_template(template_ref)
        if tpl is None:
            raise ServiceValidationError(f"Vorlage '{template_ref}' nicht gefunden")

        variables = {name: "" for name in tpl["variables"]} | dict(variables or {})
        request_id = new_id()
        tag = f"nm_{request_id}"
        rendered_title = self._render(title if title is not None else tpl["title"], variables)
        rendered_message = self._render(message if message is not None else tpl["message"], variables)
        spoken = self._render(tpl["tts_message"], variables) if tpl["tts_message"] and message is None else rendered_message
        priority = priority or tpl["priority"]
        timeout = tpl["timeout"] if timeout is None else timeout

        push_services = self._push_services(tpl, recipients)
        errors: list[str] = []
        calls = []
        targets: dict[str, list[str]] = {}

        push_data = self._push_data(tpl, request_id, tag, priority)
        for service in push_services:
            if not self.hass.services.has_service("notify", service):
                errors.append(f"notify.{service} existiert nicht")
                continue
            payload: dict[str, Any] = {"message": rendered_message or rendered_title, "data": push_data}
            if rendered_title:
                payload["title"] = rendered_title
            calls.append(self._call(errors, "notify", service, payload))
            targets.setdefault("push", []).append(service)

        skipped = None
        has_speakers = bool(
            tpl["alexa"]["entities"] or tpl["music_assistant"]["entities"] or tpl["tts"]["entities"]
        )
        if has_speakers and not test:
            if self._in_quiet_hours(tpl):
                skipped = "Ruhezeit"
            elif tpl["speakers_only_when_home"] and not self._anyone_home():
                skipped = "niemand zu Hause"

        if has_speakers and not skipped and spoken:
            if tpl["alexa"]["entities"]:
                data: dict[str, Any] = {"type": tpl["alexa"]["mode"]}
                if tpl["alexa"]["mode"] == ALEXA_MODE_ANNOUNCE:
                    data["method"] = "all"
                calls.append(
                    self._call(
                        errors,
                        "notify",
                        "alexa_media",
                        {"message": spoken, "target": tpl["alexa"]["entities"], "data": data},
                    )
                )
                targets["alexa"] = tpl["alexa"]["entities"]
            if tpl["music_assistant"]["entities"]:
                calls.append(self._music_assistant(errors, tpl, spoken))
                targets["music_assistant"] = tpl["music_assistant"]["entities"]
            if tpl["tts"]["entities"]:
                engine = self._tts_engine(tpl["tts"]["engine"])
                calls.append(
                    self._call(
                        errors,
                        "tts",
                        "speak",
                        {
                            "entity_id": engine,
                            "media_player_entity_id": tpl["tts"]["entities"],
                            "message": spoken,
                        },
                    )
                )
                targets["tts"] = tpl["tts"]["entities"]

        if tpl["persistent"]:
            calls.append(
                self._call(
                    errors,
                    "persistent_notification",
                    "create",
                    {"title": rendered_title, "message": rendered_message, "notification_id": tag},
                )
            )
            targets["persistent"] = [tag]

        await asyncio.gather(*calls)

        interactive = bool(tpl["actions"] and targets.get("push"))
        entry = {
            "time": dt_util.now().isoformat(),
            "request_id": request_id,
            "template_id": tpl["id"],
            "template": tpl["name"],
            "title": rendered_title,
            "message": rendered_message,
            "priority": priority,
            "targets": targets,
            "skipped_speakers": skipped,
            "errors": errors,
            "status": "waiting" if interactive else RESPONSE_SENT,
            "response": None,
            "test": test,
        }
        self.log.appendleft(entry)
        self.hass.bus.async_fire(
            EVENT_SENT,
            {k: entry[k] for k in ("request_id", "template_id", "template", "title", "message", "targets")},
        )

        result = {
            "request_id": request_id,
            "response": RESPONSE_SENT,
            "response_title": None,
            "reply_text": None,
            "device": None,
            "title": rendered_title,
            "message": rendered_message,
            "errors": errors,
        }
        if not interactive:
            return result

        pending = Pending(request_id, tpl, targets["push"], tag, entry, variables)
        self.pending[request_id] = pending
        if timeout:

            @callback
            def _timed_out(_now: Any) -> None:
                self._resolve(request_id, RESPONSE_TIMEOUT, None, {})

            pending.cancel_timeout = async_call_later(self.hass, timeout, _timed_out)

        if not (tpl["wait"] if wait is None else wait):
            return result

        try:
            return result | await asyncio.shield(pending.future)
        except asyncio.CancelledError:
            return result | {"response": RESPONSE_TIMEOUT}

    # ---------------------------------------------------------------- responses

    @callback
    def _handle_action(self, event: Event) -> None:
        action = str(event.data.get("action") or "")
        if not action.startswith(f"{ACTION_PREFIX}_"):
            return
        try:
            _, request_id, key = action.split("_", 2)
        except ValueError:
            return
        if request_id not in self.pending:
            LOGGER.debug("Antwort auf unbekannte/abgelaufene Anfrage %s", request_id)
            return
        self._resolve(request_id, key, event.data.get("reply_text"), event.data)

    @callback
    def _resolve(self, request_id: str, key: str, reply_text: str | None, data: dict[str, Any]) -> None:
        pending = self.pending.pop(request_id, None)
        if pending is None:
            return
        if pending.cancel_timeout and key != RESPONSE_TIMEOUT:
            pending.cancel_timeout()
        tpl = pending.template
        action = next((a for a in tpl["actions"] if a["key"] == key), None)
        device = data.get("sourceDeviceName") or data.get("device_id")
        response = {
            "response": key,
            "response_title": action["title"] if action else None,
            "reply_text": reply_text,
            "device": device,
        }
        pending.log.update(status=key, response=response, response_time=dt_util.now().isoformat())
        if not pending.future.done():
            pending.future.set_result(response)

        self.hass.bus.async_fire(
            EVENT_RESPONSE,
            {
                "request_id": request_id,
                "template_id": tpl["id"],
                "template": tpl["name"],
                "service": tpl["service"],
                "variables": pending.variables,
                **response,
            },
        )
        if tpl["clear_on_response"]:
            self.hass.async_create_task(self._clear(pending))

    async def _clear(self, pending: Pending) -> None:
        errors: list[str] = []
        calls = [
            self._call(errors, "notify", s, {"message": "clear_notification", "data": {"tag": pending.tag}})
            for s in pending.push_services
        ]
        if pending.template["persistent"]:
            calls.append(
                self._call(errors, "persistent_notification", "dismiss", {"notification_id": pending.tag})
            )
        await asyncio.gather(*calls)
