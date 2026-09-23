"""Availability storage using 5-minute buckets."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from .const import BUCKET_INTERVAL, BUCKETS_MAX

_LOGGER = logging.getLogger(__name__)


class AvailabilityBucket:
    """One 5-minute interval of availability data for a device."""

    __slots__ = ("interval_start", "online_seconds", "total_seconds")

    def __init__(self, interval_start: datetime, online_seconds: float = 0.0) -> None:
        """Initialize bucket."""
        self.interval_start = interval_start
        self.online_seconds = online_seconds
        self.total_seconds = float(BUCKET_INTERVAL)


class AvailabilityStorage:
    """Manages 5-minute availability buckets per device."""

    def __init__(self) -> None:
        """Initialize storage."""
        self._buckets: dict[str, list[AvailabilityBucket]] = {}

    @property
    def buckets(self) -> dict[str, list[AvailabilityBucket]]:
        """Return the buckets."""
        return self._buckets

    def reset(self, entity_ids: list[str] | None = None) -> None:
        """Drop availability buckets. entity_ids=None clears everything."""
        if entity_ids is None:
            self._buckets.clear()
        else:
            for eid in entity_ids:
                self._buckets.pop(eid, None)

    def _get_interval_start(self, now: datetime) -> datetime:
        """Get the start of the current 5-minute interval."""
        minute = (now.minute // 5) * 5
        return now.replace(minute=minute, second=0, microsecond=0)

    def get_or_create_bucket(self, entity_id: str, now: datetime) -> AvailabilityBucket:
        """Get the current interval's bucket, creating it if needed."""
        if entity_id not in self._buckets:
            self._buckets[entity_id] = []

        interval_start = self._get_interval_start(now)
        buckets = self._buckets[entity_id]

        if buckets and buckets[-1].interval_start == interval_start:
            return buckets[-1]

        bucket = AvailabilityBucket(interval_start=interval_start)
        buckets.append(bucket)
        _LOGGER.debug(
            "New bucket for %s at %s (total=%d)",
            entity_id,
            interval_start,
            len(buckets),
        )

        while len(buckets) > BUCKETS_MAX:
            buckets.pop(0)
            _LOGGER.debug(
                "Pruned oldest bucket for %s (now %d)", entity_id, len(buckets)
            )

        return bucket

    def record_online(self, entity_id: str, seconds: float, now: datetime) -> None:
        """Record online seconds for the current interval."""
        if seconds <= 0:
            return
        bucket = self.get_or_create_bucket(entity_id, now)
        remaining = bucket.total_seconds - bucket.online_seconds
        bucket.online_seconds += min(seconds, remaining)

    def record_offline(self, entity_id: str, seconds: float, now: datetime) -> None:
        """Record offline seconds (ensures bucket exists; offline is implicit)."""
        if seconds <= 0:
            return
        self.get_or_create_bucket(entity_id, now)

    def get_availability(
        self, entity_id: str, window: str, now: datetime
    ) -> float | None:
        """Calculate availability % for a time window.

        Returns None if insufficient data.
        """
        if entity_id not in self._buckets or not self._buckets[entity_id]:
            return None

        if window == "today":
            # Rolling 24h window — timezone-agnostic and consistent across DST changes.
            cutoff = now - timedelta(hours=24)
        else:
            window_hours = self._window_to_hours(window)
            cutoff = now - timedelta(hours=window_hours)

        relevant_buckets = [
            b for b in self._buckets[entity_id] if b.interval_start >= cutoff
        ]

        if not relevant_buckets:
            _LOGGER.debug(
                "No buckets in window '%s' for %s (cutoff=%s)",
                window,
                entity_id,
                cutoff,
            )
            return None

        # Require at least 1 bucket for "today", 10% for longer windows
        if window == "today":
            min_required = 1
        else:
            expected_buckets = window_hours * 12  # 12 buckets per hour
            min_required = max(1, int(expected_buckets * 0.1))
        if len(relevant_buckets) < min_required:
            return None

        total_online = sum(b.online_seconds for b in relevant_buckets)
        total_time = sum(b.total_seconds for b in relevant_buckets)

        if total_time == 0:
            return None

        return round((total_online / total_time) * 100, 1)

    def get_entity_availability(
        self, entity_id: str, windows: list[str], now: datetime
    ) -> dict[str, float | None]:
        """Get availability for all configured windows."""
        return {w: self.get_availability(entity_id, w, now) for w in windows}

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict for storage — run-length encoded, integer seconds.

        The naive encoding (one ``{"s": <ISO timestamp>, "o": <float>}`` object per
        entity per 5 minutes) costs ~46 bytes to say "this thing was up", and at a few
        hundred entities over a 7-day window that is tens of megabytes rewritten in
        full every 5 minutes. The timestamp is the expensive part and it is entirely
        derivable: buckets are consecutive 5-minute slots, so one slot number per
        *contiguous run* plus a flat list of values reconstructs every timestamp.

        Runs (rather than one list per entity) are what preserves gaps. A gap means
        "we were not observing" — usually Home Assistant was down — and it must not be
        confused with "observed and online", which would invent uptime that never
        happened.

        ``online_seconds`` is rounded to whole seconds. The underlying figure is
        already approximate (it accrues per coordinator tick, which does not align to
        bucket boundaries), and rounding is unbiased, so the ≤0.5 s per 300 s error
        does not systematically push availability up or down.

        Format: ``{entity_id: [[first_slot, [secs, secs, ...]], ...]}`` where
        ``slot = epoch_seconds // BUCKET_INTERVAL``.
        """
        result: dict[str, Any] = {}
        for entity_id, buckets in self._buckets.items():
            if not buckets:
                continue
            runs: list[list[Any]] = []
            run_start: int | None = None
            values: list[int] = []
            prev_slot: int | None = None
            for b in buckets:
                slot = int(b.interval_start.timestamp()) // BUCKET_INTERVAL
                if prev_slot is not None and slot == prev_slot + 1:
                    values.append(round(b.online_seconds))
                else:
                    if run_start is not None:
                        runs.append([run_start, values])
                    run_start = slot
                    values = [round(b.online_seconds)]
                prev_slot = slot
            if run_start is not None:
                runs.append([run_start, values])
            result[entity_id] = runs
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AvailabilityStorage:
        """Deserialize from dict, accepting the legacy per-bucket format too.

        Reads both encodings so an existing store loads unchanged and is rewritten
        compactly on the next save — no migration step, no history lost.
        """
        storage = cls()
        for entity_id, payload in data.items():
            buckets: list[AvailabilityBucket] = []
            if not isinstance(payload, list) or not payload:
                storage._buckets[entity_id] = buckets
                continue

            if isinstance(payload[0], dict):
                # Legacy: [{"s": <ISO>, "o": <float>}, ...]
                for b in payload:
                    try:
                        online = float(b["o"])
                        interval_start = datetime.fromisoformat(b["s"])
                        if interval_start.tzinfo is None:
                            interval_start = interval_start.replace(tzinfo=timezone.utc)
                        buckets.append(
                            AvailabilityBucket(
                                interval_start=interval_start,
                                online_seconds=min(online, float(BUCKET_INTERVAL)),
                            )
                        )
                    except (KeyError, ValueError, TypeError):
                        continue
            else:
                # Compact: [[first_slot, [secs, ...]], ...]
                for run in payload:
                    try:
                        first_slot = int(run[0])
                        values = run[1]
                    except (IndexError, TypeError, ValueError):
                        continue
                    for offset, online in enumerate(values):
                        try:
                            seconds = min(float(online), float(BUCKET_INTERVAL))
                        except (TypeError, ValueError):
                            continue
                        buckets.append(
                            AvailabilityBucket(
                                interval_start=datetime.fromtimestamp(
                                    (first_slot + offset) * BUCKET_INTERVAL,
                                    timezone.utc,
                                ),
                                online_seconds=seconds,
                            )
                        )
            storage._buckets[entity_id] = buckets
        return storage

    @staticmethod
    def _window_to_hours(window: str) -> int:
        """Convert window string to hours."""
        if window == "today":
            return 24
        if window == "3d":
            return 72
        if window == "5d":
            return 120
        if window == "7d":
            return 168
        _LOGGER.warning("Unknown availability window '%s', defaulting to 24h", window)
        return 24
