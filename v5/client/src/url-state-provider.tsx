import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { PendingLocation } from './url-state'

/** Provides what `useUrlState` needs. Render it once, inside the router. */
export function UrlStateProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const pendingRef = useRef(location)
  useLayoutEffect(() => {
    pendingRef.current = location
  }, [location])
  return <PendingLocation.Provider value={pendingRef}>{children}</PendingLocation.Provider>
}
