"""The ignore log (ignores.py) and the suppress actions taking a whole device at once.

Run like test_restarts.py: from a checkout outside the Home Assistant config dir,
    pytest tests/
"""
from datetime import timedelta

from homeassistant.core import Context
from homeassistant.util import dt as dt_util

from custom_components.entity_availability.const import DOMAIN
from custom_components.entity_availability.coordinator import EntityAvailabilityCoordinator
from custom_components.entity_availability.ignores import (
    DATA_KEY, STORAGE_KEY, async_setup_ignore_log)
from custom_components.entity_availability.services import async_setup_services


class FakeGroup(EntityAvailabilityCoordinator):
    """A group as the actions see it: what it monitors, and what it was told."""

    def __init__(self, entities):  # no Home Assistant group behind it
        self._entities = list(entities)
        self.suppressed = {}
        self.refreshes = 0
        self.data = None

    @property
    def monitored_entities(self):
        return self._entities

    def suppress_entity(self, entity_id, until=None):
        self.suppressed[entity_id] = until

    def unsuppress_entity(self, entity_id):
        self.suppressed.pop(entity_id, None)

    def async_set_updated_data(self, data):
        self.refreshes += 1


async def test_the_log_records_and_serves(hass, hass_ws_client, hass_storage):
    old = (dt_util.utcnow() - timedelta(days=11)).isoformat()
    hass_storage[STORAGE_KEY] = {"version": 1, "minor_version": 1, "key": STORAGE_KEY,
                                 "data": {"ignores": [{"t": old, "kind": "ignored", "entity_ids": ["x.old"]}]}}
    await async_setup_ignore_log(hass)
    await async_setup_ignore_log(hass)               # a second config entry: still one log
    log = hass.data[DATA_KEY]
    assert log.entries() == []                       # older than the history: gone
    until = dt_util.utcnow() + timedelta(days=1)
    log.record("ignored", ["light.a", "sensor.a"], until, "Alex")
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "entity_availability/ignores"})
    msg = await client.receive_json()
    assert msg["success"], msg
    [e] = msg["result"]["ignores"]
    assert e["kind"] == "ignored" and e["entity_ids"] == ["light.a", "sensor.a"]
    assert e["until"] == until.isoformat() and e["user"] == "Alex"


async def test_a_whole_device_is_ignored_and_let_go_at_once(hass, hass_admin_user):
    await async_setup_ignore_log(hass)
    group = FakeGroup(["light.a", "sensor.a", "sensor.other"])
    hass.data.setdefault(DOMAIN, {})["entry"] = group
    await async_setup_services(hass)
    ctx = Context(user_id=hass_admin_user.id)

    await hass.services.async_call(DOMAIN, "suppress", {
        "entity_id": ["light.a", "sensor.a"], "duration": 1440}, blocking=True, context=ctx)
    assert set(group.suppressed) == {"light.a", "sensor.a"}
    assert group.refreshes == 1                       # one refresh for the whole device
    await hass.services.async_call(DOMAIN, "suppress_indefinitely", {
        "entity_id": ["light.a", "sensor.a"]}, blocking=True, context=ctx)
    assert group.suppressed == {"light.a": None, "sensor.a": None}
    await hass.services.async_call(DOMAIN, "unsuppress", {
        "entity_id": ["light.a", "sensor.a"]}, blocking=True, context=ctx)
    assert group.suppressed == {}
    # one entity, as before
    await hass.services.async_call(DOMAIN, "suppress", {"entity_id": "sensor.other"}, blocking=True)
    assert "sensor.other" in group.suppressed

    log = hass.data[DATA_KEY].entries()
    assert [e["kind"] for e in log] == ["ignored", "ignored", "unignored", "ignored"]
    assert log[0]["entity_ids"] == ["light.a", "sensor.a"] and log[0]["until"]
    assert log[1]["until"] is None                    # until someone stops it
    assert log[0]["user"] == hass_admin_user.name
    assert log[3]["user"] is None                     # no user behind the call


async def test_an_admin_can_forget_a_test(hass, hass_ws_client, hass_read_only_access_token):
    await async_setup_ignore_log(hass)
    log = hass.data[DATA_KEY]
    log.record("ignored", ["light.a", "sensor.a"])
    log.record("ignored", ["light.a", "light.b"], group="Home")
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "entity_availability/ignores/forget",
                            "entity_ids": ["light.a", "sensor.a"]})
    msg = await client.receive_json()
    assert msg["success"] and msg["result"] == {"removed": 1}
    [e] = log.entries()                              # the group's entry keeps its other entity
    assert e["entity_ids"] == ["light.b"] and e["group"] == "Home"
    # not for everyone
    guest = await hass_ws_client(hass, hass_read_only_access_token)
    await guest.send_json({"id": 2, "type": "entity_availability/ignores/forget", "entity_ids": ["light.b"]})
    msg = await guest.receive_json()
    assert not msg["success"] and msg["error"]["code"] == "unauthorized"


def test_a_new_ignore_length_is_published():
    """Only suppressed_until changing (another length on the same ignore) must still write;
    a per-tick unrecorded value must not."""
    from custom_components.entity_availability.write_dedup import WriteDedupMixin

    class Summary(WriteDedupMixin):
        _unrecorded_attributes = frozenset({"suppressed_until", "last_seen"})
        _ea_dedup_keep = frozenset({"suppressed_until"})
        available = True

        def __init__(self):
            self.extra_state_attributes = {"suppressed": 1, "suppressed_until": {"a": "x"}, "last_seen": 1}

        def _ea_current_value(self):
            return 5

    s = Summary()
    assert s._ea_should_write()                                  # the first write
    s.extra_state_attributes = {**s.extra_state_attributes, "last_seen": 2}
    assert not s._ea_should_write()                              # a per-tick value: no write
    s.extra_state_attributes = {**s.extra_state_attributes, "suppressed_until": {"a": None}}
    assert s._ea_should_write()                                  # a new length: written
