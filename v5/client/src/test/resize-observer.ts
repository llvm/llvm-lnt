/**
 * jsdom has no `ResizeObserver`, nor any layout for one to observe. This stand-in reports nothing
 * until a test calls `resize`, which calls back every observer observing something, as a resize of
 * what they observe would.
 */

const observing = new Set<FakeResizeObserver>()

export class FakeResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe() {
    observing.add(this)
  }

  unobserve() {}

  disconnect() {
    observing.delete(this)
  }

  report() {
    this.callback([], this)
  }
}

/** Calls back every observer observing something. */
export function resize() {
  for (const observer of [...observing]) observer.report()
}

/** How many observers observe something. */
export const observerCount = () => observing.size

/** Forgets the observers of the test that ended. */
export function resetResizes() {
  observing.clear()
}
