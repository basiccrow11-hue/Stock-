/**
 * Historical replay clock.
 *
 * The engine owns the full bar series for the session in a private field and exposes ONLY bars
 * that have completed at or before the simulated "now". There is no API that returns a future bar,
 * a future price, or anything derived from one; callers advance the clock and receive the bars
 * that were just revealed. Indicators, the chart, the broker and learning analytics are all fed
 * from the revealed set.
 *
 * Time model: a bar becomes visible when it has COMPLETED (open time + duration <= now). Starting a
 * replay at 09:30 shows everything up to the 09:29 pre-market bar; the 09:30 candle appears at 09:31.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { TIMEFRAME_MINUTES } from '../types';
import { BarAggregator, aggregateBars, candleFor } from '../data/aggregate';
import { exchangeDate, exchangeTimeToUnix, regularCloseMinute } from '../time';
import { lastIndexAtOrBefore } from '../util/math';

export interface ReplayWindow {
  symbol: string;
  /** Simulated start: bars completing after this are hidden. */
  start: UnixSeconds;
  /** Replay ends when this time is reached. */
  end: UnixSeconds;
  baseTimeframe: Timeframe;
}

export class ReplayEngine {
  readonly symbol: string;
  readonly baseTimeframe: Timeframe;
  readonly start: UnixSeconds;
  readonly end: UnixSeconds;

  // Private (#) so no caller can reach future bars, even accidentally through a cast.
  readonly #bars: readonly Bar[];
  readonly #ends: readonly UnixSeconds[];
  /** Index of the last revealed bar (-1 = none). */
  #cursor: number;
  #now: UnixSeconds;
  readonly #firstSessionIndex: number;

  constructor(window: ReplayWindow, bars: readonly Bar[]) {
    this.symbol = window.symbol;
    this.baseTimeframe = window.baseTimeframe;
    this.start = window.start;
    this.end = window.end;
    const sorted = [...bars].filter((b) => b.time < window.end).sort((a, b) => a.time - b.time);
    // Freeze copies so nothing outside can mutate the tape.
    this.#bars = Object.freeze(sorted.map((b) => Object.freeze({ ...b })));
    this.#ends = this.#bars.map((b) => barEndTime(b, window.baseTimeframe));
    this.#now = window.start;
    this.#cursor = lastIndexAtOrBefore(this.#ends, window.start, (t) => t);
    this.#firstSessionIndex = this.#cursor + 1;
    if (this.#firstSessionIndex >= this.#bars.length) {
      throw new Error('No data between the selected start and end times.');
    }
  }

  /** Simulated wall-clock time. */
  get now(): UnixSeconds {
    return this.#now;
  }

  get finished(): boolean {
    return this.#cursor >= this.#bars.length - 1 || this.#now >= this.end;
  }

  /** Fraction of the session window elapsed (0..1). Based on time only, not on future data. */
  get progress(): number {
    return Math.min(1, Math.max(0, (this.#now - this.start) / Math.max(1, this.end - this.start)));
  }

  /** Number of revealed bars, including pre-start context. */
  get revealedCount(): number {
    return this.#cursor + 1;
  }

  /** True if any session bar (at/after start) has been revealed. */
  get started(): boolean {
    return this.#cursor >= this.#firstSessionIndex;
  }

  /** Index of the first bar after the start time; bars below it are context. */
  get sessionStartIndex(): number {
    return this.#firstSessionIndex;
  }

  lastBar(): Bar | null {
    return this.#cursor >= 0 ? this.#bars[this.#cursor] : null;
  }

  lastPrice(): number | null {
    return this.lastBar()?.close ?? null;
  }

  /** All revealed base bars (copy). */
  visibleBaseBars(): Bar[] {
    return this.#bars.slice(0, this.#cursor + 1).map((b) => ({ ...b }));
  }

  /** Start of the revealed bar holding time `t` (the last one starting at or before it), or null. */
  barStartAtOrBefore(t: UnixSeconds): UnixSeconds | null {
    const i = Math.min(this.#cursor, lastIndexAtOrBefore(this.#bars, t, (b) => b.time));
    return i >= 0 ? this.#bars[i].time : null;
  }

  /** Revealed bars aggregated to `timeframe`. The last candle may be still forming. */
  visibleBars(timeframe: Timeframe): Bar[] {
    return aggregateBars(this.#bars.slice(0, this.#cursor + 1), timeframe, this.baseTimeframe);
  }

  /**
   * Reveal the next base bar. Returns it (or null at the end). A bar that completes after the end
   * time is never revealed, as with advanceTo: the clock stops at the end instead.
   */
  step(): Bar | null {
    if (this.finished) return null;
    if (this.#ends[this.#cursor + 1] > this.end) {
      this.#now = Math.max(this.#now, this.end);
      return null;
    }
    this.#cursor += 1;
    this.#now = Math.max(this.#now, this.#ends[this.#cursor]);
    return { ...this.#bars[this.#cursor] };
  }

  /**
   * Advance the clock to `target` and reveal every bar that completes by then.
   * Returns newly revealed bars in order. Never moves backward (use rewindTo).
   */
  advanceTo(target: UnixSeconds): Bar[] {
    const t = Math.min(target, this.end);
    const out: Bar[] = [];
    while (this.#cursor < this.#bars.length - 1 && this.#ends[this.#cursor + 1] <= t) {
      this.#cursor += 1;
      out.push({ ...this.#bars[this.#cursor] });
    }
    this.#now = Math.max(this.#now, t);
    return out;
  }

  /**
   * Reveal base bars until the current display candle of `timeframe` is complete (i.e. one full
   * candle forward). If no candle is forming, completes the next one.
   */
  stepCandle(timeframe: Timeframe): Bar[] {
    const out: Bar[] = [];
    if (this.finished) return out;
    // The candle the next bar belongs to: the one currently forming, or the next one.
    const key = candleFor(this.#bars[this.#cursor + 1].time, timeframe, this.baseTimeframe).key;
    while (!this.finished && candleFor(this.#bars[this.#cursor + 1].time, timeframe, this.baseTimeframe).key === key) {
      const b = this.step();
      if (!b) break;
      out.push(b);
    }
    return out;
  }

  /**
   * Move the clock backward. Only the clock and reveal cursor move; the caller is responsible for
   * restoring any account state (ReplaySession does this with snapshots).
   */
  rewindTo(target: UnixSeconds): void {
    this.#cursor = this.revealedCountAt(target) - 1;
    this.#now = Math.max(target, this.start);
  }

  /** How many bars stay revealed after `rewindTo(target)`. */
  revealedCountAt(target: UnixSeconds): number {
    const t = Math.max(target, this.start);
    return Math.max(this.#firstSessionIndex - 1, lastIndexAtOrBefore(this.#ends, t, (x) => x)) + 1;
  }

  /** When the next bar opens (it is revealed once complete), or null at the end. */
  nextBarTime(): UnixSeconds | null {
    return this.#cursor + 1 < this.#bars.length ? this.#bars[this.#cursor + 1].time : null;
  }

  /** Time at which the next bar will be revealed, or null at the end. */
  nextRevealTime(): UnixSeconds | null {
    if (this.#cursor + 1 >= this.#bars.length) return null;
    return Math.min(this.#ends[this.#cursor + 1], this.end);
  }

  /** How long `bar` trades, in seconds: its timeframe, or for 1D its regular session (shorter on early closes). */
  barSeconds(bar: Bar): number {
    return barEndTime(bar, this.baseTimeframe) - bar.time;
  }

  /** Copies of the revealed bars with index in [from, to); `to` stops at what has been revealed. */
  revealedBars(from: number, to: number): Bar[] {
    return this.#bars.slice(Math.max(0, from), Math.min(to, this.#cursor + 1)).map((b) => ({ ...b }));
  }

  /** Incremental aggregator primed with all revealed bars; useful for efficient chart updates. */
  createAggregator(timeframe: Timeframe): { aggregator: BarAggregator; bars: Bar[] } {
    const aggregator = new BarAggregator(timeframe, this.baseTimeframe);
    const bars: Bar[] = [];
    for (let i = 0; i <= this.#cursor; i++) {
      const r = aggregator.push(this.#bars[i]);
      if (!r) continue;
      if (r.isNew) bars.push(r.bar);
      else bars[bars.length - 1] = r.bar;
    }
    return { aggregator, bars };
  }
}

export function barEndTime(bar: Bar, tf: Timeframe): UnixSeconds {
  if (tf === '1D') {
    // Daily bars are stamped at their session's open (csv.ts files them so); a bar never ends before it starts.
    const d = exchangeDate(bar.time);
    return Math.max(exchangeTimeToUnix(d, regularCloseMinute(d)), bar.time + 60);
  }
  return bar.time + TIMEFRAME_MINUTES[tf] * 60;
}
