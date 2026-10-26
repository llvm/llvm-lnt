import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router'

/** Ask the user whether to leave a form with unsaved changes, discarding them. */
function confirmLeaving(): boolean {
  return window.confirm('You have unsaved changes. Leave anyway?')
}

/**
 * Ask before the user leaves a form while `unsaved` (AR19): a navigation within the SPA to another
 * URL goes ahead only once the user confirms, and reloading or closing the browser tab, or leaving
 * the SPA, has the browser ask.
 *
 * Returns a function that lets the user leave without asking from then on, for the form to call
 * once its changes are saved, before a navigation of its own: the form has not rendered yet what
 * the save changed.
 */
export function useUnsavedChanges(unsaved: boolean): () => void {
  // What the router asks is the function registered by an effect, which reads them from here so
  // that it never sees what an earlier render had.
  const unsavedRef = useRef(unsaved)
  const leavableRef = useRef(false)
  useLayoutEffect(() => {
    unsavedRef.current = unsaved
  })
  const blocks = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      unsavedRef.current &&
      !leavableRef.current &&
      (nextLocation.pathname !== currentLocation.pathname ||
        nextLocation.search !== currentLocation.search),
    [],
  )
  const blocker = useBlocker(blocks)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    // Deferred, as react-router's own prompt does, for the router to be done with the navigation
    // it refused.
    if (confirmLeaving()) setTimeout(blocker.proceed, 0)
    else blocker.reset()
  }, [blocker])

  useEffect(() => {
    if (!unsaved) return
    const ask = (event: BeforeUnloadEvent) => {
      if (leavableRef.current) return
      event.preventDefault()
      // What older browsers need instead.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [unsaved])

  return useCallback(() => {
    leavableRef.current = true
  }, [])
}
