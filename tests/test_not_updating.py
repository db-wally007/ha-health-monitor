"""Not updating is judged per device (coordinator._device_last_activity).

One entity sitting still for days is normal - a closed window, a light that is off - so a
device is Not updating only once NONE of its entities, diagnostic signal sensors included,
has changed. Devices that cannot report on their own are never judged.

Run like test_restarts.py: from a checkout outside the Home Assistant config dir,
    pytest tests/
"""
import time

from homeassistant.const import EntityCategory
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.entity_availability.coordinator import EntityAvailabilityCoordinator

HOUR = 3600


def judge(hass):
    """A coordinator with just what the check reads."""
    c = EntityAvailabilityCoordinator.__new__(EntityAvailabilityCoordinator)
    c.hass = hass
    c._activity_memo = {}
    c._bad_states = {"unavailable", "unknown"}
    c._staleness_use_last_updated = False
    return c


def device(hass, name, entities):
    """A device with entities: (entity_id, device_class, state_class, diagnostic, state, hours ago)."""
    entry = MockConfigEntry(domain="test")
    entry.add_to_hass(hass)
    dev = dr.async_get(hass).async_get_or_create(config_entry_id=entry.entry_id, identifiers={("test", name)})
    ent_reg = er.async_get(hass)
    for eid, dc, sc, diag, state, ago in entities:
        domain, obj = eid.split(".")
        ent_reg.async_get_or_create(domain, "test", f"{name}_{obj}", device_id=dev.id, suggested_object_id=obj,
                                    original_device_class=dc,
                                    entity_category=EntityCategory.DIAGNOSTIC if diag else None)
        attrs = {k: v for k, v in (("device_class", dc), ("state_class", sc)) if v}
        hass.states.async_set(eid, state, attrs, timestamp=time.time() - ago * HOUR)


async def test_a_quiet_entity_on_a_live_device_is_not_stale(hass):
    # a window closed for 3 days, while its signal sensor reported 10 minutes ago
    device(hass, "window", [
        ("sensor.window_rotation", None, "measurement", False, "0", 72),
        ("sensor.window_rssi", "signal_strength", "measurement", True, "-71", 1 / 6),
    ])
    began = judge(hass)._device_last_activity("sensor.window_rotation")
    assert time.time() - began.timestamp() < 0.2 * HOUR


async def test_a_silent_device_is_judged_from_its_last_change(hass):
    # nothing from the whole device for 30 hours: that is when it was last heard
    device(hass, "probe", [
        ("sensor.probe_temperature", "temperature", "measurement", False, "21.5", 30),
        ("sensor.probe_rssi", "signal_strength", "measurement", True, "-80", 31),
    ])
    began = judge(hass)._device_last_activity("sensor.probe_temperature")
    assert abs(time.time() - began.timestamp() - 30 * HOUR) < 60


async def test_a_device_that_cannot_report_on_its_own_is_not_judged(hass):
    # a one-way cover, and a wall switch with only a battery: silence proves nothing
    device(hass, "cover", [("cover.studio", None, None, False, "closed", 100)])
    device(hass, "button", [
        ("sensor.button_battery", "battery", "measurement", False, "90", 100),
        ("event.button_press", None, None, False, "unknown", 100),
    ])
    c = judge(hass)
    assert c._device_last_activity("cover.studio") is None
    assert c._device_last_activity("sensor.button_battery") is None


async def test_an_unavailable_device_is_not_judged(hass):
    # all down: that device is Unavailable, not Not updating
    device(hass, "dead", [
        ("sensor.dead_temperature", "temperature", "measurement", False, "unavailable", 5),
        ("sensor.dead_rssi", "signal_strength", "measurement", True, "unavailable", 5),
    ])
    assert judge(hass)._device_last_activity("sensor.dead_temperature") is None


async def test_an_entity_without_a_device_is_not_judged(hass):
    hass.states.async_set("input_number.x", "3", timestamp=time.time() - 100 * HOUR)
    assert judge(hass)._device_last_activity("input_number.x") is None
