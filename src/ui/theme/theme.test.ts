import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chartLabelFill, chartLabelText, chroma, contrast, deltaE, distance, fillFor, isHex, mix, normHex, parseHex, readable, toHex, withAlpha } from './color';
import { ACCENTS, BADGE_TINT, COLOURFUL, DEFAULT_APPEARANCE, NEUTRAL_GAP, THEMES, THEME_IDS, candlePresets, onChart, resolveTheme, sanitizeAppearance, type Appearance } from './themes';
import { lastPriceColor } from '../chart/chartTheme';

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
    // On a mid-tone background the preferred direction can fall short; the other one is used.
    for (const bg of ['#7a7a7a', '#888888', '#5f6b7a', '#9a6b3a']) expect(contrast(readable('#808080', bg, 4.5), bg), bg).toBeGreaterThanOrEqual(4.5);
  });

  it('measures how colourful a colour looks', () => {
    expect(chroma('#808080')).toBeCloseTo(0, 5);
    expect(chroma('#ffffff')).toBeCloseTo(0, 5);
    expect(chroma('#d1d4dc')).toBeLessThan(COLOURFUL);
    expect(chroma('#ff0000')).toBeGreaterThan(0.2);
    // Lightening a deep green for a dark panel keeps it green; darkening a pastel for a white panel greys it.
    expect(chroma('#719b74')).toBeGreaterThan(COLOURFUL);
    expect(chroma('#5b706f')).toBeLessThan(COLOURFUL);
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
        for (const accent of [...ACCENTS, '#ffeb3b', '#111111', '#ffffff']) {
          const a: Appearance = sanitizeAppearance({ theme, accent, colors: { up: p.up, down: p.down } });
          const r = resolveTheme(a);
          const panel = r.vars['--panel'];
          // Text appears on the panel, the raised panels (risk box, toasts, streak chip), hovered
          // controls (danger buttons, the streak chip) and the selected watchlist row.
          for (const surface of ['--panel', '--panel-2', '--panel-3', '--hover', '--row-selected'])
            for (const v of ['--text', '--muted', '--accent-text', '--pos', '--neg', '--success', '--error', '--warn', '--demo', '--hist', '--sim', '--live', '--streak', '--freeze'])
              expect(contrast(r.vars[v], r.vars[surface]), `${theme}/${p.id}/${accent} ${v} on ${surface}`).toBeGreaterThanOrEqual(4.5);
          // White button text, at rest and hovered.
          for (const v of ['--accent-2', '--accent-hover', '--buy-bg', '--buy-hover', '--sell-bg', '--sell-hover'])
            expect(contrast('#ffffff', r.vars[v]), `${theme}/${p.id}/${accent} white on ${v}`).toBeGreaterThanOrEqual(4.5);
          // Backtest chart markers on the panel.
          for (const k of ['markerUp', 'markerDown'] as const) expect(contrast(r.panel[k], panel), `${theme}/${p.id} panel ${k}`).toBeGreaterThanOrEqual(4.5);
          // Axis labels lightweight-charts draws itself (black or white text on a coloured box).
          for (const style of ['candles', 'hollow', 'bars', 'line', 'area'] as const)
            for (const up of [true, false]) {
              const fill = lastPriceColor({ ...r.chart, style }, up);
              expect(contrast(chartLabelText(fill), fill), `${theme}/${p.id} ${style} last price`).toBeGreaterThanOrEqual(4.5);
            }
          expect(contrast(r.vars['--chart-text'], a.colors.background)).toBeGreaterThanOrEqual(4.5);
          // Badges and alerts draw their text on an 11% tint of the same colour (styles.css).
          for (const v of ['--pos', '--neg', '--success', '--error', '--warn', '--demo', '--hist', '--sim', '--live']) {
            const tint = mix(panel, r.vars[v], BADGE_TINT);
            expect(contrast(r.vars[v], tint), `${theme}/${p.id}/${accent} ${v} on tint`).toBeGreaterThanOrEqual(4.5);
          }
          // Chart annotations: marker text 4.5:1, lines 3:1 against the chart background.
          const bg = a.colors.background;
          for (const k of ['markerBuy', 'markerSell', 'markerUp', 'markerDown', 'axisText'] as const) expect(contrast(r.chart[k], bg), `${theme}/${p.id}/${accent} ${k}`).toBeGreaterThanOrEqual(4.5);
          for (const k of ['accent', 'warn'] as const) expect(contrast(r.chart[k], bg), `${theme}/${p.id}/${accent} ${k}`).toBeGreaterThanOrEqual(3);
          for (const v of ['--chart-strong', '--chart-pos', '--chart-neg']) expect(contrast(r.vars[v], bg), `${theme}/${p.id}/${accent} ${v}`).toBeGreaterThanOrEqual(4.5);
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

  it('keeps the chart legend readable on a custom chart background', () => {
    for (const background of ['#131722', '#000000', '#ffffff', '#808080', '#2962ff']) {
      for (const theme of THEME_IDS) {
        const r = resolveTheme(sanitizeAppearance({ theme, colors: { background } }));
        for (const v of ['--chart-strong', '--chart-pos', '--chart-neg', '--chart-text']) expect(contrast(r.vars[v], background), `${theme} ${background} ${v}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps P/L green and red when the candle colours cannot tell gains from losses', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const mono = candlePresets(scheme).find((p) => p.id === 'mono')!;
      const theme = scheme === 'light' ? 'light' : 'midnight';
      const r = resolveTheme(sanitizeAppearance({ theme, colors: { up: mono.up, down: mono.down } }));
      const standard = resolveTheme(sanitizeAppearance({ theme, pnlFollowsCandles: false }));
      expect(r.pnlUsesCandles).toBe(false);
      expect(r.vars['--pos']).toBe(standard.vars['--pos']);
      expect(r.vars['--neg']).toBe(standard.vars['--neg']);
    }
    // Same colour for up and down also falls back.
    expect(resolveTheme(sanitizeAppearance({ colors: { up: '#2962ff', down: '#2962ff' } })).pnlUsesCandles).toBe(false);
    // Clearly coloured, distinct candles are used.
    expect(resolveTheme(sanitizeAppearance({ colors: { up: '#2962ff', down: '#ff9800' } })).pnlUsesCandles).toBe(true);
  });

  it('falls back to green and red when pastel candles would give grey P/L text', () => {
    // Darkened for a white panel, these pastels lose their colour (#5b706f vs #7f6669).
    for (const [up, down] of [
      ['#b2dfdb', '#ffcdd2'],
      ['#c8e6c9', '#ffcdd2'],
      ['#a5d6a7', '#ef9a9a'],
    ]) {
      for (const theme of THEME_IDS) {
        const r = resolveTheme(sanitizeAppearance({ theme, colors: { up, down } }));
        if (r.pnlUsesCandles) {
          expect(chroma(r.vars['--pos']), `${theme} ${up}`).toBeGreaterThanOrEqual(COLOURFUL);
          expect(distance(r.vars['--pos'], r.vars['--neg']), `${theme} ${up}`).toBeGreaterThanOrEqual(60);
        }
      }
      expect(resolveTheme(sanitizeAppearance({ theme: 'light', colors: { up, down } })).pnlUsesCandles, up).toBe(false);
    }
  });

  it('keeps deep, clearly coloured candles as P/L colours on every theme', () => {
    // Lightened for a dark panel, these lose HSL saturation but still read as plainly green and red.
    // (Teal #004d40 is not here: lightened for a dark panel it is a grey-teal, #6e9a92, too close to
    // the muted labels.)
    for (const up of ['#1b5e20', '#33691e', '#2e7d32'])
      for (const down of ['#b71c1c', '#c62828', '#d32f2f', '#880e4f', '#e65100'])
        for (const theme of THEME_IDS) expect(resolveTheme(sanitizeAppearance({ theme, colors: { up, down } })).pnlUsesCandles, `${theme} ${up}/${down}`).toBe(true);
  });

  it('falls back when P/L text would look like the grey labels next to it', () => {
    // Greyish blues are colourful enough on their own but read as one more muted label.
    for (const [theme, up] of [
      ['light', '#8899bb'],
      ['light', '#bbccff'],
      ['light', '#446688'],
      ['midnight', '#002255'],
      ['midnight', '#446688'],
      ['midnight', '#8899bb'],
      ['graphite', '#002255'],
    ] as const) {
      const r = resolveTheme(sanitizeAppearance({ theme, colors: { up, down: '#ef5350' } }));
      expect(r.pnlUsesCandles, `${theme} ${up}`).toBe(false);
    }
    // Whenever candle colours are used, P/L text stays clearly apart from every neutral text colour.
    for (const theme of THEME_IDS)
      for (let i = 0; i < 300; i++) {
        const up = toHex([(i * 97) % 256, (i * 57 + 31) % 256, (i * 151 + 7) % 256]);
        const r = resolveTheme(sanitizeAppearance({ theme, colors: { up, down: '#ef5350' } }));
        if (!r.pnlUsesCandles) continue;
        for (const n of ['--text', '--text-2', '--muted']) expect(deltaE(r.vars['--pos'], r.vars[n]), `${theme} ${up} vs ${n}`).toBeGreaterThanOrEqual(NEUTRAL_GAP);
      }
  });

  it('adjusts axis label boxes as little as possible', () => {
    // Just under the chart's switch to black text: lightened a touch rather than darkened to brown.
    for (const c of ['#ff9800', '#00bcd4']) {
      const fill = chartLabelFill(c);
      expect(chartLabelText(fill), c).toBe('#000000');
      expect(distance(fill, c), c).toBeLessThan(25);
    }
    // Never further from the picked colour than plain darkening under white text would be.
    for (let i = 0; i < 200; i++) {
      const c = toHex([(i * 97) % 256, (i * 57 + 31) % 256, (i * 151 + 7) % 256]);
      expect(deltaE(chartLabelFill(c), c), c).toBeLessThanOrEqual(deltaE(fillFor('#ffffff', c, 4.5), c) + 1e-9);
    }
    // A strong red stays red rather than turning pink.
    expect(chartLabelText(chartLabelFill('#ef5350'))).toBe('#ffffff');
    // Colours that already work are untouched.
    expect(chartLabelFill('#ffeb3b')).toBe('#ffeb3b');
  });

  it('keeps crosshair labels readable whatever the crosshair colour', () => {
    // lightweight-charts picks black or white label text itself; the label box must suit that choice.
    const colours = ['#ffffff', '#ffeb3b', '#e0e0e0', '#000000', '#758696', '#26a69a', '#ff00ff', '#808080', '#00ffff', '#3a3a3a'];
    for (const crosshair of colours)
      for (const background of ['#0d1117', '#ffffff', '#808080']) {
        const label = resolveTheme(sanitizeAppearance({ colors: { crosshair, background } })).chart.crosshairLabel;
        expect(contrast(chartLabelText(label), label), `${crosshair} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    for (let i = 0; i < 200; i++) {
      const c = toHex([(i * 97) % 256, (i * 57 + 31) % 256, (i * 151 + 7) % 256]);
      const fill = chartLabelFill(c);
      expect(contrast(chartLabelText(fill), fill), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('never lets errors follow the candle colours', () => {
    const r = resolveTheme(sanitizeAppearance({ colors: { up: '#2962ff', down: '#ff9800' } }));
    expect(r.vars['--error']).toBe(resolveTheme(DEFAULT_APPEARANCE).vars['--error']);
    expect(r.vars['--error']).not.toBe(r.vars['--neg']);
  });

  it('makes indicator lines visible on the chart without touching ones that already are', () => {
    expect(onChart('#f5a623', '#0d1117')).toBe('#f5a623');
    expect(contrast(onChart('#f5a623', '#ffffff'), '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(onChart('#e0e0e0', '#ffffff'), '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('keeps the pre-load background in index.html in sync with the themes', () => {
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
    const map = html.match(/var bg = (\{[^}]*\})/)?.[1];
    expect(map).toBeTruthy();
    const parsed = JSON.parse(map!.replace(/'/g, '"').replace(/(\w+):/g, '"$1":')) as Record<string, string>;
    expect(parsed).toEqual(Object.fromEntries(THEME_IDS.map((id) => [id, THEMES[id].ui.bg])));
  });
});
