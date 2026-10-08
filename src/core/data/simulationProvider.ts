/**
 * StreamingDataProvider over the fictional SimMarket. The UI drives time with advance(); every
 * subscriber receives per-tick updates. Prices are SIMULATED and labelled as such.
 */
import type { Bar } from '../types';
import type { StreamingDataProvider, StreamUpdate, SymbolInfo, Unsubscribe } from './provider';
import { SimMarket, type SimConfig, type SimTickUpdate } from '../sim/SimMarket';

export class SimulationDataProvider implements StreamingDataProvider {
  readonly id = 'sim';
  readonly name = 'Simulated market (fictional)';
  readonly source = 'SIMULATED' as const;
  readonly requiresCredentials = false;
  private listeners = new Set<{ symbols: Set<string>; fn: (u: StreamUpdate) => void }>();

  constructor(readonly market: SimMarket) {}

  static create(startDate: string, config?: Partial<SimConfig>): SimulationDataProvider {
    return new SimulationDataProvider(new SimMarket({ startDate, config }));
  }

  unavailableReason(): string | null {
    return null;
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return this.market.symbols();
  }

  getHistory(symbol: string): Bar[] {
    return this.market.history(symbol);
  }

  subscribe(symbols: string[], onUpdate: (u: StreamUpdate) => void): Unsubscribe {
    const entry = { symbols: new Set(symbols), fn: onUpdate };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  /** Advance the simulated clock and notify subscribers. Returns the raw tick updates. */
  advance(seconds: number): SimTickUpdate[] {
    const updates = this.market.advance(seconds);
    for (const u of updates) {
      for (const l of this.listeners) {
        if (l.symbols.has(u.symbol)) l.fn({ symbol: u.symbol, bar: u.bar, isNewBar: u.isNewBar, time: u.tick.time });
      }
    }
    return updates;
  }
}
