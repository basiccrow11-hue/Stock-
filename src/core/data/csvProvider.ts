/**
 * HISTORICAL provider backed by user-imported CSV datasets (real market data the user supplies).
 * Persistence of the datasets is handled by the app's storage layer; this class only serves them.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import type { BarRequest, HistoricalDataProvider, SymbolInfo } from './provider';
import { lastIndexAtOrBefore } from '../util/math';
import { aggregateBars } from './aggregate';
import { addDays, exchangeDate, exchangeTimeToUnix, isTradingDay } from '../time';

export interface CsvDataset {
  symbol: string;
  name: string;
  baseTimeframe: Timeframe;
  bars: Bar[];
  importedAt: number;
  fileName: string;
}

export class CsvDataProvider implements HistoricalDataProvider {
  readonly id = 'csv';
  readonly name = 'Imported CSV (your historical data)';
  readonly source = 'HISTORICAL' as const;
  readonly requiresCredentials = false;
  private datasets = new Map<string, CsvDataset>();

  setDatasets(list: CsvDataset[]): void {
    this.datasets = new Map(list.map((d) => [d.symbol.toUpperCase(), d]));
  }

  upsert(d: CsvDataset): void {
    this.datasets.set(d.symbol.toUpperCase(), d);
  }

  remove(symbol: string): void {
    this.datasets.delete(symbol.toUpperCase());
  }

  list(): CsvDataset[] {
    return [...this.datasets.values()];
  }

  unavailableReason(): string | null {
    return this.datasets.size ? null : 'No CSV data imported yet. Import a file in Data & Settings.';
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return this.list().map((d) => ({ symbol: d.symbol, name: d.name || d.symbol, kind: 'stock', description: `Imported ${d.baseTimeframe} bars` }));
  }

  baseTimeframe(symbol: string): Timeframe {
    return this.datasets.get(symbol.toUpperCase())?.baseTimeframe ?? '1m';
  }

  async availableRange(symbol: string): Promise<{ from: UnixSeconds; to: UnixSeconds } | null> {
    const d = this.datasets.get(symbol.toUpperCase());
    if (!d || !d.bars.length) return null;
    return { from: d.bars[0].time, to: d.bars[d.bars.length - 1].time };
  }

  async sessionDates(symbol: string): Promise<string[] | null> {
    const d = this.datasets.get(symbol.toUpperCase());
    if (!d || !d.bars.length) return null;
    // One lookup per day: from a day's first bar, jump to the first bar after that day.
    const out: string[] = [];
    for (let i = 0; i < d.bars.length; ) {
      const date = exchangeDate(d.bars[i].time);
      if (isTradingDay(date)) out.push(date);
      i = Math.max(i + 1, lastIndexAtOrBefore(d.bars, exchangeTimeToUnix(addDays(date, 1), 0) - 1, (b) => b.time) + 1);
    }
    return out;
  }

  async getBars(req: BarRequest): Promise<Bar[]> {
    const d = this.datasets.get(req.symbol.toUpperCase());
    if (!d) throw new Error(`No imported data for ${req.symbol}.`);
    const start = lastIndexAtOrBefore(d.bars, req.from - 1, (b) => b.time) + 1;
    const out: Bar[] = [];
    for (let i = start; i < d.bars.length && d.bars[i].time < req.to; i++) out.push({ ...d.bars[i] });
    return out;
  }

  /** The imported bars aggregated as a chart does. */
  async getCoarseBars(req: BarRequest, timeframe: Timeframe): Promise<Bar[]> {
    return aggregateBars(await this.getBars(req), timeframe, this.baseTimeframe(req.symbol));
  }
}
