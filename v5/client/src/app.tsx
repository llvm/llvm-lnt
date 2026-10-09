import { lazy } from 'react'
import { Route, Routes } from 'react-router'
import { Layout } from './layout'
import { NotFound } from './pages/not-found'

// One chunk per page, fetched the first time the page is visited (AR2 "Code splitting").
const Dashboard = lazy(() => import('./pages/dashboard'))
const TestSuites = lazy(() => import('./pages/test-suites'))
const MachineDetail = lazy(() => import('./pages/details/machine-detail'))
const RunDetail = lazy(() => import('./pages/run-detail'))
const CommitDetail = lazy(() => import('./pages/commit-detail'))
const RegressionDetail = lazy(() => import('./pages/regression-detail'))
const Graph = lazy(() => import('./pages/graph'))
const Compare = lazy(() => import('./pages/compare'))
const Profiles = lazy(() => import('./pages/profiles'))
const Admin = lazy(() => import('./pages/admin'))

// The page hierarchy of AR3.
function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="suites" element={<TestSuites />} />
        <Route path="suites/:suite" element={<TestSuites />} />
        <Route path="suites/:suite/machines/:name" element={<MachineDetail />} />
        <Route path="suites/:suite/runs/:uuid" element={<RunDetail />} />
        <Route path="suites/:suite/commits/:value" element={<CommitDetail />} />
        <Route path="suites/:suite/regressions/:uuid" element={<RegressionDetail />} />
        <Route path="graph" element={<Graph />} />
        <Route path="compare" element={<Compare />} />
        <Route path="profiles" element={<Profiles />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
