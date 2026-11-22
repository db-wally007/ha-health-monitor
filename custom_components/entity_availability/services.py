"""Services for Entity Availability."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, SERVICE_RESET_STATISTICS
from .coordinator import EntityAvailabilityCoordinator
from .ignores import DATA_KEY as IGNORE_LOG_KEY  # hm: who ignored what, for the card

_LOGGER = logging.getLogger(__name__)

SERVICE_SUPPRESS = "suppress"
SERVICE_SUPPRESS_INDEFINITELY = "suppress_indefinitely"
SERVICE_UNSUPPRESS = "unsuppress"

ATTR_ENTITY_ID = "entity_id"
ATTR_GROUP = "group"
ATTR_DURATION = "duration"

# hm: entity_id takes one entity or a list - the card ignores a device as all of its
# entities at once, one call and one refresh per group.
SUPPRESS_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTITY_ID): cv.entity_ids,
        vol.Optional(ATTR_GROUP): cv.string,
        vol.Optional(ATTR_DURATION, default=60): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=10080)
        ),
    }
)

UNSUPPRESS_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTITY_ID): cv.entity_ids,
        vol.Optional(ATTR_GROUP): cv.string,
    }
)

SUPPRESS_INDEFINITELY_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTITY_ID): cv.entity_ids,
        vol.Optional(ATTR_GROUP): cv.string,
    }
)

RESET_STATISTICS_SCHEMA = vol.Schema(
    {
        vol.Optional(ATTR_ENTITY_ID): cv.entity_id,
        vol.Optional(ATTR_GROUP): cv.string,
    }
)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Set up services for Entity Availability."""

    if hass.services.has_service(DOMAIN, SERVICE_SUPPRESS):
        return

    def _slug(name: str) -> str:
        return re.sub(r"\s+", "_", name.lower())

    def _matches_group(coordinator: EntityAvailabilityCoordinator, group: str) -> bool:
        coord_slug = _slug(coordinator.group_name)
        return coordinator.entry.entry_id == group or coord_slug == _slug(group)

    def _find_coordinator(group: str):
        """Find coordinator by group name, slug, or config entry ID.

        Returns the FIRST matching coordinator. If two groups share the same
        slug (unlikely but possible), the first one wins.
        """
        for coordinator in hass.data.get(DOMAIN, {}).values():
            if not isinstance(coordinator, EntityAvailabilityCoordinator):
                continue
            if _matches_group(coordinator, group):
                return coordinator
        return None

    def _apply(entity_ids: list[str], group: str | None, action, verb: str) -> list[str]:
        """hm: `action(coordinator, entity_id)` on each entity, in every (named) group that
        monitors it, each group refreshed once. Returns the entities found."""
        found: set[str] = set()
        for coordinator in hass.data.get(DOMAIN, {}).values():
            if not isinstance(coordinator, EntityAvailabilityCoordinator):
                continue
            if group and not _matches_group(coordinator, group):
                continue
            hit = [eid for eid in entity_ids if eid in coordinator.monitored_entities]
            for eid in hit:
                action(coordinator, eid)
            if hit:
                coordinator.async_set_updated_data(coordinator.data)
                found.update(hit)
                _LOGGER.info("%s %s", verb, ", ".join(hit))
        for eid in entity_ids:
            if eid not in found:
                if group:
                    _LOGGER.warning("Entity %s not found in group %s", eid, group)
                else:
                    _LOGGER.warning("Entity %s not found in any monitored group", eid)
        return [eid for eid in entity_ids if eid in found]

    async def _log(call: ServiceCall, kind: str, entity_ids: list[str],
                   until: datetime | None = None, group: str | None = None) -> None:
        """hm: the ignore log - what was ignored or let go, until when, and by whom."""
        log = hass.data.get(IGNORE_LOG_KEY)
        if log is None or (not entity_ids and not group):
            return
        user = None
        if call.context and call.context.user_id:
            found = await hass.auth.async_get_user(call.context.user_id)
            user = found.name if found else None
        log.record(kind, entity_ids, until, user, group)

    async def handle_suppress(call: ServiceCall) -> None:
        """Handle suppress service call."""
        entity_ids = call.data.get(ATTR_ENTITY_ID) or []
        group = call.data.get(ATTR_GROUP)
        duration_minutes = call.data[ATTR_DURATION]
        until = datetime.now(timezone.utc) + timedelta(minutes=duration_minutes)

        if not entity_ids and not group:
            _LOGGER.warning("Either entity_id or group must be provided")
            return

        if group and not entity_ids:
            # Suppress all entities in the named group
            coordinator = _find_coordinator(group)
            if coordinator:
                for eid in coordinator.monitored_entities:
                    coordinator.suppress_entity(eid, until)
                coordinator.async_set_updated_data(coordinator.data)
                _LOGGER.info(
                    "Suppressed all entities in group '%s' until %s",
                    coordinator.group_name,
                    until.isoformat(),
                )
                await _log(call, "ignored", list(coordinator.monitored_entities), until,
                           coordinator.group_name)
            else:
                _LOGGER.warning("Group '%s' not found", group)
            return

        done = _apply(entity_ids, group, lambda c, eid: c.suppress_entity(eid, until),
                      f"Suppressed until {until.isoformat()}:")
        await _log(call, "ignored", done, until)

    async def handle_suppress_indefinitely(call: ServiceCall) -> None:
        """Handle suppress_indefinitely service call."""
        entity_ids = call.data.get(ATTR_ENTITY_ID) or []
        group = call.data.get(ATTR_GROUP)

        if not entity_ids and not group:
            _LOGGER.warning("Either entity_id or group must be provided")
            return

        if group and not entity_ids:
            coordinator = _find_coordinator(group)
            if coordinator:
                for eid in coordinator.monitored_entities:
                    coordinator.suppress_entity(eid, until=None)
                coordinator.async_set_updated_data(coordinator.data)
                _LOGGER.info(
                    "Suppressed all entities in group '%s' indefinitely",
                    coordinator.group_name,
                )
                await _log(call, "ignored", list(coordinator.monitored_entities), None,
                           coordinator.group_name)
            else:
                _LOGGER.warning("Group '%s' not found", group)
            return

        done = _apply(entity_ids, group, lambda c, eid: c.suppress_entity(eid, until=None),
                      "Suppressed indefinitely:")
        await _log(call, "ignored", done, None)

    async def handle_unsuppress(call: ServiceCall) -> None:
        """Handle unsuppress service call."""
        entity_ids = call.data.get(ATTR_ENTITY_ID) or []
        group = call.data.get(ATTR_GROUP)

        if not entity_ids and not group:
            _LOGGER.warning("Either entity_id or group must be provided")
            return

        if group and not entity_ids:
            # Unsuppress all entities in the named group
            coordinator = _find_coordinator(group)
            if coordinator:
                for eid in coordinator.monitored_entities:
                    coordinator.unsuppress_entity(eid)
                coordinator.async_set_updated_data(coordinator.data)
                _LOGGER.info(
                    "Unsuppressed all entities in group '%s'", coordinator.group_name
                )
                await _log(call, "unignored", list(coordinator.monitored_entities), None,
                           coordinator.group_name)
            else:
                _LOGGER.warning("Group '%s' not found", group)
            return

        done = _apply(entity_ids, group, lambda c, eid: c.unsuppress_entity(eid), "Unsuppressed:")
        await _log(call, "unignored", done, None)

    async def handle_reset_statistics(call: ServiceCall) -> None:
        """Handle reset_statistics service call."""
        entity_id = call.data.get(ATTR_ENTITY_ID)
        group = call.data.get(ATTR_GROUP)

        if not entity_id and not group:
            _LOGGER.warning("Either entity_id or group must be provided")
            return

        if group and not entity_id:
            # Reset every entity in the named group
            coordinator = _find_coordinator(group)
            if coordinator:
                coordinator.reset_statistics(None)
                _LOGGER.info(
                    "Reset statistics for all entities in group '%s'",
                    coordinator.group_name,
                )
            else:
                _LOGGER.warning("Group '%s' not found", group)
            return

        found = False
        for coordinator in hass.data.get(DOMAIN, {}).values():
            if not isinstance(coordinator, EntityAvailabilityCoordinator):
                continue
            if group and not _matches_group(coordinator, group):
                continue
            if entity_id in coordinator.monitored_entities:
                coordinator.reset_statistics([entity_id])
                _LOGGER.info("Reset statistics for %s", entity_id)
                found = True

        if not found:
            if group:
                _LOGGER.warning("Entity %s not found in group %s", entity_id, group)
            else:
                _LOGGER.warning("Entity %s not found in any monitored group", entity_id)

    hass.services.async_register(
        DOMAIN, SERVICE_SUPPRESS, handle_suppress, schema=SUPPRESS_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SUPPRESS_INDEFINITELY,
        handle_suppress_indefinitely,
        schema=SUPPRESS_INDEFINITELY_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_UNSUPPRESS, handle_unsuppress, schema=UNSUPPRESS_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_RESET_STATISTICS,
        handle_reset_statistics,
        schema=RESET_STATISTICS_SCHEMA,
    )


@callback
def async_unload_services(hass: HomeAssistant) -> None:
    """Remove services when the last config entry is unloaded."""
    hass.services.async_remove(DOMAIN, SERVICE_SUPPRESS)
    hass.services.async_remove(DOMAIN, SERVICE_SUPPRESS_INDEFINITELY)
    hass.services.async_remove(DOMAIN, SERVICE_UNSUPPRESS)
    hass.services.async_remove(DOMAIN, SERVICE_RESET_STATISTICS)
