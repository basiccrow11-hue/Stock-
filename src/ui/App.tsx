import { lazy, Suspense, useEffect, useRef, useState } from "react";
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
// Secondary pages load on first visit to keep the trading screen's initial bundle small.
const BacktestPage = lazy(() =>
  import("./pages/BacktestPage").then((m) => ({ default: m.BacktestPage })),
);
const JournalPage = lazy(() =>
  import("./pages/JournalPage").then((m) => ({ default: m.JournalPage })),
);
const AnalyticsPage = lazy(() =>
  import("./pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })),
);
const ChallengesPage = lazy(() =>
  import("./pages/ChallengesPage").then((m) => ({ default: m.ChallengesPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
import { useJournal } from "./state/journalStore";
import { useChallenges } from "./state/challengeStore";
import { useCredentials } from "./state/credentials";
import { loadCsvDatasets } from "./state/dataRegistry";
import { startPracticeTracker } from "./state/streakStore";
import { useTrading } from "./state/tradingStore";

export function App() {
  const [view, setView] = useState<View>("trade");
  const [setup, setSetup] = useState<{
    mode: SetupMode;
    challengeId?: string;
  } | null>(null);
  const [journalFocus, setJournalFocus] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

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

  return (
    <div className="app">
      <TopBar view={view} onView={setView} />
      {/* The terminal stays mounted so the chart and drawings survive page switches. */}
      {/* Focusable so a closing dialog whose opener is gone can return focus here, not to <body>. */}
      <main
        className={`terminal${view === "trade" ? "" : " hidden"}`}
        tabIndex={-1}
        data-focus-home=""
        aria-label="Trading terminal"
      >
        <Watchlist />
        <ChartPanel
          onNewSession={(mode) => setSetup({ mode })}
          onOpenSettings={openAppearance}
          active={view === "trade"}
        />
        <RightPanel />
        <BottomPanel
          onOpenJournal={(id) => {
            setJournalFocus(id);
            setView("journal");
          }}
        />
      </main>
      <Suspense
        fallback={
          view === "trade" ? null : <div className="page muted">Loading…</div>
        }
      >
        {view === "backtest" && <BacktestPage />}
        {view === "journal" && <JournalPage focusId={journalFocus} />}
        {view === "analytics" && <AnalyticsPage />}
        {view === "challenges" && (
          <ChallengesPage
            onStart={(challengeId, mode) => {
              setView("trade");
              setSetup({ mode, challengeId });
            }}
          />
        )}
        {view === "settings" && <SettingsPage />}
      </Suspense>
      {setup && (
        <SessionSetup
          mode={setup.mode}
          presetChallenge={setup.challengeId}
          onClose={() => setSetup(null)}
        />
      )}
      <TradeReviewModal />
      <StreakModal />
      <StreakCelebration view={view} />
      <Toasts />
    </div>
  );
}
