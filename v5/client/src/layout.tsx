import { Suspense } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { Loading } from './components/feedback'
import { PageErrorBoundary } from './components/page-error-boundary'
import './layout.css'

export function Layout() {
  // Every navigation recovers a page that failed, including one to the same URL.
  const { key } = useLocation()
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
          {/* The API documentation viewer is a separate document rather than an SPA route, so it
              opens in a new tab (see AR4). */}
          <a href="/api/docs" target="_blank" rel="noopener noreferrer">
            API
          </a>
        </div>
        <div className="navbar-group">
          <NavLink to="/admin">Admin</NavLink>
          <span className="navbar-disabled" title="The settings panel is not available yet">
            Settings
          </span>
        </div>
      </nav>
      <main className="page">
        <PageErrorBoundary resetKey={key}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </PageErrorBoundary>
      </main>
    </div>
  )
}
