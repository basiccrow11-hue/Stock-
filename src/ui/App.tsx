import { Suspense, useEffect, useRef, useState } from "react";
import { TopBar, type View } from "./components/TopBar";
import { Watchlist } from "./components/Watchlist";
import { ChartPanel } from "./components/ChartPanel";
import { RightPanel } from "./components/RightPanel";
import { BottomPanel } from "./components/BottomPanel";
import { SessionSetup, type SetupMode } from "./components/SessionSetup";
import { TradeReviewModal } from "./components/TradeReviewModal";
import { Toasts } from "./components/common";
import { StreakCelebration, StreakModal } from "./components/Streak";
import { requestAppearanceFocus } from "./components/Appearance";
import { ErrorBoundary, retryableLazy } from "./components/ErrorBoundary";
import { requestFocus } from "./services/focusRequest";
// Secondary pages load on first visit to keep the trading screen's initial bundle small. A download
// that fails (a dropped connection, or a new version of the app replaced the files) can be tried again.
const BacktestPage = retryableLazy(() => import("./pages/BacktestPage"), "BacktestPage");
const JournalPage = retryableLazy(() => import("./pages/JournalPage"), "JournalPage");
const AnalyticsPage = retryableLazy(() => import("./pages/AnalyticsPage"), "AnalyticsPage");
const ChallengesPage = retryableLazy(() => import("./pages/ChallengesPage"), "ChallengesPage");
const SettingsPage = retryableLazy(() => import("./pages/SettingsPage"), "SettingsPage");
import { useJournal } from "./state/journalStore";
import { useChallenges } from "./state/challengeStore";
import { useCredentials } from "./state/credentials";
import { loadCsvDatasets } from "./state/dataRegistry";
import { dismissCelebration, openStreakPanel, startPracticeTracker } from "./state/streakStore";
import { closeReview, useTrading } from "./state/tradingStore";

export function App() {
  const [view, setView] = useState<View>("trade");
  const [setup, setSetup] = useState<{
    mode: SetupMode;
    challengeId?: string;
  } | null>(null);
  const [journalFocus, setJournalFocus] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [backtestOpened, setBacktestOpened] = useState(false);
  useEffect(() => {
    if (view === "backtest") setBacktestOpened(true);
  }, [view]);

  useEffect(() => {
    void useJournal.getState().load();
    void useChallenges.getState().load();
    void loadCsvDatasets();
    void useCredentials.getState().checkServer();
  }, []);

  // "Theme and all colours…" in the chart toolbar: open settings at the Appearance card, which
  // takes focus when it mounts, so keyboard users are not left on <body>.
  const openAppearance = () => {
    requestAppearanceFocus();
    setView("settings");
  };

  // Practice time for the daily streak: every screen except settings counts.
  useEffect(
    () =>
      startPracticeTracker(
        () => viewRef.current !== "settings",
        () => useTrading.getState().playing,
      ),
    [],
  );

  // Each page, panel and dialog fails on its own: what failed says so in its place, and the rest of
  // the app, the running session included, carries on.
  return (
    <div className="app">
      <ErrorBoundary what="The top bar" layout="bar">
        <TopBar view={view} onView={setView} />
      </ErrorBoundary>
      {/* Pages cover the terminal instead of replacing it. */}
      <div className="views">
        {/* The terminal stays mounted so the chart and drawings survive page switches, and laid out */}
        {/* (only hidden) so a chart snapshot taken while a page covers it still has the chart's size. */}
        {/* Focusable so a closing dialog whose opener is gone can return focus here, not to <body>. */}
        <main
          className={`terminal${view === "trade" ? "" : " offstage"}`}
          tabIndex={-1}
          data-focus-home=""
          aria-label="Trading terminal"
        >
          <ErrorBoundary what="The watchlist" layout="panel" className="panel area-watch">
            <Watchlist />
          </ErrorBoundary>
          {/* The replay controls are part of the chart panel: playback pauses if it fails. */}
          <ErrorBoundary what="The chart" layout="panel" className="panel area-chart" pausesPlayback>
            <ChartPanel
              onNewSession={(mode) => setSetup({ mode })}
              onOpenSettings={openAppearance}
              active={view === "trade"}
            />
          </ErrorBoundary>
          <ErrorBoundary what="The order ticket" layout="panel" className="panel area-right">
            <RightPanel onNewSession={(mode) => setSetup({ mode })} />
          </ErrorBoundary>
          <ErrorBoundary what="The positions and orders panel" layout="panel" className="panel area-bottom">
            <BottomPanel
              onOpenJournal={(id) => {
                // The terminal hides; the journal takes focus on that trade's row.
                requestFocus("journal");
                setJournalFocus(id);
                setView("journal");
              }}
            />
          </ErrorBoundary>
        </main>
        <Suspense
          fallback={
            view === "trade" ? null : <div className="page muted">Loading…</div>
          }
        >
          {/* The backtester stays mounted once opened, so its strategy, results and a run in progress survive a page switch. */}
          <ErrorBoundary what="The Backtest page" layout="page" hidden={view !== "backtest"} onRetry={BacktestPage.retry}>
            {(view === "backtest" || backtestOpened) && (
              <BacktestPage active={view === "backtest"} />
            )}
          </ErrorBoundary>
          {view === "journal" && (
            <ErrorBoundary what="The Journal page" layout="page" onRetry={JournalPage.retry}>
              <JournalPage focusId={journalFocus} />
            </ErrorBoundary>
          )}
          {view === "analytics" && (
            <ErrorBoundary what="The Analytics page" layout="page" onRetry={AnalyticsPage.retry}>
              <AnalyticsPage />
            </ErrorBoundary>
          )}
          {view === "challenges" && (
            <ErrorBoundary what="The Challenges page" layout="page" onRetry={ChallengesPage.retry}>
              <ChallengesPage
                onStart={(challengeId, mode) => {
                  setView("trade");
                  setSetup({ mode, challengeId });
                }}
              />
            </ErrorBoundary>
          )}
          {view === "settings" && (
            <ErrorBoundary what="The Data & Settings page" layout="page" onRetry={SettingsPage.retry}>
              <SettingsPage />
            </ErrorBoundary>
          )}
        </Suspense>
      </div>
      {setup && (
        <ErrorBoundary what="The new session form" layout="dialog" onClose={() => setSetup(null)}>
          <SessionSetup
            mode={setup.mode}
            presetChallenge={setup.challengeId}
            onClose={() => setSetup(null)}
          />
        </ErrorBoundary>
      )}
      <ErrorBoundary what="The trade review" layout="dialog" onClose={closeReview}>
        <TradeReviewModal />
      </ErrorBoundary>
      <ErrorBoundary what="The daily practice panel" layout="dialog" onClose={() => openStreakPanel(false)}>
        <StreakModal />
      </ErrorBoundary>
      <ErrorBoundary what="The milestone celebration" layout="dialog" onClose={dismissCelebration}>
        <StreakCelebration view={view} />
      </ErrorBoundary>
      <Toasts />
    </div>
  );
}
