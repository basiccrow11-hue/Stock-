import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';
import { installThemeSync } from './ui/theme/useTheme';
import { installNumberWheelGuard } from './ui/services/numberWheel';

// Before the first render, so a saved light theme never flashes dark.
installThemeSync();
installNumberWheelGuard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
