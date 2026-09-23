"""Rule-based discovery of the monitored entity set.

Upstream Entity Availability takes a static list of entity_ids chosen in the config
flow. That does not scale: every new device has to be added by hand, and there is no
way to say "watch everything Shelly". This module resolves the list from *rules*
instead — pick integrations, labels or manufacturers once, and devices added later are
covered automatically.

The approach is borrowed from ha-connection-observer (MIT), which matches
``entity_registry_entry.platform`` against a set of selected integration domains. The
difference is that Observer applies that test per state-change event and never
materialises a set, so it cannot tell you what it is watching. Here the set is
computed explicitly, which is what makes an inventory sensor, a dashboard and
per-device history possible.

Three rules in here are not obvious and were derived from a real registry:

* ``entity_category is None`` — primary entities only. On one Shelly install this
  alone drops 162 diagnostic + 65 config entities. Battery and RSSI sensors are
  diagnostic, so they are deliberately *not* monitored as rows; they bind to their
  device's primary entity as a battery/signal source instead.
* Pseudo-device models (Hue ``Room`` / ``Zone``) are group containers, not hardware.
  Monitoring them double-counts the lights they contain and flags "offline" for
  something that was never online.
* Anchor fallback — a device whose every entity is diagnostic or stateless would
  vanish entirely under the two rules above. Hue battery switches (only ``event.*``
  plus a diagnostic battery sensor) and hub devices such as a Shelly power strip
  parent are exactly this shape, and they are devices you very much want to watch.
  They are anchored on their battery or connectivity sensor instead.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import (
    CONF_EXCLUDE_DEVICES,
    CONF_EXCLUDE_ENTITIES,
    CONF_EXCLUDE_LABELS,
    CONF_INCLUDE_DIAGNOSTIC,
    CONF_INCLUDE_ENTITIES,
    CONF_INCLUDE_LABELS,
    CONF_SOURCE_INTEGRATIONS,
    CONF_SOURCE_MANUFACTURERS,
    PSEUDO_DEVICE_MODELS,
    STATELESS_DOMAINS,
)

_LOGGER = logging.getLogger(__name__)

# device_class values usable as an availability anchor for a device that owns no
# primary entity. Ordered by preference: a battery sensor is the most reliable proof
# of life for a sleepy battery device, a connectivity sensor for a mains hub.
_ANCHOR_DEVICE_CLASSES = ("battery", "connectivity", "signal_strength")


@dataclass
class DiscoveryResult:
    """The resolved monitored set plus why each entity is in it."""

    entities: list[str] = field(default_factory=list)
    # entity_id -> short human-readable reason ("integration: shelly", "anchor: battery")
    provenance: dict[str, str] = field(default_factory=dict)
    # device_id -> display name, for every device contributing at least one entity
    devices: dict[str, str] = field(default_factory=dict)
    # reason -> count, for the inventory sensor's "what did you skip and why"
    excluded: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        """Record one exclusion against a reason bucket."""
        self.excluded[reason] = self.excluded.get(reason, 0) + 1


def _device_class_of(entry: er.RegistryEntry) -> str | None:
    """Return the effective device_class, preferring a user override."""
    return entry.device_class or entry.original_device_class


def _is_primary(entry: er.RegistryEntry, include_diagnostic: bool) -> bool:
    """True when this entity is a device's own state, not config or telemetry."""
    if entry.entity_id.split(".", 1)[0] in STATELESS_DOMAINS:
        return False
    if entry.entity_category is None:
        return True
    # Opt-in: treat diagnostic entities as monitorable too. Config entities are never
    # primary — they are settings, and a setting cannot be "offline".
    return include_diagnostic and entry.entity_category == "diagnostic"


def _anchor_rank(entry: er.RegistryEntry) -> int | None:
    """Preference rank for using this entity as a device's availability anchor."""
    dc = _device_class_of(entry)
    if dc in _ANCHOR_DEVICE_CLASSES:
        return _ANCHOR_DEVICE_CLASSES.index(dc)
    return None


def resolve(hass: HomeAssistant, cfg: dict) -> DiscoveryResult:
    """Resolve the monitored entity set from the discovery rules in ``cfg``.

    Pure read of the entity and device registries — no state machine access, so it is
    safe to call during setup and from a registry-updated callback.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)

    integrations: set[str] = set(cfg.get(CONF_SOURCE_INTEGRATIONS, []) or [])
    manufacturers: list[str] = [
        m.lower() for m in (cfg.get(CONF_SOURCE_MANUFACTURERS, []) or [])
    ]
    include_labels: set[str] = set(cfg.get(CONF_INCLUDE_LABELS, []) or [])
    exclude_labels: set[str] = set(cfg.get(CONF_EXCLUDE_LABELS, []) or [])
    include_entities: set[str] = set(cfg.get(CONF_INCLUDE_ENTITIES, []) or [])
    exclude_entities: set[str] = set(cfg.get(CONF_EXCLUDE_ENTITIES, []) or [])
    exclude_devices: set[str] = set(cfg.get(CONF_EXCLUDE_DEVICES, []) or [])
    include_diagnostic: bool = bool(cfg.get(CONF_INCLUDE_DIAGNOSTIC, False))

    result = DiscoveryResult()

    # device_id -> (primary entries, anchor candidates)
    by_device: dict[str, tuple[list, list]] = {}
    # entities with no device at all — judged on their own
    orphans: list = []

    for entry in ent_reg.entities.values():
        eid = entry.entity_id

        if eid in exclude_entities:
            result.skip("explicitly excluded")
            continue
        if entry.disabled_by is not None:
            result.skip("disabled in the registry")
            continue
        if entry.hidden_by is not None:
            result.skip("hidden in the registry")
            continue

        device = dev_reg.async_get(entry.device_id) if entry.device_id else None

        if device is not None:
            if device.disabled_by is not None:
                result.skip("device disabled")
                continue
            if device.id in exclude_devices:
                result.skip("device explicitly excluded")
                continue
            if device.model in PSEUDO_DEVICE_MODELS:
                # Hue Room/Zone and friends: a group container wearing a device's
                # clothes. Its "state" is an aggregate of real devices already watched.
                result.skip(f"pseudo-device ({device.model})")
                continue
            if exclude_labels & (device.labels or set()):
                result.skip("device carries an exclude label")
                continue

        if exclude_labels & (entry.labels or set()):
            result.skip("entity carries an exclude label")
            continue

        # --- selection: any one rule is enough -------------------------------------
        selected_by: str | None = None
        if eid in include_entities:
            selected_by = "explicitly included"
        elif entry.platform in integrations:
            selected_by = f"integration: {entry.platform}"
        elif include_labels & (entry.labels or set()):
            selected_by = "label"
        elif device is not None and include_labels & (device.labels or set()):
            selected_by = "device label"
        elif device is not None and device.manufacturer and manufacturers:
            mfr = device.manufacturer.lower()
            if any(m in mfr for m in manufacturers):
                selected_by = f"manufacturer: {device.manufacturer}"

        if selected_by is None:
            result.skip("no rule matched")
            continue

        if device is None:
            if _is_primary(entry, include_diagnostic):
                orphans.append((entry, selected_by))
            else:
                result.skip("not a primary entity")
            continue

        primaries, anchors = by_device.setdefault(device.id, ([], []))
        if _is_primary(entry, include_diagnostic):
            primaries.append((entry, selected_by))
        elif _anchor_rank(entry) is not None:
            anchors.append((entry, selected_by))
        else:
            result.skip("not a primary entity")

    # --- materialise -------------------------------------------------------------
    for device_id, (primaries, anchors) in by_device.items():
        device = dev_reg.async_get(device_id)
        name = (device.name_by_user or device.name or device_id) if device else device_id

        if primaries:
            for entry, why in primaries:
                result.entities.append(entry.entity_id)
                result.provenance[entry.entity_id] = why
            result.devices[device_id] = name
            continue

        if not anchors:
            result.skip("device has no monitorable entity")
            continue

        # Anchor fallback. Take the single best candidate, not all of them: the point
        # is to keep the device visible as one row, not to add its whole telemetry.
        anchors.sort(key=lambda pair: _anchor_rank(pair[0]))
        entry, why = anchors[0]
        result.entities.append(entry.entity_id)
        result.provenance[entry.entity_id] = (
            f"{why} (anchor: {_device_class_of(entry)})"
        )
        result.devices[device_id] = name
        result.skip("device anchored on a diagnostic entity")

    for entry, why in orphans:
        result.entities.append(entry.entity_id)
        result.provenance[entry.entity_id] = f"{why} (no device)"

    result.entities.sort()
    _LOGGER.debug(
        "Discovery resolved %d entities across %d devices (%d exclusions)",
        len(result.entities),
        len(result.devices),
        sum(result.excluded.values()),
    )
    return result


def available_integrations(hass: HomeAssistant) -> dict[str, int]:
    """Return {integration domain -> entity count} for integrations present here.

    Feeds the config flow's picker so it only offers integrations that actually exist
    on this instance, with a count so the user can see what selecting one would pull
    in. Counts primary, enabled entities — the same population ``resolve`` would take.
    """
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    counts: dict[str, int] = {}
    for entry in ent_reg.entities.values():
        if entry.disabled_by is not None or entry.hidden_by is not None:
            continue
        if not _is_primary(entry, False):
            continue
        if entry.device_id:
            device = dev_reg.async_get(entry.device_id)
            if device is not None and device.model in PSEUDO_DEVICE_MODELS:
                continue
        counts[entry.platform] = counts.get(entry.platform, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
