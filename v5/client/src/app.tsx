import { Route, Routes } from 'react-router'
import { Layout } from './layout'
import { Placeholder } from './pages/placeholder'
import { NotFound } from './pages/not-found'

// The route table contains placeholder entries for now.
function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Placeholder title="Dashboard" doc="design/client/dashboard.md" />} />
        <Route
          path="suites"
          element={<Placeholder title="Test Suites" doc="design/client/test-suites.md" />}
        />
        <Route
          path="suites/:suite"
          element={<Placeholder title="Test Suites" doc="design/client/test-suites.md" />}
        />
        <Route
          path="suites/:suite/machines/:name"
          element={<Placeholder title="Machine Detail" doc="design/client/details.md" />}
        />
        <Route
          path="suites/:suite/runs/:uuid"
          element={<Placeholder title="Run Detail" doc="design/client/details.md" />}
        />
        <Route
          path="suites/:suite/commits/:value"
          element={<Placeholder title="Commit Detail" doc="design/client/details.md" />}
        />
        <Route
          path="suites/:suite/regressions/:uuid"
          element={<Placeholder title="Regression Detail" doc="design/client/details.md" />}
        />
        <Route path="graph" element={<Placeholder title="Graph" doc="design/client/graph.md" />} />
        <Route
          path="compare"
          element={<Placeholder title="Compare" doc="design/client/compare.md" />}
        />
        <Route
          path="profiles"
          element={<Placeholder title="Profiles" doc="design/client/profiles.md" />}
        />
        <Route path="admin" element={<Placeholder title="Admin" doc="design/client/admin.md" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App
