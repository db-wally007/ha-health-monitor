import json
import os
import threading
from types import SimpleNamespace

from custom_components.entity_availability import coordinator
from custom_components.entity_availability.coordinator import _CacheStore


def _store(tmp_path):
    hass = SimpleNamespace(config=SimpleNamespace(path=lambda *p: str(tmp_path.joinpath(*p))))
    return _CacheStore(hass, 1, "k")


def test_a_save_round_trips(tmp_path):
    store = _store(tmp_path)
    store._save({"a": 1})
    assert store._load() == {"a": 1}
    assert not os.path.exists(f"{store.path}.tmp")


def test_two_saves_at_once_do_not_trip_over_each_other(tmp_path, monkeypatch):
    # An options change unloads the entry (final save) while a periodic save may still be
    # running in the executor: both wrote the one `.json.tmp`, and whichever renamed second
    # found it gone (FileNotFoundError -> a HASS Global Errors alert).
    store = _store(tmp_path)
    real_replace = os.replace
    meet = threading.Barrier(2)

    def replace_when_both_have_written(src, dst):
        try:
            meet.wait(timeout=1)       # without the lock both threads get here
        except threading.BrokenBarrierError:
            pass                       # with it the second one is still waiting its turn
        return real_replace(src, dst)

    monkeypatch.setattr(coordinator.os, "replace", replace_when_both_have_written)

    errors = []

    def save(n):
        try:
            store._save({"n": n})
        except Exception as err:  # noqa: BLE001
            errors.append(err)

    threads = [threading.Thread(target=save, args=(n,)) for n in (1, 2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    with open(store.path, encoding="utf-8") as handle:
        assert json.load(handle)["data"]["n"] in (1, 2)
    assert not os.path.exists(f"{store.path}.tmp")
