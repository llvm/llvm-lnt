import type { RouteObject } from 'react-router'
import { Layout } from './layout'
import {
  Admin,
  CommitDetail,
  Compare,
  Dashboard,
  Graph,
  MachineDetail,
  Profiles,
  RegressionDetail,
  RunDetail,
  TestSuites,
} from './pages/lazy'
import { NotFound } from './pages/not-found'
import { RethrowError } from './rethrow-error'

/** The page hierarchy of AR3, every URL in it: those it does not name show `NotFound`. */
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'suites', element: <TestSuites /> },
      { path: 'suites/:suite', element: <TestSuites /> },
      { path: 'suites/:suite/machines/:name', element: <MachineDetail /> },
      { path: 'suites/:suite/runs/:uuid', element: <RunDetail /> },
      { path: 'suites/:suite/commits/:value', element: <CommitDetail /> },
      { path: 'suites/:suite/regressions/:uuid', element: <RegressionDetail /> },
      { path: 'graph', element: <Graph /> },
      { path: 'compare', element: <Compare /> },
      { path: 'profiles', element: <Profiles /> },
      { path: 'admin', element: <Admin /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]

/** The route at the root of the router, above `children`: the app's routes, say. */
export function rootRoute(children: RouteObject[]): RouteObject {
  return { ErrorBoundary: RethrowError, children }
}
