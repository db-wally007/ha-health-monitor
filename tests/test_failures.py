"""The failure log (failures.py): when automations and scripts were failing.

Run like test_restarts.py: from a checkout outside the Home Assistant config dir,
    pytest tests/
"""
from datetime import timedelta

from homeassistant.util import dt as dt_util

from custom_components.entity_availability.failures import (
    DATA_KEY, STORAGE_KEY, async_setup_failure_log, note_run)


def run(minutes_ago, failed, error=None, run_id=None):
    t = (dt_util.utcnow() - timedelta(minutes=minutes_ago)).isoformat()
    return {"run_id": run_id or t, "finished": t, "failed": failed, "error": error,
            "trace_url": f"/config/script/trace/job?run_id={run_id or t}"}


async def test_a_failing_span_keeps_its_latest_error_and_ends(hass, hass_ws_client):
    await async_setup_failure_log(hass)
    await async_setup_failure_log(hass)               # a second config entry: still one log
    log = hass.data[DATA_KEY]
    note_run(hass, "script.job", run(90, False))      # fine, and was fine: nothing to note
    assert log.failures() == {}
    first = run(60, True, "first error", "r1")
    note_run(hass, "script.job", first)
    note_run(hass, "script.job", run(30, True, "second error", "r2"))
    [span] = log.failures()["script.job"]
    assert span["since"] == first["finished"] and span["until"] is None and span["runs"] == 2
    assert span["error"] == "second error" and span["trace_url"].endswith("run_id=r2")
    ok = run(5, False)
    note_run(hass, "script.job", ok)
    [span] = log.failures()["script.job"]
    assert span["until"] == ok["finished"] and span["error"] == "second error"
    note_run(hass, "script.job", run(1, True, "again", "r3"))      # a new span
    spans = log.failures()["script.job"]
    assert len(spans) == 2 and spans[1]["until"] is None and spans[1]["runs"] == 1
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "entity_availability/failures"})
    msg = await client.receive_json()
    assert msg["success"], msg
    assert msg["result"]["failures"]["script.job"][1]["error"] == "again"


async def test_old_spans_go_open_ones_stay(hass, hass_storage):
    old = (dt_util.utcnow() - timedelta(days=12)).isoformat()
    older = (dt_util.utcnow() - timedelta(days=13)).isoformat()
    hass_storage[STORAGE_KEY] = {"version": 1, "minor_version": 1, "key": STORAGE_KEY, "data": {"failures": {
        "script.gone": [{"since": older, "until": old, "runs": 1, "last": older}],
        "script.still": [{"since": older, "until": None, "runs": 9, "last": old}],
    }}}
    await async_setup_failure_log(hass)
    failures = hass.data[DATA_KEY].failures()
    assert "script.gone" not in failures             # ended before any history drawn
    assert failures["script.still"][0]["runs"] == 9  # still failing: kept, however old
