"""DataUpdateCoordinator for Entity Availability."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
)
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    BATTERY_HYSTERESIS,
    CONF_BAD_STATES,
    CONF_BATTERY_ENTITY_MAP,
    CONF_BATTERY_THRESHOLD,
    CONF_COLLAPSE_DEVICES,
    CONF_COOLDOWN,
    CONF_ENTITIES,
    CONF_NON_ESSENTIAL_ENTITIES,
    CONF_OFFLINE_REQUIRES_ALL,
    CONF_RECOVERY_WINDOW,
    CONF_SIGNAL_AUTO,
    CONF_SIGNAL_ENABLED,
    CONF_SIGNAL_ENTITY_MAP,
    CONF_SOURCE_MODE,
    CONF_STALENESS_THRESHOLD,
    CONF_STALENESS_USE_LAST_UPDATED,
    CONF_USE_DEVICE_NAMES,
    DEFAULT_BAD_STATES,
    DOMAIN,
    DEFAULT_BATTERY_THRESHOLD,
    DEFAULT_COLLAPSE_DEVICES,
    DEFAULT_COOLDOWN,
    DEFAULT_OFFLINE_REQUIRES_ALL,
    DEFAULT_RECOVERY_WINDOW,
    DEFAULT_SIGNAL_ENABLED,
    DEFAULT_STALENESS_THRESHOLD,
    DEFAULT_STALENESS_USE_LAST_UPDATED,
    DEFAULT_USE_DEVICE_NAMES,
    EVENT_BATTERY_OK,
    EVENT_LOW_BATTERY,
    EVENT_OFFLINE,
    EVENT_POOR_SIGNAL,
    EVENT_RECOVERED,
    EVENT_SIGNAL_OK,
    EVENT_STALE,
    EVENT_STALE_RECOVERED,
    PLATFORM_SIGNAL_TYPES,
    SCAN_INTERVAL,
    SIGNAL_HYSTERESIS,
    SIGNAL_NETWORK_TYPES,
    SOURCE_MODE_DISCOVERY,
    STALENESS_HYSTERESIS,
    STARTUP_GRACE_PERIOD,
    STORAGE_KEY_PREFIX,
    STORAGE_VERSION,
    SignalQuality,
)
from . import discovery
from .helpers import collapse_representatives
from .models import DeviceState, EntityAvailabilityData
from .storage import AvailabilityStorage

_LOGGER = logging.getLogger(__name__)

# Coalesces rapid same-entity event bursts before triggering a coordinator refresh.
# 0.5s covers real protocol flap windows (Zigbee/Z-Wave/WiFi all settle within 1s)
# without adding perceptible latency. False-alarm filtering is handled separately
# by the cooldown setting, so debounce only needs to batch burst events.
_STATE_CHANGE_DEBOUNCE = 0.5  # seconds

# Coalesces registry-event bursts before re-resolving discovery. Adding one device
# writes one registry event per entity, so a Shelly appearing fires ~15 events within
# a second; without this every one of them would trigger a full re-resolve.
_REGISTRY_DEBOUNCE = 5  # seconds

# Save storage every N updates (5 min = 10 updates at 30s interval)
_SAVE_INTERVAL_UPDATES = 10


class _CacheStore:
    """Persistence in ``config/.cache/`` instead of ``config/.storage/``.

    This file is a rolling 7-day cache of up/down samples — derived data that costs
    nothing but time to rebuild and is worthless once it ages out. Home Assistant
    backs up the whole of ``.storage/``, so keeping it there put megabytes of
    regenerable history into every nightly backup. ``.cache/*`` is on HA's own
    EXCLUDE_FROM_BACKUP list, which is exactly the semantics this data wants.

    Why this is hand-rolled rather than ``Store`` with an overridden ``path``:
    ``Store.async_load`` consults a StoreManager that pre-scans ``.storage/`` at
    startup and answers "this key does not exist" *before* ``self.path`` is ever
    read. A repointed Store therefore writes to the new location and then silently
    loads nothing from it — losing all history on the next restart. Plain file I/O
    has no such hidden index.

    Writes go to a temp file and are renamed into place, so an interrupted write
    cannot leave a truncated file behind.
    """

    def __init__(self, hass: HomeAssistant, version: int, key: str) -> None:
        """Set up a cache file at .cache/<domain>/<key>.json."""
        self.hass = hass
        self.version = version
        self.key = key
        self.path = hass.config.path(".cache", DOMAIN, f"{key}.json")

    async def async_load(self) -> dict | None:
        """Return the stored payload, or None when there is nothing usable."""
        return await self.hass.async_add_executor_job(self._load)

    def _load(self) -> dict | None:
        if not os.path.isfile(self.path):
            return None
        try:
            with open(self.path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError) as err:
            # Corrupt or unreadable: start clean rather than block setup. The cost is
            # the availability history, which rebuilds on its own.
            _LOGGER.warning("Could not read %s (%s); starting fresh", self.path, err)
            return None
        if not isinstance(payload, dict):
            return None
        return payload.get("data")

    async def async_save(self, data: dict) -> None:
        """Write the payload atomically."""
        await self.hass.async_add_executor_job(self._save, data)

    def _save(self, data: dict) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(
                {"version": self.version, "key": self.key, "data": data}, handle
            )
        os.replace(tmp, self.path)


class EntityAvailabilityCoordinator(DataUpdateCoordinator[EntityAvailabilityData]):
    """Coordinator that monitors device states and tracks availability."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass,
            _LOGGER,
            name=f"Entity Availability - {entry.title}",
            update_interval=timedelta(seconds=SCAN_INTERVAL),
            config_entry=entry,
        )
        self.entry = entry
        # Membership is either a hand-picked list (upstream behaviour) or resolved
        # from discovery rules. Either way it lands in the same attribute, so nothing
        # downstream needs to know which mode produced it. In discovery mode this is
        # re-resolved live on registry changes — see _setup_registry_listeners.
        self._discovery_mode: bool = (
            entry.data.get(CONF_SOURCE_MODE) == SOURCE_MODE_DISCOVERY
        )
        self._discovery: discovery.DiscoveryResult | None = None
        # Resolved at the END of __init__: the resolver reads _signal_auto and
        # _signal_map, so it cannot run before those exist.
        self._entities: list[str] = []
        self._non_essential: list[str] = entry.data.get(CONF_NON_ESSENTIAL_ENTITIES, [])
        self._bad_states: list[str] = entry.data.get(
            CONF_BAD_STATES, DEFAULT_BAD_STATES
        )
        self._cooldown: int = entry.data.get(CONF_COOLDOWN, DEFAULT_COOLDOWN)
        self._staleness_threshold: int = entry.data.get(
            CONF_STALENESS_THRESHOLD, DEFAULT_STALENESS_THRESHOLD
        )
        self._staleness_use_last_updated: bool = entry.data.get(
            CONF_STALENESS_USE_LAST_UPDATED, DEFAULT_STALENESS_USE_LAST_UPDATED
        )
        self._battery_threshold: int = entry.data.get(
            CONF_BATTERY_THRESHOLD, DEFAULT_BATTERY_THRESHOLD
        )
        self._signal_enabled: bool = entry.data.get(
            CONF_SIGNAL_ENABLED, DEFAULT_SIGNAL_ENABLED
        )
        self._signal_auto: bool = entry.data.get(CONF_SIGNAL_AUTO, self._discovery_mode)
        self._signal_map: dict[str, dict[str, str]] = entry.data.get(
            CONF_SIGNAL_ENTITY_MAP, {}
        )
        # Defaults ON for discovery groups (where whole devices arrive wholesale,
        # dead capabilities included) and OFF for manual ones, so a hand-picked group
        # keeps upstream's exact per-entity semantics unless the user opts in.
        self._offline_requires_all: bool = entry.data.get(
            CONF_OFFLINE_REQUIRES_ALL,
            DEFAULT_OFFLINE_REQUIRES_ALL and self._discovery_mode,
        )
        # Per-tick memo for the "are any of this device's other entities alive?" test.
        # Without it the check is O(entities-per-device) per entity per tick; with it,
        # one registry walk per device per tick. Cleared alongside _collapse_map.
        self._live_sibling_memo: dict[str, bool] = {}
        self._unsub_registry: list[CALLBACK_TYPE] = []
        self._registry_debounce: CALLBACK_TYPE | None = None
        self._availability_storage = AvailabilityStorage()
        store_key = f"{STORAGE_KEY_PREFIX}_{entry.entry_id}"
        self._store = _CacheStore(hass, STORAGE_VERSION, store_key)
        # Previous location. Read once if .cache is empty, then deleted after the
        # first successful save so history survives the move.
        self._legacy_store = Store(hass, STORAGE_VERSION, store_key)
        self._legacy_pending = False
        self._last_update: datetime | None = None
        self._startup_time: datetime | None = None
        self._unsub_state_change: CALLBACK_TYPE | None = None
        # Single group-wide trailing-edge debounce for coalescing state-change
        # bursts into ONE refresh. Replaces the old per-entity timer dict, which
        # scheduled a separate full O(N) refresh per changed entity — so K entities
        # flapping in one window triggered K full scans (O(N*K) ~ O(N^2)). The
        # timer resets on each in-window event; when it fires, exactly one refresh
        # runs. _refresh_again captures any event that lands DURING an in-flight
        # refresh so the trailing refresh is never dropped (see _run_coalesced_refresh).
        self._refresh_timer: CALLBACK_TYPE | None = None
        self._refresh_task: asyncio.Task | None = None
        self._refresh_again: bool = False
        self._device_states: dict[str, DeviceState] = {}
        self._suppressed: dict[str, datetime | None] = {}
        self._update_count: int = 0
        self._dirty: bool = False
        # Memoized entity_id -> representative entity_id map for device-collapse.
        # Rebuilt once per _async_update_data tick (registry + battery/signal churn
        # can change keys), then read by every count/list site so er lookups run
        # N-per-tick, not N x sensors. None = not yet computed this tick.
        self._collapse_map: dict[str, str] | None = None
        # Monotonic tick counter — bumped each _async_update_data. Combined sensors
        # use the sum across their source coordinators as a cheap cache key so the
        # global re-collapse runs once per tick, not once per property read.
        self._collapse_generation: int = 0

        # Everything the resolver depends on now exists.
        self._resolve_entities()

    # ------------------------------------------------------------------
    # Membership resolution
    # ------------------------------------------------------------------

    def _resolve_entities(self) -> bool:
        """Recompute the monitored set. Returns True when the set changed.

        Manual mode reads the stored list verbatim, exactly as upstream does.
        Discovery mode runs the rules in discovery.py against the registries.
        """
        if not self._discovery_mode:
            new = list(self.entry.data.get(CONF_ENTITIES, []))
        else:
            self._discovery = discovery.resolve(self.hass, dict(self.entry.data))
            new = list(self._discovery.entities)
            if self._signal_auto:
                self._signal_map = self._build_auto_signal_map(new)

        changed = new != self._entities
        self._entities = new
        return changed

    @property
    def discovery_result(self) -> discovery.DiscoveryResult | None:
        """Return the last discovery resolution, or None in manual mode."""
        return self._discovery

    def _build_auto_signal_map(self, entities: list[str]) -> dict[str, dict[str, str]]:
        """Bind each monitored entity to a signal sensor found in the registry.

        Replaces the per-entity mapping form, which renders one row per monitored
        entity and is unusable once discovery resolves hundreds. Network type is
        inferred from the integration, so a Shelly gets Wi-Fi dBm thresholds and a
        BTHome sensor gets Bluetooth ones.
        """
        mapping: dict[str, dict[str, str]] = {}
        ent_reg = er.async_get(self.hass)
        for entity_id in entities:
            sensor = self._signal_sibling_of(entity_id)
            if sensor is None:
                continue
            entry = ent_reg.async_get(entity_id)
            platform = entry.platform if entry else ""
            mapping[entity_id] = {
                "sensor": sensor,
                "network_type": PLATFORM_SIGNAL_TYPES.get(platform, "generic"),
            }
        _LOGGER.debug(
            "[%s] Auto-bound signal sensors for %d of %d entities",
            self.group_name,
            len(mapping),
            len(entities),
        )
        return mapping

    def _signal_sibling_of(self, entity_id: str) -> str | None:
        """Find a signal_strength sensor for this entity's device.

        Mirrors _battery_sibling_of, with one addition: if the entity's own device has
        no signal sensor, walk up via_device. Sub-devices frequently carry no radio of
        their own — the 4 outlets of a Shelly power strip are separate devices, but the
        RSSI lives on the strip.
        """
        ent_reg = er.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)
        entry = ent_reg.async_get(entity_id)
        if not entry or not entry.device_id:
            return None

        device_id: str | None = entry.device_id
        seen: set[str] = set()
        while device_id and device_id not in seen:
            seen.add(device_id)
            for ent in er.async_entries_for_device(
                ent_reg, device_id, include_disabled_entities=False
            ):
                dc = ent.device_class or ent.original_device_class
                if dc == SensorDeviceClass.SIGNAL_STRENGTH:
                    return ent.entity_id
            device = dev_reg.async_get(device_id)
            device_id = device.via_device_id if device else None
        return None

    def _device_has_live_sibling(self, entity_id: str) -> bool:
        """True when another entity of the same device is reporting a real state.

        A device is only genuinely offline once ALL of its entities are unavailable.
        Two classes of entity are permanently unavailable while the device is fine:
        capabilities a device advertises but never reports (common on Z-Wave), and
        features the user disabled upstream — UniFi Protect smart detections turned off
        in the Protect app leave ~12 binary sensors per camera unavailable forever.
        Counting those as outages would bury the pane in permanent false positives.

        Two entity types cannot serve as proof of life:
        - device_class: connectivity binary sensors report reachability as their VALUE
          and are built never to go unavailable, so one would keep a dead device alive.
        - button entities are stateless triggers; their state says nothing about now.

        Ported from ha-connection-observer (MIT).
        """
        ent_reg = er.async_get(self.hass)
        entry = ent_reg.async_get(entity_id)
        if not entry or not entry.device_id:
            return False

        cached = self._live_sibling_memo.get(entry.device_id)
        if cached is not None:
            return cached

        alive = False
        for ent in er.async_entries_for_device(
            ent_reg, entry.device_id, include_disabled_entities=False
        ):
            if ent.entity_id.startswith("button."):
                continue
            state = self.hass.states.get(ent.entity_id)
            if state is None or state.state in self._bad_states:
                continue
            if state.attributes.get("device_class") == "connectivity":
                continue
            alive = True
            break

        self._live_sibling_memo[entry.device_id] = alive
        return alive

    @callback
    def _setup_registry_listeners(self) -> None:
        """Re-resolve membership when the registries change (discovery mode only).

        This is what makes "add a device, it is monitored" true without a restart or a
        config-entry reload. Registry events arrive in bursts (an integration adding a
        device writes one event per entity), so they are debounced into a single
        re-resolve.
        """
        if not self._discovery_mode:
            return

        @callback
        def _on_registry_event(_event: Event) -> None:
            if self._registry_debounce is not None:
                self._registry_debounce()
            self._registry_debounce = async_call_later(
                self.hass, _REGISTRY_DEBOUNCE, _apply
            )

        @callback
        def _apply(_now) -> None:
            self._registry_debounce = None
            if not self._resolve_entities():
                return
            _LOGGER.info(
                "[%s] Discovery re-resolved: %d entities, %d devices",
                self.group_name,
                len(self._entities),
                len(self._discovery.devices) if self._discovery else 0,
            )
            self._prune_departed()
            self._setup_state_listeners()
            self.hass.async_create_task(self.async_request_refresh())

        self._unsub_registry = [
            self.hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED, _on_registry_event
            ),
            self.hass.bus.async_listen(
                dr.EVENT_DEVICE_REGISTRY_UPDATED, _on_registry_event
            ),
        ]

    def _prune_departed(self) -> None:
        """Drop per-entity state for entities that left the monitored set.

        Upstream never removes from _device_states because its membership is fixed.
        With live re-resolution that leak is a correctness bug, not just memory: every
        count sensor iterates _device_states, not _entities, so an entity that left
        while offline would be counted offline forever.
        """
        current = set(self._entities)
        departed = [eid for eid in self._device_states if eid not in current]
        # Buckets are keyed independently of _device_states, so sweep them by the same
        # rule — otherwise the store accumulates history for entities that left the
        # set and nothing ever reads or removes it.
        orphan_buckets = [
            eid for eid in self._availability_storage.buckets if eid not in current
        ]
        if orphan_buckets:
            self._availability_storage.reset(orphan_buckets)
        for eid in departed:
            self._device_states.pop(eid, None)
            self._suppressed.pop(eid, None)
        if departed or orphan_buckets:
            _LOGGER.debug(
                "[%s] Pruned %d departed entities: %s",
                self.group_name,
                len(departed),
                departed,
            )
            self._dirty = True
            self._invalidate_collapse()

    @property
    def monitored_entities(self) -> list[str]:
        """Return list of monitored entity IDs."""
        return self._entities

    @property
    def device_states(self) -> dict[str, DeviceState]:
        """Return current device states."""
        return self._device_states

    @property
    def availability_storage(self) -> AvailabilityStorage:
        """Return the availability storage."""
        return self._availability_storage

    @property
    def recovery_window_minutes(self) -> int:
        """Return the recovery window in minutes, reading live from config."""
        return self.entry.data.get(CONF_RECOVERY_WINDOW, DEFAULT_RECOVERY_WINDOW)

    @property
    def group_name(self) -> str:
        """Return the group name."""
        return self.entry.title

    @property
    def collapse_generation(self) -> int:
        """Monotonic tick counter for combined-sensor collapse caching."""
        return self._collapse_generation

    def suppress_entity(self, entity_id: str, until: datetime | None = None) -> None:
        """Suppress alerts for an entity."""
        _LOGGER.debug("[%s] Suppressing %s until %s", self.group_name, entity_id, until)
        if entity_id not in self._device_states:
            self._device_states[entity_id] = DeviceState(entity_id=entity_id)
        self._device_states[entity_id].is_suppressed = True
        self._device_states[entity_id].suppress_until = until
        self._suppressed[entity_id] = until
        self._dirty = True
        self._invalidate_collapse()

    def unsuppress_entity(self, entity_id: str) -> None:
        """Resume monitoring for an entity."""
        _LOGGER.debug("[%s] Unsuppressing %s", self.group_name, entity_id)
        if entity_id in self._device_states:
            self._device_states[entity_id].is_suppressed = False
            self._device_states[entity_id].suppress_until = None
        self._suppressed.pop(entity_id, None)
        self._dirty = True
        self._invalidate_collapse()

    def _invalidate_collapse(self) -> None:
        """Drop the per-tick collapse memo and bump the generation.

        Called on state mutations that happen OUTSIDE _async_update_data (suppress/
        unsuppress push via async_set_updated_data, not a refresh) so collapsed
        counts/lists — and combined sensors keyed on collapse_generation — reflect
        the new suppression state immediately instead of after the next 30s tick.
        """
        self._collapse_map = None
        self._collapse_generation += 1

    def reliability_stats(self, entity_id: str, now: datetime) -> dict[str, Any]:
        """Return MTBF/MTTR reliability stats for an entity.

        MTBF (hours) = observed uptime / number of offline events.
        MTTR (minutes) = total offline time / number of offline events.
        Both None until at least one full offline→recovery event exists.
        """
        device = self._device_states.get(entity_id)
        if device is None or device.offline_event_count == 0:
            return {
                "mtbf_hours": None,
                "mttr_minutes": None,
                "offline_events": device.offline_event_count if device else 0,
            }
        uptime = 0.0
        if device.monitored_since:
            uptime = (
                now - device.monitored_since
            ).total_seconds() - device.total_offline_seconds
        return {
            "mtbf_hours": round(
                max(uptime, 0.0) / device.offline_event_count / 3600, 1
            ),
            "mttr_minutes": round(
                device.total_offline_seconds / device.offline_event_count / 60, 1
            ),
            "offline_events": device.offline_event_count,
        }

    def reset_statistics(self, entity_ids: list[str] | None = None) -> None:
        """Clear availability buckets and reliability counters.

        entity_ids=None resets every monitored entity in this group, including
        suppressed ones — a group reset means "forget this group's history",
        and suppression only gates alerting/averaging, not whether history exists.
        """
        targets = entity_ids if entity_ids is not None else list(self._entities)
        now = datetime.now(timezone.utc)
        self._availability_storage.reset(entity_ids)
        for eid in targets:
            device = self._device_states.get(eid)
            if device is None:
                continue
            device.offline_event_count = 0
            device.total_offline_seconds = 0.0
            device.last_downtime_seconds = None
            device.monitored_since = now
            # If offline right now, restart the downtime clock so the eventual
            # recovery only accrues post-reset downtime — otherwise pre-reset
            # time would be added against a zeroed counter and lost/skewed.
            if device.is_offline and device.offline_since is not None:
                device.offline_since = now
        _LOGGER.debug("[%s] Reset statistics for %s", self.group_name, targets)
        self._dirty = True
        if self.data is not None:
            self.async_set_updated_data(self.data)

    async def async_config_entry_first_refresh(self) -> None:
        """Load stored data and do first refresh."""
        _LOGGER.debug(
            "[%s] First refresh: loading storage, entities=%s",
            self.group_name,
            self._entities,
        )
        await self._async_load_storage()
        # A stored file can carry entities that are no longer in the set — the rules
        # changed, or an exclusion was added, while this entry was not running. Sweep
        # them here as well as on live re-resolve, or their buckets are loaded and
        # re-saved forever with nothing reading them.
        self._prune_departed()
        self._startup_time = datetime.now(timezone.utc)
        _LOGGER.debug(
            "[%s] Startup grace period active until %s",
            self.group_name,
            self._startup_time + timedelta(seconds=STARTUP_GRACE_PERIOD),
        )
        await super().async_config_entry_first_refresh()
        self._setup_state_listeners()
        self._setup_registry_listeners()

    async def async_shutdown(self) -> None:
        """Clean up on unload."""
        _LOGGER.debug("[%s] Shutting down coordinator", self.group_name)
        # getattr guards: when __init__ raises, HA still calls shutdown on the
        # half-built object, and an AttributeError here would mask the real error.
        if getattr(self, "_unsub_state_change", None) is not None:
            self._unsub_state_change()
            self._unsub_state_change = None
        for unsub in getattr(self, "_unsub_registry", []):
            unsub()
        self._unsub_registry = []
        if getattr(self, "_registry_debounce", None) is not None:
            self._registry_debounce()
            self._registry_debounce = None
        # Cancel any pending debounce timer and stop the coalesced-refresh loop
        # from re-running (_refresh_again=False). An in-flight refresh task is
        # left to complete its current pass — it is short-lived and nulls
        # _refresh_task itself in its finally, so we do not await it here.
        if self._refresh_timer is not None:
            self._refresh_timer()
            self._refresh_timer = None
        self._refresh_again = False
        # Final save
        if self._dirty:
            _LOGGER.debug("[%s] Saving dirty storage on shutdown", self.group_name)
            await self._async_save_storage()

    async def _async_load_storage(self) -> None:
        """Load persisted availability data."""
        stored = await self._store.async_load()
        if stored is None:
            # First run after the move out of .storage — adopt the old file.
            stored = await self._legacy_store.async_load()
            if stored is not None:
                self._legacy_pending = True
                _LOGGER.info(
                    "[%s] Migrating availability history from .storage to .cache",
                    self.group_name,
                )
        if stored and isinstance(stored, dict):
            _LOGGER.debug(
                "[%s] Loading storage: %d availability entries, %d suppressed, %d device states",
                self.group_name,
                len(stored.get("availability", {})),
                len(stored.get("suppressed", {})),
                len(stored.get("device_states", {})),
            )
            if "availability" in stored:
                self._availability_storage = AvailabilityStorage.from_dict(
                    stored["availability"]
                )
            if "suppressed" in stored:
                for entity_id, until_str in stored["suppressed"].items():
                    if entity_id not in self._entities:
                        continue
                    if until_str is None:
                        # Indefinite suppression — restore without expiry
                        self._suppressed[entity_id] = None
                    else:
                        try:
                            until = datetime.fromisoformat(until_str)
                            if until.tzinfo is None:
                                until = until.replace(tzinfo=timezone.utc)
                            if until > datetime.now(timezone.utc):
                                self._suppressed[entity_id] = until
                                _LOGGER.debug(
                                    "[%s] Restored timed suppression for %s until %s",
                                    self.group_name,
                                    entity_id,
                                    until,
                                )
                        except (ValueError, TypeError):
                            pass
            if "device_states" in stored:
                for entity_id, ds in stored["device_states"].items():
                    device = DeviceState(entity_id=entity_id)
                    device.is_offline = ds.get("is_offline", False)
                    try:
                        raw_os = ds.get("offline_since")
                        if raw_os:
                            ts = datetime.fromisoformat(raw_os)
                            if ts.tzinfo is None:
                                ts = ts.replace(tzinfo=timezone.utc)
                            device.offline_since = ts
                        else:
                            device.offline_since = None
                    except (ValueError, TypeError):
                        device.offline_since = None
                    try:
                        raw_cs = ds.get("cooldown_start")
                        if raw_cs:
                            ts = datetime.fromisoformat(raw_cs)
                            if ts.tzinfo is None:
                                ts = ts.replace(tzinfo=timezone.utc)
                            device.cooldown_start = ts
                        else:
                            device.cooldown_start = None
                    except (ValueError, TypeError):
                        device.cooldown_start = None
                    try:
                        raw = ds.get("recently_offline_at")
                        if raw:
                            ts = datetime.fromisoformat(raw)
                            if ts.tzinfo is None:
                                ts = ts.replace(tzinfo=timezone.utc)
                            window_seconds = (
                                self.entry.data.get(
                                    CONF_RECOVERY_WINDOW, DEFAULT_RECOVERY_WINDOW
                                )
                                * 60
                            )
                            if (
                                datetime.now(timezone.utc) - ts
                            ).total_seconds() <= window_seconds:
                                device.recently_offline_at = ts
                    except (ValueError, TypeError):
                        device.recently_offline_at = None
                    try:
                        raw_ms = ds.get("monitored_since")
                        if raw_ms:
                            ts = datetime.fromisoformat(raw_ms)
                            if ts.tzinfo is None:
                                ts = ts.replace(tzinfo=timezone.utc)
                            device.monitored_since = ts
                    except (ValueError, TypeError):
                        device.monitored_since = None
                    try:
                        raw_lc = ds.get("last_changed")
                        if raw_lc:
                            ts = datetime.fromisoformat(raw_lc)
                            if ts.tzinfo is None:
                                ts = ts.replace(tzinfo=timezone.utc)
                            device.last_changed = ts
                    except (ValueError, TypeError):
                        device.last_changed = None
                    device.offline_event_count = ds.get("offline_event_count", 0)
                    device.total_offline_seconds = ds.get("total_offline_seconds", 0.0)
                    device.battery_level = ds.get("battery_level")
                    device.is_low_battery = ds.get("is_low_battery", False)
                    if entity_id in self._entities:
                        self._device_states[entity_id] = device

    async def _async_save_storage(self) -> None:
        """Persist availability data."""
        device_states_data: dict[str, dict] = {}
        for entity_id, device in self._device_states.items():
            if entity_id not in self._entities:
                continue
            # last_changed is non-None for all active entities after any real
            # state-change event, so this guard includes most monitored devices
            # (broader than pre-PR which only saved offline/low-battery devices).
            # Saves are periodic (_SAVE_INTERVAL_UPDATES) — not per-event.
            if (
                device.is_offline
                or device.cooldown_start is not None
                or device.recently_offline_at is not None
                or device.offline_event_count > 0
                or device.monitored_since is not None
                or device.is_low_battery
                or device.last_changed is not None
            ):
                device_states_data[entity_id] = {
                    "is_offline": device.is_offline,
                    "offline_since": device.offline_since.isoformat()
                    if device.offline_since
                    else None,
                    "cooldown_start": device.cooldown_start.isoformat()
                    if device.cooldown_start
                    else None,
                    "recently_offline_at": device.recently_offline_at.isoformat()
                    if device.recently_offline_at
                    else None,
                    "monitored_since": device.monitored_since.isoformat()
                    if device.monitored_since
                    else None,
                    "offline_event_count": device.offline_event_count,
                    "total_offline_seconds": device.total_offline_seconds,
                    "battery_level": device.battery_level,
                    "is_low_battery": device.is_low_battery,
                    "last_changed": device.last_changed.isoformat()
                    if device.last_changed
                    else None,
                }
        data = {
            "availability": self._availability_storage.to_dict(),
            "suppressed": {
                entity_id: until.isoformat() if until else None
                for entity_id, until in self._suppressed.items()
                if entity_id in self._entities
            },
            "device_states": device_states_data,
        }
        _LOGGER.debug(
            "[%s] Saving storage: %d availability entries, %d suppressed, %d offline device states",
            self.group_name,
            len(data["availability"]),
            len(data["suppressed"]),
            len(device_states_data),
        )
        await self._store.async_save(data)
        self._dirty = False
        if self._legacy_pending:
            # Only now that the new file is on disk — never delete the old copy
            # before its replacement exists.
            self._legacy_pending = False
            await self._legacy_store.async_remove()
            _LOGGER.info(
                "[%s] Migration complete, removed the old .storage file",
                self.group_name,
            )

    @callback
    def _setup_state_listeners(self) -> None:
        """Set up state change listeners for monitored entities."""
        if self._unsub_state_change is not None:
            self._unsub_state_change()

        _LOGGER.debug(
            "[%s] Setting up state listeners for %d entities",
            self.group_name,
            len(self._entities),
        )
        tracked = list(self._entities)
        if self._signal_enabled:
            signal_sensors = [
                m["sensor"] for m in self._signal_map.values() if m.get("sensor")
            ]
            tracked = list(dict.fromkeys(tracked + signal_sensors))
        battery_map = self.entry.data.get(CONF_BATTERY_ENTITY_MAP, {})
        battery_sensors = [v for v in battery_map.values() if v]
        if battery_sensors:
            tracked = list(dict.fromkeys(tracked + battery_sensors))
        self._unsub_state_change = async_track_state_change_event(
            self.hass, tracked, self._handle_state_change
        )

    @callback
    def _handle_state_change(self, event: Event) -> None:
        """Handle a monitored entity's state change (coalesced group refresh)."""
        entity_id = event.data.get("entity_id", "unknown")
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        _LOGGER.debug(
            "[%s] State change: %s  %s -> %s",
            self.group_name,
            entity_id,
            old_state.state if old_state else "None",
            new_state.state if new_state else "None",
        )
        # Record the real last-seen timestamp from the live event. HA resets
        # state.last_changed on restart, so polling it in _async_update_data
        # would give the boot time. Capturing it here from the event preserves
        # the true last-changed across restarts (persisted in storage).
        if new_state is not None and entity_id in self._device_states:
            ts = new_state.last_changed
            if ts is not None:  # pragma: no branch — HA always sets last_changed
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                self._device_states[entity_id].last_changed = ts
            self._dirty = True
        # Coalesce bursts: a single group-wide trailing-edge timer. Cancel the
        # one pending timer (if any) and re-arm it, so N entities changing within
        # the debounce window trigger exactly ONE refresh instead of N. The
        # per-entity last_changed capture above already ran synchronously, so no
        # entity's data is lost by sharing the timer.
        if self._refresh_timer is not None:
            self._refresh_timer()
        self._refresh_timer = async_call_later(
            self.hass, _STATE_CHANGE_DEBOUNCE, self._debounced_group_refresh
        )

    @callback
    def _debounced_group_refresh(self, _now: Any) -> None:
        """Launch a coalesced refresh after the debounce window settles.

        If a refresh is already in flight, set a flag instead of launching a
        second one — _run_coalesced_refresh re-runs once when it finishes, so an
        event that arrives mid-refresh is never dropped (the drop-window that
        makes HA's Debouncer(immediate=False) unsafe here). Refreshes are thus
        strictly serialized, never overlapping.
        """
        self._refresh_timer = None
        if self._refresh_task is not None and not self._refresh_task.done():
            self._refresh_again = True
            return
        self._refresh_task = self.hass.async_create_task(self._run_coalesced_refresh())

    async def _run_coalesced_refresh(self) -> None:
        """Run refreshes serially, re-running once if events arrived mid-refresh.

        Using async_refresh() (not async_request_refresh()) keeps HA's Debouncer
        execute-lock out of the path; the trailing guarantee comes from the
        _refresh_again flag set in _debounced_group_refresh.

        Serialization is safe on HA's single-threaded loop: there is no await
        between the _refresh_again check and the finally, so no timer callback can
        run in that gap to spawn a second task that the finally would then orphan.
        _debounced_group_refresh only spawns a task when _refresh_task is None or
        done — never while this loop is between iterations.
        """
        try:
            while True:
                await self.async_refresh()
                if self._refresh_again:
                    self._refresh_again = False
                    continue
                break
        finally:
            self._refresh_task = None

    async def _async_update_data(self) -> EntityAvailabilityData:
        """Update device states and availability."""
        now = datetime.now(timezone.utc)
        elapsed = (
            (now - self._last_update).total_seconds()
            if self._last_update
            else SCAN_INTERVAL
        )
        self._last_update = now
        # Invalidate the per-tick device-collapse memo: registry changes and
        # battery/signal drift can change collapse keys between ticks. The
        # monotonic generation lets combined sensors cheaply detect a new tick.
        self._collapse_map = None
        # Same lifetime: sibling liveness is read from the state machine, which moves
        # between ticks. Stale entries would freeze a device's offline verdict.
        self._live_sibling_memo = {}

        # Cap elapsed to avoid huge jumps after HA restart or sleep
        # Maximum reasonable elapsed is 2x the scan interval
        elapsed = min(elapsed, SCAN_INTERVAL * 2)

        # (event_name, payload, category) — category in {"offline","stale",
        # "low_battery","poor_signal"}. The count/entities keys for each category
        # are stamped in AFTER the loop from a single O(N) scan per touched
        # category, instead of one scan per transition inside the loop (that was
        # O(N·M) — the second starvation source under a flap storm).
        pending_events: list[tuple[str, dict, str]] = []
        # ponytail: full O(N) sweep every tick recomputes every device even when
        # only K flapped. A dirty-set event path (refresh only changed entities on
        # the debounced run, keep the 30s tick as the full time-based sweep) would
        # cut per-flap cost to O(K). Deferred — the coalesced single-timer refresh
        # already removes the O(N²) fan-out; add the dirty-set if profiling on very
        # large groups still shows the per-tick O(N) scan dominating.

        for entity_id in self._entities:
            state = self.hass.states.get(entity_id)
            if entity_id not in self._device_states:
                self._device_states[entity_id] = DeviceState(
                    entity_id=entity_id, monitored_since=now
                )

            device = self._device_states[entity_id]

            # Set non-essential flag (must be before suppressed continue so both flags are set)
            device.is_non_essential = entity_id in self._non_essential

            # Collapse provenance: WHICH sensor supplies battery/signal (static config,
            # not a live value). Must be set BEFORE the suppressed continue below, else
            # a suppressed same-device sibling keeps stale/None sources and mis-splits
            # from its unsuppressed twin for a cycle. Also set the signal unit here for
            # the same reason (it rides the collapse decision).
            device.battery_source = (
                self._get_battery_source(entity_id)
                if self._battery_threshold > 0
                else None
            )
            device.signal_source = self._get_signal_source(entity_id)
            device.signal_unit = self._signal_unit_of(entity_id)

            # Restore suppression from loaded data
            if entity_id in self._suppressed and not device.is_suppressed:
                device.is_suppressed = True
                device.suppress_until = self._suppressed[entity_id]

            # Check suppression expiry
            if (
                device.is_suppressed
                and device.suppress_until
                and now > device.suppress_until
            ):
                _LOGGER.debug(
                    "[%s] Suppression expired for %s", self.group_name, entity_id
                )
                device.is_suppressed = False
                device.suppress_until = None
                self._suppressed.pop(entity_id, None)
                self._dirty = True

            # Skip suppressed devices for availability tracking;
            # clear degraded/stale flags so suppressed entities don't surface
            if device.is_suppressed:
                device.is_degraded = False
                device.is_stale = False
                device.is_low_battery = False
                # Clear stale offline flag if entity recovered while suppressed;
                # done silently — no event fires for a suppressed transition.
                is_bad = state is None or state.state in self._bad_states
                if not is_bad and device.is_offline:
                    device.is_offline = False
                    device.offline_since = None
                    device.recently_offline_at = None
                    device.cooldown_start = None
                _LOGGER.debug(
                    "[%s] Skipping suppressed entity %s (until=%s)",
                    self.group_name,
                    entity_id,
                    device.suppress_until,
                )
                continue

            # Determine if device is in a bad state
            is_bad = state is None or state.state in self._bad_states

            # ...unless a sibling on the same device proves the device is alive, in
            # which case this one entity is a dead capability, not an outage. Applied
            # here rather than at the offline transition so it also keeps the
            # availability buckets clean — a permanently-unavailable capability entity
            # would otherwise sit at 0% and drag the whole group's average down.
            if (
                is_bad
                and self._offline_requires_all
                and self._device_has_live_sibling(entity_id)
            ):
                is_bad = False

            # Battery follows Home Assistant, with no retention.
            #
            # This used to keep the last-known level whenever the source sensor
            # stopped reporting, on the theory that a momentary dropout should not
            # blank the reading. In practice it cannot tell a dropout from a death:
            # a clock whose battery sensor had been `unavailable` for a day still
            # published "4%", on a device that was itself fully offline — a made-up
            # number presented exactly like a measured one.
            #
            # Home Assistant already decides when an entity has a value. If it says
            # `unavailable`, we do not have a reading, and reporting one anyway is
            # worse than reporting nothing: everything downstream (the low-battery
            # flag, its count, the card, any alert built on them) treats a stale
            # value as current. Note this is not a debounce problem — a sensor that
            # simply reports infrequently stays AVAILABLE holding its last state, so
            # slow BLE sensors are unaffected.
            device.battery_level = (
                self._get_battery_level(entity_id)
                if self._battery_threshold > 0
                else None
            )
            battery_low = (
                self._battery_threshold > 0
                and device.battery_level is not None
                and device.battery_level < self._battery_threshold
            )
            # De-jitter: once low, stay low until the level clears the threshold by
            # BATTERY_HYSTERESIS — a reading resting on the boundary won't flip the
            # flag (and its recorded count) every poll.
            if (
                device.is_low_battery
                and self._battery_threshold > 0
                and device.battery_level is not None
                and device.battery_level < self._battery_threshold + BATTERY_HYSTERESIS
            ):
                battery_low = True

            # Signal check — clear level when sensor unavailable (same as battery: no stale value)
            if self._signal_enabled:
                fresh_signal = self._get_signal_level(entity_id)
                device.signal_level = fresh_signal
                # signal_unit already set above (before the suppressed continue) so it
                # stays consistent with signal_source for the collapse decision.
                device.signal_quality = (
                    self._classify_signal(
                        entity_id, fresh_signal, device.signal_quality
                    )
                    if fresh_signal is not None
                    else None
                )

            # Seed on first encounter; real updates come from _handle_state_change.
            if device.last_changed is None and state:
                ts = state.last_changed
                if ts is not None:  # pragma: no branch — HA always sets last_changed
                    if ts.tzinfo is None:
                        ts = ts.replace(tzinfo=timezone.utc)
                    device.last_changed = ts
                    self._dirty = True

            # Staleness check. Uses last_updated when configured (advances on any
            # state write, including unchanged-value reports); otherwise last_changed.
            is_stale = False
            stale_ts = None
            if self._staleness_threshold > 0 and state:
                # last_updated advances on same-value writes that never fire
                # state_changed, so read directly from HA state each poll.
                stale_ts = (
                    state.last_updated
                    if self._staleness_use_last_updated
                    else device.last_changed
                )
                if stale_ts:  # pragma: no branch
                    if stale_ts.tzinfo is None:  # pragma: no cover
                        stale_ts = stale_ts.replace(tzinfo=timezone.utc)
                    age = (now - stale_ts).total_seconds() / 60
                    # De-jitter: enter stale above threshold; once stale, stay stale
                    # until age falls below the exit threshold, so an age hovering on
                    # the boundary won't flip the flag every poll. The band is capped
                    # at half the threshold so it can never reach 0 (which would trap a
                    # freshly-recovered entity, age≈0, as permanently stale).
                    band = min(STALENESS_HYSTERESIS, self._staleness_threshold / 2)
                    exit_threshold = self._staleness_threshold - band
                    if age > self._staleness_threshold or (
                        device.is_stale and age > exit_threshold
                    ):
                        is_stale = True
                        _LOGGER.debug(
                            "[%s] %s is stale: last activity %.1f min ago (threshold=%d min)",
                            self.group_name,
                            entity_id,
                            age,
                            self._staleness_threshold,
                        )

            # Cooldown logic
            if is_bad:
                if device.cooldown_start is None:
                    _lc = state.last_changed if state and state.last_changed else None
                    if _lc is not None and _lc.tzinfo is None:
                        _lc = _lc.replace(tzinfo=timezone.utc)
                    device.cooldown_start = (
                        _lc if _lc is not None and _lc < now else now
                    )
                    _LOGGER.debug(
                        "[%s] %s entered bad state (%s), cooldown started",
                        self.group_name,
                        entity_id,
                        state.state if state else "unavailable",
                    )
                cooldown_elapsed = (now - device.cooldown_start).total_seconds()
                in_grace = (
                    self._startup_time is not None
                    and (now - self._startup_time).total_seconds()
                    < STARTUP_GRACE_PERIOD
                )
                if cooldown_elapsed >= self._cooldown:
                    if not device.is_offline and not in_grace:
                        _LOGGER.debug(
                            "[%s] %s went OFFLINE (cooldown=%.0fs elapsed, since=%s)",
                            self.group_name,
                            entity_id,
                            cooldown_elapsed,
                            device.cooldown_start,
                        )
                        device.is_offline = True
                        device.offline_since = device.cooldown_start
                        device.recently_offline_at = now
                        device.offline_event_count += 1
                        pending_events.append(
                            (
                                EVENT_OFFLINE,
                                {
                                    "entity_id": entity_id,
                                    "group": self.group_name,
                                    "entry_id": self.entry.entry_id,
                                    "offline_since": device.offline_since.isoformat()
                                    if device.offline_since
                                    else None,
                                },
                                "offline",
                            )
                        )
                    elif in_grace:
                        _LOGGER.debug(
                            "[%s] %s cooldown elapsed but still in startup grace period",
                            self.group_name,
                            entity_id,
                        )
                else:
                    # Still in cooldown - record as online
                    _LOGGER.debug(
                        "[%s] %s in cooldown: %.0fs / %ds elapsed",
                        self.group_name,
                        entity_id,
                        cooldown_elapsed,
                        self._cooldown,
                    )
                    self._availability_storage.record_online(entity_id, elapsed, now)
            else:
                # Device is online
                if device.is_offline:
                    _LOGGER.debug(
                        "[%s] %s RECOVERED (was offline since %s, downtime=%.0fs)",
                        self.group_name,
                        entity_id,
                        device.offline_since,
                        (now - device.offline_since).total_seconds()
                        if device.offline_since
                        else 0,
                    )
                    device.last_recovery = now
                    if device.offline_since:
                        device.last_downtime_seconds = (
                            now - device.offline_since
                        ).total_seconds()
                        device.total_offline_seconds += device.last_downtime_seconds
                    device.is_offline = False
                    device.offline_since = None
                    device.recently_offline_at = None
                    pending_events.append(
                        (
                            EVENT_RECOVERED,
                            {
                                "entity_id": entity_id,
                                "group": self.group_name,
                                "entry_id": self.entry.entry_id,
                                "downtime_seconds": device.last_downtime_seconds,
                            },
                            "offline",
                        )
                    )
                device.cooldown_start = None
                self._availability_storage.record_online(entity_id, elapsed, now)

            # Record offline time (offline seconds are implicitly tracked
            # as total_seconds - online_seconds in the bucket).
            # Skip if still in cooldown — recorded as online above.
            if device.is_offline and not (
                is_bad
                and device.cooldown_start is not None
                and (now - device.cooldown_start).total_seconds() < self._cooldown
            ):
                self._availability_storage.record_offline(entity_id, elapsed, now)

            # Degraded = not offline but battery low or stale
            if is_stale and not device.is_stale:
                device.is_stale = True
                pending_events.append(
                    (
                        EVENT_STALE,
                        {
                            "entity_id": entity_id,
                            "group": self.group_name,
                            "entry_id": self.entry.entry_id,
                            "stale_since": (stale_ts or now).isoformat(),
                        },
                        "stale",
                    )
                )
            elif not is_stale and device.is_stale:
                device.is_stale = False
                pending_events.append(
                    (
                        EVENT_STALE_RECOVERED,
                        {
                            "entity_id": entity_id,
                            "group": self.group_name,
                            "entry_id": self.entry.entry_id,
                            "stale_since": (stale_ts or now).isoformat(),
                        },
                        "stale",
                    )
                )
            else:
                device.is_stale = is_stale
            if battery_low and not device.is_low_battery:
                device.is_low_battery = True
                pending_events.append(
                    (
                        EVENT_LOW_BATTERY,
                        {
                            "entity_id": entity_id,
                            "group": self.group_name,
                            "entry_id": self.entry.entry_id,
                            "battery_level": device.battery_level,
                        },
                        "low_battery",
                    )
                )
            elif not battery_low and device.is_low_battery:
                # The flag is cleared either way: "low" is a claim about a current
                # reading, and we no longer have one. But only ANNOUNCE a recovery
                # we actually measured — with the level at None the sensor merely
                # stopped reporting, and firing battery_ok there would resolve a
                # low-battery alert because the sensor died, which is precisely
                # backwards.
                device.is_low_battery = False
                if device.battery_level is not None:
                    pending_events.append(
                        (
                            EVENT_BATTERY_OK,
                            {
                                "entity_id": entity_id,
                                "group": self.group_name,
                                "entry_id": self.entry.entry_id,
                                "battery_level": device.battery_level,
                            },
                            "low_battery",
                        )
                    )
            else:
                device.is_low_battery = battery_low
            device.is_degraded = (not device.is_offline) and (battery_low or is_stale)

            # Signal quality transition events
            if self._signal_enabled:
                signal_poor = device.signal_quality == "poor"
                was_poor = device.prev_signal_poor
                if signal_poor and not was_poor:
                    pending_events.append(
                        (
                            EVENT_POOR_SIGNAL,
                            {
                                "entity_id": entity_id,
                                "group": self.group_name,
                                "entry_id": self.entry.entry_id,
                                "signal_level": device.signal_level,
                                "signal_quality": device.signal_quality,
                            },
                            "poor_signal",
                        )
                    )
                elif not signal_poor and was_poor and device.signal_quality is not None:
                    # Same rule as battery: a signal sensor that stopped reporting
                    # is not a signal that recovered.
                    pending_events.append(
                        (
                            EVENT_SIGNAL_OK,
                            {
                                "entity_id": entity_id,
                                "group": self.group_name,
                                "entry_id": self.entry.entry_id,
                                "signal_level": device.signal_level,
                                "signal_quality": device.signal_quality,
                            },
                            "poor_signal",
                        )
                    )
                device.prev_signal_poor = signal_poor

        # Mark as dirty; save periodically (every ~5 min)
        self._dirty = True
        self._update_count += 1
        if self._update_count >= _SAVE_INTERVAL_UPDATES:
            try:
                await self._async_save_storage()
            except Exception:  # noqa: BLE001
                _LOGGER.warning(
                    "[%s] Failed to save storage — will retry next interval",
                    self.group_name,
                )
            finally:
                self._update_count = 0

        # Stamp per-category count/entities once per touched category, then fire.
        # Each list reflects FINAL device_states (all transitions in this sweep
        # applied) — for a single transition per sweep this is byte-identical to
        # the old per-site build; for multiple transitions in one sweep the lists
        # are now consistent across every event rather than reflecting whichever
        # partial mid-loop state existed at each site.
        touched = {cat for _, _, cat in pending_events}
        category_ids: dict[str, list[str]] = {}
        if "offline" in touched:
            category_ids["offline"] = self._offline_entity_ids()
        if "stale" in touched:
            category_ids["stale"] = self._stale_entity_ids()
        if "low_battery" in touched:
            category_ids["low_battery"] = self._low_battery_entity_ids()
        if "poor_signal" in touched:
            category_ids["poor_signal"] = self._poor_signal_entity_ids()
        for _event_name, payload, cat in pending_events:
            ids = category_ids[cat]
            payload[f"{cat}_count"] = len(ids)
            # Copy per payload: sibling events of the same category must not alias
            # one list object (a consumer mutating a fired payload would corrupt them).
            payload[f"{cat}_entities"] = list(ids)

        try:
            for event_name, payload, _cat in pending_events:
                self.hass.bus.async_fire(event_name, payload)
        except Exception:  # pragma: no cover
            _LOGGER.warning("[%s] Failed to fire event", self.group_name, exc_info=True)

        # Bump after all state recomputation so combined sensors reading
        # collapse_generation see a generation that matches the finished device_states.
        self._collapse_generation += 1

        return EntityAvailabilityData(
            devices=dict(self._device_states),
            buckets=dict(self._availability_storage.buckets),
        )

    @property
    def collapse_active(self) -> bool:
        """Return True when device-collapse should apply to this group's values.

        Gated on BOTH collapse_devices AND use_device_names — collapse is a no-op
        unless device names are enabled (device identity drives the merge).
        """
        return self.entry.data.get(
            CONF_COLLAPSE_DEVICES, DEFAULT_COLLAPSE_DEVICES
        ) and self.entry.data.get(CONF_USE_DEVICE_NAMES, DEFAULT_USE_DEVICE_NAMES)

    def _collapsed_map(self) -> dict[str, str]:
        """Return {entity_id -> representative entity_id}, memoized per update tick.

        Delegates to the shared collapse_representatives helper. When collapse is
        inactive, every entity maps to itself (identity), so callers need no
        special-casing.
        """
        if self._collapse_map is not None:
            return self._collapse_map
        if not self.collapse_active:
            self._collapse_map = {eid: eid for eid in self._device_states}
            return self._collapse_map
        self._collapse_map = collapse_representatives(self.hass, self._device_states)
        return self._collapse_map

    def _representatives_matching(
        self, predicate: Callable[[DeviceState], bool]
    ) -> list[str]:
        """Return one entity_id per device whose members satisfy predicate.

        A device is counted once per category iff ANY of its collapsed members
        matches — so a device with an offline sibling AND a stale sibling appears
        in BOTH the offline and stale lists (each represented by a matching
        member), rather than only the single global representative's category.
        Within a device the first matching member (insertion order) is emitted.
        When collapse is inactive, rep_of maps every entity to itself, so this is
        identical to filtering every entity per-entity (pre-collapse behavior).

        Note: the emitted ID is the first entity that satisfies the predicate,
        which may differ from the global representative in entities_collapsed
        (worst-severity member). Example: device has eid_a (stale) and eid_b
        (offline, worse → global rep). entities_collapsed = [eid_b]; but
        stale_entities = [eid_a] because eid_b does not satisfy the stale
        predicate. Automations cross-referencing per-category lists against
        entities_collapsed should match by device rather than by entity_id.
        """
        rep_of = self._collapsed_map()
        seen_device: set[str] = set()
        result: list[str] = []
        for eid, d in self._device_states.items():
            if not predicate(d):
                continue
            device = rep_of.get(eid, eid)
            if device in seen_device:
                continue
            seen_device.add(device)
            result.append(eid)
        return result

    def representative_states_matching(
        self, predicate: Callable[[DeviceState], bool]
    ) -> list[DeviceState]:
        """Return representative DeviceStates matching predicate (device-collapsed when active).

        Sensors that format device rows (names, battery %) iterate these instead of
        raw device_states so their counts/rows reflect the collapse.
        """
        return [
            self._device_states[eid]
            for eid in self._representatives_matching(predicate)
        ]

    def collapsed_entities(self) -> list[str]:
        """Return monitored entities collapsed to one representative per device-key.

        Preserves monitored_entities order. When collapse is inactive, returns the
        full membership unchanged. This is the row source the card renders, so
        len(filtered representatives) == visible rows for every category.
        """
        rep_of = self._collapsed_map()
        seen: set[str] = set()
        result: list[str] = []
        for eid in self._entities:
            rep = rep_of.get(eid, eid)
            if rep in seen:
                continue
            seen.add(rep)
            result.append(rep)
        return result

    def collapsed_member_map(self) -> dict[str, list[str]]:
        """Return {representative_entity_id -> [all member entity_ids]} when collapse is active.

        Empty when collapse is inactive. Each list is ordered: representative first,
        remaining members in _collapsed_map insertion order. Rep is always present in
        eids (collapse_representatives maps every entity including the rep to itself),
        so the [rep, *rest] construction is safe.

        NOTE: CombinedGroupSensor builds its own row_members inline from merged_states
        rather than calling this method (it has a different key space). Keep both
        implementations semantically in sync when changing collapse logic.
        """
        if not self.collapse_active:
            return {}
        rep_of = self._collapsed_map()
        members: dict[str, list[str]] = {}
        for eid, rep in rep_of.items():
            members.setdefault(rep, []).append(eid)
        # Only emit entries with >1 member — singleton rows are trivial/unchanged.
        return {
            rep: [rep, *[e for e in eids if e != rep]]
            for rep, eids in members.items()
            if len(eids) > 1
        }

    def _offline_entity_ids(self) -> list[str]:
        """Return offline, non-suppressed, essential entity_ids (device-collapsed when active)."""
        return self._representatives_matching(
            lambda d: d.is_offline and not d.is_suppressed and not d.is_non_essential
        )

    def _low_battery_entity_ids(self) -> list[str]:
        """Return low-battery, non-suppressed, essential entity_ids (device-collapsed when active)."""
        return self._representatives_matching(
            lambda d: (
                d.is_low_battery and not d.is_suppressed and not d.is_non_essential
            )
        )

    def _stale_entity_ids(self) -> list[str]:
        """Return stale, non-suppressed, essential entity_ids (device-collapsed when active)."""
        return self._representatives_matching(
            lambda d: d.is_stale and not d.is_suppressed and not d.is_non_essential
        )

    def _get_battery_level(self, entity_id: str) -> int | None:
        """Get battery level for an entity using configured mapping or auto-detection."""
        state = self.hass.states.get(entity_id)
        if (
            state
            and state.attributes.get("device_class") == "battery"
            and state.state not in ("unavailable", "unknown", None)
        ):
            level = self._parse_battery_state(state.state)
            _LOGGER.debug(
                "[%s] Battery for %s via own state (device_class=battery): %s%%",
                self.group_name,
                entity_id,
                level,
            )
            return level

        battery_map = self.entry.data.get(CONF_BATTERY_ENTITY_MAP)
        if battery_map is not None and entity_id in battery_map:
            mapped = battery_map[entity_id]
            if not mapped:
                return None
            bat_state = self.hass.states.get(mapped)
            if bat_state and bat_state.state not in ("unavailable", "unknown", None):
                # binary_sensor battery: "on" = low (0%), "off" = ok (100%)
                if mapped.startswith("binary_sensor."):
                    level = 0 if bat_state.state == "on" else 100
                else:
                    level = self._parse_battery_state(bat_state.state)
                _LOGGER.debug(
                    "[%s] Battery for %s via map->%s: %s%%",
                    self.group_name,
                    entity_id,
                    mapped,
                    level,
                )
                return level
            return None

        # Auto-detection fallback: no map or entity not in map
        state = self.hass.states.get(entity_id)
        if state and state.attributes:
            # `is not None`, not `or`: a real 0% reading (dead battery) is falsy and
            # must NOT fall through to a sibling/guessed sensor (that would silently
            # report another sensor's level for a flat battery). Also keeps this branch
            # aligned with _get_battery_source, so value and provenance can't diverge.
            battery = state.attributes.get("battery_level")
            if battery is None:
                battery = state.attributes.get("battery")
            if battery is not None:
                level = self._parse_battery_state(str(battery).replace("%", ""))
                _LOGGER.debug(
                    "[%s] Battery for %s via attribute: %s%%",
                    self.group_name,
                    entity_id,
                    level,
                )
                return level

        battery_from_registry = self._get_battery_from_device_registry(entity_id)
        if battery_from_registry is not None:
            _LOGGER.debug(
                "[%s] Battery for %s via device registry: %s%%",
                self.group_name,
                entity_id,
                battery_from_registry,
            )
            return battery_from_registry

        parts = entity_id.split(".", 1)
        if len(parts) == 2:  # pragma: no branch
            battery_entity = f"sensor.{parts[1]}_battery"
            bat_state = self.hass.states.get(battery_entity)
            if bat_state and bat_state.state not in ("unavailable", "unknown", None):
                level = self._parse_battery_state(bat_state.state)
                _LOGGER.debug(
                    "[%s] Battery for %s via guessed entity %s: %s%%",
                    self.group_name,
                    entity_id,
                    battery_entity,
                    level,
                )
                return level

        return None

    @staticmethod
    def _parse_battery_state(value: str) -> int | None:
        """Parse a battery state string into an integer level."""
        if value.lower() == "low":
            return 0
        try:
            return int(float(value))
        except (ValueError, TypeError):
            return None

    def _battery_sibling_of(
        self, entity_id: str, *, require_usable_state: bool = False
    ) -> str | None:
        """Return the entity_id of a device_class=battery sibling on the same device.

        Single sibling-selection path shared by the value getter (registry branch) and
        the source getter, so the two can't drift onto different sensors. Iterates the
        device's entities in registry order and returns the first battery sibling.

        ``require_usable_state=True`` (value path) skips a sibling whose state is
        unavailable/unknown/None or doesn't parse to a level, so the level actually
        comes back — matching where a usable reading lives. ``False`` (source path,
        default) is provenance-only and availability-blind: which sensor supplies the
        battery doesn't change because it blipped unavailable, and a source flipping to
        None mid-blip would wildcard-merge and flap the identity this collapse
        stabilizes. Returns the sibling's entity_id, or None.
        """
        ent_reg = er.async_get(self.hass)
        entry = ent_reg.async_get(entity_id)
        if not entry or not entry.device_id:
            return None
        for ent in self._battery_entities_of_device(entry.device_id):
            if ent.entity_id == entity_id:
                continue
            if require_usable_state:
                bat_state = self.hass.states.get(ent.entity_id)
                if not bat_state or bat_state.state in ("unavailable", "unknown", None):
                    continue
                if self._parse_battery_state(bat_state.state) is None:
                    continue
            return ent.entity_id
        return None

    def _battery_entities_of_device(self, device_id: str) -> list:
        """Battery entities on a device, NUMERIC ones first.

        A device commonly exposes the same battery twice: a percentage
        (``sensor.x_battery``) and a low-battery flag
        (``binary_sensor.x_low_battery``). Both carry device_class=battery, so
        without an ordering rule different entities of one device resolve to
        different "battery sources" — and the collapse, which treats two distinct
        concrete sources as two genuinely different batteries, splits the device
        into two rows. Ranking the numeric sensor first makes every entity on the
        device agree on one source, so the device collapses to one row, and it is
        also the better source: a binary flag has no level to read.

        Registry order is the tiebreak within each tier, so the choice is stable.
        """
        numeric, binary = [], []
        for ent in er.async_entries_for_device(er.async_get(self.hass), device_id):
            if ent.original_device_class != SensorDeviceClass.BATTERY and (
                ent.device_class != SensorDeviceClass.BATTERY
            ):
                continue
            (binary if ent.entity_id.startswith("binary_sensor.") else numeric).append(ent)
        return numeric + binary

    def _get_battery_from_device_registry(self, entity_id: str) -> int | None:
        """Look up battery level via the device registry (shared sibling selection)."""
        sibling = self._battery_sibling_of(entity_id, require_usable_state=True)
        if sibling is None:
            return None
        bat_state = self.hass.states.get(sibling)
        # Selection already guaranteed a usable, parseable state.
        return self._parse_battery_state(bat_state.state)

    def _get_signal_level(self, entity_id: str) -> int | None:
        """Get signal level from the configured signal sensor for an entity."""
        mapping = self._signal_map.get(entity_id)
        if not mapping:
            return None
        sensor_id = mapping.get("sensor", "")
        if not sensor_id:
            return None
        state = self.hass.states.get(sensor_id)
        if not state or state.state in ("unavailable", "unknown"):
            return None
        try:
            return int(float(state.state))
        except (ValueError, TypeError):
            return None

    def _get_battery_source(self, entity_id: str) -> str | None:
        """Return WHICH sensor supplies this entity's battery (collapse provenance).

        Mirrors _get_battery_level's precedence branch-for-branch so the source always
        matches the value's origin (drift between the two would resurface the wrong-merge
        bug this prevents): own device_class=battery state → own id; explicit map → the
        mapped sensor; own battery_level/battery attribute → own id; a sibling
        device_class=battery entity on the same device → that sibling; the guessed
        ``sensor.<slug>_battery`` entity → that guess. None means "no known source" and
        acts as a wildcard in the collapse meet — so two DISTINCT batteries on one device
        each resolve to a concrete, different id and never wrongly merge into one row.

        Provenance is deliberately NOT gated on the source being currently available
        (unlike the value path, which must clear on unavailable): which sensor supplies
        the battery doesn't change because that sensor blipped unavailable for one poll,
        and a source flipping to None mid-blip would wildcard-merge the row and flap the
        exact identity this collapse stabilizes. So the sibling lookup here is
        availability-blind (``require_usable_state=False``) while the value path's is
        usable-state-gated. On a device with two battery siblings where the first is
        chronically unavailable, source names that first sibling while the value comes
        from the second (usable) one — an accepted cosmetic provenance mismatch, NOT a
        merge hazard: both members of the device compute the same (first) sibling, so the
        row identity stays stable and never flaps.
        """
        # Device-level answer first: every entity of a device must name the SAME
        # source or the collapse splits the device into one row per source. Only
        # entities with no device fall through to naming themselves.
        ent_reg = er.async_get(self.hass)
        reg_entry = ent_reg.async_get(entity_id)
        if reg_entry is not None and reg_entry.device_id:
            candidates = self._battery_entities_of_device(reg_entry.device_id)
            if candidates:
                return candidates[0].entity_id

        state = self.hass.states.get(entity_id)
        if state and state.attributes.get("device_class") == "battery":
            return entity_id
        battery_map = self.entry.data.get(CONF_BATTERY_ENTITY_MAP)
        if battery_map is not None and entity_id in battery_map:
            return battery_map[entity_id] or None
        if (
            state
            and state.attributes
            and (
                state.attributes.get("battery_level") is not None
                or state.attributes.get("battery") is not None
            )
        ):
            return entity_id
        sibling = self._battery_sibling_of(entity_id)
        if sibling is not None:
            return sibling
        parts = entity_id.split(".", 1)
        if len(parts) == 2:  # pragma: no branch
            guessed = f"sensor.{parts[1]}_battery"
            if self.hass.states.get(guessed) is not None:
                return guessed
        return None

    def _get_signal_source(self, entity_id: str) -> str | None:
        """Return WHICH sensor supplies this entity's signal (collapse provenance).

        Signal is map-only, so the source is the mapped sensor id, or None (wildcard).
        """
        if not self._signal_enabled:
            return None
        mapping = self._signal_map.get(entity_id)
        if not mapping:
            return None
        return mapping.get("sensor") or None

    def _signal_unit_of(self, entity_id: str) -> str | None:
        """Return the signal unit for an entity from its mapping, or None."""
        if not self._signal_enabled:
            return None
        mapping = self._signal_map.get(entity_id)
        if not mapping:
            return None
        nt = mapping.get("network_type", "generic")
        return SIGNAL_NETWORK_TYPES.get(nt, SIGNAL_NETWORK_TYPES["generic"])["unit"]

    def _classify_signal(
        self, entity_id: str, level: int, prev: SignalQuality | None = None
    ) -> SignalQuality:
        """Classify signal level as 'good', 'ok', or 'poor' based on network type.

        >= works for both higher-is-better (LQI/%) and lower-is-better (dBm) scales.
        De-jitter, POOR/OK BOUNDARY ONLY: if the entity was already 'poor', the level
        must clear the poor/ok boundary by SIGNAL_HYSTERESIS to leave 'poor', so a level
        resting on that boundary won't flip 'poor' (the sole quality feeding a recorded
        count) every poll. The shift is toward 'ok' on the >= scale for both directions.
        The good/ok boundary is intentionally NOT de-jittered — it feeds no recorded
        count, so a good/ok wobble is display-only, not write amplification.
        """
        mapping = self._signal_map.get(entity_id, {})
        nt = mapping.get("network_type", "generic")
        thresholds = SIGNAL_NETWORK_TYPES.get(nt, SIGNAL_NETWORK_TYPES["generic"])
        if level >= thresholds["good"]:
            return "good"
        ok_threshold = thresholds["ok"]
        if prev == "poor":
            ok_threshold += SIGNAL_HYSTERESIS
        if level >= ok_threshold:
            return "ok"
        return "poor"

    def _poor_signal_entity_ids(self) -> list[str]:
        """Return poor-signal, non-suppressed, essential entity_ids (device-collapsed when active)."""
        return self._representatives_matching(
            lambda d: (
                d.signal_quality == "poor"
                and not d.is_suppressed
                and not d.is_non_essential
            )
        )

    def _poor_signal_ne_entity_ids(self) -> list[str]:
        """Return poor-signal, non-suppressed, non-essential entity_ids (device-collapsed when active)."""
        return self._representatives_matching(
            lambda d: (
                d.signal_quality == "poor"
                and not d.is_suppressed
                and d.is_non_essential
            )
        )

    def _ok_signal_entity_ids(self) -> list[str]:
        """Return ok-signal, non-suppressed, essential entity_ids (device-collapsed when active)."""
        return self._representatives_matching(
            lambda d: (
                d.signal_quality == "ok"
                and not d.is_suppressed
                and not d.is_non_essential
            )
        )
