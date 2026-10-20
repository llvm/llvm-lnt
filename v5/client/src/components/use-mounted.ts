import { useEffect, useRef } from 'react'

/**
 * Whether the component is still mounted, for work that outlives it, such as a write the user may
 * have left the page during.
 */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
