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
  /**
   * Add finished attempts this history does not have yet (a restored backup). An attempt already
   * stored under the same id, in this tab or another, is left as it is. Each shows in the list as
   * soon as it is stored, and one stored but missing from the list (a restore that stopped partway)
   * is put back in it. Resolves with how many were added.
   */
  importAttempts: (list: ChallengeAttempt[]) => Promise<number>;
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
  importAttempts: async (list) => {
    let added = 0;
    for (const a of list) {
      // Whether it is here is decided by storage, not by the list, which a restore that stopped
      // partway may have left without attempts it had stored.
      const stored = await idb.get<ChallengeAttempt>('challenges', a.id);
      if (stored && get().attempts.some((x) => x.id === a.id)) continue;
      // Checked and written in one transaction, so an attempt another tab has just saved is never replaced.
      const attempt = stored ?? (await idb.modify<ChallengeAttempt>('challenges', a.id, (cur) => (cur ? undefined : a)));
      if (!attempt) continue;
      set({ attempts: [...get().attempts.filter((x) => x.id !== a.id), attempt].sort((x, y) => y.startedAt - x.startedAt) });
      added++;
    }
    return added;
  },
}));
