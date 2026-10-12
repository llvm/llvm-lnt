/**
 * A bound on how many requests are in flight at once: each request takes one of a fixed number of
 * slots, and one that finds them all taken waits for one, in the order the requests came.
 */
export class RequestSlots {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(size: number) {
    this.free = size
  }

  /**
   * `request`, sent once a slot is free, which it holds until it settles. A request whose `signal`
   * is aborted while it waits gives up waiting, and is rejected with the signal's reason.
   */
  async run<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await request()
    } finally {
      this.release()
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.free > 0) {
      this.free--
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const take = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        this.waiting.splice(this.waiting.indexOf(take), 1)
        reject(signal.reason)
      }
      this.waiting.push(take)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * Hand the slot to the request waiting longest, if one is, or free it. Handing it over, rather
   * than freeing it, keeps a request arriving meanwhile from taking it first.
   */
  private release() {
    const next = this.waiting.shift()
    if (next === undefined) this.free++
    else next()
  }
}
