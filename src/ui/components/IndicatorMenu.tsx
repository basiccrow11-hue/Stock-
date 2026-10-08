import { useLayoutEffect, useRef, useState } from 'react';
import { useSettings, type IndicatorConfig, type IndicatorType } from '../state/settingsStore';
import { newId } from '../../core/util/ids';
import { usePopover } from './usePopover';

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

/**
 * A number box the user can type into freely. Clamping every keystroke would turn the "1" of "14"
 * into the minimum at once, so the value is applied only while what is typed is valid, and tidied
 * up (clamped, or restored if empty) when the box loses focus or on Enter.
 */
function DraftNumber({ value, min, step = 1, integer = true, label, onCommit }: { value: number; min: number; step?: number; integer?: boolean; label: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const parse = (text: string) => {
    const n = Number(text);
    return text.trim() === '' || !Number.isFinite(n) ? null : integer ? Math.round(n) : n;
  };
  const finish = () => {
    if (draft === null) return;
    const n = parse(draft);
    if (n !== null && Math.max(min, n) !== value) onCommit(Math.max(min, n));
    setDraft(null);
  };
  const text = draft ?? String(value);
  return (
    <input
      type="number"
      aria-label={label}
      title={label}
      min={min}
      step={step}
      // As wide as what it holds (at least two characters) plus padding and the spin buttons, so a
      // value is never clipped and short ones leave room for the indicator's name.
      className="draft-number"
      style={{ width: `calc(${Math.max(2, text.length)}ch + 36px)` }}
      value={text}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parse(e.target.value);
        if (n !== null && n >= min && n !== value) onCommit(n);
      }}
      onBlur={finish}
      onKeyDown={(e) => e.key === 'Enter' && finish()}
    />
  );
}

export function IndicatorMenu() {
  const { open, toggle, close, boxRef, triggerRef, popRef } = usePopover();
  const { indicators, updateIndicator, addIndicator, removeIndicator } = useSettings();
  const [addType, setAddType] = useState<IndicatorType>('sma');
  // After a row is removed, focus moves to the next row's Remove button (else the previous one's, else
  // the indicator picker), so it never drops to the page while the menu is still open.
  const refocusRow = useRef<number | null>(null);
  useLayoutEffect(() => {
    const k = refocusRow.current;
    if (k === null) return;
    refocusRow.current = null;
    const buttons = popRef.current?.querySelectorAll<HTMLElement>('[data-remove]');
    (buttons?.length ? buttons[Math.min(k, buttons.length - 1)] : popRef.current?.querySelector<HTMLElement>('select'))?.focus();
  }, [indicators, popRef]);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button ref={triggerRef} className={`btn sm${open ? ' active' : ''}`} onClick={toggle} aria-expanded={open}>
        Indicators ({indicators.filter((i) => i.enabled).length})
      </button>
      {open && (
        <div ref={popRef} className="card popover" style={{ width: 'min(340px, calc(100vw - 16px))' }} role="dialog" aria-label="Indicators">
          <div className="stack">
            {indicators.map((i, k) => (
              <div key={i.id} className="row" style={{ gap: 6 }}>
                <label className="check" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <input type="checkbox" checked={i.enabled} onChange={(e) => updateIndicator(i.id, { enabled: e.target.checked })} />
                  {indicatorName(i)}
                </label>
                {(i.type === 'sma' || i.type === 'ema' || i.type === 'rsi' || i.type === 'atr' || i.type === 'bb') && (
                  <DraftNumber label={`${indicatorName(i)} period`} min={2} value={i.period ?? 2} onCommit={(period) => updateIndicator(i.id, { period })} />
                )}
                {i.type === 'bb' && (
                  <DraftNumber label={`${indicatorName(i)} standard deviation multiplier`} min={0.5} step={0.5} integer={false} value={i.mult ?? 2} onCommit={(mult) => updateIndicator(i.id, { mult })} />
                )}
                {i.type === 'macd' && (
                  <>
                    <DraftNumber label={`${indicatorName(i)} fast period`} min={2} value={i.fast ?? 12} onCommit={(fast) => updateIndicator(i.id, { fast })} />
                    <DraftNumber label={`${indicatorName(i)} slow period`} min={3} value={i.slow ?? 26} onCommit={(slow) => updateIndicator(i.id, { slow })} />
                    <DraftNumber label={`${indicatorName(i)} signal period`} min={2} value={i.signal ?? 9} onCommit={(signal) => updateIndicator(i.id, { signal })} />
                  </>
                )}
                {i.type !== 'volume' && i.type !== 'macd' && (
                  <input
                    type="color"
                    aria-label={`${indicatorName(i)} colour`}
                    title="Colour"
                    value={i.color}
                    onChange={(e) => updateIndicator(i.id, { color: e.target.value })}
                    style={{ width: 28, height: 26, padding: 0, border: 0, background: 'none' }}
                  />
                )}
                <button
                  className="btn ghost sm"
                  data-remove
                  aria-label={`Remove ${indicatorName(i)}`}
                  title="Remove"
                  onClick={() => {
                    refocusRow.current = k;
                    removeIndicator(i.id);
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            ))}
            <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <select value={addType} onChange={(e) => setAddType(e.target.value as IndicatorType)} aria-label="Indicator to add">
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
              <button className="btn sm" onClick={() => close()}>
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
