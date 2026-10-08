/** New-session dialog: historical replay setup or simulated market setup. */
import { useEffect, useMemo, useState } from 'react';
import { Modal, SourceBadge, NumberField } from './common';
import { HISTORICAL_PROVIDERS, demoProvider } from '../state/dataRegistry';
import { useSettings } from '../state/settingsStore';
import { REPLAY_SPEEDS, SIM_SPEEDS, play, startReplay, startSim, useTrading } from '../state/tradingStore';
import { TIMEFRAMES, type Timeframe } from '../../core/types';
import type { SymbolInfo } from '../../core/data/provider';
import { DEFAULT_LOOKBACK } from '../../core/replay/ReplaySession';
import { CHALLENGES } from '../../core/challenges/challenges';
import { SIM_STOCKS, type SimConfig } from '../../core/sim/SimMarket';
import { exchangeDate, isTradingDay, nextTradingDay, parseHHMM, tradingDayOnOrBefore } from '../../core/time';
import { DEMO_FIRST_DATE } from '../../core/data/demoProvider';
import { useCredentials } from '../state/credentials';

export type SetupMode = 'replay' | 'sim';

export function SessionSetup({ mode: initialMode, onClose, presetChallenge }: { mode: SetupMode; onClose: () => void; presetChallenge?: string }) {
  const [mode, setMode] = useState<SetupMode>(initialMode);
  return (
    <Modal title="New session" onClose={onClose} wide>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={mode === 'replay' ? 'on' : ''} onClick={() => setMode('replay')}>
          Historical replay
        </button>
        <button className={mode === 'sim' ? 'on' : ''} onClick={() => setMode('sim')}>
          Simulated market
        </button>
      </div>
      {mode === 'replay' ? <ReplayForm onDone={onClose} presetChallenge={presetChallenge} /> : <SimForm onDone={onClose} presetChallenge={presetChallenge} />}
    </Modal>
  );
}

function randomTradingDay(from: string, to: string): string {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  const d = new Date(a + Math.random() * (b - a)).toISOString().slice(0, 10);
  return tradingDayOnOrBefore(d) < from ? nextTradingDay(from) : tradingDayOnOrBefore(d);
}

function ReplayForm({ onDone, presetChallenge }: { onDone: () => void; presetChallenge?: string }) {
  const settings = useSettings();
  const r = settings.replay;
  useCredentials((s) => s.creds); // re-render when keys change provider availability
  const loading = useTrading((s) => s.loading);
  const [providerId, setProviderId] = useState(r.providerId);
  const [symbol, setSymbol] = useState(r.symbol);
  const [date, setDate] = useState(r.date);
  const [startTime, setStartTime] = useState(r.startTime);
  const [endTime, setEndTime] = useState(r.endTime);
  const [multiDay, setMultiDay] = useState(r.multiDay);
  const [endDate, setEndDate] = useState(r.endDate);
  const [timeframe, setTimeframe] = useState<Timeframe>(r.timeframe);
  const [speed, setSpeed] = useState(r.speed);
  const [balance, setBalance] = useState<number | ''>(settings.defaultBalance);
  const [includeWatchlist, setIncludeWatchlist] = useState(r.includeWatchlist);
  const [blind, setBlind] = useState(r.blind);
  const [challengeId, setChallengeId] = useState(presetChallenge ?? '');
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const provider = HISTORICAL_PROVIDERS.find((p) => p.id === providerId) ?? demoProvider;
  const unavailable = provider.unavailableReason();

  useEffect(() => {
    let alive = true;
    provider
      .listSymbols()
      .then((s) => alive && setSymbols(s))
      .catch(() => alive && setSymbols([]));
    return () => {
      alive = false;
    };
  }, [provider]);

  useEffect(() => {
    let alive = true;
    setRange(null);
    provider
      .availableRange(symbol.toUpperCase())
      .then((rg) => alive && setRange(rg ? { from: exchangeDate(rg.from), to: exchangeDate(rg.to) } : null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [provider, symbol]);

  useEffect(() => {
    if (!challengeId) return;
    const def = CHALLENGES.find((c) => c.id === challengeId);
    if (def) {
      setBalance(def.setup.startingBalance);
      if (def.setup.multiDay) setMultiDay(true);
    }
  }, [challengeId]);

  const validation = useMemo(() => {
    if (unavailable) return unavailable;
    if (!symbol.trim()) return 'Choose a ticker.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Choose a date.';
    if (!isTradingDay(date)) return `${date} is not a trading day (weekend or NYSE holiday).`;
    if (range && (date < range.from || date > range.to)) return `Data for ${symbol.toUpperCase()} covers ${range.from} to ${range.to}.`;
    const s = parseHHMM(startTime);
    const e = parseHHMM(endTime);
    if (s === null || e === null) return 'Enter start and end times as HH:MM.';
    if (multiDay) {
      if (endDate < date) return 'End date must be on or after the start date.';
      if (range && endDate > range.to) return `Data ends on ${range.to}.`;
    } else if (e <= s) return 'End time must be after the start time.';
    if (typeof balance !== 'number' || balance < 100) return 'Starting balance must be at least $100.';
    if (timeframe === '1D' && !multiDay) return 'The daily timeframe needs a multi-day replay.';
    return null;
  }, [unavailable, symbol, date, range, startTime, endTime, multiDay, endDate, balance, timeframe]);

  const extraSymbols = includeWatchlist ? settings.watchlist.filter((s) => s !== symbol.toUpperCase() && (providerId !== 'demo' && providerId !== 'csv' ? true : symbols.some((x) => x.symbol === s))) : [];

  const submit = async () => {
    if (validation) return;
    setError(null);
    settings.updateReplay({ providerId, symbol: symbol.toUpperCase(), date, startTime, endTime, multiDay, endDate, timeframe, speed, includeWatchlist, blind });
    const ok = await startReplay({
      providerId,
      symbol: symbol.toUpperCase(),
      extraSymbols: extraSymbols.slice(0, 7),
      date,
      startTime,
      endTime,
      endDate: multiDay ? endDate : undefined,
      startingBalance: balance as number,
      lookbackDays: DEFAULT_LOOKBACK[timeframe],
      timeframe,
      speed,
      blind,
      challengeId: challengeId || undefined,
    });
    if (ok) onDone();
    else setError(useTrading.getState().error ?? 'Could not start the replay.');
  };

  return (
    <div className="stack">
      <div className="form-grid">
        <label className="field">
          <span>Data source</span>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {HISTORICAL_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.unavailableReason() ? ' (not set up)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Ticker</span>
          <input type="text" list="setup-symbols" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <datalist id="setup-symbols">
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.name}
              </option>
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>{multiDay ? 'Start date' : 'Date'}</span>
          <input type="date" value={date} min={range?.from ?? DEMO_FIRST_DATE} max={range?.to} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Start time (ET)</span>
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>
        {multiDay && (
          <label className="field">
            <span>End date</span>
            <input type="date" value={endDate} min={date} max={range?.to} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>End time (ET)</span>
          <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </label>
        <label className="field">
          <span>Chart timeframe</span>
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            {TIMEFRAMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Starting balance" suffix="$" value={balance} min={100} step={1000} onChange={setBalance} disabled={!!challengeId} />
        <label className="field">
          <span>Replay speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Challenge (optional)</span>
          <select value={challengeId} onChange={(e) => setChallengeId(e.target.value)}>
            <option value="">None</option>
            {CHALLENGES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="check">
          <input type="checkbox" checked={multiDay} onChange={(e) => setMultiDay(e.target.checked)} /> Multi-day replay
        </label>
        <label className="check">
          <input type="checkbox" checked={includeWatchlist} onChange={(e) => setIncludeWatchlist(e.target.checked)} /> Also replay watchlist symbols on the same clock
        </label>
        <label className="check" title="Hides the calendar date so you cannot recall what happened that day.">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> Blind mode (hide the date)
        </label>
        <button
          className="btn sm"
          onClick={() => {
            const from = range?.from ?? DEMO_FIRST_DATE;
            const to = range?.to ?? demoProvider.lastDate;
            const d = randomTradingDay(from, to);
            setDate(d);
            if (multiDay) {
              let e = d;
              for (let i = 0; i < 4; i++) e = nextTradingDay(e);
              setEndDate(e > to ? to : e);
            }
          }}
        >
          Random date
        </button>
      </div>
      <div className="row wrap small">
        {provider.source && <SourceBadge source={provider.source} />}
        <span className="muted">
          {providerId === 'demo'
            ? 'Bundled demo bars are synthetic: realistic intraday behaviour, but not the real prices for that ticker and date.'
            : providerId === 'csv'
              ? 'Replays bars you imported in Data & Settings.'
              : 'Downloads real 1-minute bars through the local proxy (requires npm run dev or npm run preview).'}
        </span>
      </div>
      {range && <div className="small muted">Available data: {range.from} to {range.to}</div>}
      {extraSymbols.length > 0 && <div className="small muted">Also loading: {extraSymbols.slice(0, 7).join(', ')}</div>}
      {validation && <div className="alert warn">{validation}</div>}
      {error && <div className="alert error">{error}</div>}
      <div className="row">
        <div className="spacer" />
        <button className="btn primary" disabled={!!validation || loading} onClick={() => void submit()}>
          {loading ? 'Loading data…' : 'Start replay'}
        </button>
      </div>
    </div>
  );
}

function SimForm({ onDone, presetChallenge }: { onDone: () => void; presetChallenge?: string }) {
  const settings = useSettings();
  const sim = settings.sim;
  const [balance, setBalance] = useState<number | ''>(sim.startingBalance);
  const [seed, setSeed] = useState<number | ''>('');
  const [vol, setVol] = useState(sim.volatilityMultiplier);
  const [events, setEvents] = useState(sim.eventFrequency);
  const [trend, setTrend] = useState(sim.trendStrength);
  const [regime, setRegime] = useState<SimConfig['marketRegime']>(sim.marketRegime);
  const [speed, setSpeed] = useState(sim.speed);
  const [challengeId, setChallengeId] = useState(presetChallenge && !CHALLENGES.find((c) => c.id === presetChallenge)?.requiresSessionEnd ? presetChallenge : '');

  useEffect(() => {
    const def = CHALLENGES.find((c) => c.id === challengeId);
    if (def) setBalance(def.setup.startingBalance);
  }, [challengeId]);

  const invalid = typeof balance !== 'number' || balance < 100 ? 'Starting balance must be at least $100.' : null;

  const start = () => {
    if (invalid) return;
    const s = seed === '' ? Math.floor(Math.random() * 2 ** 31) : seed;
    settings.update({ sim: { ...sim, volatilityMultiplier: vol, eventFrequency: events, trendStrength: trend, marketRegime: regime, speed, startingBalance: balance as number } });
    startSim({ config: { seed: s, volatilityMultiplier: vol, eventFrequency: events, trendStrength: trend, marketRegime: regime }, startingBalance: balance as number, speed, challengeId: challengeId || undefined });
    play();
    onDone();
  };

  return (
    <div className="stack">
      <div className="alert info">
        A fictional market of six made-up companies. Prices, regimes and news are generated by a stochastic model and are clearly labelled SIMULATED. It never uses or imitates real tickers.
      </div>
      <div className="small muted">
        Stocks: {SIM_STOCKS.map((s) => `${s.symbol} (${s.personality.replace('_', ' ')})`).join(' · ')}
      </div>
      <div className="form-grid">
        <NumberField label="Starting balance" suffix="$" value={balance} min={100} step={1000} onChange={setBalance} disabled={!!challengeId} />
        <NumberField label="Seed" suffix="blank = random" value={seed} step={1} onChange={setSeed} />
        <label className="field">
          <span>Volatility · {vol.toFixed(1)}x</span>
          <input type="range" min={0.3} max={3} step={0.1} value={vol} onChange={(e) => setVol(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>News frequency · {events.toFixed(1)}x</span>
          <input type="range" min={0} max={4} step={0.1} value={events} onChange={(e) => setEvents(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Trend strength · {trend.toFixed(1)}x</span>
          <input type="range" min={0} max={3} step={0.1} value={trend} onChange={(e) => setTrend(Number(e.target.value))} />
        </label>
        <label className="field">
          <span>Market regime</span>
          <select value={regime} onChange={(e) => setRegime(e.target.value as SimConfig['marketRegime'])}>
            <option value="auto">Random phases (hidden)</option>
            <option value="bull">Bull</option>
            <option value="bear">Bear</option>
            <option value="neutral">Sideways / neutral</option>
          </select>
        </label>
        <label className="field">
          <span>Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SIM_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Challenge (optional)</span>
          <select value={challengeId} onChange={(e) => setChallengeId(e.target.value)}>
            <option value="">None</option>
            {CHALLENGES.filter((c) => !c.requiresSessionEnd).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {invalid && <div className="alert warn">{invalid}</div>}
      <div className="row">
        <div className="spacer" />
        <button className="btn primary" disabled={!!invalid} onClick={start}>
          Start market
        </button>
      </div>
    </div>
  );
}
