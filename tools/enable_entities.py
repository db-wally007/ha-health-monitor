"""Enable disabled registry entities over the HA websocket API.

Shelly and BTHome ship RSSI sensors disabled by default, and Shelly power-strip
parents ship their whole diagnostic set disabled — which leaves the strip with no
entity that can anchor it and its outlets with no radio to read. Enabling them is
what turns signal monitoring on for real.

Reads entity ids on stdin, one per line. Prints what it changed.

    podman exec -i -e HA_TOKEN=... -e HA_URL=http://localhost:8123 \
        homeassistant-pod-homeassistant \
        python3 /config/www/ha-health-monitor/tools/enable_entities.py < ids.txt
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
            await ws.receive_json()  # auth_required
            await ws.send_json({"type": "auth", "access_token": TOKEN})
            auth = await ws.receive_json()
            if auth.get("type") != "auth_ok":
                print("AUTH FAILED:", auth)
                return

            msg_id = 0
            ok = failed = 0
            for entity_id in ids:
                msg_id += 1
                await ws.send_json(
                    {
                        "id": msg_id,
                        "type": "config/entity_registry/update",
                        "entity_id": entity_id,
                        "disabled_by": None,
                    }
                )
                while True:
                    resp = await ws.receive_json()
                    if resp.get("id") == msg_id:
                        break
                if resp.get("success"):
                    ok += 1
                    print(f"  enabled  {entity_id}")
                else:
                    failed += 1
                    err = (resp.get("error") or {}).get("message", resp)
                    print(f"  FAILED   {entity_id}: {err}")
            print(f"\n{ok} enabled, {failed} failed")


if __name__ == "__main__":
    asyncio.run(main())
