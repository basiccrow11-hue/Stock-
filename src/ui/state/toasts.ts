import { create } from 'zustand';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error' | 'warning';
  text: string;
}

interface ToastStore {
  toasts: Toast[];
  /** Shows a toast and returns its id. Without `ms`, it stays long enough to read: 4 s, longer for long text. */
  push: (tone: Toast['tone'], text: string, ms?: number) => number;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  push: (tone, text, ms = Math.min(12_000, Math.max(4000, text.length * 50))) => {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-4), { id, tone, text }] });
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (tone: Toast['tone'], text: string, ms?: number): number => useToasts.getState().push(tone, text, ms);
