import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import { RealApp } from './RealApp.tsx';

// No StrictMode on the real app: its dev-only double effects would double every OpenF1 request (rate-limited API). The mock makes no requests, so it runs strict to prove cleanup.
const root = createRoot(document.getElementById('root')!);
// The mock source is dev-only: `import.meta.env.DEV` is false in `vite build`, so the dynamic import (and the mock) never ship.
if (import.meta.env.DEV) {
  const sc = new URLSearchParams(location.search).get('scenario');
  if (sc) {
    import('./mock/MockApp.tsx').then(({ MockApp }) => root.render(<StrictMode><MockApp scenario={sc} /></StrictMode>));
  } else root.render(<RealApp />);
} else root.render(<RealApp />);
