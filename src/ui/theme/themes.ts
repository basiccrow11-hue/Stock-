/**
 * Appearance: app themes, accent colour and chart styling.
 *
 * `Appearance` is what the user picks (persisted in settings). `resolveTheme()` turns it into the
 * concrete values every surface needs: CSS variables for the app chrome and a palette for the
 * canvas charts, with text colours adjusted to stay readable whatever colours were picked.
 */
import { blendUntil, chartLabelFill, chroma, contrast, distance, fillFor, hueDistance, isDark, isHex, mix, normHex, readable, withAlpha } from './color';

export type ThemeId = 'midnight' | 'graphite' | 'light';
export type ChartStyle = 'candles' | 'hollow' | 'bars' | 'line' | 'area';
export type PriceScaleKind = 'normal' | 'log' | 'percent';

export interface ChartColors {
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  borderUp: string;
  borderDown: string;
  /** Line and area chart colour. */
  line: string;
  background: string;
  grid: string;
  text: string;
  crosshair: string;
}

export interface Appearance {
  theme: ThemeId;
  accent: string;
  /** Profit and loss text uses the chart's up/down colours (e.g. blue/orange stays consistent). */
  pnlFollowsCandles: boolean;
  chartStyle: ChartStyle;
  /** Wick and border colours follow the body colour. */
  linkCandleParts: boolean;
  colors: ChartColors;
  vertGrid: boolean;
  horzGrid: boolean;
  /** 0.05..1 */
  volumeOpacity: number;
  crosshairMagnet: boolean;
  priceScale: PriceScaleKind;
  lastPriceLine: boolean;
  /** Chart axis font size in px, 10..14. */
  chartFontSize: number;
  /**
   * The P/L colour decisions on screen when the colours last changed. While new colours sit right
   * at the edge of the rules (within PNL_HOLD_BAND), these stand, so dragging a colour picker
   * through shades that round either side of a limit does not flicker between candle colours and
   * green/red. Set by the settings store (holdPnl).
   */
  pnlHold?: { panel: boolean; chart: boolean };
}

interface ThemeDef {
  id: ThemeId;
  label: string;
  scheme: 'dark' | 'light';
  ui: {
    bg: string;
    panel: string;
    panel2: string;
    panel3: string;
    border: string;
    border2: string;
    text: string;
    text2: string;
    muted: string;
    hover: string;
    hoverBorder: string;
    rowLine: string;
    shadow: string;
    backdrop: string;
  };
  chart: Pick<ChartColors, 'background' | 'grid' | 'text' | 'crosshair'>;
}

export const LABEL_HUES = { pos: '#26a69a', neg: '#ef5350', warn: '#f5a623', demo: '#b794f6', hist: '#f5c451', sim: '#38d0e6', live: '#3ddc84' };

export const THEMES: Record<ThemeId, ThemeDef> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    scheme: 'dark',
    ui: {
      bg: '#0b0e13',
      panel: '#0f131a',
      panel2: '#131925',
      panel3: '#19202d',
      border: '#1f2633',
      border2: '#2a3242',
      text: '#d6dde6',
      text2: '#aab4c2',
      muted: '#6f7b8c',
      hover: '#222b3a',
      hoverBorder: '#364056',
      rowLine: '#141a24',
      shadow: 'rgba(0,0,0,0.6)',
      backdrop: 'rgba(0,0,0,0.62)',
    },
    chart: { background: '#0d1117', grid: '#161b24', text: '#8b98a9', crosshair: '#758696' },
  },
  graphite: {
    id: 'graphite',
    label: 'Graphite',
    scheme: 'dark',
    ui: {
      bg: '#121316',
      panel: '#17181c',
      panel2: '#1c1e23',
      panel3: '#24262c',
      border: '#2a2c33',
      border2: '#363941',
      text: '#e3e5ea',
      text2: '#b4b8c1',
      muted: '#7d818c',
      hover: '#2c2f36',
      hoverBorder: '#454951',
      rowLine: '#202227',
      shadow: 'rgba(0,0,0,0.55)',
      backdrop: 'rgba(0,0,0,0.6)',
    },
    chart: { background: '#131417', grid: '#1f2125', text: '#9a9ea8', crosshair: '#7d818c' },
  },
  light: {
    id: 'light',
    label: 'Light',
    scheme: 'light',
    ui: {
      bg: '#eef1f5',
      panel: '#ffffff',
      panel2: '#f6f8fa',
      panel3: '#edf0f4',
      border: '#dfe3e9',
      border2: '#c9d0d9',
      text: '#131722',
      text2: '#3f4756',
      muted: '#687183',
      hover: '#e6eaf0',
      hoverBorder: '#b6bfcc',
      rowLine: '#eef1f4',
      shadow: 'rgba(15,23,42,0.18)',
      backdrop: 'rgba(15,23,42,0.35)',
    },
    chart: { background: '#ffffff', grid: '#eef1f5', text: '#4a5263', crosshair: '#9598a1' },
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export interface CandlePreset {
  id: string;
  label: string;
  up: string;
  down: string;
}

/** Candle colour presets. Monochrome adapts to dark or light backgrounds. */
export function candlePresets(scheme: 'dark' | 'light'): CandlePreset[] {
  return [
    { id: 'classic', label: 'Classic', up: '#26a69a', down: '#ef5350' },
    { id: 'vivid', label: 'Green and red', up: '#089981', down: '#f23645' },
    { id: 'colorblind', label: 'Blue and orange (colour-blind safe)', up: '#2962ff', down: '#ff9800' },
    { id: 'ocean', label: 'Cyan and magenta', up: '#00bcd4', down: '#e91e63' },
    scheme === 'dark' ? { id: 'mono', label: 'Monochrome', up: '#d1d4dc', down: '#5d606b' } : { id: 'mono', label: 'Monochrome', up: '#9aa0ab', down: '#131722' },
  ];
}

/** Default line/area colour per scheme: neutral, so it never looks like one of the indicator lines. */
export function defaultLineColor(scheme: 'dark' | 'light'): string {
  return scheme === 'dark' ? '#e0e3eb' : '#131722';
}

export const ACCENTS = ['#4f8cff', '#2962ff', '#26a69a', '#7e57c2', '#ec407a', '#ff9800', '#00bcd4', '#8bc34a'];

/** Spoken names for the accent swatches. */
export const ACCENT_NAMES: Record<string, string> = {
  '#4f8cff': 'Sky blue',
  '#2962ff': 'Royal blue',
  '#26a69a': 'Teal',
  '#7e57c2': 'Purple',
  '#ec407a': 'Pink',
  '#ff9800': 'Orange',
  '#00bcd4': 'Cyan',
  '#8bc34a': 'Lime',
};

export const CHART_STYLES: { id: ChartStyle; label: string }[] = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'midnight',
  accent: '#4f8cff',
  pnlFollowsCandles: true,
  chartStyle: 'candles',
  linkCandleParts: true,
  colors: {
    up: '#26a69a',
    down: '#ef5350',
    wickUp: '#26a69a',
    wickDown: '#ef5350',
    borderUp: '#26a69a',
    borderDown: '#ef5350',
    line: defaultLineColor('dark'),
    ...THEMES.midnight.chart,
  },
  vertGrid: true,
  horzGrid: true,
  volumeOpacity: 0.33,
  crosshairMagnet: false,
  priceScale: 'normal',
  lastPriceLine: true,
  chartFontSize: 11,
};

/** Chart surface colours that belong to a theme (candle colours are kept when switching). */
export function themeChartSurface(theme: ThemeId): Pick<ChartColors, 'background' | 'grid' | 'text' | 'crosshair'> {
  return { ...THEMES[theme].chart };
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const color = (v: unknown, fallback: string) => (isHex(v) ? normHex(v) : fallback);
const range = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Accepts anything (e.g. persisted JSON) and returns a complete, valid Appearance. */
export function sanitizeAppearance(raw: unknown): Appearance {
  const d = DEFAULT_APPEARANCE;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Appearance>;
  const c = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Partial<ChartColors>;
  const theme = oneOf(r.theme, THEME_IDS, d.theme);
  const surface = themeChartSurface(theme);
  return {
    theme,
    accent: color(r.accent, d.accent),
    pnlFollowsCandles: bool(r.pnlFollowsCandles, d.pnlFollowsCandles),
    chartStyle: oneOf(r.chartStyle, CHART_STYLES.map((s) => s.id), d.chartStyle),
    linkCandleParts: bool(r.linkCandleParts, d.linkCandleParts),
    colors: {
      up: color(c.up, d.colors.up),
      down: color(c.down, d.colors.down),
      wickUp: color(c.wickUp, color(c.up, d.colors.wickUp)),
      wickDown: color(c.wickDown, color(c.down, d.colors.wickDown)),
      borderUp: color(c.borderUp, color(c.up, d.colors.borderUp)),
      borderDown: color(c.borderDown, color(c.down, d.colors.borderDown)),
      line: color(c.line, defaultLineColor(THEMES[theme].scheme)),
      background: color(c.background, surface.background),
      grid: color(c.grid, surface.grid),
      text: color(c.text, surface.text),
      crosshair: color(c.crosshair, surface.crosshair),
    },
    vertGrid: bool(r.vertGrid, d.vertGrid),
    horzGrid: bool(r.horzGrid, d.horzGrid),
    volumeOpacity: range(r.volumeOpacity, 0.05, 1, d.volumeOpacity),
    crosshairMagnet: bool(r.crosshairMagnet, d.crosshairMagnet),
    priceScale: oneOf(r.priceScale, ['normal', 'log', 'percent'] as const, d.priceScale),
    lastPriceLine: bool(r.lastPriceLine, d.lastPriceLine),
    chartFontSize: Math.round(range(r.chartFontSize, 10, 14, d.chartFontSize)),
    ...(r.pnlHold && typeof r.pnlHold.panel === 'boolean' && typeof r.pnlHold.chart === 'boolean' ? { pnlHold: { panel: r.pnlHold.panel, chart: r.pnlHold.chart } } : {}),
  };
}

/** Everything a canvas chart needs, already resolved to concrete colours. */
export interface ChartPalette extends ChartColors {
  style: ChartStyle;
  scheme: 'dark' | 'light';
  scaleBorder: string;
  crosshairLabel: string;
  /** Axis text, adjusted to stay readable on the chart background. */
  axisText: string;
  /** Accent and warning colours for lines drawn on the chart (at least 3:1 against it). */
  accent: string;
  warn: string;
  /** Fill-marker colours. lightweight-charts draws marker text in the marker colour, so 4.5:1. */
  markerBuy: string;
  markerSell: string;
  markerUp: string;
  markerDown: string;
  volumeUp: string;
  volumeDown: string;
  histUp: string;
  histDown: string;
  bandUp: string;
  bandDown: string;
  areaTop: string;
  areaBottom: string;
  watermark: string;
  watermarkSub: string;
  vertGrid: boolean;
  horzGrid: boolean;
  magnet: boolean;
  priceScale: PriceScaleKind;
  lastPriceLine: boolean;
  fontSize: number;
}

/** Colours for small charts drawn on app panels (equity curves, backtest results). */
export interface PanelChartPalette {
  text: string;
  grid: string;
  border: string;
  accent: string;
  benchmark: string;
  up: string;
  down: string;
  /** Fill markers (their text is drawn in the marker colour, so 4.5:1 on the panel). */
  markerUp: string;
  markerDown: string;
  wickUp: string;
  wickDown: string;
  borderUp: string;
  borderDown: string;
}

export interface ResolvedTheme {
  scheme: 'dark' | 'light';
  /** P/L text on the panels really uses the candle colours (false when they are too grey or too alike to tell apart). */
  pnlUsesCandles: boolean;
  /** The chart legend's P/L uses them too (false when they would be hard to read on the chart background). */
  chartPnlUsesCandles: boolean;
  /** How far the candle colours are inside (positive) or outside the panel P/L rules, as a share of the nearest limit. */
  pnlMargin: number;
  vars: Record<string, string>;
  chart: ChartPalette;
  panel: PanelChartPalette;
}

/**
 * OKLCH chroma below which a colour reads as grey. Pastels darkened for a white panel land around
 * 0.025 to 0.035 (#5b706f, #7f6669); clearly coloured text is 0.05 and up.
 */
export const COLOURFUL = 0.04;

/**
 * How far P/L text must differ in colour (hueDistance, lightness ignored) from the neutral text
 * around it. The greys are slightly bluish, so a greyish blue or periwinkle can pass COLOURFUL and
 * still read as one more muted label (#5f6982 next to #62697b: 0.012; #616790: 0.036). Clear blues
 * sit at 0.045 and up (Tableau blue on Midnight, Okabe-Ito sky blue on Light), which colour-blind
 * users rely on.
 */
export const NEUTRAL_GAP = 0.042;

/**
 * Within this share of a P/L colour limit (chroma, neutral gap, up/down distance), a decision
 * already on screen stands (Appearance.pnlHold). Near-grey text sits on few whole RGB values, and a
 * one-step change moves its chroma by up to about 5% of COLOURFUL.
 */
export const PNL_HOLD_BAND = 0.06;

/** Badges and alerts tint their background with this much of their text colour (see styles.css). */
export const BADGE_TINT = 0.11;

/** Readable at `min` both on the panel and on the tinted background badges use. */
function toneText(hue: string, panel: string, min = 4.5): string {
  let c = readable(hue, panel, min);
  for (let i = 0; i < 6; i++) {
    const tint = mix(panel, c, BADGE_TINT);
    if (contrast(c, tint) >= min) return c;
    c = readable(c, tint, min + 0.05);
  }
  return c;
}

/** Readable at `min` on every one of `surfaces` (all lighter or all darker than the text). */
function readableOnAll(fg: string, surfaces: string[], min = 4.5): string {
  let c = fg;
  for (let i = 0; i < 3; i++) for (const s of surfaces) c = readable(c, s, min);
  return c;
}

/** Colour for a line drawn on the chart: kept as picked unless it would be hard to see (below 3:1). */
export function onChart(color: string, background: string): string {
  return readable(color, background, 3);
}

export function resolveTheme(a: Appearance): ResolvedTheme {
  const t = THEMES[a.theme];
  const ui = t.ui;
  const dark = t.scheme === 'dark';
  const c = a.colors;
  // The selected watchlist row: a light tint of the accent, with P/L text on it.
  const rowSelected = mix(ui.panel, a.accent, dark ? 0.1 : 0.07);
  // Coloured text sits on the panel, the raised panels, hovered controls (a danger button, the
  // streak chip), the selected row and the tint badges use.
  const surfaces = [ui.panel2, ui.panel3, ui.hover, rowSelected];
  // Readable on all of them and on its own badge tint, found in one search: rounding only once keeps
  // neighbouring shades of a colour on neighbouring results (the P/L rules below depend on that).
  const onAll = (x: string) => [ui.panel, ...surfaces].every((s) => contrast(x, s) >= 4.5) && contrast(x, mix(ui.panel, x, BADGE_TINT)) >= 4.5;
  const text = (hue: string) => blendUntil(hue, ui.panel, onAll) ?? toneText(readableOnAll(hue, surfaces), ui.panel);
  const muted = readableOnAll(ui.muted, [ui.panel, ...surfaces]);
  const bg = c.background;
  // Candle colours only work as P/L colours when the text actually drawn with them (darkened or
  // lightened for contrast) is clearly coloured, different from each other and from the neutral text
  // around it, on the panels and on the chart. Monochrome, pastel or greyish candles fall back to the
  // standard green and red. Colourfulness is OKLCH chroma: HSL saturation would call a deep green
  // lightened for a dark panel "grey" (#1b5e20 becomes #719b74, saturation 0.17), though it still
  // plainly reads as green. `neutrals` is the text P/L sits among, body text first.
  // How far a pair of P/L colours is inside (positive) or outside (negative) those rules, as a share
  // of each limit: both colourful, apart from each other and from every neutral.
  const margin = (x: string, y: string, neutrals: string[]) =>
    Math.min(distance(x, y) / 60 - 1, ...[x, y].flatMap((v) => [chroma(v) / COLOURFUL - 1, ...neutrals.map((n) => hueDistance(v, n) / NEUTRAL_GAP - 1)]));
  const decide = (m: number, held: boolean | undefined) => (held !== undefined && Math.abs(m) < PNL_HOLD_BAND ? held : m >= 0);
  // Each surface decides for itself. The panels (P/L columns, buy and sell buttons) only depend on
  // the theme, where green and red always work.
  const pnlMargin = margin(text(c.up), text(c.down), [ui.text, ui.text2, muted]);
  const pnlUsesCandles = a.pnlFollowsCandles && decide(pnlMargin, a.pnlHold?.panel);
  // The chart legend also depends on the chart background. Falling back there only helps when green
  // and red pass where the candles fail (a custom background can defeat both).
  const chartMargin = (up: string, down: string) => margin(readable(up, bg, 4.5), readable(down, bg, 4.5), [readable(ui.text, bg, 7)]);
  const chartPnlUsesCandles = pnlUsesCandles && (decide(chartMargin(c.up, c.down), a.pnlHold?.chart) || chartMargin(LABEL_HUES.pos, LABEL_HUES.neg) < 0);
  const posHue = pnlUsesCandles ? c.up : LABEL_HUES.pos;
  const negHue = pnlUsesCandles ? c.down : LABEL_HUES.neg;
  const chartPosHue = chartPnlUsesCandles ? c.up : LABEL_HUES.pos;
  const chartNegHue = chartPnlUsesCandles ? c.down : LABEL_HUES.neg;
  const buyBg = fillFor('#ffffff', posHue, 4.5);
  const sellBg = fillFor('#ffffff', negHue, 4.5);
  const accentUi = readable(a.accent, ui.panel, 3);
  const accentFill = fillFor('#ffffff', a.accent, 4.5);
  const selected = mix(ui.panel, a.accent, dark ? 0.18 : 0.12);
  const axisText = readable(c.text, bg, 4.5);
  // Hover fills darken, so white text stays at 4.5:1 or better.
  const hoverFill = (fill: string) => mix(fill, '#000000', 0.12);

  const vars: Record<string, string> = {
    '--bg': ui.bg,
    '--panel': ui.panel,
    '--panel-2': ui.panel2,
    '--panel-3': ui.panel3,
    '--border': ui.border,
    '--border-2': ui.border2,
    '--text': ui.text,
    '--text-2': ui.text2,
    '--muted': muted,
    '--hover': ui.hover,
    '--hover-border': ui.hoverBorder,
    '--row-line': ui.rowLine,
    '--shadow': ui.shadow,
    '--backdrop': ui.backdrop,
    '--accent': accentUi,
    '--accent-text': text(a.accent),
    '--accent-2': accentFill,
    '--accent-hover': hoverFill(accentFill),
    '--on-accent': '#ffffff',
    '--selected': selected,
    '--on-selected': dark ? '#ffffff' : ui.text,
    '--row-selected': rowSelected,
    '--pos': text(posHue),
    '--neg': text(negHue),
    // Errors and confirmations never follow the candle colours.
    '--success': text(LABEL_HUES.pos),
    '--error': text(LABEL_HUES.neg),
    '--buy-bg': buyBg,
    '--buy-hover': hoverFill(buyBg),
    '--buy-border': mix(buyBg, posHue, 0.5),
    '--sell-bg': sellBg,
    '--sell-hover': hoverFill(sellBg),
    '--sell-border': mix(sellBg, negHue, 0.5),
    '--warn': text(LABEL_HUES.warn),
    '--demo': text(LABEL_HUES.demo),
    '--hist': text(LABEL_HUES.hist),
    '--sim': text(LABEL_HUES.sim),
    '--live': text(LABEL_HUES.live),
    '--chart-bg': bg,
    '--legend-bg': withAlpha(bg, 0.82),
    '--chart-text': axisText,
    '--chart-strong': readable(ui.text, bg, 7),
    '--chart-pos': readable(chartPosHue, bg, 4.5),
    '--chart-neg': readable(chartNegHue, bg, 4.5),
    '--streak': text('#ff8a3d'),
    '--freeze': text('#5ec8f2'),
    'color-scheme': t.scheme,
  };

  const chartDark = isDark(bg);
  const op = a.volumeOpacity;
  const chart: ChartPalette = {
    ...c,
    style: a.chartStyle,
    scheme: t.scheme,
    scaleBorder: mix(bg, c.text, 0.18),
    crosshairLabel: chartLabelFill(mix(c.crosshair, '#000000', chartDark ? 0.45 : 0.3)),
    axisText,
    accent: onChart(a.accent, bg),
    warn: onChart(LABEL_HUES.warn, bg),
    markerBuy: readable(a.accent, bg, 4.5),
    markerSell: readable(LABEL_HUES.warn, bg, 4.5),
    markerUp: readable(c.up, bg, 4.5),
    markerDown: readable(c.down, bg, 4.5),
    volumeUp: withAlpha(c.up, op),
    volumeDown: withAlpha(c.down, op),
    histUp: withAlpha(c.up, 0.6),
    histDown: withAlpha(c.down, 0.6),
    bandUp: withAlpha(c.up, 0.53),
    bandDown: withAlpha(c.down, 0.53),
    areaTop: withAlpha(c.line, 0.28),
    areaBottom: withAlpha(c.line, 0.02),
    watermark: withAlpha(axisText, chartDark ? 0.1 : 0.12),
    watermarkSub: withAlpha(axisText, chartDark ? 0.16 : 0.2),
    vertGrid: a.vertGrid,
    horzGrid: a.horzGrid,
    magnet: a.crosshairMagnet,
    priceScale: a.priceScale,
    lastPriceLine: a.lastPriceLine,
    fontSize: a.chartFontSize,
  };

  const panel: PanelChartPalette = {
    text: muted,
    grid: mix(ui.panel, ui.border, 0.7),
    border: ui.border,
    accent: readable(a.accent, ui.panel, 3),
    benchmark: readable(ui.muted, ui.panel, 3),
    up: c.up,
    down: c.down,
    markerUp: readable(c.up, ui.panel, 4.5),
    markerDown: readable(c.down, ui.panel, 4.5),
    wickUp: c.wickUp,
    wickDown: c.wickDown,
    borderUp: c.borderUp,
    borderDown: c.borderDown,
  };

  return { scheme: t.scheme, pnlUsesCandles, chartPnlUsesCandles, pnlMargin, vars, chart, panel };
}

/** The next appearance, carrying the P/L decisions now on screen (see Appearance.pnlHold). */
export function holdPnl(prev: Appearance, next: Appearance): Appearance {
  const { pnlHold: _, ...rest } = next;
  if (!prev.pnlFollowsCandles || !next.pnlFollowsCandles) return rest;
  const r = resolveTheme(prev);
  return { ...rest, pnlHold: { panel: r.pnlUsesCandles, chart: r.chartPnlUsesCandles } };
}
