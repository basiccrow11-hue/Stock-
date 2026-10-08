/** Appearance controls: app theme, accent and chart styling, plus a live chart preview. */
import { useEffect, useRef, useState } from 'react';
import { HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useSettings } from '../state/settingsStore';
import { ACCENTS, CHART_STYLES, THEMES, THEME_IDS, candlePresets, type ChartColors, type ChartStyle, type PriceScaleKind } from '../theme/themes';
import { useTheme } from '../theme/useTheme';
import { contrast, normHex } from '../theme/color';
import { addMainSeries, chartOptions, mainPoint, mainSeriesOptions, priceScaleMode, type MainSeries } from '../chart/chartTheme';
import { CHART_LOCALE } from '../services/format';
import type { Bar } from '../../core/types';

const COLOR_INPUT_STYLE = { width: 30, height: 26, padding: 0, border: 0, background: 'none', cursor: 'pointer' } as const;

function ColorField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string | null }) {
  return (
    <label className="color-field" title={hint ?? undefined}>
      <input type="color" value={value} onChange={(e) => onChange(normHex(e.target.value))} style={COLOR_INPUT_STYLE} aria-label={label} />
      <span className="color-field-text">
        <span>{label}</span>
        <span className="mono muted small">{value}</span>
      </span>
      {hint && (
        <span className="color-warn" aria-label={hint}>
          !
        </span>
      )}
    </label>
  );
}

export function ThemePicker() {
  const theme = useSettings((s) => s.appearance.theme);
  const applyTheme = useSettings((s) => s.applyTheme);
  return (
    <div className="theme-tiles" role="radiogroup" aria-label="App theme">
      {THEME_IDS.map((id) => {
        const t = THEMES[id];
        return (
          <button key={id} role="radio" aria-checked={theme === id} className={`theme-tile${theme === id ? ' on' : ''}`} onClick={() => applyTheme(id)}>
            <span className="theme-swatch" style={{ background: t.ui.bg, borderColor: t.ui.border }}>
              <span style={{ background: t.ui.panel, borderColor: t.ui.border }} />
              <span style={{ background: t.chart.background, borderColor: t.ui.border }}>
                <i style={{ background: '#26a69a', height: 14, marginTop: 6 }} />
                <i style={{ background: '#ef5350', height: 10, marginTop: 9 }} />
                <i style={{ background: '#26a69a', height: 16, marginTop: 3 }} />
              </span>
            </span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AccentPicker() {
  const accent = useSettings((s) => s.appearance.accent);
  const update = useSettings((s) => s.updateAppearance);
  return (
    <div className="row wrap" style={{ gap: 6 }} role="radiogroup" aria-label="Accent colour">
      {ACCENTS.map((c) => (
        <button key={c} role="radio" aria-checked={accent === c} aria-label={c} className={`swatch${accent === c ? ' on' : ''}`} style={{ background: c }} onClick={() => update({ accent: c })} />
      ))}
      <label className="swatch custom" title="Custom accent colour">
        <input type="color" value={accent} onChange={(e) => update({ accent: normHex(e.target.value) })} aria-label="Custom accent colour" />
      </label>
    </div>
  );
}

export function ChartStylePicker() {
  const style = useSettings((s) => s.appearance.chartStyle);
  const update = useSettings((s) => s.updateAppearance);
  return (
    <div className="seg" role="group" aria-label="Chart type">
      {CHART_STYLES.map((s) => (
        <button key={s.id} className={style === s.id ? 'on' : ''} onClick={() => update({ chartStyle: s.id as ChartStyle })}>
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function CandlePresetPicker() {
  const a = useSettings((s) => s.appearance);
  const apply = useSettings((s) => s.applyCandlePreset);
  const presets = candlePresets(THEMES[a.theme].scheme);
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {presets.map((p) => {
        const on = a.colors.up === p.up && a.colors.down === p.down;
        return (
          <button key={p.id} className={`btn sm preset${on ? ' active' : ''}`} onClick={() => apply(p.id)} title={p.label}>
            <span className="preset-swatch" style={{ background: p.up }} />
            <span className="preset-swatch" style={{ background: p.down }} />
            {p.label.replace(' (colour-blind safe)', '')}
          </button>
        );
      })}
    </div>
  );
}

/** Warnings for colour choices that make the chart hard to read. */
function visibilityHints(c: ChartColors): Partial<Record<keyof ChartColors, string>> {
  const out: Partial<Record<keyof ChartColors, string>> = {};
  const faint = (k: keyof ChartColors, what: string) => {
    if (contrast(c[k], c.background) < 1.6) out[k] = `${what} is hard to see on this background.`;
  };
  faint('up', 'Up colour');
  faint('down', 'Down colour');
  faint('line', 'Line colour');
  faint('text', 'Text');
  if (!out.up && !out.down && contrast(c.up, c.down) < 1.12) {
    const [r1, g1, b1] = [1, 3, 5].map((i) => parseInt(c.up.slice(i, i + 2), 16));
    const [r2, g2, b2] = [1, 3, 5].map((i) => parseInt(c.down.slice(i, i + 2), 16));
    if (Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 70) out.down = 'Up and down colours look almost the same.';
  }
  return out;
}

export function ChartColorsEditor({ compact = false }: { compact?: boolean }) {
  const a = useSettings((s) => s.appearance);
  const setColor = useSettings((s) => s.setChartColor);
  const update = useSettings((s) => s.updateAppearance);
  const c = a.colors;
  const hints = visibilityHints(c);
  const usesLine = a.chartStyle === 'line' || a.chartStyle === 'area';
  const usesCandles = a.chartStyle === 'candles' || a.chartStyle === 'hollow';
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="color-grid">
        <ColorField label={usesCandles ? 'Up body' : 'Up'} value={c.up} onChange={(v) => setColor('up', v)} hint={hints.up} />
        <ColorField label={usesCandles ? 'Down body' : 'Down'} value={c.down} onChange={(v) => setColor('down', v)} hint={hints.down} />
        {usesCandles && !a.linkCandleParts && (
          <>
            <ColorField label="Up border" value={c.borderUp} onChange={(v) => setColor('borderUp', v)} />
            <ColorField label="Down border" value={c.borderDown} onChange={(v) => setColor('borderDown', v)} />
            <ColorField label="Up wick" value={c.wickUp} onChange={(v) => setColor('wickUp', v)} />
            <ColorField label="Down wick" value={c.wickDown} onChange={(v) => setColor('wickDown', v)} />
          </>
        )}
        {usesLine && <ColorField label="Line" value={c.line} onChange={(v) => setColor('line', v)} hint={hints.line} />}
        {!compact && (
          <>
            <ColorField label="Background" value={c.background} onChange={(v) => setColor('background', v)} />
            <ColorField label="Grid" value={c.grid} onChange={(v) => setColor('grid', v)} />
            <ColorField label="Axis text" value={c.text} onChange={(v) => setColor('text', v)} hint={hints.text} />
            <ColorField label="Crosshair" value={c.crosshair} onChange={(v) => setColor('crosshair', v)} />
          </>
        )}
      </div>
      {usesCandles && (
        <label className="check small">
          <input type="checkbox" checked={a.linkCandleParts} onChange={(e) => update({ linkCandleParts: e.target.checked })} /> Wick and border match the body
        </label>
      )}
    </div>
  );
}

export function ChartOptionsEditor() {
  const a = useSettings((s) => s.appearance);
  const update = useSettings((s) => s.updateAppearance);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 14 }}>
        <label className="check">
          <input type="checkbox" checked={a.vertGrid} onChange={(e) => update({ vertGrid: e.target.checked })} /> Vertical grid
        </label>
        <label className="check">
          <input type="checkbox" checked={a.horzGrid} onChange={(e) => update({ horzGrid: e.target.checked })} /> Horizontal grid
        </label>
        <label className="check" title="The crosshair snaps to the close of the candle under the cursor">
          <input type="checkbox" checked={a.crosshairMagnet} onChange={(e) => update({ crosshairMagnet: e.target.checked })} /> Magnet crosshair
        </label>
        <label className="check">
          <input type="checkbox" checked={a.lastPriceLine} onChange={(e) => update({ lastPriceLine: e.target.checked })} /> Last price line
        </label>
      </div>
      <div className="row wrap" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="small">Price scale</span>
          <div className="seg" role="group" aria-label="Price scale">
            {(
              [
                ['normal', 'Normal'],
                ['log', 'Log'],
                ['percent', '%'],
              ] as [PriceScaleKind, string][]
            ).map(([k, label]) => (
              <button key={k} className={a.priceScale === k ? 'on' : ''} onClick={() => update({ priceScale: k })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="row small" style={{ gap: 6 }}>
          Volume opacity
          <input type="range" min={5} max={100} step={5} value={Math.round(a.volumeOpacity * 100)} onChange={(e) => update({ volumeOpacity: Number(e.target.value) / 100 })} />
          <span className="num muted" style={{ width: 34 }}>
            {Math.round(a.volumeOpacity * 100)}%
          </span>
        </label>
        <label className="row small" style={{ gap: 6 }}>
          Axis font
          <select value={a.chartFontSize} onChange={(e) => update({ chartFontSize: Number(e.target.value) })}>
            {[10, 11, 12, 13, 14].map((n) => (
              <option key={n} value={n}>
                {n}px
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ live preview

/** Deterministic sample bars for the preview (not market data; never shown as prices of anything). */
function sampleBars(): Bar[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const out: Bar[] = [];
  let px = 100;
  // Axis labels read 09:30 onwards, like a regular session.
  const t0 = Date.UTC(2024, 0, 2, 9, 30) / 1000;
  for (let i = 0; i < 64; i++) {
    const drift = Math.sin(i / 9) * 0.35;
    const open = px;
    const close = Math.max(1, open + drift + (rnd() - 0.5) * 1.6);
    const high = Math.max(open, close) + rnd() * 0.7;
    const low = Math.min(open, close) - rnd() * 0.7;
    out.push({ time: t0 + i * 300, open, high, low, close, volume: 2000 + rnd() * 6000 + Math.abs(close - open) * 3000 });
    px = close;
  }
  return out;
}

const SAMPLE = sampleBars();

export function ChartPreview({ height = 200 }: { height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<MainSeries | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const styleRef = useRef<ChartStyle | null>(null);
  const pal = useTheme().chart;

  useEffect(() => {
    const chart = createChart(ref.current!, {
      autoSize: true,
      handleScroll: false,
      handleScale: false,
      timeScale: { timeVisible: true, rightOffset: 2 },
      localization: { locale: CHART_LOCALE },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volRef.current = null;
      styleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({ ...chartOptions(pal), layout: { ...chartOptions(pal).layout, attributionLogo: false } });
    if (styleRef.current !== pal.style) {
      if (mainRef.current) chart.removeSeries(mainRef.current);
      mainRef.current = addMainSeries(chart, pal);
      mainRef.current.setSeriesOrder(0);
      styleRef.current = pal.style;
      mainRef.current.setData(SAMPLE.map((b) => mainPoint(pal.style, b.time as UTCTimestamp, b)) as never);
    }
    mainRef.current!.applyOptions(mainSeriesOptions(pal));
    chart.priceScale('right', 0).applyOptions({ mode: priceScaleMode(pal.priceScale) });
    if (!volRef.current) {
      volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }
    volRef.current.setData(SAMPLE.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? pal.volumeUp : pal.volumeDown })));
    chart.timeScale().fitContent();
  }, [pal]);

  return (
    <div className="chart-preview">
      <div ref={ref} style={{ height, position: 'relative' }} />
      <span className="chart-preview-tag">Preview · sample bars</span>
    </div>
  );
}

// ------------------------------------------------------------------ containers

/** Full appearance card for the settings page. */
export function AppearanceCard() {
  const a = useSettings((s) => s.appearance);
  const update = useSettings((s) => s.updateAppearance);
  const reset = useSettings((s) => s.resetAppearance);
  return (
    <div className="card stack" id="appearance">
      <div className="row">
        <h2>Appearance</h2>
        <div className="spacer" />
        <button className="btn sm" onClick={() => window.confirm('Reset theme and chart colours to the defaults?') && reset()}>
          Reset appearance
        </button>
      </div>
      <div className="appearance-grid">
        <div className="stack" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 6 }}>
            <h3>Theme</h3>
            <ThemePicker />
            <p className="small muted" style={{ margin: 0 }}>
              Switching theme also resets the chart background, grid, text and crosshair to match it. Candle colours are kept.
            </p>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <h3>Accent</h3>
            <AccentPicker />
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <h3>Chart type</h3>
            <ChartStylePicker />
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <h3>Candle colours</h3>
            <CandlePresetPicker />
          </div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <ChartPreview />
        </div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <h3>Chart colours</h3>
        <ChartColorsEditor />
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <h3>Chart options</h3>
        <ChartOptionsEditor />
      </div>
      <label className="check">
        <input type="checkbox" checked={a.pnlFollowsCandles} onChange={(e) => update({ pnlFollowsCandles: e.target.checked })} /> Profit and loss text uses the candle up/down colours
      </label>
      <p className="small muted" style={{ margin: 0 }}>
        Text colours are adjusted automatically when needed so numbers stay readable on any theme. Data source labels (DEMO, HISTORICAL, SIMULATED) always stay on the chart.
      </p>
    </div>
  );
}

/** Quick chart appearance menu in the chart toolbar. */
export function ChartSettingsMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button className={`btn sm${open ? ' active' : ''}`} onClick={() => setOpen(!open)} title="Chart appearance" aria-expanded={open}>
        Chart style
      </button>
      {open && (
        <div className="card popover chart-settings-pop">
          <div className="stack" style={{ gap: 10 }}>
            <ChartStylePicker />
            <CandlePresetPicker />
            <ChartColorsEditor compact />
            <ChartOptionsEditor />
            <div className="row">
              {onOpenSettings && (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                >
                  Theme and all colours…
                </button>
              )}
              <div className="spacer" />
              <button className="btn sm" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
