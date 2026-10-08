/** Promise wrapper around the backtest worker, with a main-thread fallback. */
import { runBacktest, type BacktestParams, type BacktestResult } from '../../core/backtest/Backtester';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: BacktestResult) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./backtest.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: BacktestResult; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result!);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Backtest worker crashed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

export function runBacktestAsync(params: BacktestParams): Promise<BacktestResult> {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(runBacktest(params));
        } catch (e) {
          reject(e as Error);
        }
      }, 0),
    );
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, params });
  });
}

/** Stop a running backtest by killing the worker. */
export function cancelBacktests(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error('Cancelled'));
  pending.clear();
}
