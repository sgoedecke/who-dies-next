package dev.dotadle;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.stream.JsonWriter;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import skadistats.clarity.Clarity;
import skadistats.clarity.event.Insert;
import skadistats.clarity.io.Util;
import skadistats.clarity.model.*;
import skadistats.clarity.processor.entities.*;
import skadistats.clarity.processor.gameevents.OnCombatLogEntry;
import skadistats.clarity.processor.reader.OnMessage;
import skadistats.clarity.processor.reader.OnTickEnd;
import skadistats.clarity.processor.runner.Context;
import skadistats.clarity.processor.runner.SimpleRunner;
import skadistats.clarity.processor.stringtables.StringTables;
import skadistats.clarity.processor.stringtables.UsesStringTable;
import skadistats.clarity.source.MappedFileSource;
import skadistats.clarity.wire.shared.common.proto.CommonNetworkBaseTypes;

@UsesEntities
@UsesStringTable("EntityNames")
public final class ReplayWorker {
    private static final Gson JSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();
    private static final int MAX_EVENTS = 200_000;
    private static final int MAX_DEATHS = 20_000;
    private static final String HERO_PREFIX = "CDOTA_Unit_Hero_";
    @Insert private Entities entities;
    @Insert private StringTables tables;
    @Insert private Context context;
    private final JsonWriter out;
    private final double interval;
    private final Path inspect;
    private final Set<String> limitations = new LinkedHashSet<>();
    private final Map<Integer, Entity> heroEntities = new LinkedHashMap<>();
    private final Map<Integer, Entity> towerEntities = new LinkedHashMap<>();
    private final Map<Integer, Entity> treeEntities = new LinkedHashMap<>();
    private final Map<Integer, Tower> towerStates = new LinkedHashMap<>();
    private final Map<Integer, Tree> treeStates = new LinkedHashMap<>();
    private final Set<String> observedTreeClasses = new LinkedHashSet<>();
    private final Map<Integer, Boolean> previousLife = new HashMap<>();
    private final Map<Integer, String> heroIds = new HashMap<>();
    private final Set<String> inspected = new HashSet<>();
    private final List<Event> events = new ArrayList<>();
    private final List<Event> deaths = new ArrayList<>();
    private double nextSample;
    private int serverTick = -1;
    private long frames;
    private String matchId;
    private boolean sawPosition;
    private boolean sawHero;
    private final CooldownClock cooldownClock = new CooldownClock();

    record Ability(String name, Integer level, Double cooldown) {}
    record Item(String name, Integer charges, Double cooldown) {}
    record Hero(String id, String name, String team, Integer level, Double x, Double y, Double hp, Double maxHp,
                Double mana, Double maxMana, Boolean alive, List<Ability> abilities,
                List<Item> items, List<String> effects) {}
    record Tower(String id, String name, String team, Double x, Double y, Double z,
                 Double hp, Double maxHp, Boolean alive) {}
    record Tree(String id, Double x, Double y, Double z, Boolean alive) {}
    record Frame(double time, List<Hero> heroes, List<Tower> towers, List<Tree> trees) {}
    record MapContext(String towerSource, String treeSource, String treeCoverage,
                      String terrainSource, List<String> limitations) {}
    record Event(double time, String type, String actorId, String targetId, String ability,
                 Double value, String description) {}

    ReplayWorker(JsonWriter out, double interval, Path inspect) {
        this.out = out;
        this.interval = interval;
        this.inspect = inspect;
        limitations.add("Frame/event times are replay elapsed seconds (demo tick × tick interval), not time since horn. Combat events use their replay delivery tick and can be delayed by combat-log batching.");
        limitations.add("Active modifier snapshots are not reconstructed; effects is null. Modifier add/remove combat events are retained when present.");
        limitations.add("Unknown network properties remain null. Ability/item lists contain only resolved handles; hidden or unavailable slots are omitted.");
        limitations.add("Real hero deaths use per-tick life-state transitions (alive to dying/dead), including reincarnation; killer attribution is unavailable.");
        limitations.add("Patch labels are not inferred from build numbers; patch is null unless a semantic patch label is available.");
        limitations.add("Hero level is observed m_iCurrentLevel, not an ability level; unavailable or invalid hero levels are null.");
        limitations.add("Clarity's Dota summary exposes end_time but no verified Unix match-start field. matchStartTime is null; match age must be verified externally by matchId, never inferred from replay duration, download time or file timestamps.");
    }

    static Double numeric(Object value) {
        if (!(value instanceof Number n) || !Double.isFinite(n.doubleValue())) return null;
        return n.doubleValue();
    }

    static Integer integer(Object value) {
        return value instanceof Number n ? n.intValue() : null;
    }

    static Integer heroLevel(Object value) {
        Double level = numeric(value);
        return level != null && level >= 0 && level <= Integer.MAX_VALUE && level == Math.rint(level)
            ? level.intValue() : null;
    }

    static Object property(Entity entity, String... names) {
        if (entity == null) return null;
        for (String name : names) {
            FieldPath path = entity.getDtClass().getFieldPathForName(name);
            if (path != null) {
                Object value = entity.getPropertyForFieldPath(path);
                if (value != null) return value;
            }
        }
        return null;
    }

    static Double worldCoordinate(Object cell, Object offset) {
        Double c = numeric(cell), v = numeric(offset);
        return c == null || v == null ? null : c * 128.0 + v - 16384.0;
    }

    static Double cooldown(Object end, Double gameTime) {
        Double deadline = numeric(end);
        if (deadline == null) return null;
        if (deadline == 0) return 0.0; // Observed ready/reset state, not an assumed default.
        return gameTime == null ? null : Math.max(0, deadline - gameTime);
    }

    static final class CooldownClock {
        enum Encoding { UNKNOWN, DEADLINE, REMAINING }
        record Observation(double time, double raw, Double gameTime) {}
        private final Map<Integer, Observation> previous = new HashMap<>();
        Encoding encoding = Encoding.UNKNOWN;

        Double observe(int handle, Double raw, Double gameTime, double replayTime) {
            if (raw == null || raw < 0) return null;
            Observation before = previous.put(handle, new Observation(replayTime, raw, gameTime));
            if (encoding == Encoding.UNKNOWN && before != null && raw > 0 && before.raw > 0) {
                double elapsed = replayTime - before.time;
                double gameElapsed = gameTime == null || before.gameTime == null
                    ? elapsed : gameTime - before.gameTime;
                double decrease = before.raw - raw;
                // New builds transmit remaining duration; older builds transmit a deadline.
                // Infer from an observed progression, never from a guessed patch/build cutoff.
                if (elapsed >= 0.15 && elapsed <= 15.0 && gameElapsed > 0.1 && decrease > 0.01
                        && Math.abs(decrease - gameElapsed) <= 0.2) {
                    encoding = Encoding.REMAINING;
                } else if (elapsed >= 0.15 && gameElapsed > 0.1 && decrease == 0
                        && gameTime != null && before.gameTime != null && raw > gameTime) {
                    encoding = Encoding.DEADLINE;
                }
            }
            if (raw == 0) return 0.0;
            return switch (encoding) {
                case REMAINING -> raw;
                case DEADLINE -> cooldown(raw, gameTime);
                case UNKNOWN -> null;
            };
        }
    }

    static boolean validHandle(Integer handle) {
        return handle != null && handle != -1 && handle != 0xFFFFFF && handle != 0xFFFFFFFF;
    }

    static boolean isDeath(Boolean before, Boolean after) {
        return Boolean.TRUE.equals(before) && Boolean.FALSE.equals(after);
    }

    private Entity resolve(Object handle) {
        Integer value = integer(handle);
        return validHandle(value) ? entities.getByHandle(value) : null;
    }

    private double now() {
        return Math.max(0, context.getTick()) * context.getMillisPerTick() / 1000.0;
    }

    @OnMessage(CommonNetworkBaseTypes.CNETMsg_Tick.class)
    public void serverTick(CommonNetworkBaseTypes.CNETMsg_Tick tick) {
        serverTick = tick.getTick();
    }

    @OnEntityCreated
    public void created(Entity entity) {
        String name = entity.getDtClass().getDtName();
        if (name.startsWith(HERO_PREFIX)) {
            heroEntities.put(entity.getHandle(), entity);
        }
        if (name.equals("CDOTA_BaseNPC_Tower")) towerEntities.put(entity.getHandle(), entity);
        if (name.toLowerCase(Locale.ROOT).contains("tree")) observedTreeClasses.add(name);
        if (name.equals("CDOTA_TempTree")) treeEntities.put(entity.getHandle(), entity);
    }

    @OnEntityDeleted
    public void deleted(Entity entity) {
        if (towerEntities.remove(entity.getHandle()) != null) {
            Tower current = towerSnapshot(entity, towerStates.get(entity.getHandle()));
            if (current != null) towerStates.put(entity.getHandle(), removedTower(current));
        }
        if (treeEntities.remove(entity.getHandle()) != null) {
            Tree current = treeSnapshot(entity, treeStates.get(entity.getHandle()));
            if (current != null) treeStates.put(entity.getHandle(),
                new Tree(current.id, current.x, current.y, current.z, false));
        }
        heroEntities.remove(entity.getHandle());
        previousLife.remove(entity.getHandle());
        cooldownClock.previous.remove(entity.getHandle());
        heroIds.remove(entity.getHandle());
    }

    private Set<Integer> selectedHandles() {
        Set<Integer> selected = new HashSet<>();
        Entity players = entities.getByDtName("CDOTA_PlayerResource");
        if (players == null) return selected;
        for (int slot = 0; slot < 64; slot++) {
            Integer handle = integer(property(players,
                "m_vecPlayerTeamData." + Util.arrayIdxToString(slot) + ".m_hSelectedHero"));
            if (validHandle(handle)) selected.add(handle);
        }
        return selected;
    }

    private boolean realHero(Entity hero, Set<Integer> selected) {
        if (Boolean.TRUE.equals(property(hero, "m_bIsIllusion"))) return false;
        Integer replicating = integer(property(hero, "m_hReplicatingOtherHeroModel"));
        if (validHandle(replicating) && replicating != 0) return false;
        Integer clone = integer(property(hero, "m_nCloneIndex"));
        if (clone != null && clone > 0) return false;
        Integer team = integer(property(hero, "m_iTeamNum"));
        if (team == null || (team != 2 && team != 3)) return false;
        // The selected-hero handle is authoritative for illusions, Meepo and Tempest Double.
        if (selected.contains(hero.getHandle())) return true;
        Integer player = integer(property(hero, "m_iPlayerID"));
        Entity resource = entities.getByDtName("CDOTA_PlayerResource");
        if (player != null && player >= 0 && player < 64 && resource != null) {
            Integer primary = integer(property(resource,
                "m_vecPlayerTeamData." + Util.arrayIdxToString(player) + ".m_hSelectedHero"));
            if (validHandle(primary) && resolve(primary) != null && primary != hero.getHandle()) return false;
        }
        limitations.add("Some heroes lacked an authoritative selected-hero handle; explicit illusion/replication/clone flags were used as fallback.");
        return true;
    }

    private String entityName(Entity entity) {
        Integer index = integer(property(entity, "m_pEntity.m_nameStringTableIndex",
            "m_pEntity.m_nameStringableIndex", "m_iName"));
        StringTable table = tables.forName("EntityNames");
        if (table != null && index != null && index >= 0 && index < table.getEntryCount()) {
            String name = table.getNameByIndex(index);
            if (name != null && !name.isBlank()) return name;
        }
        return null;
    }

    private String heroId(Entity hero) {
        String existing = heroIds.get(hero.getHandle());
        if (existing != null) return existing;
        String id = entityName(hero);
        if (id == null || !id.startsWith("npc_dota_hero_")) {
            id = hero.getDtClass().getDtName();
            limitations.add("A hero lacked an EntityNames entry; its network class is used as its ID until a canonical name is observed.");
            return id;
        }
        heroIds.put(hero.getHandle(), id);
        return id;
    }

    private Double gameTime() {
        Entity rules = entities.getByDtName("CDOTAGamerulesProxy");
        Double direct = numeric(property(rules, "m_pGameRules.m_fGameTime"));
        if (direct != null) return direct;
        Integer pausedTicks = integer(property(rules, "m_pGameRules.m_nTotalPausedTicks"));
        Object paused = property(rules, "m_pGameRules.m_bGamePaused");
        Integer tick = Boolean.TRUE.equals(paused)
            ? integer(property(rules, "m_pGameRules.m_nPauseStartTick")) : serverTick;
        if (paused == null || pausedTicks == null || tick == null || tick < 0) return null;
        return (tick - pausedTicks) * context.getMillisPerTick() / 1000.0;
    }

    private void inspect(Entity entity) throws IOException {
        if (inspect != null && inspected.add(entity.getDtClass().getDtName())) {
            Files.writeString(inspect, entity + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        }
    }

    static Tower removedTower(Tower observed) {
        return new Tower(observed.id, observed.name, observed.team, observed.x, observed.y, observed.z,
            observed.hp, observed.maxHp, Boolean.FALSE.equals(observed.alive) ? false : null);
    }

    private Double coordinate(Entity entity, String axis) {
        Double cellPosition = worldCoordinate(property(entity, "CBodyComponent.m_cell" + axis),
            property(entity, "CBodyComponent.m_vec" + axis));
        if (cellPosition != null) return cellPosition;
        Object origin = property(entity, "m_vecOrigin", "CBodyComponent.m_vecOrigin");
        int component = switch (axis) { case "X" -> 0; case "Y" -> 1; default -> 2; };
        if (origin instanceof skadistats.clarity.model.Vector vector && vector.getDimension() > component) {
            return numeric(vector.getElement(component));
        }
        return null;
    }

    private static Double latest(Double current, Double previous) {
        return current == null ? previous : current;
    }

    static Boolean observedTowerAlive(Object lifeValue, Object healthValue) {
        Integer life = integer(lifeValue);
        if (life != null) return life == 0;
        Double health = numeric(healthValue);
        return health == null ? null : health > 0;
    }

    private Tower towerSnapshot(Entity entity, Tower previous) {
        Integer team = integer(property(entity, "m_iTeamNum"));
        if (team == null || (team != 2 && team != 3)) return previous;
        String name = entityName(entity);
        if (name == null) name = previous != null ? previous.name : entity.getDtClass().getDtName();
        Double hp = latest(numeric(property(entity, "m_iHealth")), previous == null ? null : previous.hp);
        Boolean alive = observedTowerAlive(property(entity, "m_lifeState"), hp);
        if (alive == null && previous != null) alive = previous.alive;
        return new Tower("tower:" + Integer.toUnsignedString(entity.getHandle()), name,
            team == 2 ? "radiant" : "dire",
            latest(coordinate(entity, "X"), previous == null ? null : previous.x),
            latest(coordinate(entity, "Y"), previous == null ? null : previous.y),
            latest(coordinate(entity, "Z"), previous == null ? null : previous.z),
            hp, latest(numeric(property(entity, "m_iMaxHealth")), previous == null ? null : previous.maxHp), alive);
    }

    private Tree treeSnapshot(Entity entity, Tree previous) {
        Double x = latest(coordinate(entity, "X"), previous == null ? null : previous.x);
        Double y = latest(coordinate(entity, "Y"), previous == null ? null : previous.y);
        if (x == null || y == null) return previous;
        Integer life = integer(property(entity, "m_lifeState"));
        return new Tree("tree:" + Integer.toUnsignedString(entity.getHandle()), x, y,
            latest(coordinate(entity, "Z"), previous == null ? null : previous.z),
            life == null ? true : life == 0);
    }

    private void updateMapStates() throws IOException {
        for (Entity entity : towerEntities.values()) {
            if (!entity.isActive()) continue;
            Tower state = towerSnapshot(entity, towerStates.get(entity.getHandle()));
            if (state != null) towerStates.put(entity.getHandle(), state);
            inspect(entity);
        }
        for (Entity entity : treeEntities.values()) {
            if (!entity.isActive()) continue;
            Tree state = treeSnapshot(entity, treeStates.get(entity.getHandle()));
            if (state != null) treeStates.put(entity.getHandle(), state);
            inspect(entity);
        }
    }

    private Hero snapshot(Entity hero, Double gameTime) throws IOException {
        String id = heroId(hero);
        Double x = worldCoordinate(property(hero, "CBodyComponent.m_cellX"), property(hero, "CBodyComponent.m_vecX"));
        Double y = worldCoordinate(property(hero, "CBodyComponent.m_cellY"), property(hero, "CBodyComponent.m_vecY"));
        sawPosition |= x != null && y != null;
        Integer life = integer(property(hero, "m_lifeState"));
        List<Ability> abilities = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (int slot = 0; slot < 40; slot++) {
            String suffix = "." + Util.arrayIdxToString(slot);
            Entity ability = resolve(property(hero, "m_hAbilities" + suffix, "m_vecAbilities" + suffix));
            if (ability == null || !seen.add(ability.getHandle())) continue;
            String name = entityName(ability);
            if (name == null) {
                name = ability.getDtClass().getDtName();
                limitations.add("Some ability/item names use network class names because their EntityNames entry was unavailable.");
            }
            abilities.add(new Ability(name, integer(property(ability, "m_iLevel")),
                cooldownClock.observe(ability.getHandle(), numeric(property(ability, "m_fCooldown")), gameTime, now())));
            inspect(ability);
        }
        List<Item> items = new ArrayList<>();
        seen.clear();
        for (int slot = 0; slot < 19; slot++) {
            Entity item = resolve(property(hero, "m_hItems." + Util.arrayIdxToString(slot)));
            if (item == null || !seen.add(item.getHandle())) continue;
            String name = entityName(item);
            if (name == null) {
                name = item.getDtClass().getDtName();
                limitations.add("Some ability/item names use network class names because their EntityNames entry was unavailable.");
            }
            items.add(new Item(name, integer(property(item, "m_iCurrentCharges")),
                cooldownClock.observe(item.getHandle(), numeric(property(item, "m_fCooldown")), gameTime, now())));
            inspect(item);
        }
        inspect(hero);
        return new Hero(id, id, Objects.equals(integer(property(hero, "m_iTeamNum")), 2) ? "radiant" : "dire",
            heroLevel(property(hero, "m_iCurrentLevel")),
            x, y, numeric(property(hero, "m_iHealth")), numeric(property(hero, "m_iMaxHealth")),
            numeric(property(hero, "m_flMana")), numeric(property(hero, "m_flMaxMana")),
            life == null ? null : life == 0, abilities, items, null);
    }

    @OnTickEnd
    public void tick(boolean synthetic) throws IOException {
        if (context.getTick() < 0) return;
        double time = now();
        updateMapStates();
        Set<Integer> selected = selectedHandles();
        List<Entity> real = new ArrayList<>();
        for (Entity hero : heroEntities.values()) {
            if (!hero.isActive() || !realHero(hero, selected)) continue;
            real.add(hero);
            Integer life = integer(property(hero, "m_lifeState"));
            if (life == null) continue;
            boolean alive = life == 0;
            Boolean before = previousLife.put(hero.getHandle(), alive);
            if (isDeath(before, alive)) {
                String id = heroId(hero);
                if (deaths.size() < MAX_DEATHS) {
                    deaths.add(new Event(time, "death", null, id, null, null, id + " died (entity life-state transition)"));
                } else limitations.add("Death events exceeded 20,000; additional deaths were omitted.");
            }
        }
        if (time + 1e-7 < nextSample) return;
        nextSample = (Math.floor(time / interval) + 1) * interval;
        if (real.isEmpty()) return;
        sawHero = true;
        Double gameTime = gameTime();
        Entity rules = entities.getByDtName("CDOTAGamerulesProxy");
        if (rules != null) inspect(rules);
        List<Hero> heroes = new ArrayList<>();
        for (Entity hero : real) heroes.add(snapshot(hero, gameTime));
        heroes.sort(Comparator.comparing(Hero::id));
        JSON.toJson(new Frame(time, heroes, new ArrayList<>(towerStates.values()),
            treeStates.isEmpty() ? null : new ArrayList<>(treeStates.values())), Frame.class, out);
        frames++;
        if (matchId == null) {
            Object value = property(entities.getByDtName("CDOTAGamerulesProxy"), "m_pGameRules.m_unMatchID64");
            if (value instanceof Number n && n.longValue() > 0) matchId = Long.toUnsignedString(n.longValue());
        }
    }

    static String canonicalCombatHero(String name, boolean illusion) {
        return !illusion && name != null && name.startsWith("npc_dota_hero_") ? name : null;
    }

    @OnCombatLogEntry
    public void combat(CombatLogEntry entry) {
        if (context.getTick() < 0) return;
        String type = switch (entry.getType()) {
            case DOTA_COMBATLOG_DAMAGE -> "damage";
            case DOTA_COMBATLOG_ABILITY -> "ability";
            case DOTA_COMBATLOG_ITEM -> "item";
            case DOTA_COMBATLOG_MODIFIER_ADD, DOTA_COMBATLOG_MODIFIER_REMOVE -> "modifier";
            default -> null;
        };
        if (type == null) return;
        String actor = canonicalCombatHero(entry.getAttackerName(), entry.isAttackerIllusion());
        String target = canonicalCombatHero(entry.getTargetName(), entry.isTargetIllusion());
        if (actor == null && target == null) return;
        if (events.size() >= MAX_EVENTS) {
            limitations.add("Non-death combat events exceeded 200,000; later combat events were omitted. Death events have an independent limit.");
            return;
        }
        String ability = entry.getInflictorName();
        String description = entry.getType().name().replace("DOTA_COMBATLOG_", "").toLowerCase(Locale.ROOT)
            + ": " + Objects.toString(entry.getAttackerName(), "unknown")
            + " → " + Objects.toString(entry.getTargetName(), "unknown")
            + (ability == null || ability.isBlank() ? "" : " (" + ability + ")");
        events.add(new Event(now(), type, actor, target, ability,
            entry.hasValue() ? (double) entry.getValue() : null, description));
    }

    private void parse(Path replay) throws Exception {
        try {
            var info = Clarity.infoForFile(replay.toString());
            if (inspect != null) Files.writeString(inspect, "Replay summary metadata:\n" + info + "\n",
                StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            if (info.hasGameInfo() && info.getGameInfo().hasDota()) {
                long id = info.getGameInfo().getDota().getMatchId();
                if (id != 0) matchId = Long.toUnsignedString(id);
            }
        } catch (Exception e) {
            limitations.add("Replay summary metadata was unavailable: " + e.getClass().getSimpleName());
        }
        out.beginObject();
        out.name("schemaVersion").value(1);
        out.name("matchStartTime").nullValue();
        out.name("patch").nullValue();
        out.name("parser").beginObject().name("name").value("clarity").name("version").value("4.0.1").endObject();
        out.name("coordinateSystem").value("dota-world");
        out.name("sampleInterval").value(interval);
        out.name("frames").beginArray();
        try (MappedFileSource source = new MappedFileSource(replay.toString())) {
            new SimpleRunner(source).runWith(this);
        }
        if (!sawHero) throw new IOException("No real Dota hero frames decoded; unsupported, empty or incomplete replay.");
        if (!sawPosition) limitations.add("No world positions decoded; this replay's coordinate schema is unsupported.");
        limitations.add(switch (cooldownClock.encoding) {
            case REMAINING -> "Observed m_fCooldown counting down; cooldowns use remaining-duration encoding. Positive values before encoding was established are null.";
            case DEADLINE -> "Observed m_fCooldown as an absolute deadline; cooldowns subtract the server game clock. Positive values before encoding was established are null.";
            case UNKNOWN -> "Cooldown encoding could not be established; positive cooldown values are null instead of assuming deadline or remaining-duration semantics.";
        });
        out.endArray();
        out.name("matchId").value(matchId);
        out.name("events").beginArray();
        events.addAll(deaths);
        events.sort(Comparator.comparingDouble(Event::time));
        for (Event event : events) JSON.toJson(event, Event.class, out);
        out.endArray();
        out.name("limitations");
        JSON.toJson(limitations, Set.class, out);
        out.name("mapContext");
        List<String> mapLimitations = new ArrayList<>(List.of(
            "Permanent map-tree layout and regrowth are not reconstructed from replay entities; no initial trees are fabricated.",
            "Terrain elevation meshes, cliffs and ramps are unavailable. Entity Z coordinates are not terrain geometry.",
            "Deleted towers retain last observed position and HP; alive becomes null unless destruction was actually observed.",
            "Temporary-tree alive describes observed entity presence; deletion marks removal. Tree state is not permanent-tree coverage."));
        if (!observedTreeClasses.isEmpty()) mapLimitations.add("Observed tree-related network classes: " + String.join(", ", observedTreeClasses));
        JSON.toJson(new MapContext(
            towerStates.isEmpty() ? "unavailable" : "Observed CDOTA_BaseNPC_Tower entity properties",
            treeStates.isEmpty() ? "unavailable" : "Observed CDOTA_TempTree entity creation, positions and deletion",
            treeStates.isEmpty() ? "unavailable" : "temporary-only",
            null, mapLimitations), MapContext.class, out);
        out.endObject();
        out.flush();
        System.err.printf("Decoded %,d frames, %,d combat events and %,d real-hero deaths.%n",
            frames, events.size() - deaths.size(), deaths.size());
    }

    public static void main(String[] args) {
        Path partial = null;
        try {
            if (args.length == 0 || args[0].equals("--help")) {
                System.err.println("Usage: worker/run.sh replay.dem [--output replay.json] [--interval 0.25] [--inspect properties.txt]");
                if (args.length == 0) System.exit(2);
                return;
            }
            Path replay = Path.of(args[0]).toAbsolutePath().normalize();
            Path output = null, inspect = null;
            double interval = 0.25;
            for (int i = 1; i < args.length; i += 2) {
                if (i + 1 >= args.length) throw new IllegalArgumentException("Missing value for " + args[i]);
                switch (args[i]) {
                    case "--output" -> output = Path.of(args[i + 1]).toAbsolutePath().normalize();
                    case "--interval" -> interval = Double.parseDouble(args[i + 1]);
                    case "--inspect" -> inspect = Path.of(args[i + 1]).toAbsolutePath().normalize();
                    default -> throw new IllegalArgumentException("Unknown option " + args[i]);
                }
            }
            if (!Double.isFinite(interval) || interval < 0.1 || interval > 10) {
                throw new IllegalArgumentException("--interval must be between 0.1 and 10 seconds.");
            }
            if (!Files.isRegularFile(replay)) throw new FileNotFoundException("Replay not found: " + replay);
            if (sameFile(replay, output) || sameFile(replay, inspect) || sameFile(output, inspect)) {
                throw new IllegalArgumentException("Input, output and inspect files must be different.");
            }
            Path pending = output == null ? null : partialPath(output);
            if (sameFile(replay, pending) || sameFile(inspect, pending) || sameFile(output, pending)) {
                throw new IllegalArgumentException("The output partial file must not alias input, output or inspect files.");
            }
            if (inspect != null) Files.writeString(inspect, "", StandardCharsets.UTF_8);
            if (output != null) {
                Path parent = output.getParent();
                Files.createDirectories(parent);
                Files.deleteIfExists(pending);
                partial = pending;
            }
            Writer writer = partial == null
                ? new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8))
                : Files.newBufferedWriter(partial, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
            try (JsonWriter json = new JsonWriter(writer)) {
                json.setSerializeNulls(true);
                new ReplayWorker(json, interval, inspect).parse(replay);
            }
            if (output != null) {
                Files.move(partial, output, StandardCopyOption.REPLACE_EXISTING);
                partial = null;
            }
        } catch (Exception e) {
            System.err.println("Replay parse failed: " + e);
            if (Boolean.getBoolean("dotadle.debug")) e.printStackTrace(System.err);
            if (partial != null) {
                try { Files.deleteIfExists(partial); } catch (IOException ignored) { }
            }
            System.exit(1);
        }
    }

    static Path partialPath(Path output) {
        return output.resolveSibling(output.getFileName() + ".partial");
    }

    private static boolean sameFile(Path a, Path b) throws IOException {
        return a != null && b != null && (a.equals(b)
            || (Files.exists(a) && Files.exists(b) && Files.isSameFile(a, b)));
    }
}
