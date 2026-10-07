import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { catalogSchema, scenarioSchema } from '../shared/scenario';
import type { Catalog, Hero, Scenario } from '../shared/scenario';
import { ZodError } from 'zod';
import { scenarioEligibility } from '../shared/recent';
import { resolveAbilityAsset, resolveItemAsset } from '../shared/assets';
import { frameAt, heroName, percent, readableName, readableRecordText, scenarioPath } from './game';
import { AbilityArtwork, AssetContext, displayHeroName, HeroPortrait, ItemArtwork, useAssetManifest } from './assets';
import { Arena, healthTone } from './Arena';
import { deathTimes, feedRows, revealTime } from './fx';
import type { FeedRow, Unit } from './fx';
import { HeroHUD } from './HeroHUD';
import { catalogEntryAvailability, eligiblePracticeEntries, randomPracticeId } from './availability';
import { useClientMap } from './ClientMap';
import type { ClientMap } from '../shared/client-map';
import { publicUrl } from './public-url';

function loadError(cause: unknown): string {
  return cause instanceof ZodError ? cause.issues[0]?.message ?? 'Scenario unavailable.'
    : cause instanceof Error ? cause.message : 'Scenario unavailable.';
}

export function App() {
  const assets = useAssetManifest();
  const clientMap = useClientMap();
  const [nowMs, setNowMs] = useState(Date.now);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [requested, setRequested] = useState(() => new URLSearchParams(location.search).get('scenario') || null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const [rejectedSources, setRejectedSources] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const [visit, setVisit] = useState(0);
  const [notice, setNotice] = useState('');
  // Session-only score: the game deliberately persists nothing between visits.
  const [score, setScore] = useState({ played: 0, correct: 0, streak: 0, best: 0 });
  const recordResult = useCallback((won: boolean) => setScore(previous => {
    const streak = won ? previous.streak + 1 : 0;
    return { played: previous.played + 1, correct: previous.correct + (won ? 1 : 0), streak, best: Math.max(previous.best, streak) };
  }), []);
  const selectedId = requested;
  const practiceEntries = catalog ? eligiblePracticeEntries(catalog, nowMs, Object.keys(rejectedSources)) : [];
  const canNext = practiceEntries.some(entry => entry.id !== selectedId);
  const currentAvailability = scenario ? scenarioEligibility(scenario, nowMs) : null;
  const unavailableReason = unavailable || (currentAvailability && !currentAvailability.eligible ? currentAvailability.message : '');
  const failure = error || unavailableReason || (catalog && !practiceEntries.length ? 'No eligible real replays are available.' : '');

  function selectFromUrl(nextCatalog: Catalog) {
    const url = new URL(location.href);
    const bookmarked = url.searchParams.get('scenario');
    const eligible = eligiblePracticeEntries(nextCatalog);
    const id = eligible.some(entry => entry.id === bookmarked) ? bookmarked : randomPracticeId(eligible, null);
    setRequested(id);
    setNotice(bookmarked && id && bookmarked !== id ? 'That replay is unavailable. Showing another real replay.' : '');
    url.searchParams.delete('mode');
    if (id) url.searchParams.set('scenario', id);
    else url.searchParams.delete('scenario');
    history.replaceState(null, '', url);
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (catalog) selectFromUrl(catalog);
      else setRequested(new URLSearchParams(location.search).get('scenario') || null);
      setVisit(value => value + 1);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [catalog]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch(publicUrl('/scenarios/index.json'), { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Catalog unavailable.'); return response.json(); })
      .then(data => {
        if (!controller.signal.aborted) {
          const parsed = catalogSchema.safeParse(data);
          if (!parsed.success) {
            if (parsed.error.issues.some(issue => issue.code === 'too_small' && issue.path.length === 1 && issue.path[0] === 'scenarios')) {
              throw new Error('No eligible real replays are available.');
            }
            throw parsed.error;
          }
          setCatalog(parsed.data);
          setRejectedSources({});
          selectFromUrl(parsed.data);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(loadError(cause));
      });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    setScenario(null);
    setUnavailable('');
    if (!catalog || !selectedId) return;
    const controller = new AbortController();
    setError('');
    async function load() {
      try {
        const entry = catalog!.scenarios.find(candidate => candidate.id === selectedId);
        if (entry) {
          const status = catalogEntryAvailability(entry);
          if (!status.eligible) {
            if (!controller.signal.aborted) setUnavailable(status.message);
            return;
          }
        }
        const response = await fetch(publicUrl(scenarioPath(catalog!, selectedId!)), { signal: controller.signal });
        if (!response.ok) throw new Error('Scenario unavailable.');
        const data = scenarioSchema.parse(await response.json());
        if (data.id !== selectedId) throw new Error('Scenario does not match the catalog.');
        const status = scenarioEligibility(data);
        if (!status.eligible) {
          if (!controller.signal.aborted) {
            setRejectedSources(previous => ({ ...previous, [data.id]: status.message }));
            setUnavailable(status.message);
          }
          return;
        }
        if (!controller.signal.aborted) setScenario(data);
      } catch (cause) {
        if (!controller.signal.aborted) setError(loadError(cause));
      }
    }
    void load();
    return () => controller.abort();
  }, [catalog, selectedId, retry, visit]);

  function navigate(id: string) {
    const url = new URL(location.href);
    url.searchParams.set('scenario', id);
    url.searchParams.delete('mode');
    history.pushState(null, '', url);
    setScenario(null);
    setUnavailable('');
    setError('');
    setNotice('');
    setRequested(id);
    setVisit(value => value + 1);
  }

  function nextPractice() {
    const now = Date.now();
    setNowMs(now);
    const candidates = catalog ? eligiblePracticeEntries(catalog, now, Object.keys(rejectedSources)) : [];
    const id = randomPracticeId(candidates, selectedId);
    if (id) navigate(id);
  }

  return <AssetContext.Provider value={assets}>
    <main className="app-shell">
      <div className="title-bar">
        <div className="question-row">
          <h1>Who dies <span className="question-accent">next</span>?</h1>
        </div>
        {score.played > 0 && <p className="scoreboard" aria-label={`Session score: ${score.correct} of ${score.played} correct, current streak ${score.streak}, best ${score.best}`}>
          {score.streak > 0 && <span className="streak hot" title="Current streak"><span aria-hidden="true">🔥</span> {score.streak}</span>}
          <span title="Correct this session">{score.correct}/{score.played}</span>
          {score.best > 1 && <span className="best" title="Best streak this session">best {score.best}</span>}
        </p>}
      </div>
      {notice && <p className="selection-notice" role="status">{notice}</p>}
      {failure ? <section className="load-state" role="alert"><p>{failure}</p><button onClick={() => setRetry(v => v + 1)}>Retry</button>{canNext && <button onClick={nextPractice}>Next</button>}</section>
            : scenario && scenario.id === selectedId ? <Game key={`${scenario.id}:${visit}`} scenario={scenario} clientMap={clientMap} nowMs={nowMs} canNext={canNext} onNext={nextPractice} onResult={recordResult} />
              : <p className="loading-state" role="status">Loading…</p>}
    </main>
  </AssetContext.Provider>;
}

function FeedUnit({ unit, heroes }: { unit: Unit | null; heroes: Array<Pick<Hero, 'id' | 'name' | 'team'>> }) {
  if (!unit) return null;
  const hero = unit.id ? heroes.find(candidate => candidate.id === unit.id) : undefined;
  return hero ? <span className={`feed-hero ${hero.team}`} title={hero.name}><HeroPortrait hero={hero} size={20} /></span>
    : <span className="feed-unit">{unit.label}</span>;
}

function FeedAbility({ name, heroId }: { name: string; heroId: string | null }) {
  const assets = useContext(AssetContext);
  const ability = resolveAbilityAsset(assets, name);
  const item = ability ? null : resolveItemAsset(assets, name);
  const label = ability?.label ?? item?.label ?? readableName(name);
  return <span className="feed-ability">
    <span className="feed-icon" aria-hidden="true">{item ? <ItemArtwork name={name} slot /> : <AbilityArtwork name={name} heroId={heroId ?? ''} />}</span>
    <span className="feed-ability-name">{label}</span>
  </span>;
}

function FeedEntry({ row, heroes }: { row: FeedRow; heroes: Array<Pick<Hero, 'id' | 'name' | 'team'>> }) {
  const base = readableRecordText(row.event.description, heroes);
  const text = row.count > 1 ? `${base} ×${row.count}` : base;
  const victim = row.type === 'death' && row.target?.id ? heroes.find(hero => hero.id === row.target!.id) : undefined;
  return <li className={`feed-row feed-${row.type} ${row.type === 'death' ? 'death-event' : ''}`} title={text} aria-label={text || row.type}>
    <time>+{row.time.toFixed(1)}s</time>
    <span className="feed-line">
      <FeedUnit unit={row.actor} heroes={heroes} />
      {row.type === 'death' ? <span className="feed-verb" aria-hidden="true">☠</span>
        : row.ability ? <FeedAbility name={row.ability} heroId={row.actor?.id ?? null} /> : null}
      {row.target && row.type !== 'death' && <span className="feed-verb" aria-hidden="true">→</span>}
      <FeedUnit unit={row.target} heroes={heroes} />
      {victim && <span className="feed-victim">{victim.name} died</span>}
      {!row.actor && !row.target && !row.ability && <span className="feed-unit">{base}</span>}
    </span>
    {row.count > 1 && <span className="feed-count">×{row.count}</span>}
    {row.value !== null && row.type !== 'death' && <span className="event-value">{Math.round(row.value)}</span>}
  </li>;
}

function Game({ scenario, clientMap, nowMs, canNext, onNext, onResult }: {
  scenario: Scenario; clientMap: ClientMap | null; nowMs: number;
  canNext: boolean; onNext: () => void; onResult: (correct: boolean) => void;
}) {
  const assets = useContext(AssetContext);
  const nextDescriptionId = useId();
  const nextDescription = canNext ? 'Load another eligible real scenario at random.' : 'No other eligible real scenarios are available.';
  const [selected, setSelected] = useState<string | null>(null);
  const [inspected, setInspected] = useState(scenario.question.optionIds[0]);
  const [locked, setLocked] = useState(false);
  const committed = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [banner, setBanner] = useState(false);
  const feed = useRef<HTMLOListElement>(null);
  const participants = useMemo(() => new Set(scenario.startSnapshot.heroes.map(hero => hero.id)), [scenario]);
  const revealAt = useMemo(() => revealTime(scenario), [scenario]);
  const deaths = useMemo(() => deathTimes(scenario.events, participants), [scenario, participants]);
  const observed = locked ? frameAt(scenario, time) : scenario.startSnapshot;
  const frame = { ...observed, heroes: observed.heroes.map(h => ({ ...h, name: displayHeroName(assets, h) })) };
  const hero = frame.heroes.find(h => h.id === inspected) ?? frame.heroes[0];
  const options = frame.heroes.filter(h => scenario.question.optionIds.includes(h.id));
  const rows = locked ? feedRows(scenario.events, participants, time) : [];
  const answerId = scenario.question.answerId;
  const correct = selected === answerId;
  const answerName = heroName(options, answerId);

  useEffect(() => {
    if (!playing || !locked) return;
    let handle: number;
    let previous: number | undefined;
    function tick(now: number) {
      const elapsed = previous === undefined ? 0 : (now - previous) / 1000;
      previous = now;
      if (elapsed > 0) setTime(value => Math.min(scenario.duration, value + elapsed));
      handle = requestAnimationFrame(tick);
    }
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, locked, scenario.duration]);
  useEffect(() => { if (time >= scenario.duration) setPlaying(false); }, [time, scenario.duration]);
  // The verdict waits for the recorded death; once seen it stays visible through scrubbing.
  useEffect(() => {
    if (!locked || revealed || time < revealAt) return;
    setRevealed(true);
    setBanner(true);
    onResult(correct);
  }, [locked, revealed, time, revealAt, correct, onResult]);
  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(false), 2800);
    return () => clearTimeout(timer);
  }, [banner]);
  useLayoutEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [rows.length]);

  function lock() {
    if (!selected || committed.current) return;
    committed.current = true;
    setTime(0);
    setLocked(true);
    setPlaying(true);
  }

  const markerLeft = (seconds: number) => `calc(8px + (100% - 16px) * ${seconds / scenario.duration})`;

  return <>
    <div className="game-layout">
      <section className="arena-panel" aria-label="Fight observation">
        <Arena scenario={scenario} frame={frame} inspected={inspected} onInspect={setInspected}
          clientMap={clientMap} nowMs={nowMs} time={locked ? time : null} />
        <div className="playback">
          {banner && <div className={`reveal-banner ${correct ? 'correct' : 'incorrect'}`} aria-hidden="true">
            <strong>{correct ? 'Correct!' : 'Not this time'}</strong>
            <span>{answerName} died at +{revealAt.toFixed(1)}s</span>
          </div>}
          <div className="playback-buttons">
            <button aria-label={playing ? 'Pause continuation' : 'Play continuation'} disabled={!locked}
              title={locked ? undefined : 'Guess to unlock playback'}
              onClick={() => { if (time >= scenario.duration) setTime(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
            <button aria-label="Restart continuation" disabled={!locked} onClick={() => { setTime(0); setPlaying(false); }}>Restart</button>
            {revealed && scenario.source.matchId && <a className="match-link" href={`https://www.opendota.com/matches/${encodeURIComponent(scenario.source.matchId)}`}
              target="_blank" rel="noreferrer noopener">Match {scenario.source.matchId} ↗</a>}
            <span className="playback-time">{time.toFixed(1)} / {scenario.duration}s</span>
          </div>
          <div className="timeline">
            <input aria-label="Continuation timeline" type="range" min="0" max={scenario.duration} step="0.05" value={time} disabled={!locked}
              style={{ ['--progress' as string]: `${time / scenario.duration * 100}%` }}
              onChange={event => { setPlaying(false); setTime(Number(event.target.value)); }} />
            {locked && deaths.filter(death => revealed || death.time <= time).map(death => <span key={`${death.targetId}:${death.time}`}
              className={`timeline-death ${death.targetId === answerId ? 'answer' : ''}`} style={{ left: markerLeft(death.time) }} aria-hidden="true"
              title={`${heroName(frame.heroes, death.targetId)} died at +${death.time.toFixed(1)}s`} />)}
          </div>
        </div>
      </section>
      <div className="side-column">
        <aside className="prediction-panel" aria-label="Your prediction">
          <fieldset className="answer-options" disabled={locked}>
            <legend className="sr-only">Who dies next?</legend>
            {options.map(option => {
              const isAnswer = revealed && option.id === answerId;
              const wrongPick = revealed && option.id === selected && !correct;
              const hp = percent(option.hp, option.maxHp);
              return <label key={option.id} className={`answer-option ${option.team} ${selected === option.id ? 'selected' : ''} ${isAnswer ? 'correct-option' : ''} ${wrongPick ? 'wrong-option' : ''} ${option.alive === false ? 'dead' : ''}`}>
                <input type="radio" name="prediction" value={option.id} checked={selected === option.id}
                  onChange={() => { setSelected(option.id); setInspected(option.id); }} />
                <HeroPortrait hero={option} size={44} />
                <span className="answer-name"><strong>{option.name}</strong><small>{option.team === 'radiant' ? 'Radiant' : 'Dire'} · Lv {option.level ?? '?'}</small>
                  <span className={`answer-hp ${healthTone(hp)} ${hp === null ? 'unknown' : ''}`} aria-hidden="true"><span style={{ width: `${hp ?? 0}%` }} /></span>
                </span>
                <span className="answer-indicator" aria-hidden="true">{isAnswer ? '✓' : wrongPick ? '✗' : ''}</span>
              </label>;
            })}
          </fieldset>
          <div className="prediction-actions">
            {!locked ? <button className="primary-button lock-button" disabled={!selected} onClick={lock}>Guess</button>
              : revealed ? <p className={`result ${correct ? 'correct' : 'incorrect'}`} role="status" aria-label={`${correct ? 'Correct' : 'Incorrect'}. ${answerName} dies next.`}>
                <strong>{correct ? 'Correct' : 'Incorrect'}</strong><span>{answerName} died first</span>
              </p>
              : <p className="pending-result" role="status">
                <span>You picked <strong>{heroName(options, selected!)}</strong></span><span className="watching">Watching…</span>
              </p>}
              <button className={`next-button ${revealed ? 'ready' : ''}`} disabled={!canNext} title={nextDescription} aria-describedby={nextDescriptionId}
                onClick={() => { setPlaying(false); onNext(); }}>Next</button>
              <span id={nextDescriptionId} className="sr-only">{nextDescription}</span>
          </div>
        </aside>
        {locked && rows.length > 0 && <section className="events-panel" aria-label="Event feed">
          <ol className="event-feed" ref={feed}>{rows.map(row => <FeedEntry key={row.key} row={row} heroes={frame.heroes} />)}</ol>
        </section>}
      </div>
      <section className="inspection-panel" aria-label="Hero inspection">
        <HeroHUD key={hero.id} hero={hero} />
      </section>
    </div>
  </>;
}
