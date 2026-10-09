/**
 * jsdom has no `IntersectionObserver`, which React Aria uses to load more of a list when its end
 * scrolls into view. This stand-in has nothing in view until a test calls `scrollToEnd`. From then
 * on, everything is, and like the browser's, it says so as soon as it starts observing a target.
 */

const observers = new Set<FakeIntersectionObserver>()
let inView = false

export class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds = []
  private readonly targets = new Set<Element>()
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    this.targets.add(target)
    observers.add(this)
    if (inView) queueMicrotask(() => this.report([target]))
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  report(targets: Element[] = [...this.targets]) {
    const entries = targets
      .filter((target) => this.targets.has(target))
      .map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 }) as IntersectionObserverEntry)
    if (entries.length > 0) this.callback(entries, this)
  }
}

/** What the browser reports when the user scrolls a list to its end, and keeps it there. */
export function scrollToEnd() {
  inView = true
  for (const observer of observers) observer.report()
}

/** Nothing in view again, for the next test. */
export function resetIntersections() {
  inView = false
}
