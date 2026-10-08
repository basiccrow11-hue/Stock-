/** Small, dependency-free colour helpers (hex in, hex out) with WCAG contrast. */

export type RGB = [number, number, number];

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(c: unknown): c is string {
  return typeof c === 'string' && HEX_RE.test(c);
}

export function parseHex(c: string): RGB {
  if (!isHex(c)) throw new Error(`Not a hex colour: ${c}`);
  const h = c.length === 4 ? c.slice(1).replace(/./g, (x) => x + x) : c.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Normalise to lowercase #rrggbb. */
export function normHex(c: string): string {
  return toHex(parseHex(c));
}

/** Linear blend: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function withAlpha(c: string, alpha: number): string {
  const [r, g, b] = parseHex(c);
  return `rgba(${r},${g},${b},${Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000})`;
}

/** WCAG relative luminance. */
export function luminance(c: string): number {
  const ch = parseHex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(c: string): boolean {
  return luminance(c) < 0.2;
}

/**
 * Keep the hue of `fg` but move it toward white (on dark backgrounds) or black (on light ones)
 * until it reaches `min` contrast against `bg`. Returns `fg` unchanged when it already passes.
 */
export function readable(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return normHex(fg);
  const target = isDark(bg) ? '#ffffff' : '#000000';
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(fg, target, mid), bg) >= min) hi = mid;
    else lo = mid;
  }
  return mix(fg, target, hi);
}

/** White or near-black text, whichever reads better on a filled background. */
export function onColor(bg: string): string {
  return contrast('#ffffff', bg) >= contrast('#0b0e13', bg) ? '#ffffff' : '#0b0e13';
}

/** Darken (or lighten) a fill until `text` on it reaches `min` contrast. */
export function fillFor(text: string, base: string, min = 4.5): string {
  if (contrast(text, base) >= min) return normHex(base);
  const target = isDark(text) ? '#ffffff' : '#000000';
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(text, mix(base, target, mid)) >= min) hi = mid;
    else lo = mid;
  }
  return mix(base, target, hi);
}
