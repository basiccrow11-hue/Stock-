/** Applies the resolved theme to the document and exposes it to React components. */
import { useMemo } from 'react';
import { useSettings } from '../state/settingsStore';
import { resolveTheme, type Appearance, type ResolvedTheme } from './themes';

let cache: { a: Appearance; r: ResolvedTheme } | null = null;

/** Memoised across the app: every chart resolving the same appearance shares one object. */
export function resolved(a: Appearance): ResolvedTheme {
  if (cache?.a !== a) cache = { a, r: resolveTheme(a) };
  return cache.r;
}

export function useTheme(): ResolvedTheme {
  const a = useSettings((s) => s.appearance);
  return useMemo(() => resolved(a), [a]);
}

function apply(r: ResolvedTheme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(r.vars)) root.style.setProperty(k, v);
  root.dataset.theme = r.scheme;
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = r.vars['--panel'];
}

/** Apply now (before the first render, so there is no flash of the default theme) and on change. */
export function installThemeSync(): () => void {
  apply(resolved(useSettings.getState().appearance));
  return useSettings.subscribe((s, prev) => {
    if (s.appearance !== prev.appearance) apply(resolved(s.appearance));
  });
}
