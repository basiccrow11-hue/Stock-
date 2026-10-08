/**
 * In-memory credentials. By default keys live only for this browser session (gone on reload).
 * Users can opt into encrypted persistence (see services/secureStore.ts) or keep keys server-side.
 */
import { create } from 'zustand';
import type { VendorCredentials } from '../../core/data/vendorProviders';

interface CredentialStore {
  creds: VendorCredentials;
  unlocked: boolean;
  serverChecked: boolean;
  set: (patch: Partial<VendorCredentials>) => void;
  clear: () => void;
  checkServer: () => Promise<void>;
}

export const useCredentials = create<CredentialStore>()((set) => ({
  creds: {},
  unlocked: false,
  serverChecked: false,
  set: (patch) => set((s) => ({ creds: { ...s.creds, ...patch }, unlocked: true })),
  clear: () => set((s) => ({ creds: { serverHasAlpacaKey: s.creds.serverHasAlpacaKey, serverHasPolygonKey: s.creds.serverHasPolygonKey }, unlocked: false })),
  checkServer: async () => {
    try {
      const res = await fetch('/api/server-keys');
      if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error('no endpoint');
      const j = (await res.json()) as { polygon: boolean; alpaca: boolean };
      set((s) => ({ creds: { ...s.creds, serverHasPolygonKey: j.polygon, serverHasAlpacaKey: j.alpaca }, serverChecked: true }));
    } catch {
      set({ serverChecked: true });
    }
  },
}));

export function getCredentials(): VendorCredentials {
  return useCredentials.getState().creds;
}
