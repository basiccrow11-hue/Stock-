/// <reference lib="webworker" />
/** Runs backtests off the main thread so the UI stays responsive on long ranges. */
import { runBacktest, type BacktestParams } from '../../core/backtest/Backtester';

self.onmessage = (e: MessageEvent<{ id: number; params: BacktestParams }>) => {
  const { id, params } = e.data;
  try {
    const result = runBacktest(params);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err as Error).message });
  }
};
