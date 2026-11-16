import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { I18nProvider } from './app/i18n';
import { registerOffline } from './app/offline';
import { Router } from './app/router';
import './styles/app.css';

// Registers the service worker that keeps the site usable with no network. Quietly: if the
// browser will not have one, the pages work exactly as before.
void registerOffline().catch(() => {});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <Router>
        <App />
      </Router>
    </I18nProvider>
  </StrictMode>,
);
