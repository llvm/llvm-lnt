import { describe, expect, it } from 'vitest'
import {
  compareSuiteLists,
  compareSuites,
  suiteLabel,
  suiteLabelOf,
  suiteOption,
  suitesNamed,
} from './labels'

const suite = (name: string, display_name: string | null = null) => ({ name, display_name })

describe('suiteLabel', () => {
  it('is the display name, or the name when there is none', () => {
    expect(suiteLabel(suite('nts', 'LLVM test-suite'))).toBe('LLVM test-suite')
    expect(suiteLabel(suite('nts'))).toBe('nts')
  })

  it("names a suite by its name until it is known, or if it isn't", () => {
    const suites = [suite('nts', 'LLVM test-suite')]
    expect(suiteLabelOf(suites, 'nts')).toBe('LLVM test-suite')
    expect(suiteLabelOf(suites, 'libcxx')).toBe('libcxx')
    expect(suiteLabelOf(undefined, 'nts')).toBe('nts')
  })

  it('shows an option by its label, standing for the name', () => {
    expect(suiteOption(suite('nts', 'LLVM'))).toEqual({ value: 'nts', label: 'LLVM' })
  })
})

describe('compareSuites', () => {
  const order = (...suites: ReturnType<typeof suite>[]) =>
    [...suites].sort(compareSuites).map((entry) => entry.name)

  it('orders suites by label, case-insensitively, rather than by name', () => {
    expect(order(suite('a', 'zeta'), suite('b', 'Beta'), suite('c'), suite('d', 'alpha'))).toEqual([
      'd',
      'b',
      'c',
      'a',
    ])
  })

  it("orders labels as the browser's language does, rather than by code point", () => {
    expect(order(suite('a', 'Zürich'), suite('b', 'Écrins'), suite('c', 'Fuji'))).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('breaks ties between labels by name', () => {
    expect(order(suite('b', 'Same'), suite('a', 'same'), suite('c', 'SAME'))).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})

describe('suitesNamed', () => {
  it('names the suites as listed, or by their names alone, in order', () => {
    const suites = [suite('nts', 'LLVM test-suite'), suite('libcxx', 'libc++')]
    expect(suitesNamed(suites, ['nts', 'gone', 'libcxx'])).toEqual([
      suite('gone'),
      suite('libcxx', 'libc++'),
      suite('nts', 'LLVM test-suite'),
    ])
  })
})

describe('compareSuiteLists', () => {
  it('compares the suites in turn, a list before those it starts', () => {
    const [a, b, c] = [suite('a'), suite('b'), suite('c')]
    expect(compareSuiteLists([a, c], [b])).toBeLessThan(0)
    expect(compareSuiteLists([a], [a, b])).toBeLessThan(0)
    expect(compareSuiteLists([a, b], [a, b])).toBe(0)
    expect(compareSuiteLists([b], [a, c])).toBeGreaterThan(0)
  })
})
