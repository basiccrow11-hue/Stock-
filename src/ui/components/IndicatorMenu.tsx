import { useState } from 'react';
import { useSettings, type IndicatorConfig, type IndicatorType } from '../state/settingsStore';
import { newId } from '../../core/util/ids';

const LABEL: Record<IndicatorType, string> = {
  sma: 'SMA',
  ema: 'EMA',
  vwap: 'VWAP',
  bb: 'Bollinger Bands',
  rsi: 'RSI',
  macd: 'MACD',
  atr: 'ATR',
  volume: 'Volume',
};

export function indicatorName(i: IndicatorConfig): string {
  if (i.type === 'sma' || i.type === 'ema' || i.type === 'rsi' || i.type === 'atr') return `${LABEL[i.type]} ${i.period}`;
  if (i.type === 'bb') return `BB ${i.period}, ${i.mult}`;
  if (i.type === 'macd') return `MACD ${i.fast},${i.slow},${i.signal}`;
  return LABEL[i.type];
}

const DEFAULTS: Record<IndicatorType, Partial<IndicatorConfig>> = {
  sma: { period: 20 },
  ema: { period: 20 },
  vwap: {},
  bb: { period: 20, mult: 2 },
  rsi: { period: 14 },
  macd: { fast: 12, slow: 26, signal: 9 },
  atr: { period: 14 },
  volume: {},
};

export function IndicatorMenu() {
  const [open, setOpen] = useState(false);
  const { indicators, updateIndicator, addIndicator, removeIndicator } = useSettings();
  const [addType, setAddType] = useState<IndicatorType>('sma');
  const num = (v: string, min = 1) => Math.max(min, Math.round(Number(v) || min));

  return (
    <div style={{ position: 'relative' }}>
      <button className={`btn sm${open ? ' active' : ''}`} onClick={() => setOpen(!open)}>
        Indicators ({indicators.filter((i) => i.enabled).length})
      </button>
      {open && (
        <div className="card popover" style={{ width: 340 }}>
          <div className="stack">
            {indicators.map((i) => (
              <div key={i.id} className="row" style={{ gap: 6 }}>
                <label className="check" style={{ flex: 1 }}>
                  <input type="checkbox" checked={i.enabled} onChange={(e) => updateIndicator(i.id, { enabled: e.target.checked })} />
                  {indicatorName(i)}
                </label>
                {(i.type === 'sma' || i.type === 'ema' || i.type === 'rsi' || i.type === 'atr' || i.type === 'bb') && (
                  <input type="number" title="Period" style={{ width: 54 }} value={i.period} onChange={(e) => updateIndicator(i.id, { period: num(e.target.value, 2) })} />
                )}
                {i.type === 'bb' && <input type="number" title="Std dev multiplier" step={0.5} style={{ width: 48 }} value={i.mult} onChange={(e) => updateIndicator(i.id, { mult: Math.max(0.5, Number(e.target.value) || 2) })} />}
                {i.type === 'macd' && (
                  <>
                    <input type="number" title="Fast" style={{ width: 42 }} value={i.fast} onChange={(e) => updateIndicator(i.id, { fast: num(e.target.value, 2) })} />
                    <input type="number" title="Slow" style={{ width: 42 }} value={i.slow} onChange={(e) => updateIndicator(i.id, { slow: num(e.target.value, 3) })} />
                    <input type="number" title="Signal" style={{ width: 42 }} value={i.signal} onChange={(e) => updateIndicator(i.id, { signal: num(e.target.value, 2) })} />
                  </>
                )}
                {i.type !== 'volume' && i.type !== 'macd' && (
                  <input type="color" title="Color" value={i.color} onChange={(e) => updateIndicator(i.id, { color: e.target.value })} style={{ width: 28, height: 26, padding: 0, border: 0, background: 'none' }} />
                )}
                <button className="btn ghost sm" title="Remove" onClick={() => removeIndicator(i.id)}>
                  ✕
                </button>
              </div>
            ))}
            <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <select value={addType} onChange={(e) => setAddType(e.target.value as IndicatorType)}>
                {(Object.keys(LABEL) as IndicatorType[]).map((t) => (
                  <option key={t} value={t}>
                    {LABEL[t]}
                  </option>
                ))}
              </select>
              <button className="btn sm" onClick={() => addIndicator({ id: newId('ind'), type: addType, enabled: true, color: '#9ccc65', ...DEFAULTS[addType] })}>
                Add
              </button>
              <div className="spacer" />
              <button className="btn sm" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Every indicator is computed only from candles revealed so far, so values never use future data.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
