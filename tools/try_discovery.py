"""Dry-run the discovery rules against this instance's registries.

Reads the registry .storage files directly and drives the real discovery.resolve(),
so what it prints is what the coordinator would monitor. Safe to run any time — it
touches no state and writes nothing.

    podman exec homeassistant-pod-homeassistant \
        python3 /config/www/ha-health-monitor/tools/try_discovery.py shelly hue bthome
"""

import json
import sys
from types import SimpleNamespace

sys.path.insert(0, "/config/custom_components")

from entity_availability import discovery  # noqa: E402
from entity_availability.const import CONF_SOURCE_INTEGRATIONS  # noqa: E402

STORAGE = "/config/.storage/"


def _load():
    ents = json.load(open(STORAGE + "core.entity_registry"))["data"]["entities"]
    devs = json.load(open(STORAGE + "core.device_registry"))["data"]["devices"]

    entries = {}
    for e in ents:
        entries[e["entity_id"]] = SimpleNamespace(
            entity_id=e["entity_id"],
            platform=e.get("platform"),
            device_id=e.get("device_id"),
            disabled_by=e.get("disabled_by"),
            hidden_by=e.get("hidden_by"),
            entity_category=e.get("entity_category"),
            device_class=e.get("device_class"),
            original_device_class=e.get("original_device_class"),
            labels=set(e.get("labels") or []),
        )

    devices = {}
    for d in devs:
        devices[d["id"]] = SimpleNamespace(
            id=d["id"],
            model=d.get("model"),
            manufacturer=d.get("manufacturer"),
            name=d.get("name"),
            name_by_user=d.get("name_by_user"),
            disabled_by=d.get("disabled_by"),
            via_device_id=d.get("via_device_id"),
            labels=set(d.get("labels") or []),
        )

    ent_reg = SimpleNamespace(entities=entries, async_get=lambda eid: entries.get(eid))
    dev_reg = SimpleNamespace(async_get=lambda did: devices.get(did))
    return ent_reg, dev_reg, devices


def main():
    integrations = sys.argv[1:] or [
        "shelly", "hue", "bthome", "mqtt", "ecowitt_local", "apc_ups_snmp",
        "opensprinkler", "jablotron_cloud", "espsomfy_rts_enhanced", "unifiprotect",
    ]
    ent_reg, dev_reg, devices = _load()
    discovery.er.async_get = lambda hass: ent_reg
    discovery.dr.async_get = lambda hass: dev_reg

    result = discovery.resolve(None, {CONF_SOURCE_INTEGRATIONS: integrations})

    print(f"integrations: {', '.join(integrations)}")
    print(
        f"\nRESOLVED: {len(result.entities)} entities across "
        f"{len(result.devices)} devices\n"
    )

    per_int = {}
    for eid in result.provenance:
        plat = ent_reg.async_get(eid).platform
        d = per_int.setdefault(plat, [0, set()])
        d[0] += 1
        dev = ent_reg.async_get(eid).device_id
        if dev:
            d[1].add(dev)
    print("per integration (entities / devices):")
    for k in sorted(per_int, key=lambda k: -per_int[k][0]):
        n, ds = per_int[k]
        print(f"  {k:24s} {n:5d} / {len(ds):3d}")

    print("\nanchored devices (no primary entity, kept via battery/connectivity):")
    for eid, why in sorted(result.provenance.items()):
        if "anchor:" in why:
            dev = devices.get(ent_reg.async_get(eid).device_id)
            name = (dev.name_by_user or dev.name) if dev else "?"
            print(f"  {name:32s} {eid}")

    print("\nexclusions:")
    for k, v in sorted(result.excluded.items(), key=lambda kv: -kv[1]):
        print(f"  {v:5d}  {k}")


if __name__ == "__main__":
    main()
