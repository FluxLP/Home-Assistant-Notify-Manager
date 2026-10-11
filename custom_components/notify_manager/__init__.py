"""Notify Manager: notification templates with a management panel."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_set_service_schema
from homeassistant.helpers.typing import ConfigType

from .const import (
    DOMAIN,
    NAME,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_STATIC_URL,
    PANEL_URL_PATH,
    PRIORITIES,
    SERVICE_RELOAD,
    SERVICE_SEND,
    VERSION,
)
from .sender import NotifyManager
from .store import NotifyManagerStore
from .websocket import async_setup_websocket

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# Keys of a template service call that are options, everything else is a variable.
CALL_OPTIONS = ("title", "message", "priority", "recipients", "wait", "timeout")

OPTION_SCHEMA = {
    vol.Optional("title"): cv.string,
    vol.Optional("message"): cv.string,
    vol.Optional("priority"): vol.In(PRIORITIES),
    vol.Optional("recipients"): vol.All(cv.ensure_list, [cv.string]),
    vol.Optional("wait"): cv.boolean,
    vol.Optional("timeout"): vol.All(vol.Coerce(int), vol.Range(min=0, max=86400)),
}

SEND_SCHEMA = vol.Schema(
    {
        vol.Required("template"): cv.string,
        vol.Optional("variables", default=dict): dict,
        **OPTION_SCHEMA,
    }
)

TEMPLATE_SERVICE_SCHEMA = vol.Schema(OPTION_SCHEMA, extra=vol.ALLOW_EXTRA)

OPTION_FIELDS: dict[str, Any] = {
    "wait": {
        "name": "Auf Antwort warten",
        "description": "Die Automation wartet, bis ein Aktions-Button gedrückt wurde oder das Zeitlimit abläuft.",
        "selector": {"boolean": {}},
    },
    "timeout": {
        "name": "Zeitlimit (Sekunden)",
        "selector": {"number": {"min": 0, "max": 86400, "unit_of_measurement": "s", "mode": "box"}},
    },
    "priority": {
        "name": "Priorität überschreiben",
        "selector": {
            "select": {
                "options": [
                    {"value": "normal", "label": "Normal"},
                    {"value": "time_sensitive", "label": "Zeitkritisch"},
                    {"value": "critical", "label": "Kritisch"},
                ]
            }
        },
    },
    "title": {"name": "Titel überschreiben", "selector": {"text": {}}},
    "message": {"name": "Text überschreiben", "selector": {"text": {"multiline": True}}},
}


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    store = NotifyManagerStore(hass)
    await store.async_load()
    manager = NotifyManager(hass, store)
    manager.async_start()
    template_services: set[str] = set()
    hass.data[DOMAIN] = {"manager": manager, "template_services": template_services}

    async def _send(call: ServiceCall, template: str, variables: dict[str, Any]) -> ServiceResponse:
        options = {k: call.data[k] for k in CALL_OPTIONS if k in call.data}
        result = await manager.async_send(template, variables, **options)
        return result if call.return_response else None

    async def handle_send(call: ServiceCall) -> ServiceResponse:
        return await _send(call, call.data["template"], call.data["variables"])

    async def handle_template(call: ServiceCall) -> ServiceResponse:
        tpl = next((t for t in store.templates.values() if t["service"] == call.service), None)
        if tpl is None:
            return None
        variables = {k: v for k, v in call.data.items() if k not in CALL_OPTIONS}
        return await _send(call, tpl["id"], variables)

    async def handle_reload(call: ServiceCall) -> None:
        await store.async_load()
        sync_template_services()

    @callback
    def sync_template_services() -> None:
        """Register one service per template, so they show up in the action picker."""
        wanted = {t["service"]: t for t in store.templates.values()}
        for service in template_services - wanted.keys():
            hass.services.async_remove(DOMAIN, service)
        template_services.clear()
        for service, tpl in wanted.items():
            if not hass.services.has_service(DOMAIN, service):
                hass.services.async_register(
                    DOMAIN,
                    service,
                    handle_template,
                    schema=TEMPLATE_SERVICE_SCHEMA,
                    supports_response=SupportsResponse.OPTIONAL,
                )
            template_services.add(service)
            fields = {
                var: {"name": var, "required": False, "selector": {"text": {}}}
                for var in tpl["variables"]
            }
            async_set_service_schema(
                hass,
                DOMAIN,
                service,
                {
                    "name": f"{NAME}: {tpl['name']}",
                    "description": tpl["description"]
                    or f"Sendet die Benachrichtigungs-Vorlage „{tpl['name']}“.",
                    "fields": fields | OPTION_FIELDS,
                },
            )

    hass.services.async_register(
        DOMAIN, SERVICE_SEND, handle_send, schema=SEND_SCHEMA, supports_response=SupportsResponse.OPTIONAL
    )
    hass.services.async_register(DOMAIN, SERVICE_RELOAD, handle_reload)
    sync_template_services()

    async_setup_websocket(hass, manager, sync_template_services)
    await _async_register_panel(hass)
    return True


async def _async_register_panel(hass: HomeAssistant) -> None:
    if not hass.data.get(f"{DOMAIN}_static"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(PANEL_STATIC_URL, str(Path(__file__).parent / "frontend"), False)]
        )
        hass.data[f"{DOMAIN}_static"] = True

    frontend.async_register_built_in_panel(
        hass,
        component_name="custom",
        sidebar_title=NAME,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL_PATH,
        require_admin=True,
        config={
            "_panel_custom": {
                "name": PANEL_COMPONENT,
                "module_url": f"{PANEL_STATIC_URL}/notify-manager-panel.js?v={VERSION}",
                "embed_iframe": False,
                "trust_external": False,
            }
        },
    )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = hass.data.pop(DOMAIN, None)
    if data:
        data["manager"].async_stop()
        for service in data["template_services"]:
            hass.services.async_remove(DOMAIN, service)
    hass.services.async_remove(DOMAIN, SERVICE_SEND)
    hass.services.async_remove(DOMAIN, SERVICE_RELOAD)
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    return True
