/**
 * jsdom lays nothing out: every element is 0 pixels tall, so a virtualized list, which renders the
 * rows that fit in its box, renders none, and no element has `scrollTo` or `scrollIntoView`. Until
 * the test ends, `fakeLayout` gives every element the size given, content too large for any test to
 * scroll past its end, a `scrollTo` that scrolls at once, as the browser's does when it does not
 * animate, and a `scrollIntoView` that does nothing.
 */

import { onTestFinished, vi } from 'vitest'

/** How large every element's content is, in pixels, both ways. */
const CONTENT_SIZE = 1e9

export function fakeLayout({
  width = 800,
  height = 480,
}: { width?: number; height?: number } = {}) {
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height),
    // On `HTMLElement` rather than `Element`, where they are defined: that is how React Aria's
    // virtualizer tells that a test lays elements out, which it otherwise takes to be infinitely
    // large, rendering every item.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height),
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(CONTENT_SIZE),
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(CONTENT_SIZE),
  ]
  const scrollTo = vi.fn(function (this: Element, options?: ScrollToOptions) {
    if (options?.top !== undefined) this.scrollTop = options.top
    if (options?.left !== undefined) this.scrollLeft = options.left
    this.dispatchEvent(new Event('scroll'))
  })
  Element.prototype.scrollTo = scrollTo as Element['scrollTo']
  Element.prototype.scrollIntoView = () => {}
  onTestFinished(() => {
    spies.forEach((spy) => spy.mockRestore())
    delete (Element.prototype as Partial<Element>).scrollTo
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })
  return { scrollTo }
}
