/**
 * jsdom has no `ResizeObserver`, nor any layout for one to observe. This stand-in reports nothing
 * until a test calls `resize`, which calls back every observer with an entry for each element it
 * observes, as a resize of all of them would.
 */

const observing = new Set<FakeResizeObserver>()

export class FakeResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback
  private readonly targets = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.targets.add(target)
    observing.add(this)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
    if (this.targets.size === 0) observing.delete(this)
  }

  disconnect() {
    this.targets.clear()
    observing.delete(this)
  }

  report() {
    const entries = [...this.targets].map(
      (target) => ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry,
    )
    this.callback(entries, this)
  }
}

/** Calls back every observer observing something, as a resize of what it observes. */
export function resize() {
  for (const observer of [...observing]) observer.report()
}

/** How many observers observe something. */
export const observerCount = () => observing.size

/** Forgets the observers of the test that ended. */
export function resetResizes() {
  observing.clear()
}
