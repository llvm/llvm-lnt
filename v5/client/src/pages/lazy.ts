import { lazy } from 'react'

// One chunk per page, fetched the first time the page is visited (AR2 "Code splitting"). Lazy
// components rather than lazy routes, which would keep the page left, and its URL, until the new
// page's code has loaded.
export const Dashboard = lazy(() => import('./dashboard'))
export const TestSuites = lazy(() => import('./test-suites'))
export const MachineDetail = lazy(() => import('./details/machine-detail'))
export const RunDetail = lazy(() => import('./details/run-detail'))
export const CommitDetail = lazy(() => import('./details/commit-detail'))
export const RegressionDetail = lazy(() => import('./details/regression-detail'))
export const Graph = lazy(() => import('./graph'))
export const Compare = lazy(() => import('./compare'))
export const Profiles = lazy(() => import('./profiles'))
export const Admin = lazy(() => import('./admin'))
