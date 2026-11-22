"""When automations and scripts were failing (fork addition, hm).

The coordinator keeps only a job's latest run (jobs.py): Failed from a failed run until the
next run that ends without an error. That says nothing of the past - once a job recovers,
the card's history showed it green all along. So this log keeps, per job, each span it
spent failing: from the first failed run seen to the run that ended it, with the error and
trace of its MOST RECENT failed run (the one worth reading; every run of a job failing each
hour would be noise). Runs are noted as the coordinator first sees them, so the log knows
only what happened since it was added - nothing before.

    {"type": "entity_availability/failures"} ->
    {"failures": {entity_id: [{"since": iso, "until": iso | None, "runs": n, "last": iso,
                               "error": str | None, "trace_url": str | None}, ...]}}

`until` None: still failing. `runs`: how many failed runs the span had; `last` when the
latest of them finished. Spans that ended more than RETENTION_DAYS ago are dropped.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_KEY = f"{DOMAIN}_failures"
STORAGE_KEY = f"{DOMAIN}.failures"
STORAGE_VERSION = 1
# The recorder's default purge, as the restart and ignore logs: older than any history drawn.
RETENTION_DAYS = 10
SAVE_DELAY_SECS = 5


class FailureLog:
    """Every job's failing spans; one log per Home Assistant, not per group."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._jobs: dict[str, list[dict[str, Any]]] = {}

    async def async_start(self) -> None:
        data = await self._store.async_load()
        if isinstance(data, dict) and isinstance(data.get("failures"), dict):
            self._jobs = data["failures"]
        self._prune()
        websocket_api.async_register_command(self.hass, ws_failures)

    def note(self, entity_id: str, run: dict[str, Any]) -> None:
        """A job's newest run, as the coordinator first sees it: a failed run opens a span
        (or becomes the one an open span shows), one without an error ends it."""
        spans = self._jobs.get(entity_id, [])
        open_ = spans[-1] if spans and spans[-1].get("until") is None else None
        if run.get("failed"):
            if open_ is None:
                open_ = {"since": run.get("finished"), "until": None, "runs": 0}
                spans.append(open_)
                self._jobs[entity_id] = spans
            open_["runs"] += 1
            open_["last"] = run.get("finished")
            open_["error"] = run.get("error")
            open_["trace_url"] = run.get("trace_url")
        elif open_ is not None:
            open_["until"] = run.get("finished")
        else:
            return  # fine, and was fine: nothing to note
        self._prune()
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY_SECS)

    def failures(self) -> dict[str, list[dict[str, Any]]]:
        return {eid: [dict(s) for s in spans] for eid, spans in self._jobs.items()}

    def _prune(self) -> None:
        cutoff = (dt_util.utcnow() - timedelta(days=RETENTION_DAYS)).isoformat()
        for eid in list(self._jobs):
            kept = [s for s in self._jobs[eid] if s.get("until") is None or s["until"] >= cutoff]
            if kept:
                self._jobs[eid] = kept
            else:
                del self._jobs[eid]

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {"failures": self._jobs}


async def async_setup_failure_log(hass: HomeAssistant) -> None:
    """Start the failure log once, whichever config entry loads first."""
    if DATA_KEY in hass.data:
        return
    log = FailureLog(hass)
    hass.data[DATA_KEY] = log
    await log.async_start()


@callback
def note_run(hass: HomeAssistant, entity_id: str, run: dict[str, Any] | None) -> None:
    """Hand a job's newest run to the log (the coordinator's hook)."""
    log: FailureLog | None = hass.data.get(DATA_KEY)
    if log is not None and run:
        log.note(entity_id, run)


@callback
@websocket_api.websocket_command({vol.Required("type"): "entity_availability/failures"})
def ws_failures(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    log: FailureLog | None = hass.data.get(DATA_KEY)
    connection.send_result(msg["id"], {"failures": log.failures() if log else {}})
