"""Constants for the Entity Availability integration."""

from typing import Literal

DOMAIN = "entity_availability"

SignalQuality = Literal["good", "ok", "poor"]

# Config flow
CONF_GROUP_NAME = "group_name"
CONF_ENTITIES = "entities"
CONF_BAD_STATES = "bad_states"
CONF_COOLDOWN = "cooldown"
CONF_STALENESS_THRESHOLD = "staleness_threshold"
CONF_STALENESS_USE_LAST_UPDATED = "staleness_use_last_updated"
CONF_BATTERY_THRESHOLD = "battery_threshold"
CONF_BATTERY_ENTITY_MAP = "battery_entity_map"
CONF_SIGNAL_ENABLED = "signal_enabled"
CONF_SIGNAL_ENTITY_MAP = "signal_entity_map"
CONF_AVAILABILITY_WINDOWS = "availability_windows"
CONF_USE_DEVICE_NAMES = "use_device_names"
CONF_COLLAPSE_DEVICES = "collapse_devices"
CONF_NON_ESSENTIAL_ENTITIES = "non_essential_entities"

# Discovery — rule-based membership instead of a hand-picked entity list.
# See discovery.py. CONF_ENTITIES stays the resolved result, so every downstream
# consumer (sensors, card, storage) is unchanged whichever mode a group uses.
CONF_SOURCE_MODE = "source_mode"
SOURCE_MODE_MANUAL = "manual"
SOURCE_MODE_DISCOVERY = "discovery"
DEFAULT_SOURCE_MODE = SOURCE_MODE_MANUAL

CONF_SOURCE_INTEGRATIONS = "source_integrations"
CONF_SOURCE_MANUFACTURERS = "source_manufacturers"
CONF_INCLUDE_LABELS = "include_labels"
CONF_EXCLUDE_LABELS = "exclude_labels"
CONF_INCLUDE_ENTITIES = "include_entities"
CONF_EXCLUDE_ENTITIES = "exclude_entities"
CONF_EXCLUDE_DEVICES = "exclude_devices"
CONF_INCLUDE_DIAGNOSTIC = "include_diagnostic"

# Auto-bind battery/signal from device-registry siblings instead of the per-entity
# mapping forms. Those forms render one row per monitored entity, which is unusable
# once discovery resolves hundreds.
CONF_BATTERY_AUTO = "battery_auto"
CONF_SIGNAL_AUTO = "signal_auto"

# A device is only offline once ALL of its entities are unavailable. Some devices
# expose capabilities they never report (Z-Wave), and some expose features the user
# turned off upstream (UniFi Protect smart detections disabled in the Protect app) —
# those entities sit unavailable forever while the device is perfectly healthy.
# Ported from ha-connection-observer (MIT).
CONF_OFFLINE_REQUIRES_ALL = "offline_requires_all"
DEFAULT_OFFLINE_REQUIRES_ALL = True

# A Bluetooth device not heard for this long is offline — the same 15 minutes Home
# Assistant itself uses (FALLBACK_MAXIMUM_STALE_ADVERTISEMENT_SECONDS). Needed because
# HA skips that check for devices that flag themselves "sleepy" (send only on change),
# which Shelly BLU door/window and H&T sensors do even with periodic beacons enabled —
# without this they keep showing their last state forever once dead.
BLE_SILENT_AFTER = 15 * 60  # seconds

# Automations and scripts are also checked for FAILED RUNS, read from Home Assistant's
# own traces (jobs.py) — automatic, no configuration, same rule for every one.
JOB_DOMAINS = ("automation", "script")

# Entities whose state is an action or an announcement, not a condition. A button is
# "unknown" until first pressed; an event entity until first fired. Treating either as
# unavailable manufactures permanent false positives.
STATELESS_DOMAINS = frozenset(
    {
        "button",
        "scene",
        "event",
        "update",
        "image",
        "notify",
        "conversation",
        "tts",
        "stt",
    }
)

# Group containers that the integration registers as devices. Hue Rooms and Zones
# aggregate real lights that are already monitored individually.
PSEUDO_DEVICE_MODELS = frozenset({"Room", "Zone"})

# Integration domain -> signal network type, for auto-binding a signal sensor to the
# right thresholds in SIGNAL_NETWORK_TYPES below. Anything unlisted falls back to
# "generic" (dBm).
PLATFORM_SIGNAL_TYPES: dict[str, str] = {
    "shelly": "wifi",
    "esphome": "wifi",
    "tasmota": "wifi",
    "unifi": "wifi",
    "unifiprotect": "wifi",
    "bthome": "bluetooth",
    "bluetooth": "bluetooth",
    "hue": "zigbee_lqi",
    "zha": "zigbee_lqi",
    "deconz": "zigbee_lqi",
    "zwave_js": "zwave",
    "matter": "thread",
    "otbr": "thread",
}

# Entry types
CONF_ENTRY_TYPE = "entry_type"
ENTRY_TYPE_GROUP = "group"
ENTRY_TYPE_COMBINED = "combined_group"
# UI-only choice on the first step. A discovery group is stored as ENTRY_TYPE_GROUP
# with CONF_SOURCE_MODE=discovery, so every consumer of entry_type is unaffected.
ENTRY_TYPE_DISCOVERY = "discovery_group"
CONF_COMBINED_GROUPS = "combined_groups"

# Defaults
DEFAULT_NAME = "Entity Availability"
DEFAULT_BAD_STATES = ["unavailable", "unknown"]
DEFAULT_COOLDOWN = 60  # seconds
DEFAULT_STALENESS_THRESHOLD = 0  # disabled
DEFAULT_STALENESS_USE_LAST_UPDATED = False  # last_changed preserves prior behavior
DEFAULT_BATTERY_THRESHOLD = 20  # percent
DEFAULT_SIGNAL_ENABLED = False
DEFAULT_AVAILABILITY_WINDOWS = ["today", "7d"]
DEFAULT_USE_DEVICE_NAMES = False
DEFAULT_COLLAPSE_DEVICES = False

# De-jitter dead-bands: a flag flips ON at its threshold but only flips back OFF
# once the reading clears the threshold by this margin. Stops a reading sitting on
# a boundary (battery at the %, staleness age at the minute, signal at the dBm)
# from oscillating the flag — and its recorded count attr — every poll.
BATTERY_HYSTERESIS = 3  # percent above threshold to clear a low-battery flag
STALENESS_HYSTERESIS = 1  # minutes below threshold to clear a stale flag
SIGNAL_HYSTERESIS = 3  # units toward "ok" to clear a poor-signal flag

# Signal strength thresholds per network type.
# Each entry: {"label": str, "unit": str, "good": int, "ok": int, "higher_is_better": bool}
# higher_is_better=False (dBm): level >= good → green; level >= ok → yellow; below ok → red
# higher_is_better=True  (LQI/%): level >= good → green; level >= ok → yellow; below ok → red
# To add a new type: append an entry here — the config flow, coordinator, and card pick it up automatically.
SIGNAL_NETWORK_TYPES: dict[str, dict[str, int | str | bool]] = {
    "5g": {
        "label": "5G",
        "unit": "dBm",
        "good": -80,
        "ok": -100,
        "higher_is_better": False,
    },
    "bluetooth": {
        "label": "Bluetooth",
        "unit": "dBm",
        "good": -70,
        "ok": -85,
        "higher_is_better": False,
    },
    "generic": {
        "label": "Generic/RSSI",
        "unit": "dBm",
        "good": -60,
        "ok": -80,
        "higher_is_better": False,
    },
    "lorawan": {
        "label": "LoRaWAN",
        "unit": "dBm",
        "good": -100,
        "ok": -115,
        "higher_is_better": False,
    },
    "lte": {
        "label": "LTE/4G",
        "unit": "dBm",
        "good": -80,
        "ok": -90,
        "higher_is_better": False,
    },
    "percent": {
        "label": "Percentage",
        "unit": "%",
        "good": 70,
        "ok": 40,
        "higher_is_better": True,
    },
    "thread": {
        "label": "Thread",
        "unit": "dBm",
        "good": -70,
        "ok": -85,
        "higher_is_better": False,
    },
    "wifi": {
        "label": "Wi-Fi",
        "unit": "dBm",
        "good": -67,
        "ok": -80,
        "higher_is_better": False,
    },
    "zigbee_lqi": {
        "label": "Zigbee (LQI)",
        "unit": "LQI",
        "good": 201,
        "ok": 51,
        "higher_is_better": True,
    },
    "zigbee_rssi": {
        "label": "Zigbee (RSSI/dBm)",
        "unit": "dBm",
        "good": -70,
        "ok": -85,
        "higher_is_better": False,
    },
    "zwave": {
        "label": "Z-Wave",
        "unit": "dBm",
        "good": -70,
        "ok": -85,
        "higher_is_better": False,
    },
}
AVAILABLE_WINDOWS = ["today", "3d", "5d", "7d"]

# Storage
STORAGE_VERSION = 1
STORAGE_KEY_PREFIX = "entity_availability"
BUCKET_INTERVAL = 300  # 5 minutes per bucket
BUCKETS_MAX = 2016  # 7 days * 24 hours * 12 buckets/hour

# Update interval for coordinator
SCAN_INTERVAL = 30  # seconds

# Grace period after HA startup before new offline transitions are allowed
STARTUP_GRACE_PERIOD = 60  # seconds

# Recovery window for recently_recovered / recently_offline sensors
CONF_RECOVERY_WINDOW = "recovery_window"
DEFAULT_RECOVERY_WINDOW = 5  # minutes

# Services
SERVICE_RESET_STATISTICS = "reset_statistics"

# Bus events fired on entity availability transitions
EVENT_OFFLINE = "entity_availability_offline"
EVENT_RECOVERED = "entity_availability_recovered"
EVENT_LOW_BATTERY = "entity_availability_low_battery"
EVENT_BATTERY_OK = "entity_availability_battery_ok"
EVENT_STALE = "entity_availability_stale"
EVENT_STALE_RECOVERED = "entity_availability_stale_recovered"
EVENT_POOR_SIGNAL = "entity_availability_poor_signal"
EVENT_SIGNAL_OK = "entity_availability_signal_ok"
EVENT_JOB_FAILED = "entity_availability_job_failed"
EVENT_JOB_RECOVERED = "entity_availability_job_recovered"

# Sentinel area name for entities with no HA area assigned.
# Parentheses signal "not a real area" and avoid colliding with user-created area names.
NO_AREA_SENTINEL = "(No Area)"
