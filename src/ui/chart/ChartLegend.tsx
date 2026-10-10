/**
 * The chart's legend, TradingView style: the candle under the crosshair (the newest one otherwise),
 * each indicator's name and parameters with its values on that candle in its line's colour, and a
 * title with values at the top of each lower pane. It re-renders on its own when the chart tells it
 * to (crosshair moves, new bars), so moving the crosshair never re-renders the chart itself.
 */
import { useSyncExternalStore } from 'react';
import type { Bar } from '../../core/types';
import { compactVolume, price as fmtPrice } from '../services/format';

export interface LegendValue {
  text: string;
  color: string;
}

export interface LegendEntry {
  id: string;
  /** The indicator's name with its parameters, e.g. "EMA 9". */
  name: string;
  values: LegendValue[];
}

export interface LegendModel {
  symbol: string;
  timeframe: string;
  bar: Bar;
  /** The close before `bar`, for its change. */
  prevClose: number;
  /** The trading day, in blind mode, of a candle under the crosshair (the date stays hidden). */
  dayLabel: string | null;
  /** Indicators drawn over the prices. */
  overlays: LegendEntry[];
  /** Indicators in panes of their own, with the pane's top in pixels from the chart's top. */
  panes: (LegendEntry & { top: number })[];
  /** About the history on the chart: loading, failed, or the data has nothing earlier. */
  note: string | null;
  /** One flowing block instead of a row per indicator, when rows would cover much of a short price pane. */
  compact: boolean;
  /** Pixels kept clear on the right: the price axis and the names on its value labels. */
  right: number;
}

/** Where the legend reads what to show; `version` changes whenever that may have changed. */
export interface LegendSource {
  subscribe: (onChange: () => void) => () => void;
  version: () => number;
  read: () => LegendModel | null;
}

export function ChartLegend({ source }: { source: LegendSource }) {
  useSyncExternalStore(source.subscribe, source.version);
  const m = source.read();
  if (!m) return null;
  const { bar } = m;
  const change = ((bar.close - m.prevClose) / m.prevClose) * 100;
  return (
    <>
      <div className={`chart-legend${m.compact ? ' compact' : ''}`} style={{ maxWidth: `calc(100% - ${m.right}px)` }}>
        <div className="legend-row">
          <span className="legend-sym">{m.symbol}</span>
          <span className="muted">{m.timeframe}</span>
          {m.dayLabel && <span className="muted">{m.dayLabel}</span>}
          <span>
            O <b>{fmtPrice(bar.open)}</b>
          </span>
          <span>
            H <b>{fmtPrice(bar.high)}</b>
          </span>
          <span>
            L <b>{fmtPrice(bar.low)}</b>
          </span>
          <span>
            C <b className={bar.close >= bar.open ? 'pos' : 'neg'}>{fmtPrice(bar.close)}</b>
          </span>
          <span>
            V <b>{compactVolume(bar.volume)}</b>
          </span>
          {Number.isFinite(change) && (
            <span className={change >= 0 ? 'pos' : 'neg'}>
              {change >= 0 ? '+' : ''}
              {change.toFixed(2)}%
            </span>
          )}
        </div>
        {m.overlays.map((e) => (
          <Entry key={e.id} entry={e} />
        ))}
        {m.note && <div className="legend-note">{m.note}</div>}
      </div>
      {m.panes.map((e) => (
        <div key={e.id} className="chart-legend pane-legend" style={{ top: e.top + 4, maxWidth: `calc(100% - ${m.right}px)` }}>
          <Entry entry={e} />
        </div>
      ))}
    </>
  );
}

function Entry({ entry }: { entry: LegendEntry }) {
  return (
    <div className="legend-ind">
      <span className="legend-name">{entry.name}</span>
      {entry.values.map((v, i) => (
        <b key={i} style={{ color: v.color }}>
          {v.text}
        </b>
      ))}
    </div>
  );
}
