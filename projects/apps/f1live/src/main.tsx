import { createRoot } from 'react-dom/client';
import './tokens.css';
import './style.css';
import { App } from './App.tsx';

// No StrictMode: its dev-only double effects would double every OpenF1 request (rate-limited API).
createRoot(document.getElementById('root')!).render(<App />);
