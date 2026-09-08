import { NavLink, Outlet } from 'react-router'
import './layout.css'

export function Layout() {
  return (
    <div className="layout">
      <nav className="navbar">
        <div className="navbar-group">
          <NavLink to="/" end className="navbar-brand">
            LNT
          </NavLink>
          <NavLink to="/suites">Test Suites</NavLink>
          <NavLink to="/graph">Graph</NavLink>
          <NavLink to="/compare">Compare</NavLink>
          <NavLink to="/profiles">Profiles</NavLink>
          {/* Opens the OpenAPI viewer in a new tab once the API exists (see design/client/architecture.md). */}
          <span className="navbar-disabled" title="The API documentation viewer is not available yet">
            API
          </span>
        </div>
        <div className="navbar-group">
          <NavLink to="/admin">Admin</NavLink>
          <span className="navbar-disabled" title="The settings panel is not available yet">
            Settings
          </span>
        </div>
      </nav>
      <main className="page">
        <Outlet />
      </main>
    </div>
  )
}
