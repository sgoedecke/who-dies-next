import { useContext, useEffect, useId, useRef, useState } from 'react';
import { catalogSchema, scenarioSchema } from '../shared/scenario';
import type { Catalog, Scenario } from '../shared/scenario';
import { ZodError } from 'zod';
import { scenarioEligibility } from '../shared/recent';
import { resolveAbilityAsset, resolveItemAsset } from '../shared/assets';
import { frameAt, heroName, readableName, readableRecordText, scenarioPath } from './game';
import { AssetContext, displayHeroName, HeroPortrait, useAssetManifest } from './assets';
import { Arena } from './Arena';
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
      <div className="question-row">
        <h1>Who dies <span className="question-accent">next</span>?</h1>
      </div>
      {notice && <p className="selection-notice" role="status">{notice}</p>}
      {failure ? <section className="load-state" role="alert"><p>{failure}</p><button onClick={() => setRetry(v => v + 1)}>Retry</button>{canNext && <button onClick={nextPractice}>Next</button>}</section>
            : scenario && scenario.id === selectedId ? <Game key={`${scenario.id}:${visit}`} scenario={scenario} clientMap={clientMap} nowMs={nowMs} canNext={canNext} onNext={nextPractice} />
              : <p className="loading-state" role="status">Loading…</p>}
    </main>
  </AssetContext.Provider>;
}

function Game({ scenario, clientMap, nowMs, canNext, onNext }: {
  scenario: Scenario; clientMap: ClientMap | null; nowMs: number;
  canNext: boolean; onNext: () => void;
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
  const observed = locked ? frameAt(scenario, time) : scenario.startSnapshot;
  const frame = { ...observed, heroes: observed.heroes.map(h => ({ ...h, name: displayHeroName(assets, h) })) };
  const hero = frame.heroes.find(h => h.id === inspected) ?? frame.heroes[0];
  const options = frame.heroes.filter(h => scenario.question.optionIds.includes(h.id));
  const events = locked ? scenario.events.filter(event => event.time <= time).sort((a, b) => a.time - b.time) : [];
  const correct = selected === scenario.question.answerId;

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

  function lock() {
    if (!selected || committed.current) return;
    committed.current = true;
    setTime(0);
    setLocked(true);
    setPlaying(true);
  }

  return <>
    <div className="game-layout">
      <section className="arena-panel" aria-label="Fight observation">
        <Arena scenario={scenario} frame={frame} inspected={inspected} onInspect={setInspected}
          clientMap={clientMap} nowMs={nowMs} />
        <div className="playback">
          <div className="playback-buttons">
            <button aria-label={playing ? 'Pause continuation' : 'Play continuation'} disabled={!locked}
              title={locked ? undefined : 'Guess to unlock playback'}
              onClick={() => { if (time >= scenario.duration) setTime(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
            <button aria-label="Restart continuation" disabled={!locked} onClick={() => { setTime(0); setPlaying(false); }}>Restart</button>
            <span className="playback-time">{time.toFixed(1)} / {scenario.duration}s</span>
          </div>
          <input aria-label="Continuation timeline" type="range" min="0" max={scenario.duration} step="0.05" value={time} disabled={!locked}
            onChange={event => { setPlaying(false); setTime(Number(event.target.value)); }} />
        </div>
      </section>
      <div className="side-column">
        <aside className="prediction-panel" aria-label="Your prediction">
          <fieldset className="answer-options" disabled={locked}>
            <legend className="sr-only">Who dies next?</legend>
            {options.map(option => <label key={option.id} className={`answer-option ${selected === option.id ? 'selected' : ''} ${locked && option.id === scenario.question.answerId ? 'correct-option' : ''}`}>
              <input type="radio" name="prediction" value={option.id} checked={selected === option.id}
                style={{ position: 'static', appearance: 'auto', width: 18, height: 18, opacity: 1, margin: '0 0 0 auto', order: 3, flexShrink: 0, zIndex: 1, pointerEvents: 'auto', accentColor: '#b7ed7c' }}
                onChange={() => { setSelected(option.id); setInspected(option.id); }} />
              <HeroPortrait hero={option} size={42} />
              <span className="answer-name"><strong>{option.name}</strong><small>{option.team === 'radiant' ? 'Radiant' : 'Dire'} · Lv {option.level ?? '?'}</small></span>
              {locked && option.id === scenario.question.answerId && <span className="answer-check" aria-hidden="true">✓</span>}
            </label>)}
          </fieldset>
          <div className="prediction-actions">
            {!locked ? <button className="primary-button lock-button" disabled={!selected} onClick={lock}>Guess</button>
              : <p className={`result ${correct ? 'correct' : 'incorrect'}`} role="status" aria-label={`${correct ? 'Correct' : 'Incorrect'}. ${heroName(options, scenario.question.answerId)} dies next.`}>
                <strong>{correct ? 'Correct' : 'Incorrect'}</strong><span>{heroName(options, scenario.question.answerId)}</span>
              </p>}
              <button className="next-button" disabled={!canNext} title={nextDescription} aria-describedby={nextDescriptionId}
                onClick={() => { setPlaying(false); onNext(); }}>Next</button>
              <span id={nextDescriptionId} className="sr-only">{nextDescription}</span>
          </div>
        </aside>
        {locked && events.length > 0 && <section className="events-panel" aria-label="Event feed">
          <ol className="event-feed">{events.map((event, index) => {
            const text = readableRecordText(event.description, frame.heroes);
            const ability = event.ability ? resolveAbilityAsset(assets, event.ability)?.label ?? resolveItemAsset(assets, event.ability)?.label ?? readableName(event.ability) : null;
            const target = frame.heroes.find(h => h.id === (event.targetId ?? event.actorId));
            return <li key={`${event.time}:${index}`} className={event.type === 'death' ? 'death-event' : ''} title={text} aria-label={text || event.type}>
              <time>+{event.time.toFixed(1)}s</time>
              <span className="event-symbol" aria-hidden="true">{event.type === 'death' ? '×' : '›'}</span>
              <span>{ability ?? target?.name ?? '?'}</span>
              {event.value !== null && <span className="event-value">{event.value}</span>}
            </li>;
          })}</ol>
        </section>}
      </div>
      <section className="inspection-panel" aria-label="Hero inspection">
        <div className="hero-tabs" aria-label="Choose a hero to inspect">
          {frame.heroes.map(h => <button key={h.id} onClick={() => setInspected(h.id)} aria-pressed={inspected === h.id}
            className={`${h.team} ${inspected === h.id ? 'active' : ''}`}>
            <span className={`team-dot ${h.team}`} />{h.name}
            <span className="roster-level" aria-label={`Hero level ${h.level ?? 'unknown'}`}>Lv {h.level ?? '?'}</span>
            {h.alive === false && <span title="Dead" aria-label="Dead">×</span>}
          </button>)}
        </div>
        <HeroHUD key={hero.id} hero={hero} />
      </section>
    </div>
  </>;
}
