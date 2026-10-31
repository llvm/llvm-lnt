import { describe, expect, it } from 'vitest'
import { suiteRef, type ProjectName } from './api/suites'
import {
  compareEntryLists,
  compareProjects,
  compareSuites,
  entriesNamed,
  entryLabel,
  fullLabel,
  fullLabelOf,
  projectLabel,
  projectNamed,
  suiteLabel,
  suiteOption,
  type NamedEntry,
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

  it('show an option by its own label under its project, and by its full label once picked', () => {
    expect(suiteOption(suite('nts', 'Tests'))).toEqual({
      value: 'llvm/nts',
      label: 'Tests',
      selectedLabel: 'LLVM/Tests',
      section: { key: 'llvm', heading: 'LLVM' },
    })
    expect(suiteOption(suite('nts', null, project('swift')))).toEqual({
      value: 'swift/nts',
      label: 'nts',
      selectedLabel: 'swift/nts',
      section: { key: 'swift', heading: 'swift' },
    })
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

describe('entriesNamed', () => {
  const EXTRA = project('llvm-extra', 'LLVM Extra')
  const projects = [
    { ...EXTRA, suites: [suite('alpha', null, EXTRA)] },
    { ...LLVM, suites: [suite('nts', 'LLVM test-suite'), suite('libcxx', 'libc++')] },
  ]

  it('names whole projects and suites as listed, or by their names where not, in order', () => {
    const refs = [
      { project: 'llvm', suite: 'nts' },
      { project: 'llvm-extra', suite: null },
      { project: 'llvm', suite: 'gone' },
      { project: 'swift', suite: null },
      { project: 'llvm', suite: null },
      { project: 'llvm', suite: 'libcxx' },
    ]
    // By project label, the whole project before its suites, then by suite label (AR22).
    expect(entriesNamed(projects, refs)).toEqual([
      { project: LLVM, suite: null },
      // A suite not listed is named by its own name, under its project's label.
      { project: LLVM, suite: suite('gone') },
      { project: LLVM, suite: suite('libcxx', 'libc++') },
      { project: LLVM, suite: suite('nts', 'LLVM test-suite') },
      { project: EXTRA, suite: null },
      { project: project('swift'), suite: null },
    ])
  })

  it('shows a whole project as its label followed by (all), and a suite by its full label', () => {
    const named = entriesNamed(projects, [
      { project: 'llvm', suite: null },
      { project: 'llvm-extra', suite: 'alpha' },
    ])
    expect(named.map(entryLabel)).toEqual(['LLVM (all)', 'LLVM Extra/alpha'])
  })
})

describe('compareEntryLists', () => {
  it('compares the entries in turn, a list before those it starts', () => {
    const whole: NamedEntry = { project: LLVM, suite: null }
    const [a, b] = [suite('a'), suite('b')].map((s): NamedEntry => ({ project: LLVM, suite: s }))
    expect(compareEntryLists([whole], [a])).toBeLessThan(0)
    expect(compareEntryLists([a, b], [b])).toBeLessThan(0)
    expect(compareEntryLists([a], [a, b])).toBeLessThan(0)
    expect(compareEntryLists([whole, a], [whole, a])).toBe(0)
    expect(compareEntryLists([b], [whole, b])).toBeGreaterThan(0)
  })
})
