import { exchangeDate, formatExchangeTime } from '../../core/time';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return usd.format(v);
}

export function signedMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd.format(Math.abs(v))}`;
}

export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4);
}

export function pct(v: number | null | undefined, digits = 2, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = `${Math.abs(v).toFixed(digits)}%`;
  if (!signed) return v < 0 ? `−${s}` : s;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}`;
}

export function qty(v: number): string {
  return int.format(v);
}

export function number(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function compactVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return num.format(v);
}

/** "2025-01-15 10:32" in exchange time, or a relative day label in blind mode. */
export function dateTime(t: number, blindDayLabel?: string): string {
  return `${blindDayLabel ?? exchangeDate(t)} ${formatExchangeTime(t)}`;
}

export function pnlClass(v: number | null | undefined): string {
  if (!v || !Number.isFinite(v)) return '';
  return v > 0 ? 'pos' : 'neg';
}

/** Browser locale for chart axis labels, sanitised (some systems report tags like "en-US@posix"). */
export const CHART_LOCALE: string = (() => {
  try {
    const l = (typeof navigator !== 'undefined' ? navigator.language : 'en-US').split('@')[0];
    new Intl.DateTimeFormat(l);
    return l;
  } catch {
    return 'en-US';
  }
})();

/** A replay or market speed: simulated time per real second. */
export function speedLabel(s: number): string {
  if (s === 1) return '1x real time';
  if (s < 60) return `${s}x`;
  const perSec = s / 60;
  return `${s}x · ${perSec >= 60 ? `${perSec / 60}h` : `${perSec}m`}/s`;
}
