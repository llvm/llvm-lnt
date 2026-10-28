import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from 'react'

interface Host {
  register(element: Element): () => void
}

/**
 * What a box floating over the page, such as a chart's dialog (GR11), offers the overlays opened
 * from inside it but placed elsewhere in the page, such as a commit's card (AR21), so that they
 * count as part of it: a press in one is no press outside the box, and while one is open, Escape
 * is its own.
 */
export const NestedOverlays = createContext<Host | null>(null)

/**
 * The box's side of `NestedOverlays`: the value to provide, whether a target is in an overlay
 * nested in it, and whether any is open.
 */
export function useNestedOverlayHost() {
  const nested = useRef(new Set<Element>())
  const host = useMemo<Host>(
    () => ({
      register: (element) => {
        nested.current.add(element)
        return () => void nested.current.delete(element)
      },
    }),
    [],
  )
  const contains = useCallback((target: Node) => {
    for (const element of nested.current) if (element.contains(target)) return true
    return false
  }, [])
  const isOpen = useCallback(() => nested.current.size > 0, [])
  return { host, contains, isOpen }
}

/** Register `ref`'s element as an overlay nested in the box around it, if any, while mounted. */
export function useNestedOverlay(ref: RefObject<Element | null>) {
  const host = useContext(NestedOverlays)
  useEffect(() => {
    const element = ref.current
    if (host === null || element === null) return
    return host.register(element)
  }, [host, ref])
}
