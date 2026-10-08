import { describe, expect, it } from 'vitest';
import { contrast, fillFor, isHex, mix, normHex, parseHex, readable, toHex, withAlpha } from './color';
import { DEFAULT_APPEARANCE, THEME_IDS, candlePresets, resolveTheme, sanitizeAppearance, type Appearance } from './themes';

describe('colour helpers', () => {
  it('parses and formats hex', () => {
    expect(isHex('#abc')).toBe(true);
    expect(isHex('#a1b2c3')).toBe(true);
    expect(isHex('a1b2c3')).toBe(false);
    expect(isHex('#a1b2c3ff')).toBe(false);
    expect(isHex('red')).toBe(false);
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(toHex([255, 0, 128])).toBe('#ff0080');
    expect(normHex('#ABC')).toBe('#aabbcc');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(withAlpha('#ff0000', 0.333)).toBe('rgba(255,0,0,0.333)');
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('adjusts text colours until they are readable', () => {
    // Teal on white is too faint for text; it gets darkened, keeping its hue.
    const t = readable('#26a69a', '#ffffff', 4.5);
    expect(contrast(t, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t, '#ffffff')).toBeLessThan(5.5);
    // Dark blue on near-black gets lightened.
    const b = readable('#0d2a6b', '#0f131a', 4.5);
    expect(contrast(b, '#0f131a')).toBeGreaterThanOrEqual(4.5);
    // Already readable colours are untouched.
    expect(readable('#ffffff', '#000000')).toBe('#ffffff');
  });

  it('darkens fills so white text stays readable', () => {
    const f = fillFor('#ffffff', '#ffeb3b', 4.5);
    expect(contrast('#ffffff', f)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('appearance', () => {
  it('sanitizes junk into valid defaults', () => {
    expect(sanitizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    const a = sanitizeAppearance({
      theme: 'neon',
      accent: 'javascript:alert(1)',
      chartStyle: 'heikin',
      volumeOpacity: 7,
      chartFontSize: 3,
      priceScale: 'weird',
      colors: { up: '#00FF00', background: 'url(x)' },
    });
    expect(a.theme).toBe('midnight');
    expect(a.accent).toBe(DEFAULT_APPEARANCE.accent);
    expect(a.chartStyle).toBe('candles');
    expect(a.volumeOpacity).toBe(1);
    expect(a.chartFontSize).toBe(10);
    expect(a.priceScale).toBe('normal');
    expect(a.colors.up).toBe('#00ff00');
    // Wick and border inherit the body colour when they were never set.
    expect(a.colors.wickUp).toBe('#00ff00');
    expect(a.colors.background).toBe(DEFAULT_APPEARANCE.colors.background);
  });

  it('uses the theme chart surface when stored colours are missing', () => {
    const a = sanitizeAppearance({ theme: 'light' });
    expect(a.colors.background).toBe('#ffffff');
  });

  it('keeps every text colour readable in every theme and preset', () => {
    for (const theme of THEME_IDS) {
      const scheme = theme === 'light' ? 'light' : 'dark';
      for (const p of candlePresets(scheme)) {
        for (const accent of ['#4f8cff', '#ffeb3b', '#111111', '#ffffff']) {
          const a: Appearance = sanitizeAppearance({ theme, accent, colors: { up: p.up, down: p.down } });
          const r = resolveTheme(a);
          const panel = r.vars['--panel'];
          for (const v of ['--text', '--muted', '--pos', '--neg', '--warn', '--demo', '--hist', '--sim', '--live', '--accent-text', '--streak', '--freeze'])
            expect(contrast(r.vars[v], panel), `${theme}/${p.id}/${accent} ${v}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast('#ffffff', r.vars['--accent-2'])).toBeGreaterThanOrEqual(4.5);
          expect(contrast('#ffffff', r.vars['--buy-bg'])).toBeGreaterThanOrEqual(4.5);
          expect(contrast('#ffffff', r.vars['--sell-bg'])).toBeGreaterThanOrEqual(4.5);
          expect(contrast(r.vars['--chart-text'], a.colors.background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('can keep P/L colours independent of candle colours', () => {
    const follow = resolveTheme(sanitizeAppearance({ colors: { up: '#2962ff', down: '#ff9800' } }));
    const fixed = resolveTheme(sanitizeAppearance({ pnlFollowsCandles: false, colors: { up: '#2962ff', down: '#ff9800' } }));
    expect(follow.vars['--pos']).not.toBe(fixed.vars['--pos']);
    expect(fixed.vars['--pos']).toBe(resolveTheme(DEFAULT_APPEARANCE).vars['--pos']);
  });

  it('derives volume and band colours from candle colours', () => {
    const r = resolveTheme(sanitizeAppearance({ volumeOpacity: 0.5, colors: { up: '#2962ff', down: '#ff9800' } }));
    expect(r.chart.volumeUp).toBe('rgba(41,98,255,0.5)');
    expect(r.chart.volumeDown).toBe('rgba(255,152,0,0.5)');
  });
});
