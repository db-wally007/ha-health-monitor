from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, EVENT_HOMEASSISTANT_STOP
from homeassistant.core import CoreState

from custom_components.entity_availability.restarts import (
    DATA_KEY, STORAGE_KEY, async_setup_restart_log)


async def test_a_restart_is_noted_once(hass, hass_ws_client, hass_storage):
    # the last shutdown wrote when it began stopping
    hass_storage[STORAGE_KEY] = {"version": 1, "minor_version": 1, "key": STORAGE_KEY,
                                 "data": {"restarts": [], "stopping": "2099-01-01T08:00:00+00:00"}}
    hass.set_state(CoreState.starting)
    await async_setup_restart_log(hass)
    await async_setup_restart_log(hass)          # a second config entry: still one log
    hass.set_state(CoreState.running)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()

    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "entity_availability/restarts"})
    msg = await client.receive_json()
    assert msg["success"], msg
    [r] = msg["result"]["restarts"]
    assert r["stopped"] == "2099-01-01T08:00:00+00:00"
    assert r["booted"] <= r["started"]
    assert msg["result"]["grace"] == 60

    await client.close()
    # stopping is written down for the next start
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
    await hass.async_block_till_done()
    saved = hass_storage[STORAGE_KEY]["data"]
    assert saved["stopping"] and len(saved["restarts"]) == 1


async def test_a_reload_into_running_ha_is_not_a_restart(hass, hass_ws_client):
    assert hass.state is CoreState.running
    await async_setup_restart_log(hass)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()
    assert hass.data[DATA_KEY].restarts() == []


async def test_a_crash_leaves_no_stop_time(hass, hass_storage):
    hass.set_state(CoreState.starting)
    await async_setup_restart_log(hass)
    hass.set_state(CoreState.running)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STARTED)
    await hass.async_block_till_done()
    [r] = hass.data[DATA_KEY].restarts()
    assert r["stopped"] is None


async def test_past_restarts_come_from_the_recorder(recorder_mock, hass, hass_ws_client):
    from datetime import timedelta
    from homeassistant.components.recorder import get_instance
    from homeassistant.components.recorder.db_schema import RecorderRuns
    from homeassistant.components.recorder.util import session_scope
    from homeassistant.util import dt as dt_util

    now = dt_util.utcnow()
    def add_runs():
        with session_scope(hass=hass) as session:
            # two earlier runs: one ended cleanly, one crashed
            session.add(RecorderRuns(start=now - timedelta(hours=5), end=now - timedelta(hours=4), closed_incorrect=False))
            session.add(RecorderRuns(start=now - timedelta(hours=4) + timedelta(seconds=40), end=now - timedelta(hours=2), closed_incorrect=True))
            session.add(RecorderRuns(start=now - timedelta(hours=1), end=None, closed_incorrect=False))
    await get_instance(hass).async_add_executor_job(add_runs)
    await async_setup_restart_log(hass)          # into a running HA: backfill at once
    found = {r["booted"][:16]: r for r in hass.data[DATA_KEY].restarts() if r.get("approx")}
    after_clean = found[(now - timedelta(hours=4) + timedelta(seconds=40)).isoformat()[:16]]
    after_crash = found[(now - timedelta(hours=1)).isoformat()[:16]]
    # after a clean run its end is the stop; after a crash nothing says when it stopped
    assert after_clean["stopped"][:16] == (now - timedelta(hours=4)).isoformat()[:16]
    assert after_crash["stopped"] is None
