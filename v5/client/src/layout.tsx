import { Suspense } from 'react'
import { NavLink, Outlet, useLocation, useMatch } from 'react-router'
import clsx from 'clsx'
import { useRevision } from './api/api-index'
import { suiteRef } from './api/suites'
import { SettingsMenu } from './auth/settings-menu'
import { Loading } from './components/feedback'
import { PageErrorBoundary } from './components/page-error-boundary'
import { comparePath, graphPath, PROJECTS_PATH, profilesPath, suitePath } from './paths'
import styles from './layout.module.css'

export function Layout() {
  // Every navigation recovers a page that failed, including one to the same URL.
  const { key } = useLocation()
  // The suite of a suite-scoped page, which the links to other pages pass on (AR4).
  const match = useMatch('/projects/:project/suites/:suite/*')?.params
  const suite =
    match?.project === undefined || match.suite === undefined
      ? undefined
      : suiteRef(match.project, match.suite)
  return (
    <div className={styles.root}>
      <nav className={styles.navbar}>
        <div className={styles.group}>
          <NavLink to="/" end className={clsx(styles.link, styles.brand)}>
            LNT
          </NavLink>
          <NavLink
            to={suite === undefined ? PROJECTS_PATH : suitePath(suite)}
            className={styles.link}
          >
            Test Suites
          </NavLink>
          <NavLink to={graphPath({ suite })} className={styles.link}>
            Graph
          </NavLink>
          <NavLink to={comparePath({ suite })} className={styles.link}>
            Compare
          </NavLink>
          <NavLink to={profilesPath({ suite })} className={styles.link}>
            Profiles
          </NavLink>
          {/* The API documentation viewer is a separate document rather than an SPA route, so it
              opens in a new tab (see AR4). */}
          <a href="/api/docs" target="_blank" rel="noopener noreferrer" className={styles.link}>
            API
          </a>
        </div>
        <div className={styles.group}>
          <NavLink to="/admin" className={styles.link}>
            Admin
          </NavLink>
          <SettingsMenu className={clsx(styles.link, styles.button)} />
        </div>
      </nav>
      <main className={styles.page}>
        <PageErrorBoundary resetKey={key}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </PageErrorBoundary>
      </main>
      <Footer />
    </div>
  )
}

/** The page footer (AR4), naming the commit of LNT the server was built from, if it says. */
function Footer() {
  const revision = useRevision()
  return (
    <footer className={styles.footer}>
      LNT v5
      {revision !== null && (
        <>
          <span aria-hidden="true"> · </span>
          <a
            href={`https://github.com/llvm/llvm-lnt/commit/${revision}`}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.revision}
          >
            {revision}
          </a>
        </>
      )}
    </footer>
  )
}
