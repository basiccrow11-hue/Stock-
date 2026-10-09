# Stock Replay

A trading simulator for practising when the market is closed. Replay a past trading day bar by bar without seeing what comes next, paper trade it with realistic orders, journal every trade, review your execution, backtest rule-based strategies, or trade a fictional market that never closes.

Everything runs in your browser. Nothing touches a real brokerage account.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests (Vitest): orders, fills, positions, P/L, shorts, indicators, backtests, risk, replay and look-ahead prevention, streak rules, theme contrast, the Vercel proxy |
| `npm run typecheck` | TypeScript, strict mode |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build (keeps the data proxy for Polygon/Alpaca) |

Requires Node 20.19+ or 22.12+ (the test runner needs 22.12+). Node 21 and 22.0 to 22.11 are not supported by the build tools.

## Read this first: what the data is

Every chart, trade and journal entry carries a badge saying where its prices came from.

| Badge | Meaning |
| --- | --- |
| **DEMO · SYNTHETIC** | Bundled offline bars for SPY, QQQ, IWM, AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL and AMD from 2019 onward. They are **generated**, not recorded. They behave like real tape (opening volatility, lunch lull, trend and range days, gaps, earnings days, correlation with the index) but they are **not the real prices** of those tickers on those dates. Good for practising mechanics; useless for studying what actually happened. |
| **HISTORICAL** | Real recorded bars: a CSV you import, or Polygon / Alpaca with your own API key. |
| **SIMULATED · FICTIONAL** | The fictional market: six made-up companies, generated prices, generated news. |
| **LIVE** | Not available. There is no live feed and no real-money trading. |

To practise on real price action, import a CSV or add a vendor key (see below).

## Features

**Historical replay.** Pick a ticker, date, start and end time (ET), single or multi-day, chart timeframe (1m, 5m, 15m, 30m, 1h, 4h, 1D), starting balance and speed. Play, pause, step one bar (one minute on 1-minute data), step one chart candle, step back one bar, restart, change speed (up to 6.5 hours, one regular session, per second), jump to a time. Play runs at the chosen speed on any base timeframe, so an hourly bar takes its hour and a daily bar its session; only nights, weekends and other stretches with no bar trading are skipped. Watchlist symbols can replay on the same clock. **Blind mode** hides the calendar date everywhere (clock, chart axis, crosshair, journal, exports, in every open tab of the app) while the session runs. The chart's axis labels are placed on a calendar moved by some years, so their spacing does not mark real month or year starts, and the session's trades are listed first in the journal rather than among your other trades by date. The session ends when the replay reaches its end time, you start another session or you close the tab. **Random date** picks a day for you (with imported data, one the data has bars for; a date it has no bars for is flagged before the session starts). A blind replay's date is not kept as the next session's default.

**No look-ahead.** Future bars live in private fields of the replay engine and are only handed out once their bar has *completed* on the replay clock. Higher-timeframe candles are built from revealed 1-minute bars, so a forming 15m candle only shows what has happened so far. Indicators are causal (value at bar *i* uses bars 0..*i* only). Tests prove that two datasets with identical pasts and different futures produce identical charts, indicators, fills and backtest results up to the present.

**Paper trading.** Buy, sell, short, cover. Cash, buying power (cash, 2× Reg T or 4× intraday margin), positions with average entry, unrealized and realized P/L, total value, day P/L, win rate and trade count. Every order, fill and event is logged. Buy and Short only open or add to a position, as at a broker that tells them apart from Sell and Cover: an entry order placed while flat that would fill after a position the other way has opened (two-sided entries around a range, say) is cancelled with a message rather than turned into an exit. When an exit and the opposite entry trigger at the same price (a stop at the other side's entry, or a gap through both), the exit fills first and the entry then opens the new trade. Close position also cancels the rest of an entry still filling into the position (a market order, or one already partly filled), so it cannot grow back after the close; entries that have not started stay working. The ticket says how much of an order filled when it fills in pieces.

**Orders.** Market, limit, stop and stop-limit; DAY or GTC; optional extended hours for limits. Stop loss and take profit attach as a one-cancels-other bracket. The ticket shows estimated entry (including half-spread), position value, stop distance, dollar and % risk, potential reward and R:R before you submit, and can size a position from a risk %. Working orders can be modified (click the price) or cancelled. A bracket whose stop or target sits on the wrong side of the price the entry would fill at is refused: that includes a limit or stop already through the market, which fills at once near the last price rather than at its own level, and a working order whose price you change.

**Fill model** (all configurable in Data & Settings):
- Market orders fill at the last price plus half the spread and slippage, or at the next bar open (conservative mode, which uses the next bar that starts after the order, even when that bar opens the next session). An order for a symbol that has not traded yet in the current session (at the start of a replay, with data that has no pre-market bars, a watchlist symbol whose first bar comes later than the others', after the close on a symbol with no after-hours bars, or in the simulated market before its first tick) waits for that symbol's next bar and never fills at an earlier session's close: placed before that bar starts, it fills at its open; placed while it is still forming (a daily bar is only shown at its close), on its prices after that moment. On daily bars, a market order placed while the replay is paused at a close (after a step) fills at that close.
- Inside a bar the engine walks an assumed path (open → nearer extreme → other extreme → close, or worst case for your position). Stops and limits trigger at their price level when the path crosses them; gaps fill at the open. An order trades only on prices after it was placed or last changed: placed partway through a bar (on 5-minute, hourly or daily data, or a daily symbol beside 1-minute ones), it can fill only on the part of that bar's path after that moment, never at an earlier high or low.
- Spread in bps or cents, wider outside regular hours; slippage in bps plus market impact by share of bar volume (charged on up to one bar's whole volume, so with no volume cap a larger order fills at once and pays the impact of one full bar, 5% at the default 5 bps per 1%; a sell never fills below the minimum tick); per-share, per-order and minimum commissions (the per-order fee and minimum are charged once per order, however many pieces it fills in); a cap on the share of a bar's volume you can trade (larger orders fill partially and the rest keeps working; a stop that has fired is a market order from then on, so its rest fills from the next bars even if price comes back; every order filled against the same bar shares the cap, so splitting an order does not get around it). A bar with no volume (data without a volume column) has no cap.
- Market hours follow the NYSE calendar (holidays, early closes). Orders placed while closed wait for the session.

**Risk management.** Warnings such as "WARNING: This trade risks 4.7% of your account." never block a trade unless **strict mode** is on, which rejects orders that exceed your risk, daily loss or position limits or lack a stop.

**Chart.** Candles, volume, crosshair legend, zoom and pan, ET time axis. Indicators: SMA, EMA, VWAP, Bollinger Bands, RSI, MACD, ATR and volume; add, remove, recolour and change periods. Drawing tools: trend line, horizontal and vertical line, rectangle, support/resistance zone and Fibonacci retracement, saved per symbol and kept in place on every timeframe (moving one on a coarser timeframe shifts it by whole candles there). A point drawn to the right of the last candle stays on the candle that later fills that slot: nights, weekends and holidays take no room, as on the chart. Click a drawing to select it and drag it to move it (a Delete button appears in the chart's corner); click the bare chart to let go. Grab a rectangle or zone by its outline and a Fibonacci by its dashed diagonal (or any level once it is selected); their insides leave the crosshair, zoom and pan working. Your fills, open orders, stop and target lines are drawn on the chart. Click the ⌖ buttons on the ticket to pick a price from the chart (a click on a drawing picks too). A working order's price in the Orders tab is a button: click it or Tab to it and press Enter to change it. A stop-limit shows its stop and its limit, each editable until the stop triggers; after that only the limit (if the stop triggers while you edit it, the edit is dropped and a message says so). On a touch screen, tap near a drawing's line to select it, then drag it or its handles; swipes and pinches over any other drawing pan, zoom or scroll as usual. On a phone, a screen up to 1180px wide and 640px tall (a phone in landscape, a small tablet) or any window under 560px tall, the trade screen becomes one scrolling column: watchlist, chart, order ticket, then positions and orders; a vertical swipe on the chart scrolls the page. On other short screens the bottom panel gets shorter so the chart keeps its room.

**Journal.** Each closed trade creates an entry automatically: symbol, direction, entry and exit, size, average prices, stop, target, P/L, return, R multiple, holding time, commission, a chart snapshot, a tag and notes (why I entered, my setup, what I did well, what I did wrong, what I would change). Notes save as you type, and an edit cut off by closing or reloading the tab is finished the next time the app opens (or by another open tab of the app, which also shows it). Search, filter, export to CSV or JSON.

**Learning Mode.** When a trade closes, playback pauses and a review opens: exit reason (by the order that closed the most shares: a stop order is a stop loss whether it came from the ticket's bracket or was placed on its own, a limit that took profit is a target, a market order is a manual exit; a trade closed in parts lists each part), whether the stop filled where you planned or well past it (a gap), whether a gap (or the volume cap, filling one order in parts) filled your entry past its own stop (R is then measured from your order's price, or for a market order from the price when you placed it) or past its own target (planned R:R is then measured from your order's price), was moved into profit or was widened, whether you added past your stop (R is then measured from your first entry, and the risk rule counts as broken; a stop that only came with a later add counts as no stop at entry, and when it sat past your average entry the review says R cannot be measured), MFE and MAE (best and worst open P/L, also in R), how much of the best open profit you kept, risk taken, planned R:R, stop distance in ATR, and a check against your own trading rules (the daily loss rule reads the day's P/L as the account's Day P/L does, positions carried from earlier days included). After a stop, the review adds what price did next once the replay has shown a fixed stretch after the exit (20 minutes on a 1m chart, up to 4 weeks on daily; data coarser than the chart, such as a daily file on a 1m chart, is measured in its own bars), so the verdict is the same at any replay speed; if the replay ends first it goes by what was shown. When several trades close in one step, their reviews open one after another. It explains what happened; it never suggests a trade.

**Analytics.** Net P/L, return, win rate, profit factor, expectancy, average R, planned R:R, average win and loss, payoff ratio, largest win and loss, max drawdown, losing streak, holding time and commissions, plus an equity curve and an R-multiple distribution. Breakdowns by symbol, tag, direction, entry hour, weekday and exit reason. Filter by data source, replay vs simulated market and tag; rewound sessions are excluded by default.

**Backtester.** IF/THEN rules over price, EMA, SMA, VWAP, RSI, MACD (line, signal, histogram), Bollinger Bands, ATR or a number, with crosses above/below and is above/below, combined with ALL or ANY; actions buy, sell, short, cover. Stop loss %, take profit %, sizing by shares, % of equity or % risk, commission, slippage and spread, optional flatten before the close (in the session's last bar, the final minute on 1-minute data; what cannot be closed there, because a thin stock's data has no bar at the close or the volume cap lets only part of the position trade, is closed from the next session's open, with a warning naming the days; daily bars are whole sessions, so it does not apply to them). Signals are evaluated on **closed** candles and filled at the **next bar's open**. Results: stats, equity vs buy and hold, trades on the chart, trade and signal lists. Runs in a Web Worker; a year of 1-minute data takes well under a second.

**Simulated market.** Start Market launches six fictional stocks with different personalities (growth, large-cap tech, small cap, blue chip, volatile momentum, index ETF). Hidden bull, bear and sideways phases, trends, consolidation, overnight gaps, intraday volatility patterns and news events (earnings, analyst calls, lawsuits, economic data) that move prices. Every headline is labelled SIMULATED. Volatility, news frequency, trend strength, regime and seed are configurable.

**Daily practice streak.** The flame in the top bar counts the days in a row you reached your daily practice goal (5 to 60 minutes, default 10). Practice time counts while the tab is in front and you are active on any screen except Data & Settings; a playing replay keeps counting for 10 minutes after your last click or key press, since watching tape is practice too. The ring around the flame fills as you go. Click it for today's progress, your best streak, the next milestone (3, 7, 14, 30, 50, 100 days...) and a calendar of the last four months. Every 7th day you meet your goal within a running streak earns a streak freeze (you can hold 2); freezes cover missed days automatically, but only when you have enough for the whole gap. Days follow your computer's calendar, weekends included, and changing the goal never rewrites completed days. A milestone reached while a replay is playing gets a short note at once and its celebration when you pause, after any trade review, or the next time you open the app, as long as that streak is still running. So it never covers the chart mid-trade, and it waits while you are typing in a field so no keystroke lands on it. Two open windows count the same minutes once. The streak rewards practice time, never profit or trade count, so there is no reason to force a trade to keep it alive. It is stored in your browser.

**Appearance.** Data & Settings → Appearance, or **Chart style** in the chart toolbar for quick changes while you trade. Themes: Midnight, Graphite and Light, plus an accent colour. Chart type: candles, hollow candles, OHLC bars, line or area. Candle colour presets (classic, green/red, colour-blind safe blue/orange, cyan/magenta, monochrome) or your own up/down body, border and wick colours; chart background, grid, axis text and crosshair; grid lines on or off, magnet crosshair, last price line, normal/log/percent price scale (percent labels measure from the first bar on screen and indicators keep their true position; grid lines sit on round prices, so their percent values are not round numbers), volume opacity and axis font size. A live preview shows the result, and a note under the colour fields says when a colour is hard to see. Profit and loss text can follow your candle colours (colours that would be hard to tell from each other or from the grey text around them, such as monochrome or pastel candles, fall back to green and red; colour-blind-safe pairs such as Okabe-Ito or Tableau blue and orange are kept; errors always stay red). The panels and the chart legend decide separately, since a custom chart background can make colours that work on the panels hard to read on the chart; a note under the setting says which fell back. For shades right at the edge of these rules, the choice already on screen stands, so dragging a colour picker does not flicker between them. Text, chart markers, axis labels, drawing labels and indicator lines are nudged automatically when a colour would be hard to read on its background (WCAG 4.5:1 for text, 3:1 for lines), as little as possible. The last-price line and its label mark the last bar on screen (the newest one unless you scroll back) and share one colour, so the line can come out slightly lighter or darker than your candles. Data source labels always stay on the chart.

**Challenges.** Grow $10k to $12k risking ≤1% per trade; trade a day without a 5% drawdown; average 2:1 planned R:R over 10 trades; 20 trades following your rules; positive expectancy over 15 trades. A result is *official* only if you never rewound the session.

## Using real data

### CSV import (works offline)

Data & Settings → Import historical data. Needs columns for time, open, high, low, close and ideally volume. Header names are matched loosely (`timestamp`, `datetime`, `date` + `time`, `o`/`h`/`l`/`c`/`v`, Nasdaq.com's `Close/Last`, ...). Timestamps may be Unix seconds or milliseconds, ISO 8601 with or without offset, or dates with the year last (01/16/2024, 16/01/2024, 16.01.2024): a first number over 12 anywhere in the file makes them day/month, a second one makes them month/day, and a file where every date could be either is read as month/day (day/month when dotted) with a note in the preview. Dates that do not exist (month 13, 31 April) are rejected, not rolled over. Prices written with a decimal comma (185,64, as files from many European locales are) are recognised, and so are abbreviated volumes (82.49M). A comma that could be either (1,234) is settled by the rest of the file (other prices, the volumes, a `;` delimiter, dotted dates); when nothing settles it, it is read as grouping thousands and the preview says so. Without volume, fills are not capped by bar volume and VWAP is not meaningful. Times without a zone are read as New York time by default (switchable to UTC), and there is an option for vendors that stamp bars with their close time. 1-minute bars give the most realistic fills; daily bars work for daily replays and backtests. The bar size (1, 5, 15 or 30 minutes, 1 or 4 hours, or daily) is read from the spacing between bars, ignoring nights, weekends, minutes with no trades and any gap that spans the 09:30 open or the close (where hourly bars on the clock hour meet a session that opens on the half hour), so a thinly traded stock's 1-minute file is still 1-minute; a file spaced at a size the replay does not support (2, 3 or 10 minutes, 2, 6, 8 or 12 hours, weekly or monthly rows) is refused rather than relabelled; a daily file with the odd second row on a day stays daily, and the preview says which rows were merged. The ticker is guessed from the file name, including TradingView's `NASDAQ_AAPL, 1D.csv` and class shares such as `BRK.B`; check it before saving. Each daily row is filed under the day it names, whatever time it is stamped with (midnight UTC, midnight New York, the open or the close), so a day's bar is never shown before that day has traded; rows dated on a weekend or a day the NYSE was closed are skipped and listed in the preview (the holiday calendar follows history: MLK Day from 1998, Juneteenth from 2022). Importing another file for a ticker that already has data adds its bars to that data (where both have a bar at the same time, the new file's is kept), or replaces it if you choose; a file with a different bar size replaces it after you confirm. A bar is shown once it is complete, so with an end time before a bar's end (hourly bars stamped 15:30 run to 16:30) that last bar is not shown. Imports are stored in your browser (IndexedDB).

### Polygon or Alpaca

The browser cannot call these APIs directly (CORS), so the dev and preview servers include a small proxy at `/api/polygon` and `/api/alpaca`, and a Vercel deployment gets the same proxy as a function (see below). A plain static host without either will not work for vendor data; the app says so when it detects one.

Keys, three options:
1. **Session only (default):** paste them in Data & Settings. They live in memory and are gone on reload.
2. **Encrypted in the browser:** save them with a passphrase (AES-GCM, key derived with PBKDF2). You unlock them each session.
3. **Server side (local dev):** put them in `.env.local` next to `package.json`. The browser never sees them; the proxy adds them. On Vercel see [Deploying to Vercel](#deploying-to-vercel) before doing this.

```bash
# .env.local  (git-ignored)
POLYGON_API_KEY=...
ALPACA_KEY_ID=...
ALPACA_SECRET=...
```

Keys are never hard-coded and never logged. `/api/server-keys` reports only whether a key is configured.

## Deploying to Vercel

The repository deploys as is: `vercel.json` builds the Vite app into `dist/` and adds a small function, `api/proxy.ts`, that replaces the dev server's data proxy for Polygon and Alpaca.

- The function forwards only the two bar endpoints the app uses, so it is not an open proxy.
- On a public deployment it forwards only the keys a visitor enters in their own browser. Keys in the project's environment variables (`POLYGON_API_KEY`, `ALPACA_KEY_ID`, `ALPACA_SECRET`) are ignored unless you also set `ALLOW_SERVER_KEYS=true`, because otherwise anyone with the URL could spend your quota. Only set it on a deployment protected by Vercel Authentication or a password.
- Everything else (journal, streak, settings, imported CSVs) stays in each visitor's browser. There is no database and no account.

## Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause, on the Trade screen. It never presses a focused button, so a click on Buy followed by Space cannot place a second order; Enter presses a focused button. |
| → | Step forward one bar (one minute on 1-minute data) |
| Shift + → | Step one chart candle |
| ← | Step back one bar (marks the session as rewound) |
| Esc | Close the open dialog or menu; otherwise cancel chart price picking (also from a ticket field) or the current drawing |
| Delete | Delete the selected drawing, on the Trade screen only (not while a dialog or menu is open) |
| Tab, then Enter | Switch the charted symbol from the watchlist or the positions table, or open a journal entry |

## Honest limits

- **Demo data is synthetic.** See above. Do not draw conclusions about real tickers from it.
- **Fills are modelled from bars, not an order book.** The engine knows each bar's open, high, low, close and volume, not the order in which prices traded inside it, so it assumes a path. Queue position for limit orders is not modelled ("touch" fills as soon as price reaches your limit; choose "trade through" for a stricter rule). Spreads are a configurable model, not historical quotes.
- **Price level can hint at the era in blind mode.** Blind mode hides dates, but a real ticker's price level (for example SPY near 590) still narrows down when it was.
- **Sessions do not survive a page reload.** The journal, analytics, imported data, settings and drawings persist; an in-progress replay or simulated market does not.
- **Rewinding rewrites history.** Stepping back past a closed trade undoes it and removes its journal entry (you are asked first), and the session is flagged as not blind. Jumping back to a time restores the account as it was at that moment, orders placed then included; Restart returns to the starting balance with no orders. Going back before the first new bar has appeared (Restart at the start, or after Play was paused within the first minute) is not a rewind, since nothing after the start has been seen.
- **Vendor data needs the proxy and a network.** Polygon and Alpaca were implemented against their documented APIs and are tested with mocked responses; plan limits (history depth, rate limits, IEX vs SIP volume) are the vendor's.
- **Single user, single browser.** Data is stored locally; there is no account or sync. Clearing site data resets the journal and the streak.
- **The streak measures time, not quality.** It cannot tell focused practice from leaving a replay playing; it only stops counting after 10 minutes without input. It is a nudge to show up, not a measure of skill.

## Architecture

```
src/core/            framework-free engine (fully unit tested)
  time.ts            NYSE calendar, sessions, ET conversion (DST-safe)
  data/              MarketDataProvider / HistoricalDataProvider / StreamingDataProvider interfaces,
                     demo generator, CSV parser + provider, Polygon + Alpaca providers,
                     SimulationDataProvider, bar aggregation
  replay/            ReplayEngine (one symbol, hides the future) and ReplaySession (multi-symbol clock,
                     broker, step-back checkpoints)
  broker/            SimBroker (orders, fills, positions, brackets, P/L) and execution config
  indicators/        causal SMA, EMA, RSI, MACD, Bollinger, ATR, VWAP
  risk/              pre-trade risk assessment, position sizing, strict mode
  backtest/          rule definitions and the backtester
  sim/               fictional market generator and news
  analytics/         performance statistics
  learning/          post-trade review
  challenges/        challenge definitions and evaluation
  streak/            daily practice streak rules (goal, freezes, milestones, calendar)
src/ui/              React UI
  state/             zustand stores; tradingStore runs the play loop and bridges engine → UI;
                     streakStore tracks active practice time
  theme/             themes, colour maths (WCAG contrast) and the resolved palette for CSS and charts
  chart/             lightweight-charts wrapper, drawing layer, line charts
  components/        terminal panels, order ticket, dialogs
  pages/             backtest, journal, analytics, challenges, settings
vite.config.ts       dev/preview proxy for vendor APIs, server-side key injection
api/proxy.ts         the same proxy as a Vercel function (deployed builds)
vercel.json          build settings, proxy rewrites, security headers
```

The engine has no browser dependencies, so new data sources plug in by implementing `HistoricalDataProvider` (see `src/core/data/provider.ts`) and registering it in `src/ui/state/dataRegistry.ts`.
