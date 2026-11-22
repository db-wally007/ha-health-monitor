"""Ignored devices: who set or ended an ignore, and when (fork addition, hm).

A device or helper is IGNORED while its entities are suppressed - the suppress /
suppress_indefinitely actions, which the card's Ignore button calls with every entity of
the row. Suppressed entities leave the offline, low-battery, not-updating and failed lists,
so nothing alerts on them, and the card shows the row as "Ignored". The coordinator keeps
the suppression itself (and drops it when its time runs out); this log keeps the story for
the card's timeline:

    {"type": "entity_availability/ignores"} ->
    {"ignores": [{"t": iso, "kind": "ignored" | "unignored", "entity_ids": [...],
                  "until": iso | None, "user": name | None, "group"?: name}, ...]}

`until` None on "ignored" means until someone stops it. An ignore that runs out by itself
is not logged: its "until" says when it ended. A whole group ignored at once is logged with
its `group` and every entity it monitors.

Admins can drop entities from the log (a test's ignores, so they leave no story behind):

    {"type": "entity_availability/ignores/forget", "entity_ids": [...]} -> {"removed": n}
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_KEY = f"{DOMAIN}_ignores"
STORAGE_KEY = f"{DOMAIN}.ignores"
STORAGE_VERSION = 1
# The recorder's default purge, as the restart log: older than any history drawn.
RETENTION_DAYS = 10
SAVE_DELAY_SECS = 5


class IgnoreLog:
    """Every ignore set or ended; one log per Home Assistant, not per group."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._entries: list[dict[str, Any]] = []

    async def async_start(self) -> None:
        data = await self._store.async_load()
        if isinstance(data, dict) and isinstance(data.get("ignores"), list):
            self._entries = data["ignores"]
        self._prune()
        websocket_api.async_register_command(self.hass, ws_ignores)
        websocket_api.async_register_command(self.hass, ws_forget)

    def record(
        self,
        kind: str,
        entity_ids: list[str],
        until: datetime | None = None,
        user: str | None = None,
        group: str | None = None,
    ) -> dict[str, Any]:
        """Note an ignore set ("ignored") or ended by someone ("unignored")."""
        entry: dict[str, Any] = {
            "t": dt_util.utcnow().isoformat(),
            "kind": kind,
            "entity_ids": list(entity_ids),
            "until": until.isoformat() if until else None,
            "user": user,
        }
        if group:
            entry["group"] = group
        self._entries.append(entry)
        self._prune()
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
        return entry

    def entries(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def forget(self, entity_ids: list[str]) -> int:
        """Drop these entities from every entry; an entry left with none goes. Returns how
        many entries went."""
        drop = set(entity_ids)
        kept: list[dict[str, Any]] = []
        for e in self._entries:
            rest = [x for x in e.get("entity_ids", []) if x not in drop]
            if rest:
                kept.append({**e, "entity_ids": rest})
        removed = len(self._entries) - len(kept)
        self._entries = kept
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)
        return removed

    def _prune(self) -> None:
        cutoff = (dt_util.utcnow() - timedelta(days=RETENTION_DAYS)).isoformat()
        self._entries = [e for e in self._entries if e.get("t", "") >= cutoff]

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {"ignores": self._entries}


async def async_setup_ignore_log(hass: HomeAssistant) -> None:
    """Start the ignore log once, whichever config entry loads first."""
    if DATA_KEY in hass.data:
        return
    log = IgnoreLog(hass)
    hass.data[DATA_KEY] = log
    await log.async_start()


@callback
@websocket_api.websocket_command({vol.Required("type"): "entity_availability/ignores"})
def ws_ignores(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    log: IgnoreLog | None = hass.data.get(DATA_KEY)
    connection.send_result(msg["id"], {"ignores": log.entries() if log else []})


@callback
@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): "entity_availability/ignores/forget",
    vol.Required("entity_ids"): [str],
})
def ws_forget(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    log: IgnoreLog | None = hass.data.get(DATA_KEY)
    removed = log.forget(msg["entity_ids"]) if log else 0
    connection.send_result(msg["id"], {"removed": removed})
