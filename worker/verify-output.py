#!/usr/bin/env python3
"""Validate a real worker output without any third-party Python dependencies."""
import collections
import json
import math
import sys


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


with open(sys.argv[1], encoding="utf-8") as stream:
    replay = json.load(stream)
assert replay["schemaVersion"] == 1
assert replay["parser"] == {"name": "clarity", "version": "4.0.1"}
assert replay["coordinateSystem"] == "dota-world"
assert replay["matchId"] is None or isinstance(replay["matchId"], str)
assert replay["matchStartTime"] is None or (
    isinstance(replay["matchStartTime"], int) and not isinstance(replay["matchStartTime"], bool)
    and replay["matchStartTime"] > 0
)
assert replay["patch"] is None or isinstance(replay["patch"], str)
assert finite(replay["sampleInterval"]) and replay["sampleInterval"] > 0
assert replay["frames"], "A successful replay must include real hero frames"
last = -1
heroes = set()
nonnull = collections.Counter()
for frame in replay["frames"]:
    assert finite(frame["time"]) and frame["time"] > last
    last = frame["time"]
    assert frame["heroes"]
    ids = [hero["id"] for hero in frame["heroes"]]
    assert len(set(ids)) == len(ids), "Duplicate hero IDs in a frame"
    for hero in frame["heroes"]:
        heroes.add(hero["id"])
        assert hero["team"] in ("radiant", "dire")
        assert isinstance(hero["name"], str)
        assert hero["level"] is None or (
            isinstance(hero["level"], int) and not isinstance(hero["level"], bool) and hero["level"] >= 0
        )
        for key in ("x", "y", "hp", "maxHp", "mana", "maxMana"):
            assert hero[key] is None or finite(hero[key]), (key, hero[key])
            nonnull[key] += hero[key] is not None
        assert hero["alive"] is None or isinstance(hero["alive"], bool)
        assert hero["effects"] is None or isinstance(hero["effects"], list)
        for key, scalar in (("abilities", "level"), ("items", "charges")):
            assert isinstance(hero[key], list)
            for state in hero[key]:
                assert isinstance(state["name"], str) and state["name"]
                assert state[scalar] is None or finite(state[scalar])
                assert state["cooldown"] is None or (finite(state["cooldown"]) and state["cooldown"] >= 0)
    for category in ("towers", "trees"):
        observed = frame.get(category)
        if observed is None:
            continue
        assert isinstance(observed, list)
        assert len({entity["id"] for entity in observed}) == len(observed)
        for entity in observed:
            assert isinstance(entity["id"], str)
            for key in ("x", "y", "z"):
                assert entity[key] is None or finite(entity[key])
            assert entity["alive"] is None or isinstance(entity["alive"], bool)
            if category == "towers":
                assert entity["team"] in ("radiant", "dire")
                assert isinstance(entity["name"], str)
                for key in ("hp", "maxHp"):
                    assert entity[key] is None or finite(entity[key])
last = -1
for event in replay["events"]:
    assert finite(event["time"]) and event["time"] >= last
    last = event["time"]
    assert event["type"] in ("death", "damage", "ability", "item", "modifier")
    for key in ("actorId", "targetId", "ability"):
        assert event[key] is None or isinstance(event[key], str)
    assert event["value"] is None or finite(event["value"])
    assert isinstance(event["description"], str) and event["description"]
    if event["type"] == "death":
        assert event["targetId"] in heroes, "Deaths must refer to observed real heroes"
assert isinstance(replay["limitations"], list)
assert all(isinstance(item, str) for item in replay["limitations"])
if "mapContext" in replay:
    context = replay["mapContext"]
    assert context["treeCoverage"] in ("all", "temporary-only", "unavailable")
    assert isinstance(context["towerSource"], str) and isinstance(context["treeSource"], str)
    assert context["terrainSource"] is None or isinstance(context["terrainSource"], str)
    assert all(isinstance(item, str) for item in context["limitations"])
print(json.dumps({
    "matchId": replay["matchId"],
    "frames": len(replay["frames"]),
    "heroes": sorted(heroes),
    "events": dict(collections.Counter(event["type"] for event in replay["events"])),
    "observedProperties": dict(nonnull),
}, indent=2))
