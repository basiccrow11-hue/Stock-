/**
 * The fictional SimMarket as a stream the app drives: advance() moves its clock and every subscriber
 * receives each tick. Prices are SIMULATED and labelled as such.
 */
import type { Bar, UnixSeconds } from '../types';
import type { DrivenStreamingProvider, StreamUpdate, SymbolInfo, Unsubscribe } from './provider';
import { SimMarket, type SimConfig, type SimEvent } from '../sim/SimMarket';

export class SimulationDataProvider implements DrivenStreamingProvider<SimEvent> {
  readonly id = 'sim';
  readonly name = 'Simulated market (fictional)';
  readonly source = 'SIMULATED' as const;
  readonly requiresCredentials = false;
  readonly symbols: readonly string[];
  private listeners = new Set<{ symbols: Set<string>; fn: (u: StreamUpdate) => void }>();

  constructor(readonly market: SimMarket) {
    this.symbols = market.profiles.map((p) => p.symbol);
  }

  static create(startDate: string, config?: Partial<SimConfig>): SimulationDataProvider {
    return new SimulationDataProvider(new SimMarket({ startDate, config }));
  }

  get clock(): UnixSeconds {
    return this.market.clock;
  }

  get tickSeconds(): number {
    return this.market.config.tickSeconds;
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

  events(): readonly SimEvent[] {
    return this.market.events;
  }

  subscribe(symbols: readonly string[], onUpdate: (u: StreamUpdate) => void): Unsubscribe {
    const entry = { symbols: new Set(symbols), fn: onUpdate };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  advance(seconds: number): void {
    for (const u of this.market.advance(seconds)) {
      for (const l of this.listeners) {
        if (l.symbols.has(u.symbol)) l.fn({ symbol: u.symbol, bar: u.bar, isNewBar: u.isNewBar, time: u.tick.time, tick: u.tick });
      }
    }
  }
}
