import { Suspense } from 'react'
import { NavLink, Outlet, useLocation, useMatch } from 'react-router'
import { SettingsMenu } from './auth/settings-menu'
import { Loading } from './components/feedback'
import { PageErrorBoundary } from './components/page-error-boundary'
import './layout.css'

/** `path`, with the suite of a suite-scoped page passed on as `param` (AR4). */
function withSuite(path: string, param: string, suite: string | undefined): string {
  return suite === undefined ? path : `${path}?${new URLSearchParams({ [param]: suite })}`
}

export function Layout() {
  // Every navigation recovers a page that failed, including one to the same URL.
  const { key } = useLocation()
  const suite = useMatch('/suites/:suite/*')?.params.suite
  return (
    <div className="layout">
      <nav className="navbar">
        <div className="navbar-group">
          <NavLink to="/" end className="navbar-brand">
            LNT
          </NavLink>
          <NavLink to={suite === undefined ? '/suites' : `/suites/${encodeURIComponent(suite)}`}>
            Test Suites
          </NavLink>
          <NavLink to={withSuite('/graph', 'suite', suite)}>Graph</NavLink>
          <NavLink to={withSuite('/compare', 'suite_a', suite)}>Compare</NavLink>
          <NavLink to={withSuite('/profiles', 'suite_a', suite)}>Profiles</NavLink>
          {/* The API documentation viewer is a separate document rather than an SPA route, so it
              opens in a new tab (see AR4). */}
          <a href="/api/docs" target="_blank" rel="noopener noreferrer">
            API
          </a>
        </div>
        <div className="navbar-group">
          <NavLink to="/admin">Admin</NavLink>
          <SettingsMenu />
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
