"""Remove entities from the Home Assistant entity registry.

Deleting the YAML that defined an entity does not remove its registry entry — the
entity lingers as ``unavailable`` forever, cluttering pickers and (now) showing up
in health monitoring as a permanently offline thing. This clears those out.

Only ever pass ids you have confirmed are orphaned: a registry entry that still has
a live integration behind it will simply be recreated, and for some integrations
removing it is destructive.

Reads entity ids on stdin, one per line.

    podman exec -i -e HA_TOKEN=... -e HA_URL=http://localhost:8123 \
        homeassistant-pod-homeassistant \
        python3 /config/www/ha-health-monitor/tools/remove_entities.py < ids.txt
"""

import asyncio
import os
import sys

import aiohttp

URL = os.environ.get("HA_URL", "http://localhost:8123")
TOKEN = os.environ["HA_TOKEN"]


async def main() -> None:
    ids = [line.strip() for line in sys.stdin if line.strip()]
    if not ids:
        print("nothing to do")
        return

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(f"{URL}/api/websocket") as ws:
            await ws.receive_json()
            await ws.send_json({"type": "auth", "access_token": TOKEN})
            if (await ws.receive_json()).get("type") != "auth_ok":
                print("AUTH FAILED")
                return

            msg_id = 0
            ok = failed = 0
            for entity_id in ids:
                msg_id += 1
                await ws.send_json({
                    "id": msg_id,
                    "type": "config/entity_registry/remove",
                    "entity_id": entity_id,
                })
                while True:
                    resp = await ws.receive_json()
                    if resp.get("id") == msg_id:
                        break
                if resp.get("success"):
                    ok += 1
                    print(f"  removed  {entity_id}")
                else:
                    failed += 1
                    print(f"  FAILED   {entity_id}: {(resp.get('error') or {}).get('message', resp)}")
            print(f"\n{ok} removed, {failed} failed")


if __name__ == "__main__":
    asyncio.run(main())
