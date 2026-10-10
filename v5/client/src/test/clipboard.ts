import { onTestFinished, vi } from 'vitest'

/**
 * Give the page a clipboard, which jsdom lacks, until the test finishes: `writeText` succeeds, or
 * does what `write` says. Returns the mock, to see what was copied. Install it after any
 * `userEvent.setup()`, which installs a clipboard of its own.
 */
export function mockClipboard(write: (text: string) => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(write)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
  })
  return writeText
}
