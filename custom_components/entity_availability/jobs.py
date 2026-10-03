"""Run failures of automations and scripts, read from Home Assistant's own traces.

Home Assistant records how every automation and script run ended — the exception that
stopped it, or the message of a ``stop: … error: true`` step — in its trace store. This
module reads that record, so nothing has to be added to any automation or script.

The trace store (``hass.data[DATA_TRACE]``) is internal, not a public API. Everything
here degrades to "no verdict" instead of raising if its shape changes, so an HA update
can blank the run results but never take the coordinator down with it.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

# Outcomes of a run whose actions actually executed. Anything else is a trigger that
# never got that far — conditions not met (failed_conditions), trigger not matched
# (not_triggered), or turned away because the job was still running (failed_single /
# failed_max_runs). Those say nothing about whether the job works, so they neither
# fail it nor clear a failure.
_EXECUTED = frozenset(
    {"finished", "aborted", "cancelled", "error", "disallowed_recursion_detected"}
)
_FAILED = frozenset({"error", "disallowed_recursion_detected"})


def _trace_store(hass: HomeAssistant) -> dict | None:
    try:
        from homeassistant.components.trace.const import DATA_TRACE
    except ImportError:  # pragma: no cover — trace is part of default_config
        return None
    store = hass.data.get(DATA_TRACE)
    return store if isinstance(store, dict) else None


async def async_restore(hass: HomeAssistant) -> None:
    """Load the traces HA saved at its last shutdown.

    HA restores them lazily, the first time someone opens a trace in the UI. Until then
    a run that failed before a restart would be invisible here.
    """
    try:
        from homeassistant.components.trace.util import async_restore_traces

        await async_restore_traces(hass)
    except Exception:  # noqa: BLE001 — a missing restore must never block setup
        _LOGGER.debug("Could not restore saved traces", exc_info=True)


def as_dt(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return dt_util.parse_datetime(value)
    return None


def _run_traces(bucket: Any) -> list:
    # 2026.9+: TraceBuckets(runs, not_triggered). Earlier: one dict of traces.
    runs = getattr(bucket, "runs", None)
    if runs is not None:
        return list(runs.values())
    if isinstance(bucket, dict):
        return list(bucket.values())
    return []


def _stop_error(trace: Any, short: dict) -> str | None:
    """The message of a ``stop: … error: true`` step, if that is how the run ended.

    Such a run is recorded as "aborted" with no ``error`` field — the same outcome as a
    condition step deciding not to go on, which is ordinary flow control. Only the last
    step's result tells the two apart.
    """
    try:
        steps = trace.as_extended_dict().get("trace") or {}
        elements = steps.get(short.get("last_step")) or []
        final = elements[-1] if elements else {}
    except Exception:  # noqa: BLE001
        return None
    if final.get("error"):
        return str(final["error"])
    result = final.get("result") or {}
    if result.get("error"):
        return str(result.get("stop") or "Stopped with an error")
    return None


def latest_run(hass: HomeAssistant, entity_id: str) -> dict[str, Any] | None:
    """The newest run of an automation or script whose actions executed.

    Returns None when HA holds no such run — it never ran, or every stored trace is a
    trigger that was turned away before its actions.
    """
    store = _trace_store(hass)
    if store is None:
        return None
    entry = er.async_get(hass).async_get(entity_id)
    if entry is None or not entry.unique_id:
        return None
    domain = entity_id.split(".", 1)[0]
    bucket = store.get(f"{domain}.{entry.unique_id}")
    if bucket is None:
        return None

    best: tuple[datetime, Any, dict] | None = None
    for trace in _run_traces(bucket):
        try:
            short = trace.as_short_dict()
        except Exception:  # noqa: BLE001
            continue
        if short.get("state") != "stopped":
            continue
        if short.get("script_execution") not in _EXECUTED:
            continue
        finished = as_dt((short.get("timestamp") or {}).get("finish"))
        if finished is None:
            continue
        if best is None or finished > best[0]:
            best = (finished, trace, short)
    if best is None:
        return None

    finished, trace, short = best
    execution = short.get("script_execution")
    error = short.get("error")
    if error is None and execution == "aborted":
        error = _stop_error(trace, short)
    failed = bool(error) or execution in _FAILED
    if failed and not error:
        error = execution.replace("_", " ")
    run_id = short.get("run_id")
    return {
        "run_id": run_id,
        "finished": finished.isoformat(),
        "execution": execution,
        "failed": failed,
        "error": error,
        "trace_url": f"/config/{domain}/trace/{entry.unique_id}?run_id={run_id}",
    }


def is_newer(candidate: dict | None, current: dict | None) -> bool:
    """Whether a run read from the traces replaces the one already on record."""
    if candidate is None:
        return False
    if current is None:
        return True
    if candidate.get("run_id") == current.get("run_id"):
        return False
    new, old = as_dt(candidate.get("finished")), as_dt(current.get("finished"))
    return new is not None and (old is None or new > old)
