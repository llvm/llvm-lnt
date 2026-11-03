import { describe, expect, it } from 'vitest'
import { suiteRef, type ProjectName } from './api/suites'
import {
  compareProjects,
  compareSuiteLists,
  compareSuites,
  fullLabel,
  fullLabelOf,
  projectLabel,
  projectNamed,
  suiteLabel,
  suiteOption,
  suitesNamed,
} from './labels'

const project = (name: string, display_name: string | null = null): ProjectName => ({
  name,
  display_name,
})

const LLVM = project('llvm', 'LLVM')

const suite = (name: string, display_name: string | null = null, of: ProjectName = LLVM) => ({
  name,
  display_name,
  project: of,
})

describe('labels', () => {
  it('are the display names, or the names where there are none', () => {
    expect(projectLabel(LLVM)).toBe('LLVM')
    expect(projectLabel(project('swift'))).toBe('swift')
    expect(suiteLabel(suite('nts', 'LLVM test-suite'))).toBe('LLVM test-suite')
    expect(suiteLabel(suite('nts'))).toBe('nts')
  })

  it("make a suite's full label of its project's label and its own", () => {
    expect(fullLabel(suite('nts', 'LLVM test-suite'))).toBe('LLVM/LLVM test-suite')
    expect(fullLabel(suite('nts', null, project('llvm')))).toBe('llvm/nts')
  })

  it("name a suite by its names until it is known, or if it isn't", () => {
    const suites = [suite('nts', 'LLVM test-suite')]
    expect(fullLabelOf(suites, suiteRef('llvm', 'nts'))).toBe('LLVM/LLVM test-suite')
    expect(fullLabelOf(suites, suiteRef('llvm', 'libcxx'))).toBe('llvm/libcxx')
    expect(fullLabelOf(suites, suiteRef('other', 'nts'))).toBe('other/nts')
    expect(fullLabelOf(undefined, suiteRef('llvm', 'nts'))).toBe('llvm/nts')
  })

  it("name a project by its name until it is known, or if it isn't", () => {
    expect(projectNamed([LLVM], 'llvm')).toBe(LLVM)
    expect(projectNamed([LLVM], 'swift')).toEqual(project('swift'))
    expect(projectNamed(undefined, 'llvm')).toEqual(project('llvm'))
  })

  it('show an option by its full label, standing for its names', () => {
    expect(suiteOption(suite('nts', 'Tests'))).toEqual({ value: 'llvm/nts', label: 'LLVM/Tests' })
  })
})

describe('compareSuites', () => {
  const order = (...suites: ReturnType<typeof suite>[]) =>
    [...suites].sort(compareSuites).map((entry) => `${entry.project.name}/${entry.name}`)

  it('orders suites by label, case-insensitively, rather than by name', () => {
    expect(order(suite('a', 'zeta'), suite('b', 'Beta'), suite('c'), suite('d', 'alpha'))).toEqual([
      'llvm/d',
      'llvm/b',
      'llvm/c',
      'llvm/a',
    ])
  })

  it("orders labels as the browser's language does, rather than by code point", () => {
    expect(order(suite('a', 'Zürich'), suite('b', 'Écrins'), suite('c', 'Fuji'))).toEqual([
      'llvm/b',
      'llvm/c',
      'llvm/a',
    ])
  })

  it('breaks ties between labels by name', () => {
    expect(order(suite('b', 'Same'), suite('a', 'same'), suite('c', 'SAME'))).toEqual([
      'llvm/a',
      'llvm/b',
      'llvm/c',
    ])
  })

  it('orders a level at a time: by project, then by suite, rather than by full label', () => {
    // As strings, 'LLVM Extra/alpha' comes before 'LLVM/zeta', since ' ' comes before '/'.
    const extra = project('extra', 'LLVM Extra')
    expect(order(suite('alpha', null, extra), suite('zeta'))).toEqual(['llvm/zeta', 'extra/alpha'])
  })

  it('orders projects by label, then by name', () => {
    const projects = [project('b', 'Same'), project('c', 'alpha'), project('a', 'same')]
    expect(projects.sort(compareProjects).map((entry) => entry.name)).toEqual(['c', 'a', 'b'])
  })
})

describe('suitesNamed', () => {
  it('names the suites as listed, or by their names alone, in order', () => {
    const suites = [suite('nts', 'LLVM test-suite'), suite('libcxx', 'libc++')]
    const refs = [suiteRef('llvm', 'nts'), suiteRef('llvm', 'gone'), suiteRef('llvm', 'libcxx')]
    expect(suitesNamed(suites, refs)).toEqual([
      suite('gone', null, project('llvm')),
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
