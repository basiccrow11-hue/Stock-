import { create } from 'zustand';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error' | 'warning';
  text: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (tone: Toast['tone'], text: string, ms?: number) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  push: (tone, text, ms = 4000) => {
    const id = ++seq;
    set({ toasts: [...get().toasts.slice(-4), { id, tone, text }] });
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (tone: Toast['tone'], text: string, ms?: number) => useToasts.getState().push(tone, text, ms);
