package dev.dotadle;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonParser;
import java.util.List;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class ReplayWorkerTest {
    @Test void coordinatesAreDotaWorldUnitsNotMinimapCells() {
        assertEquals(0.0, ReplayWorker.worldCoordinate(128, 0f));
        assertEquals(-8192.0, ReplayWorker.worldCoordinate(64, 0f));
        assertEquals(8191.5, ReplayWorker.worldCoordinate(191, 127.5f));
        assertNull(ReplayWorker.worldCoordinate(128, null));
    }
    @Test void absentCooldownIsNotReady() {
        assertNull(ReplayWorker.cooldown(null, 100.0));
        assertNull(ReplayWorker.cooldown(110f, null));
        assertEquals(0.0, ReplayWorker.cooldown(0f, null));
        assertEquals(10.0, ReplayWorker.cooldown(110f, 100.0));
        assertEquals(0.0, ReplayWorker.cooldown(90f, 100.0));
    }
    @Test void handlesAreValidatedWithoutIndexMasking() {
        assertFalse(ReplayWorker.validHandle(null));
        assertFalse(ReplayWorker.validHandle(-1));
        assertFalse(ReplayWorker.validHandle(0xFFFFFF));
        assertTrue(ReplayWorker.validHandle(0x100123));
    }
    @Test void combatIllusionsNeverBorrowRealHeroIds() {
        assertNull(ReplayWorker.canonicalCombatHero("npc_dota_hero_axe", true));
        assertNull(ReplayWorker.canonicalCombatHero("npc_dota_creep_badguys_melee", false));
        assertEquals("npc_dota_hero_axe", ReplayWorker.canonicalCombatHero("npc_dota_hero_axe", false));
    }
    @Test void absentOrNonfiniteValuesStayNull() {
        assertNull(ReplayWorker.numeric(null));
        assertNull(ReplayWorker.numeric(Double.NaN));
        assertNull(ReplayWorker.numeric(Float.POSITIVE_INFINITY));
        assertEquals(42.0, ReplayWorker.numeric(42));
    }
    @Test void onlyObservedAliveToDeadTransitionsAreDeaths() {
        assertFalse(ReplayWorker.isDeath(null, false));
        assertFalse(ReplayWorker.isDeath(false, false));
        assertFalse(ReplayWorker.isDeath(false, true));
        assertFalse(ReplayWorker.isDeath(true, null));
        assertTrue(ReplayWorker.isDeath(true, false));
    }
    @Test void normalizedSchemaExplicitlySerializesUnknownValues() {
        var hero = new ReplayWorker.Hero("npc_dota_hero_axe", "npc_dota_hero_axe", "radiant", null,
            null, null, 500.0, 600.0, null, null, true,
            List.of(new ReplayWorker.Ability("axe_berserkers_call", 1, null)), List.of(), null);
        var json = JsonParser.parseString(new GsonBuilder().serializeNulls().create().toJson(hero)).getAsJsonObject();
        assertTrue(json.get("x").isJsonNull());
        assertTrue(json.get("level").isJsonNull());
        assertTrue(json.get("effects").isJsonNull());
        assertTrue(json.getAsJsonArray("abilities").get(0).getAsJsonObject().get("cooldown").isJsonNull());
        assertEquals(0, json.getAsJsonArray("items").size());
    }
    @Test void currentReplayCooldownIsObservedRemainingDuration() {
        var clock = new ReplayWorker.CooldownClock();
        assertNull(clock.observe(100, 14.0, 190.5, 162.5));
        assertEquals(13.7, clock.observe(100, 13.7, 190.8, 162.766));
        assertEquals(ReplayWorker.CooldownClock.Encoding.REMAINING, clock.encoding);
        assertEquals(60.0, clock.observe(200, 60.0, 190.8, 162.766));
    }
    @Test void olderReplayCooldownIsObservedAbsoluteDeadline() {
        var clock = new ReplayWorker.CooldownClock();
        assertNull(clock.observe(100, 500.0, 480.0, 430.0));
        assertEquals(19.75, clock.observe(100, 500.0, 480.25, 430.25));
        assertEquals(ReplayWorker.CooldownClock.Encoding.DEADLINE, clock.encoding);
    }
    @Test void expiredOrResetCooldownDoesNotGuessEncoding() {
        var clock = new ReplayWorker.CooldownClock();
        assertNull(clock.observe(100, 20.0, 200.0, 100.0));
        assertNull(clock.observe(100, 20.0, 200.25, 100.25));
        assertEquals(0.0, clock.observe(100, 0.0, 200.5, 100.5));
        assertEquals(ReplayWorker.CooldownClock.Encoding.UNKNOWN, clock.encoding);
    }
    @Test void pausedCountdownCannotBeMistakenForDeadline() {
        var clock = new ReplayWorker.CooldownClock();
        assertNull(clock.observe(100, 140.0, 100.0, 100.0));
        assertNull(clock.observe(100, 140.0, 100.0, 100.25));
        assertEquals(ReplayWorker.CooldownClock.Encoding.UNKNOWN, clock.encoding);
        assertEquals(139.75, clock.observe(100, 139.75, 100.25, 100.5));
        assertEquals(ReplayWorker.CooldownClock.Encoding.REMAINING, clock.encoding);
    }
    @Test void maximumSamplingIntervalStillDetectsEncoding() {
        var clock = new ReplayWorker.CooldownClock();
        assertNull(clock.observe(100, 140.0, 500.0, 100.0));
        assertEquals(130.0, clock.observe(100, 130.0, 510.0, 110.0));
    }
    @Test void partialPathIsDeterministicForTimeoutCleanup() {
        assertEquals(Path.of("worker/replay.json.partial"),
            ReplayWorker.partialPath(Path.of("worker/replay.json")));
        assertEquals(Path.of("replay.partial"), ReplayWorker.partialPath(Path.of("replay")));
    }
    @Test void towerDeletionDoesNotInventDestruction() {
        var observed = new ReplayWorker.Tower("tower:42", "dota_goodguys_tower1_mid",
            "radiant", -1544.0, -1408.0, 128.0, 1200.0, 1800.0, true);
        var removed = ReplayWorker.removedTower(observed);
        assertNull(removed.alive());
        assertEquals(observed.id(), removed.id());
        assertEquals(observed.x(), removed.x());
        assertEquals(observed.z(), removed.z());
        assertEquals(observed.hp(), removed.hp());
    }
    @Test void observedDestroyedTowerStaysDestroyedAfterDeletion() {
        var observed = new ReplayWorker.Tower("tower:42", "dota_goodguys_tower1_mid",
            "radiant", -1544.0, -1408.0, 128.0, 0.0, 1800.0, false);
        assertEquals(observed, ReplayWorker.removedTower(observed));
        assertNull(ReplayWorker.observedTowerAlive(null, null));
        assertFalse(ReplayWorker.observedTowerAlive(null, 0));
        assertTrue(ReplayWorker.observedTowerAlive(0, 1800));
        assertFalse(ReplayWorker.observedTowerAlive(1, 0));
    }
    @Test void mapContextAndEntityZAreExplicitWithoutInventingTerrain() {
        var context = new ReplayWorker.MapContext("entity", "entity", "temporary-only", null,
            List.of("Permanent trees unavailable."));
        var json = JsonParser.parseString(new GsonBuilder().serializeNulls().create().toJson(context)).getAsJsonObject();
        assertEquals("temporary-only", json.get("treeCoverage").getAsString());
        assertTrue(json.get("terrainSource").isJsonNull());
        var frame = new ReplayWorker.Frame(10.0, List.of(), List.of(), null);
        var frameJson = JsonParser.parseString(new GsonBuilder().serializeNulls().create().toJson(frame)).getAsJsonObject();
        assertTrue(frameJson.get("trees").isJsonNull());
        assertEquals(0, frameJson.getAsJsonArray("towers").size());
    }
    @Test void heroLevelIsAnObservedNonnegativeIntegerOrUnknown() {
        assertEquals(0, ReplayWorker.heroLevel(0));
        assertEquals(1, ReplayWorker.heroLevel(1));
        assertEquals(30, ReplayWorker.heroLevel(30));
        assertNull(ReplayWorker.heroLevel(null));
        assertNull(ReplayWorker.heroLevel(-1));
        assertNull(ReplayWorker.heroLevel(1.5));
        assertNull(ReplayWorker.heroLevel(Double.NaN));
        assertNull(ReplayWorker.heroLevel(Double.POSITIVE_INFINITY));
    }
}
