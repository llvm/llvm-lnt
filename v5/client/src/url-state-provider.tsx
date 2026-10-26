import type { ReactNode } from 'react'
import type { DataRouter } from 'react-router'
import { UrlStateRouter } from './url-state'

/**
 * Provides what `useUrlState` needs: `router`, whose location its changes start from. Render it
 * once, around the router's provider.
 *
 * The router must navigate synchronously, as it does without loaders, actions, lazy routes or
 * middleware, so that its location is always that of the last navigation, even one it has not
 * rendered yet, which a change made right after it must start from.
 */
export function UrlStateProvider({
  router,
  children,
}: {
  router: Pick<DataRouter, 'state'>
  children: ReactNode
}) {
  return <UrlStateRouter.Provider value={router}>{children}</UrlStateRouter.Provider>
}
