import { TOKEN_STORAGE_KEY } from './storage-key'

/**
 * The token, and how many times it has been set or rechecked: every change gets a generation of
 * its own, so that it gets a check of its own, even when the token itself is the same as before.
 */
export interface TokenSnapshot {
  token: string | null
  generation: number
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Storage the browser forbids (cookies disabled, say) throws on access.
    return null
  }
}

/**
 * The API token, persisted in `localStorage` (AR2), and so shared by every tab of the SPA: one tab
 * hears of another's change through the `storage` event, while something subscribes (the app's
 * `AuthProvider` does, for as long as the app runs).
 *
 * The token is also kept in memory, so that it lasts the session where storage is unavailable.
 */
export class TokenStore {
  private readonly storage = browserStorage()
  private snapshot: TokenSnapshot
  private readonly listeners = new Set<() => void>()

  constructor() {
    this.snapshot = { token: this.read(), generation: 0 }
  }

  get = (): TokenSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) globalThis.addEventListener('storage', this.onStorage)
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) globalThis.removeEventListener('storage', this.onStorage)
    }
  }

  /** Store `token`, or forget it if null. Leading and trailing whitespace is not part of it. */
  set = (token: string | null): void => {
    const value = token?.trim() || null
    try {
      if (value === null) this.storage?.removeItem(TOKEN_STORAGE_KEY)
      else this.storage?.setItem(TOKEN_STORAGE_KEY, value)
    } catch {
      // Full or forbidden: the token still lasts the session, in memory.
    }
    this.update(value)
  }

  /** Check the same token again. */
  recheck = (): void => {
    this.update(this.snapshot.token)
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(TOKEN_STORAGE_KEY) || null
    } catch {
      return null
    }
  }

  private update(token: string | null): void {
    this.snapshot = { token, generation: this.snapshot.generation + 1 }
    for (const listener of this.listeners) listener()
  }

  /** Another tab changed the token, or cleared all of storage (a null key). */
  private onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== this.storage) return
    if (event.key === TOKEN_STORAGE_KEY || event.key === null) this.update(this.read())
  }
}
