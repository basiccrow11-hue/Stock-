export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Round a price to the US equity tick ($0.01 at/above $1, $0.0001 below). */
export function roundToTick(price: number): number {
  return price >= 1 ? round(price, 2) : round(price, 4);
}

/** A price written to its tick: 2 decimals at/above $1, 4 below. */
export function formatTick(price: number): string {
  return price >= 1 ? price.toFixed(2) : price.toFixed(4);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

/** Binary search: index of the last element with key <= target, or -1. */
export function lastIndexAtOrBefore<T>(items: readonly T[], target: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
