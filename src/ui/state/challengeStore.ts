/** Challenge attempts history (persisted) and the active attempt. */
import { create } from 'zustand';
import { idb } from '../services/idb';
import type { ChallengeResult } from '../../core/challenges/challenges';
import type { TradingRules } from '../../core/learning/review';
import type { DataSourceKind } from '../../core/types';

export interface ChallengeAttempt {
  id: string;
  challengeId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  label: string;
  /** Where the session's prices came from, shown beside the result. Absent on older attempts. */
  source?: DataSourceKind;
  /** The trading rules when the attempt started, which it is scored on. Absent on older attempts (scored on the current rules). */
  rules?: TradingRules;
  result: ChallengeResult;
}

interface ChallengeStore {
  attempts: ChallengeAttempt[];
  active: ChallengeAttempt | null;
  load: () => Promise<void>;
  start: (a: ChallengeAttempt) => void;
  updateActive: (result: ChallengeResult) => void;
  finishActive: () => Promise<void>;
}

export const useChallenges = create<ChallengeStore>()((set, get) => ({
  attempts: [],
  active: null,
  load: async () => {
    try {
      const attempts = await idb.all<ChallengeAttempt>('challenges');
      attempts.sort((a, b) => b.startedAt - a.startedAt);
      set({ attempts });
    } catch {
      /* non-persistent browser: keep in memory */
    }
  },
  start: (a) => set({ active: a }),
  updateActive: (result) => {
    const a = get().active;
    if (!a) return;
    const same = a.result.status === result.status && a.result.detail === result.detail && a.result.official === result.official && a.result.progress === result.progress;
    if (!same) set({ active: { ...a, result } });
  },
  finishActive: async () => {
    const a = get().active;
    if (!a) return;
    const done = { ...a, endedAt: Date.now() };
    set({ active: null, attempts: [done, ...get().attempts.filter((x) => x.id !== done.id)] });
    await idb.set('challenges', done.id, done).catch(() => undefined);
  },
}));
