"""Home Assistant restarts, recorded once (fork addition, hm).

While Home Assistant stops and starts again, many entities read "unavailable" or
"unknown" for a minute or two - their integrations are not loaded yet. That is not the
devices' fault, and the integration already ignores it (STARTUP_GRACE_PERIOD, the
cooldown). The recorder keeps those states all the same, and the card's availability
history reads the recorder: without help it shows a red gap on dozens of entities at
every restart.

So each restart is noted here, once: when Home Assistant began stopping (None after a
crash, which announces nothing), when this start began, and when Home Assistant was
running again. Restarts from before the log existed - or missed by it - are filled in
from the recorder's own record of its runs (recorder_runs: each run's start and end,
and whether it ended cleanly); those know when Home Assistant stopped and booted but
not when it was running again, so `started` is the boot and `approx` is set. The card draws a restart as one grey event instead of a gap on every
entity, and tells real drop-outs from restarts.

Read it over the websocket:
    {"type": "entity_availability/restarts"} ->
    {"restarts": [{"stopped": iso | None, "booted": iso, "started": iso, "approx"?: true}, ...],
     "grace": STARTUP_GRACE_PERIOD, "cooldowns": {group unique_id: seconds}}
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, EVENT_HOMEASSISTANT_STOP
from homeassistant.core import CoreState, Event, HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, STARTUP_GRACE_PERIOD

_LOGGER = logging.getLogger(__name__)

DATA_KEY = f"{DOMAIN}_restarts"
STORAGE_KEY = f"{DOMAIN}.restarts"
STORAGE_VERSION = 1
# The recorder's default purge: a restart older than any history drawn is no use.
RETENTION_DAYS = 10
# A logged restart and a recorder run this close together are the same restart.
SAME_RESTART = timedelta(minutes=3)


class RestartLog:
    """Notes every Home Assistant restart; one per Home Assistant, not per group."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._restarts: list[dict[str, Any]] = []
        self._booting: dict[str, Any] | None = None

    async def async_start(self) -> None:
        data = await self._store.async_load() or {}
        self._restarts = list(data.get("restarts", []))
        self._prune()
        if self.hass.state is CoreState.running:
            # The integration was (re)loaded into a running Home Assistant: not a start.
            await self._async_backfill()
        else:
            self._booting = {
                # written when Home Assistant last began stopping; absent after a crash
                "stopped": data.get("stopping"),
                "booted": dt_util.utcnow().isoformat(),
            }
            self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, self._async_started)
        self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._async_stopping)
        websocket_api.async_register_command(self.hass, ws_restarts)

    async def _async_started(self, _event: Event) -> None:
        if self._booting is None:
            return
        self._restarts.append({**self._booting, "started": dt_util.utcnow().isoformat()})
        self._booting = None
        # The recorder is certainly ready by now; it fills in what the log missed.
        await self._async_backfill()
        self._prune()
        await self._store.async_save({"restarts": self._restarts})

    async def _async_stopping(self, _event: Event) -> None:
        # Awaited: Home Assistant waits for its stop listeners before shutting down.
        await self._store.async_save(
            {"restarts": self._restarts, "stopping": dt_util.utcnow().isoformat()}
        )

    async def _async_backfill(self) -> None:
        """Add the restarts the recorder knows of and the log does not."""
        try:
            from homeassistant.components.recorder import get_instance
            from homeassistant.components.recorder.db_schema import RecorderRuns
            from homeassistant.components.recorder.util import session_scope

            instance = get_instance(self.hass)
        except (ImportError, KeyError):
            return  # no recorder: only what the log itself notes
        since = dt_util.utcnow() - timedelta(days=RETENTION_DAYS)

        def _runs() -> list[tuple]:
            with session_scope(hass=self.hass, read_only=True) as session:
                return [
                    (r.start, r.end, r.closed_incorrect)
                    for r in session.query(RecorderRuns)
                    .filter(RecorderRuns.start >= since)
                    .order_by(RecorderRuns.start)
                ]

        try:
            runs = await instance.async_add_executor_job(_runs)
        except Exception:  # noqa: BLE001 - a read that fails costs only the backfill
            _LOGGER.debug("Could not read the recorder's runs", exc_info=True)
            return

        def utc(t):
            return None if t is None else dt_util.as_utc(t if t.tzinfo else t.replace(tzinfo=dt_util.UTC))

        logged = [dt_util.parse_datetime(r["booted"]) for r in self._restarts if r.get("booted")]
        for prev, run in zip(runs, runs[1:]):
            booted = utc(run[0])
            match = next((r for r, b in zip(self._restarts, logged) if b and abs(b - booted) < SAME_RESTART), None)
            stopped = None if prev[2] or prev[1] is None else utc(prev[1]).isoformat()
            if match is not None:
                # the log's own entry; it only lacks the stop time after a crash or the
                # first start with the log
                if match.get("stopped") is None and stopped:
                    match["stopped"] = stopped
                continue
            self._restarts.append({"stopped": stopped, "booted": booted.isoformat(),
                                   "started": booted.isoformat(), "approx": True})
        self._restarts.sort(key=lambda r: r.get("booted") or r.get("started", ""))

    def _prune(self) -> None:
        cutoff = (dt_util.utcnow() - timedelta(days=RETENTION_DAYS)).isoformat()
        self._restarts = [r for r in self._restarts if r.get("started", "") >= cutoff]

    def restarts(self) -> list[dict[str, Any]]:
        return list(self._restarts)


async def async_setup_restart_log(hass: HomeAssistant) -> None:
    """Start the restart log once, whichever config entry loads first."""
    if DATA_KEY in hass.data:
        return
    log = RestartLog(hass)
    hass.data[DATA_KEY] = log
    await log.async_start()


@callback
@websocket_api.websocket_command({vol.Required("type"): "entity_availability/restarts"})
def ws_restarts(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    log: RestartLog | None = hass.data.get(DATA_KEY)
    cooldowns: dict[str, float] = {}
    for entry in hass.config_entries.async_entries(DOMAIN):
        coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
        cooldown = getattr(coordinator, "_cooldown", None)
        if entry.unique_id and cooldown is not None:
            cooldowns[entry.unique_id] = cooldown
    connection.send_result(
        msg["id"],
        {
            "restarts": log.restarts() if log else [],
            "grace": STARTUP_GRACE_PERIOD,
            "cooldowns": cooldowns,
        },
    )
