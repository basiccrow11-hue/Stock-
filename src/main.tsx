import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import './styles.css';
import { installThemeSync } from './ui/theme/useTheme';
import { installNumberWheelGuard } from './ui/services/numberWheel';

// Before the first render, so a saved light theme never flashes dark.
installThemeSync();
installNumberWheelGuard();

// The last resort: each page, panel and dialog has its own boundary (App.tsx). Playback pauses,
// since the replay controls go with the app.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary what="The app" layout="app" pausesPlayback>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
