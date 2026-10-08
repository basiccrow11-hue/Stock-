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

/** Blend `fg` toward `target` just far enough to reach `min` contrast against `bg` (null if it never does). */
function towards(fg: string, target: string, bg: string, min: number): string | null {
  if (contrast(target, bg) < min) return null;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(fg, target, mid), bg) >= min) hi = mid;
    else lo = mid;
  }
  return mix(fg, target, hi);
}

/**
 * Keep the hue of `fg` but move it toward white (on dark backgrounds) or black (on light ones)
 * until it reaches `min` contrast against `bg`. Returns `fg` unchanged when it already passes. On a
 * mid-tone background where the preferred direction cannot get there, the other direction is used,
 * and if neither can, whichever of black or white reads better.
 */
export function readable(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return normHex(fg);
  const [first, second] = isDark(bg) ? ['#ffffff', '#000000'] : ['#000000', '#ffffff'];
  return towards(fg, first, bg, min) ?? towards(fg, second, bg, min) ?? (contrast(first, bg) >= contrast(second, bg) ? first : second);
}

/**
 * How colourful a colour looks: OKLCH chroma, about 0 for greys and 0.1 to 0.3 for clear colours.
 * Unlike HSL saturation it does not collapse when a colour is lightened, so a deep green made
 * lighter for contrast still counts as green.
 */
export function chroma(c: string): number {
  const [, a, b] = oklab(c);
  return Math.hypot(a, b);
}

/** Perceptual difference between two colours (distance in OKLab): about 0.02 is barely visible. */
export function deltaE(x: string, y: string): number {
  const p = oklab(x);
  const q = oklab(y);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function oklab(c: string): [number, number, number] {
  const [r, g, b] = parseHex(c).map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in RGB, 0..441. A rough "do these look alike" measure. */
export function distance(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
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

/**
 * lightweight-charts picks black or white text for its axis labels (last price, price lines,
 * crosshair) with this grayscale rule, so label backgrounds are chosen to suit it.
 */
export function chartLabelText(bg: string): string {
  const [r, g, b] = parseHex(bg);
  return 0.199 * r + 0.687 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

/**
 * `color` adjusted just enough that lightweight-charts' own label text on it reaches 4.5:1. Either
 * it is darkened under white text, or lightened just past the point where the chart switches to
 * black text, whichever looks less different: an orange just under that point stays orange instead
 * of turning brown.
 */
export function chartLabelFill(color: string): string {
  if (contrast(chartLabelText(color), color) >= 4.5) return normHex(color);
  const darker = fillFor('#ffffff', color, 4.5);
  const reads = (c: string) => chartLabelText(c) === '#000000' && contrast('#000000', c) >= 4.5;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (reads(mix(color, '#ffffff', mid))) hi = mid;
    else lo = mid;
  }
  const lighter = mix(color, '#ffffff', hi);
  return deltaE(lighter, color) < deltaE(darker, color) ? lighter : darker;
}
