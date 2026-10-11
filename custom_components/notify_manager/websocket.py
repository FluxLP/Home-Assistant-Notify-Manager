"""Websocket API used by the Notify Manager panel."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.util import slugify

from .const import DOMAIN, VERSION
from .sender import NotifyManager


def _name(hass: HomeAssistant, entity_id: str, entry: er.RegistryEntry | None = None) -> str:
    state = hass.states.get(entity_id)
    if state and state.name:
        return state.name
    if entry and (entry.name or entry.original_name):
        return entry.name or entry.original_name
    return entity_id


def discover_targets(hass: HomeAssistant) -> dict[str, Any]:
    """Collect everything a notification can be sent to."""
    mobile_names = {
        f"mobile_app_{slugify(entry.data.get('device_name', ''))}": entry.data.get("device_name")
        for entry in hass.config_entries.async_entries("mobile_app")
    }
    push = [
        {"service": service, "name": mobile_names.get(service) or service.removeprefix("mobile_app_").replace("_", " ").title()}
        for service in sorted(hass.services.async_services_for_domain("notify"))
        if service.startswith("mobile_app_")
    ]

    registry = er.async_get(hass)
    players: dict[str, list[dict[str, str]]] = {"alexa": [], "music_assistant": [], "other": []}
    for entity_id in sorted(hass.states.async_entity_ids("media_player")):
        entry = registry.async_get(entity_id)
        if entry and entry.disabled_by:
            continue
        platform = entry.platform if entry else None
        group = {"alexa_media": "alexa", "music_assistant": "music_assistant"}.get(platform or "", "other")
        state = hass.states.get(entity_id)
        players[group].append(
            {
                "entity_id": entity_id,
                "name": _name(hass, entity_id, entry),
                "platform": platform or "",
                "available": bool(state and state.state != "unavailable"),
            }
        )

    return {
        "push": push,
        "alexa": players["alexa"] if hass.services.has_service("notify", "alexa_media") else [],
        "music_assistant": players["music_assistant"]
        if hass.services.has_service("music_assistant", "play_announcement")
        else [],
        "media_players": players["other"],
        "tts_engines": [
            {"entity_id": e, "name": _name(hass, e)} for e in sorted(hass.states.async_entity_ids("tts"))
        ],
        "persons": [
            {"entity_id": s.entity_id, "name": s.name, "state": s.state}
            for s in hass.states.async_all("person")
        ],
    }


@callback
def async_setup_websocket(
    hass: HomeAssistant, manager: NotifyManager, on_change: Callable[[], None]
) -> None:
    store = manager.store

    def _config() -> dict[str, Any]:
        return {
            "version": VERSION,
            "templates": list(store.templates.values()),
            "recipients": list(store.recipients.values()),
        }

    @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config"})
    @callback
    def ws_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        connection.send_result(msg["id"], _config())

    @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/targets"})
    @callback
    def ws_targets(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        connection.send_result(msg["id"], discover_targets(hass))

    @websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/log"})
    @callback
    def ws_log(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        connection.send_result(msg["id"], {"log": list(manager.log)})

    @websocket_api.websocket_command(
        {vol.Required("type"): f"{DOMAIN}/template/save", vol.Required("template"): dict}
    )
    @websocket_api.require_admin
    @websocket_api.async_response
    async def ws_template_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        try:
            tpl = await store.async_save_template(msg["template"])
        except vol.Invalid as err:
            connection.send_error(msg["id"], "invalid_format", str(err))
            return
        on_change()
        connection.send_result(msg["id"], {"template": tpl})

    @websocket_api.websocket_command(
        {vol.Required("type"): f"{DOMAIN}/template/delete", vol.Required("template_id"): str}
    )
    @websocket_api.require_admin
    @websocket_api.async_response
    async def ws_template_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        await store.async_delete_template(msg["template_id"])
        on_change()
        connection.send_result(msg["id"])

    @websocket_api.websocket_command(
        {vol.Required("type"): f"{DOMAIN}/recipient/save", vol.Required("recipient"): dict}
    )
    @websocket_api.require_admin
    @websocket_api.async_response
    async def ws_recipient_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        try:
            rec = await store.async_save_recipient(msg["recipient"])
        except vol.Invalid as err:
            connection.send_error(msg["id"], "invalid_format", str(err))
            return
        connection.send_result(msg["id"], {"recipient": rec})

    @websocket_api.websocket_command(
        {vol.Required("type"): f"{DOMAIN}/recipient/delete", vol.Required("recipient_id"): str}
    )
    @websocket_api.require_admin
    @websocket_api.async_response
    async def ws_recipient_delete(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        await store.async_delete_recipient(msg["recipient_id"])
        connection.send_result(msg["id"])

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/test",
            vol.Required("template_id"): str,
            vol.Optional("variables", default=dict): dict,
        }
    )
    @websocket_api.require_admin
    @websocket_api.async_response
    async def ws_test(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
        try:
            result = await manager.async_send(
                msg["template_id"], msg["variables"], wait=False, test=True
            )
        except Exception as err:  # noqa: BLE001 - report any failure back to the panel
            connection.send_error(msg["id"], "send_failed", str(err))
            return
        connection.send_result(msg["id"], result)

    for command in (
        ws_config,
        ws_targets,
        ws_log,
        ws_template_save,
        ws_template_delete,
        ws_recipient_save,
        ws_recipient_delete,
        ws_test,
    ):
        websocket_api.async_register_command(hass, command)
