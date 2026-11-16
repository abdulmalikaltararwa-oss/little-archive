import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { useTheme } from './app/theme';
import { toast } from './app/ui-state';
import { createArchive } from './data/archive';
import { createBackend } from './data/backend';
import { askAiAgain } from './features/ai-permission/gate';
import { morph } from './lib/transition';

// One of three backends is chosen for this page (a browser on a self-hosted server, the phone app's bridge,
// or the in-memory demo), then the same interface runs on top of it.
const backend = await createBackend();
useTheme.getState().init(backend.remembers);

const archive = createArchive({ backend, notify: (message, options) => toast(message, options), transition: morph });
archive.setAiPermissionAsker(() => askAiAgain(archive));

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App archive={archive} />
  </StrictMode>,
);

void archive.boot();
