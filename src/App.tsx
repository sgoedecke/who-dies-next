import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { catalogSchema, scenarioSchema } from '../shared/scenario';
import type { Catalog, Hero, Scenario } from '../shared/scenario';
import { ZodError } from 'zod';
import { resolveAbilityAsset, resolveItemAsset } from '../shared/assets';
import { frameAt, heroName, percent, readableName, readableRecordText, scenarioPath } from './game';
import { AbilityArtwork, AssetContext, displayHeroName, HeroPortrait, ItemArtwork, useAssetManifest } from './assets';
import { Arena, healthTone } from './Arena';
import { deathTimes, feedRows, revealTime } from './fx';
import type { FeedRow, Unit } from './fx';
import { HeroHUD } from './HeroHUD';
import { eligiblePracticeEntries } from './availability';
import { DAILY_COUNT, dailyIds, loadProgress, localDay, msUntilNextDay, puzzleNumber, resultEmoji, saveProgress, shareText } from './daily';
import type { DailyResult } from './daily';
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
  const [nowMs] = useState(Date.now);
  // The day is fixed for the visit so a puzzle in progress doesn't change at midnight.
  const [day] = useState(() => localDay());
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [results, setResults] = useState<DailyResult[]>([]);
  const [index, setIndex] = useState(0);
  const [revealedCurrent, setRevealedCurrent] = useState(false);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const finished = ids.length > 0 && index >= ids.length;
  const currentId = finished ? null : ids[index] ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch(publicUrl('/scenarios/index.json'), { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Catalog unavailable.'); return response.json(); })
      .then(data => {
        if (controller.signal.aborted) return;
        const parsed = catalogSchema.parse(data);
        const todays = dailyIds(eligiblePracticeEntries(parsed, Date.parse(`${day}T12:00:00Z`)), day);
        if (!todays.length) throw new Error('No eligible real replays are available.');
        const saved = loadProgress(day, todays);
        setCatalog(parsed);
        setIds(todays);
        setResults(saved);
        setIndex(saved.length);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(loadError(cause));
      });
    return () => controller.abort();
  }, [retry, day]);

  useEffect(() => {
    setScenario(null);
    if (!catalog || !currentId) return;
    const controller = new AbortController();
    setError('');
    (async () => {
      try {
        const response = await fetch(publicUrl(scenarioPath(catalog, currentId)), { signal: controller.signal });
        if (!response.ok) throw new Error('Scenario unavailable.');
        const data = scenarioSchema.parse(await response.json());
        if (data.id !== currentId) throw new Error('Scenario does not match the catalog.');
        if (!controller.signal.aborted) setScenario(data);
      } catch (cause) {
        if (!controller.signal.aborted) setError(loadError(cause));
      }
    })();
    return () => controller.abort();
  }, [catalog, currentId, retry]);

  const recordGuess = useCallback((result: DailyResult) => setResults(previous => {
    if (previous.length !== index) return previous;
    const next = [...previous, result];
    saveProgress(day, next);
    return next;
  }), [day, index]);
  const onReveal = useCallback(() => setRevealedCurrent(true), []);

  function next() {
    setRevealedCurrent(false);
    setIndex(results.length);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const shown = (position: number) => results[position] && (position < index || revealedCurrent);
  const isLast = index === ids.length - 1;

  return <AssetContext.Provider value={assets}>
    <main className="app-shell">
      <div className="title-bar">
        <div className="question-row">
          <h1>Who dies <span className="question-accent">next</span>?</h1>
        </div>
        {ids.length > 0 && <div className="daily-progress" aria-label={`Daily #${puzzleNumber(day)}: ${finished ? 'complete' : `clip ${index + 1} of ${ids.length}`}`}>
          <span className="daily-number">#{puzzleNumber(day)}</span>
          <ol className="progress-pips" aria-hidden="true">
            {ids.map((id, position) => <li key={id} className={`pip ${shown(position) ? (results[position].correct ? 'won' : 'lost') : ''} ${position === index ? 'current' : ''}`} />)}
          </ol>
        </div>}
      </div>
      {error ? <section className="load-state" role="alert"><p>{error}</p><button onClick={() => setRetry(v => v + 1)}>Retry</button></section>
        : finished ? <DailyResults day={day} results={results} />
          : scenario && scenario.id === currentId ? <Game key={scenario.id} scenario={scenario} clientMap={clientMap} nowMs={nowMs}
            nextLabel={isLast ? 'See results' : 'Next'} onGuess={recordGuess} onReveal={onReveal} onNext={next} />
            : <p className="loading-state" role="status">Loading…</p>}
    </main>
  </AssetContext.Provider>;
}

function useCountdown(): string {
  const [remaining, setRemaining] = useState(() => msUntilNextDay());
  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(msUntilNextDay()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor(remaining / 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function DailyResults({ day, results }: { day: string; results: DailyResult[] }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const countdown = useCountdown();
  const score = results.filter(result => result.correct).length;
  const text = shareText(day, results);
  const verdict = score === DAILY_COUNT ? 'Flawless.' : score >= 4 ? 'Sharp reads.' : score >= 2 ? 'Not bad.' : 'Rough day in the trenches.';

  async function copy() {
    setCopied(await copyText(text) ? 'copied' : 'failed');
  }
  useEffect(() => {
    if (copied !== 'copied') return;
    const timer = window.setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return <section className="daily-results" aria-label="Daily results">
    <p className="results-kicker">Daily #{puzzleNumber(day)} complete</p>
    <p className="results-score"><strong>{score}</strong>/{DAILY_COUNT}</p>
    <p className="results-verdict">{verdict}</p>
    <p className="results-squares" aria-label={`${score} of ${DAILY_COUNT} correct`}>{results.map((result, position) => <span key={position}>{resultEmoji(result.correct)}</span>)}</p>
    <ol className="results-list">
      {results.map((result, position) => <li key={result.id} className={result.correct ? 'won' : 'lost'}>
        <span className="results-index">{position + 1}</span>
        <span className="results-pick"><HeroPortrait hero={result.picked} size={32} /><span><small>You picked</small>{result.picked.name}</span></span>
        <span className="results-answer"><HeroPortrait hero={result.answer} size={32} /><span><small>Died first</small>{result.answer.name}</span></span>
        <span className="results-mark" aria-label={result.correct ? 'Correct' : 'Incorrect'}>{result.correct ? '✓' : '✗'}</span>
      </li>)}
    </ol>
    <button className={`primary-button copy-button ${copied}`} onClick={copy}>{copied === 'copied' ? 'Copied!' : 'Copy result'}</button>
    {copied === 'failed' && <textarea className="share-fallback" readOnly value={text} aria-label="Result to share" onFocus={event => event.currentTarget.select()} />}
    <p className="results-next">Next puzzle in <time>{countdown}</time></p>
  </section>;
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

function Game({ scenario, clientMap, nowMs, nextLabel, onGuess, onReveal, onNext }: {
  scenario: Scenario; clientMap: ClientMap | null; nowMs: number; nextLabel: string;
  onGuess: (result: DailyResult) => void; onReveal: () => void; onNext: () => void;
}) {
  const assets = useContext(AssetContext);
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
    onReveal();
  }, [locked, revealed, time, revealAt, onReveal]);
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
    const ref = (id: string) => {
      const option = options.find(candidate => candidate.id === id)!;
      return { id: option.id, name: option.name, team: option.team };
    };
    onGuess({ id: scenario.id, correct: selected === answerId, picked: ref(selected), answer: ref(answerId) });
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
              <button className={`next-button ${revealed ? 'ready' : ''}`} disabled={!locked}
                title={locked ? undefined : 'Guess first'} onClick={() => { setPlaying(false); onNext(); }}>{nextLabel}</button>
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
