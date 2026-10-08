/** Data sources, CSV import, API keys, execution assumptions, risk and trading rules. */
import { useEffect, useState } from 'react';
import { useSettings } from '../state/settingsStore';
import { useCredentials } from '../state/credentials';
import { csvProvider, deleteCsvDataset, saveCsvDataset } from '../state/dataRegistry';
import { applyExecutionConfig } from '../state/tradingStore';
import { parseCsv, type CsvParseResult } from '../../core/data/csv';
import type { CsvDataset } from '../../core/data/csvProvider';
import { deleteEncrypted, hasEncrypted, loadEncrypted, saveEncrypted } from '../services/secureStore';
import { NumberField, SourceBadge } from '../components/common';
import { toast } from '../state/toasts';
import { dateTime } from '../services/format';
import { DEMO_TICKERS } from '../../core/data/demoProvider';

/** NumberField handler that ignores the transient empty value while typing. */
function num(set: (v: number) => void) {
  return (v: number | '') => {
    if (v !== '' && Number.isFinite(v)) set(v);
  };
}

export function SettingsPage() {
  return (
    <div className="page">
      <div className="page-inner stack" style={{ gap: 16 }}>
        <h1>Data &amp; Settings</h1>
        <DataSourcesCard />
        <CsvImportCard />
        <ApiKeysCard />
        <ExecutionCard />
        <RiskCard />
        <GeneralCard />
      </div>
    </div>
  );
}

function DataSourcesCard() {
  return (
    <div className="card stack">
      <h2>Data sources</h2>
      <p className="muted small">Every chart, trade and journal entry is labelled with where its prices came from. Nothing is ever mixed silently.</p>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row wrap">
          <SourceBadge source="DEMO" />
          <span className="small">
            Bundled, offline, synthetic bars for {DEMO_TICKERS.map((t) => t.symbol).join(', ')}. Realistic intraday structure (open volatility, lunch lull, trends, gaps, earnings days) but <b>not the real prices</b> for those dates. Use it to practise mechanics; use real data to study real tape.
          </span>
        </div>
        <div className="row wrap">
          <SourceBadge source="HISTORICAL" />
          <span className="small">Real recorded bars: your CSV imports, or Polygon / Alpaca with an API key.</span>
        </div>
        <div className="row wrap">
          <SourceBadge source="SIMULATED" />
          <span className="small">The fictional market. Made-up companies, prices and news.</span>
        </div>
        <div className="row wrap">
          <SourceBadge source="LIVE" />
          <span className="small">Not available in this version. The app is for practice when markets are closed; there is no live feed and no real-money trading.</span>
        </div>
      </div>
    </div>
  );
}

function CsvImportCard() {
  const [datasets, setDatasets] = useState<CsvDataset[]>(csvProvider.list());
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [symbol, setSymbol] = useState('');
  const [tz, setTz] = useState<'exchange' | 'utc'>('exchange');
  const [closeStamped, setCloseStamped] = useState(false);
  const [parsed, setParsed] = useState<CsvParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    try {
      setParsed(parseCsv(file.text, { naiveTimezone: tz, timestampsAreBarClose: closeStamped }));
      setError(null);
    } catch (e) {
      setParsed(null);
      setError((e as Error).message);
    }
  }, [file, tz, closeStamped]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) {
      setError('File is larger than 200 MB. Split it by year or symbol.');
      return;
    }
    const text = await f.text();
    setFile({ name: f.name, text });
    const guess = f.name.replace(/\.(csv|txt)$/i, '').split(/[_\-\s.]/)[0].toUpperCase();
    if (!symbol && /^[A-Z.]{1,8}$/.test(guess)) setSymbol(guess);
  };

  const save = async () => {
    if (!parsed || !symbol.trim() || !file) return;
    const d: CsvDataset = { symbol: symbol.trim().toUpperCase(), name: symbol.trim().toUpperCase(), baseTimeframe: parsed.baseTimeframe, bars: parsed.bars, importedAt: Date.now(), fileName: file.name };
    try {
      await saveCsvDataset(d);
      setDatasets(csvProvider.list());
      toast('success', `Imported ${parsed.bars.length.toLocaleString('en-US')} ${parsed.baseTimeframe} bars for ${d.symbol}.`);
      setFile(null);
      setParsed(null);
      setSymbol('');
    } catch (e) {
      setError(`Could not save: ${(e as Error).message}`);
    }
  };

  return (
    <div className="card stack">
      <h2>Import historical data (CSV)</h2>
      <p className="muted small">
        Bring your own real bars, for example an export from your broker, TradingView or a data vendor. Needs columns for time, open, high, low, close and (ideally) volume. Epoch, ISO and US date formats are recognised. Intraday bars give the most realistic fills; 1-minute is best. Data stays in this browser.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>CSV file</span>
          <input type="file" accept=".csv,.txt,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <label className="field">
          <span>Ticker</span>
          <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="e.g. AAPL" />
        </label>
        <label className="field">
          <span>Timestamps without a timezone are</span>
          <select value={tz} onChange={(e) => setTz(e.target.value as 'exchange' | 'utc')}>
            <option value="exchange">New York (exchange) time</option>
            <option value="utc">UTC</option>
          </select>
        </label>
        <label className="check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={closeStamped} onChange={(e) => setCloseStamped(e.target.checked)} /> Timestamps mark the bar close
        </label>
      </div>
      {error && <div className="alert error">{error}</div>}
      {parsed && (
        <div className="alert info">
          {parsed.rowsRead.toLocaleString('en-US')} rows read, {parsed.bars.length.toLocaleString('en-US')} valid {parsed.baseTimeframe} bars, {parsed.rowsSkipped} skipped. Range {dateTime(parsed.firstTime)} to {dateTime(parsed.lastTime)} ET.
          {parsed.warnings.map((w, i) => (
            <div key={i} className="warn">
              {w}
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <div className="spacer" />
        <button className="btn primary" disabled={!parsed || !parsed.bars.length || !symbol.trim()} onClick={() => void save()}>
          Save dataset
        </button>
      </div>
      {datasets.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Bars</th>
              <th>Timeframe</th>
              <th>Range</th>
              <th>File</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.symbol}>
                <td>
                  <b>{d.symbol}</b>
                </td>
                <td>{d.bars.length.toLocaleString('en-US')}</td>
                <td>{d.baseTimeframe}</td>
                <td className="mono small">
                  {d.bars.length ? `${dateTime(d.bars[0].time)} → ${dateTime(d.bars[d.bars.length - 1].time)}` : '—'}
                </td>
                <td className="muted small">{d.fileName}</td>
                <td className="num">
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete the imported data for ${d.symbol}?`)) return;
                      await deleteCsvDataset(d.symbol);
                      setDatasets(csvProvider.list());
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ApiKeysCard() {
  const { creds, set, clear, checkServer, serverChecked } = useCredentials();
  const alpacaFeed = useSettings((s) => s.alpacaFeed);
  const update = useSettings((s) => s.update);
  const [polygon, setPolygon] = useState('');
  const [alpacaId, setAlpacaId] = useState('');
  const [alpacaSecret, setAlpacaSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [stored, setStored] = useState(false);

  useEffect(() => {
    void hasEncrypted().then(setStored);
    if (!serverChecked) void checkServer();
  }, [serverChecked, checkServer]);

  const applySession = () => {
    const patch: Record<string, string> = {};
    if (polygon.trim()) patch.polygonApiKey = polygon.trim();
    if (alpacaId.trim()) patch.alpacaKeyId = alpacaId.trim();
    if (alpacaSecret.trim()) patch.alpacaSecret = alpacaSecret.trim();
    if (!Object.keys(patch).length) return toast('warning', 'Enter at least one key.');
    set(patch);
    setPolygon('');
    setAlpacaId('');
    setAlpacaSecret('');
    toast('success', 'Keys loaded for this browser session only. They are gone when you reload.');
  };

  const saveEnc = async () => {
    if (passphrase.length < 8) return toast('warning', 'Use a passphrase of at least 8 characters.');
    const merged = { ...creds, ...(polygon.trim() && { polygonApiKey: polygon.trim() }), ...(alpacaId.trim() && { alpacaKeyId: alpacaId.trim() }), ...(alpacaSecret.trim() && { alpacaSecret: alpacaSecret.trim() }) };
    if (!merged.polygonApiKey && !merged.alpacaKeyId) return toast('warning', 'Enter at least one key.');
    await saveEncrypted({ polygonApiKey: merged.polygonApiKey, alpacaKeyId: merged.alpacaKeyId, alpacaSecret: merged.alpacaSecret }, passphrase);
    set(merged);
    setStored(true);
    setPassphrase('');
    setPolygon('');
    setAlpacaId('');
    setAlpacaSecret('');
    toast('success', 'Keys encrypted (AES-GCM) and saved in this browser.');
  };

  const unlock = async () => {
    try {
      set(await loadEncrypted(passphrase));
      setPassphrase('');
      toast('success', 'Saved keys unlocked for this session.');
    } catch {
      toast('error', 'Wrong passphrase, or the stored keys are damaged.');
    }
  };

  const mask = (v?: string) => (v ? `••••${v.slice(-4)}` : 'not set');

  return (
    <div className="card stack">
      <h2>Market data API keys (optional)</h2>
      <p className="muted small">
        Keys are never hard-coded and never sent anywhere except the vendor, through this app's local proxy. By default they live in memory for this session only. You can save them encrypted with a passphrase, or put them in <code>.env.local</code> on the machine running the app so the browser never sees them (see README).
      </p>
      <div className="kv">
        <span className="k">Polygon</span>
        <span>
          {mask(creds.polygonApiKey)}
          {creds.serverHasPolygonKey ? ' · server key configured' : ''}
        </span>
        <span className="k">Alpaca</span>
        <span>
          {mask(creds.alpacaKeyId)}
          {creds.serverHasAlpacaKey ? ' · server key configured' : ''}
        </span>
        <span className="k">Encrypted copy</span>
        <span>{stored ? 'saved in this browser' : 'none'}</span>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Polygon API key</span>
          <input type="password" autoComplete="off" value={polygon} onChange={(e) => setPolygon(e.target.value)} />
        </label>
        <label className="field">
          <span>Alpaca key ID</span>
          <input type="password" autoComplete="off" value={alpacaId} onChange={(e) => setAlpacaId(e.target.value)} />
        </label>
        <label className="field">
          <span>Alpaca secret</span>
          <input type="password" autoComplete="off" value={alpacaSecret} onChange={(e) => setAlpacaSecret(e.target.value)} />
        </label>
        <label className="field">
          <span>Alpaca feed</span>
          <select value={alpacaFeed} onChange={(e) => update({ alpacaFeed: e.target.value as 'iex' | 'sip' })}>
            <option value="iex">IEX (free, partial volume)</option>
            <option value="sip">SIP (paid, full tape)</option>
          </select>
        </label>
        <label className="field">
          <span>Passphrase (for encrypted storage)</span>
          <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </label>
      </div>
      <div className="row wrap">
        <button className="btn" onClick={applySession}>
          Use for this session
        </button>
        <button className="btn" onClick={() => void saveEnc()}>
          Save encrypted
        </button>
        {stored && (
          <button className="btn" onClick={() => void unlock()}>
            Unlock saved keys
          </button>
        )}
        <div className="spacer" />
        <button className="btn ghost" onClick={clear}>
          Forget session keys
        </button>
        {stored && (
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm('Delete the encrypted keys stored in this browser?')) return;
              await deleteEncrypted();
              setStored(false);
            }}
          >
            Delete saved keys
          </button>
        )}
      </div>
    </div>
  );
}

function ExecutionCard() {
  const exec = useSettings((s) => s.execution);
  const updateExecution = useSettings((s) => s.updateExecution);
  const upd = (patch: Parameters<typeof updateExecution>[0]) => {
    updateExecution(patch);
    applyExecutionConfig();
  };
  return (
    <div className="card stack">
      <h2>Execution model</h2>
      <p className="muted small">
        Fills are simulated from bar data, so these are assumptions, not a real order book. Defaults suit a liquid large-cap stock. Changes apply to the running session from the next fill.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Spread model</span>
          <select value={exec.spread.mode} onChange={(e) => upd({ spread: { ...exec.spread, mode: e.target.value as 'bps' | 'cents' } })}>
            <option value="bps">Basis points of price</option>
            <option value="cents">Fixed dollars</option>
          </select>
        </label>
        <NumberField label="Spread (bid to ask)" suffix={exec.spread.mode === 'bps' ? 'bps' : '$'} value={exec.spread.value} step={exec.spread.mode === 'bps' ? 0.5 : 0.01} min={0} onChange={num((v) => upd({ spread: { ...exec.spread, value: v } }))} />
        <NumberField label="Minimum spread" suffix="$" value={exec.spread.minimum} step={0.01} min={0} onChange={num((v) => upd({ spread: { ...exec.spread, minimum: v } }))} />
        <NumberField label="Extended-hours spread" suffix="× regular" value={exec.spread.extendedHoursMultiplier} step={0.5} min={1} onChange={num((v) => upd({ spread: { ...exec.spread, extendedHoursMultiplier: v } }))} />
        <NumberField label="Slippage" suffix="bps" value={exec.slippage.bps} step={0.5} min={0} onChange={num((v) => upd({ slippage: { ...exec.slippage, bps: v } }))} />
        <NumberField label="Market impact" suffix="bps per 1% of bar volume" value={exec.slippage.impactBpsPerPctOfVolume} step={1} min={0} onChange={num((v) => upd({ slippage: { ...exec.slippage, impactBpsPerPctOfVolume: v } }))} />
        <NumberField label="Commission per share" suffix="$" value={exec.commission.perShare} step={0.001} min={0} onChange={num((v) => upd({ commission: { ...exec.commission, perShare: v } }))} />
        <NumberField label="Commission per order" suffix="$" value={exec.commission.perOrder} step={0.5} min={0} onChange={num((v) => upd({ commission: { ...exec.commission, perOrder: v } }))} />
        <NumberField label="Minimum commission" suffix="$" value={exec.commission.minimumPerOrder} step={0.5} min={0} onChange={num((v) => upd({ commission: { ...exec.commission, minimumPerOrder: v } }))} />
        <label className="field">
          <span>Market orders fill at</span>
          <select value={exec.marketOrderFill} onChange={(e) => upd({ marketOrderFill: e.target.value as 'last_price' | 'next_bar_open' })}>
            <option value="last_price">Last price (+ spread, slippage)</option>
            <option value="next_bar_open">Next bar open (conservative)</option>
          </select>
        </label>
        <label className="field">
          <span>Limit orders fill when price</span>
          <select value={exec.limitFill} onChange={(e) => upd({ limitFill: e.target.value as 'touch' | 'trade_through' })}>
            <option value="touch">Touches the limit</option>
            <option value="trade_through">Trades through by one tick</option>
          </select>
        </label>
        <label className="field">
          <span>Inside a bar, assume price went</span>
          <select value={exec.intrabarPath} onChange={(e) => upd({ intrabarPath: e.target.value as 'ohlc' | 'worst_case' })}>
            <option value="ohlc">Open → nearer extreme → other → close</option>
            <option value="worst_case">Worst case for my position first</option>
          </select>
        </label>
        <NumberField label="Max share of bar volume" suffix="% · 0 = no cap" value={Math.round(exec.maxParticipation * 100)} step={5} min={0} max={100} onChange={num((v) => upd({ maxParticipation: v / 100 }))} />
        <label className="field">
          <span>Account type</span>
          <select value={exec.marginMultiplier} onChange={(e) => upd({ marginMultiplier: Number(e.target.value) })}>
            <option value={1}>Cash (1×, no leverage)</option>
            <option value={2}>Reg T margin (2×)</option>
            <option value={4}>Intraday margin (4×)</option>
          </select>
        </label>
      </div>
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="check">
          <input type="checkbox" checked={exec.allowShortSelling} onChange={(e) => upd({ allowShortSelling: e.target.checked })} /> Allow short selling
        </label>
        <label className="check">
          <input type="checkbox" checked={exec.allowExtendedHours} onChange={(e) => upd({ allowExtendedHours: e.target.checked })} /> Allow extended-hours orders
        </label>
      </div>
    </div>
  );
}

function RiskCard() {
  const exec = useSettings((s) => s.execution);
  const updateExecution = useSettings((s) => s.updateExecution);
  const rules = useSettings((s) => s.rules);
  const updateRules = useSettings((s) => s.updateRules);
  const sr = exec.strictRisk;
  const setStrict = (patch: Partial<typeof sr>) => {
    updateExecution({ strictRisk: { ...sr, ...patch } });
    applyExecutionConfig();
  };
  return (
    <div className="card stack">
      <h2>Risk management</h2>
      <div className="two-col">
        <div className="stack">
          <h3>Strict mode</h3>
          <p className="muted small">Off by default: the ticket warns but lets you place any trade. When on, orders that break these limits are rejected.</p>
          <label className="check">
            <input type="checkbox" checked={sr.enabled} onChange={(e) => setStrict({ enabled: e.target.checked })} /> Block orders that break these limits
          </label>
          <div className="form-grid">
            <NumberField label="Max risk per trade" suffix="% of equity" value={sr.maxRiskPctPerTrade} step={0.25} min={0.1} onChange={num((v) => setStrict({ maxRiskPctPerTrade: v }))} />
            <NumberField label="Max daily loss" suffix="% of equity" value={sr.maxDailyLossPct} step={0.5} min={0.5} onChange={num((v) => setStrict({ maxDailyLossPct: v }))} />
            <NumberField label="Max position size" suffix="% of equity" value={sr.maxPositionPctOfEquity} step={10} min={1} onChange={num((v) => setStrict({ maxPositionPctOfEquity: v }))} />
          </div>
          <label className="check">
            <input type="checkbox" checked={sr.requireStopLoss} onChange={(e) => setStrict({ requireStopLoss: e.target.checked })} /> Require a stop loss on every entry
          </label>
        </div>
        <div className="stack">
          <h3>My trading rules</h3>
          <p className="muted small">Used by Learning Mode reviews and the &ldquo;follow your rules&rdquo; challenge. They never block orders.</p>
          <div className="form-grid">
            <NumberField label="Max risk per trade" suffix="%" value={rules.maxRiskPctPerTrade} step={0.25} min={0.1} onChange={num((v) => updateRules({ maxRiskPctPerTrade: v }))} />
            <NumberField label="Min reward:risk" suffix=":1" value={rules.minRewardRisk} step={0.25} min={0} onChange={num((v) => updateRules({ minRewardRisk: v }))} />
            <NumberField label="Max trades per day" value={rules.maxTradesPerDay} step={1} min={1} onChange={num((v) => updateRules({ maxTradesPerDay: Math.round(v) }))} />
            <NumberField label="No trades in first" suffix="min · 0 = off" value={rules.noTradesFirstMinutes} step={5} min={0} onChange={num((v) => updateRules({ noTradesFirstMinutes: Math.round(v) }))} />
            <NumberField label="Max daily loss" suffix="%" value={rules.maxDailyLossPct} step={0.5} min={0.5} onChange={num((v) => updateRules({ maxDailyLossPct: v }))} />
          </div>
          <label className="check">
            <input type="checkbox" checked={rules.requireStopLoss} onChange={(e) => updateRules({ requireStopLoss: e.target.checked })} /> Every trade needs a stop loss
          </label>
        </div>
      </div>
    </div>
  );
}

function GeneralCard() {
  const s = useSettings();
  const [watch, setWatch] = useState(s.watchlist.join(', '));
  return (
    <div className="card stack">
      <h2>General</h2>
      <div className="form-grid">
        <NumberField label="Default starting balance" suffix="$" value={s.defaultBalance} step={1000} min={100} onChange={num((v) => s.update({ defaultBalance: v }))} />
        <label className="field" style={{ gridColumn: 'span 2' }}>
          <span>Watchlist (comma separated)</span>
          <input
            type="text"
            value={watch}
            onChange={(e) => setWatch(e.target.value)}
            onBlur={() => {
              const list = [...new Set(watch.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
              s.update({ watchlist: list });
              setWatch(list.join(', '));
            }}
          />
        </label>
      </div>
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="check">
          <input type="checkbox" checked={s.learningMode} onChange={(e) => s.update({ learningMode: e.target.checked })} /> Learning Mode: pause and review each trade when it closes
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoSnapshot} onChange={(e) => s.update({ autoSnapshot: e.target.checked })} /> Save a chart snapshot with each journal entry
        </label>
      </div>
      <div className="row">
        <div className="spacer" />
        <button
          className="btn danger"
          onClick={() => {
            if (!window.confirm('Reset all settings to their defaults? Your journal, imported data and keys are kept.')) return;
            s.reset();
            setWatch(useSettings.getState().watchlist.join(', '));
            applyExecutionConfig();
          }}
        >
          Reset settings
        </button>
      </div>
    </div>
  );
}
