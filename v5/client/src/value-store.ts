import { useSyncExternalStore } from 'react'

/**
 * A value kept out of React state, so that a change to it renders again only the components that
 * read it, through `useStoreValue`, rather than the component owning it and everything below.
 */
export class ValueStore<T> {
  private value: T
  private readonly listeners = new Set<() => void>()

  constructor(value: T) {
    this.value = value
  }

  get = () => this.value

  set(value: T) {
    if (Object.is(value, this.value)) return
    this.value = value
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** What `read` makes of `store`'s value, rendering again only when that changes. */
export function useStoreValue<T, R>(store: ValueStore<T>, read: (value: T) => R): R {
  return useSyncExternalStore(store.subscribe, () => read(store.get()))
}
