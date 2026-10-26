import { RouterProvider, type DataRouter } from 'react-router'
import { UrlStateProvider } from './url-state-provider'

/** The provider of `router`, as the app renders it, with what `useUrlState` needs around it. */
export function AppRouterProvider({ router }: { router: DataRouter }) {
  return (
    <UrlStateProvider router={router}>
      {/* Without transitions, a control kept in the URL shows a change on the click that makes
          it, rather than once the navigation it triggers has rendered in the background. On the
          other hand, going to a page whose code has not loaded yet shows the loading fallback in
          place of the page left, rather than keep it up until the new one is ready. */}
      <RouterProvider router={router} useTransitions={false} />
    </UrlStateProvider>
  )
}
