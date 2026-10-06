import { NavLink, Outlet } from 'react-router-dom';
import './AppShell.css';

const navLinkClassName = ({ isActive }) => 'app-nav-link' + (isActive ? ' is-active' : '');

/**
 * Shared page frame for both modes: a top bar with mode navigation and an
 * <Outlet /> for the active route. Historical.jsx and Live.jsx render
 * inside this via the router, so nav/chrome only exists in one place.
 */
export function AppShell() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">F1 Live</span>
        <nav className="app-nav" aria-label="Telemetry mode">
          <NavLink to="/" end className={navLinkClassName}>
            Replay
          </NavLink>
          <NavLink to="/live" className={navLinkClassName}>
            Live
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
