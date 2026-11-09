import { describe, expect, it } from 'vitest'
import { suiteRef, type ProjectName } from './api/suites'
import {
  compareEntryLists,
  compareMachines,
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
    expect(fullLabel(suite('nts', 'LLVM test-suite'))).toBe('LLVM › LLVM test-suite')
    expect(fullLabel(suite('nts', null, project('llvm')))).toBe('llvm › nts')
    expect(fullLabel(suite('nts', 'C/D', project('llvm', 'A/B')))).toBe('A/B › C/D')
  })

  it("name a suite by its names until it is known, or if it isn't", () => {
    const suites = [suite('nts', 'LLVM test-suite')]
    expect(fullLabelOf(suites, suiteRef('llvm', 'nts'))).toBe('LLVM › LLVM test-suite')
    expect(fullLabelOf(suites, suiteRef('llvm', 'libcxx'))).toBe('llvm › libcxx')
    expect(fullLabelOf(suites, suiteRef('other', 'nts'))).toBe('other › nts')
    expect(fullLabelOf(undefined, suiteRef('llvm', 'nts'))).toBe('llvm › nts')
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
      selectedLabel: 'LLVM › Tests',
      section: { key: 'llvm', heading: 'LLVM' },
    })
    expect(suiteOption(suite('nts', null, project('swift')))).toEqual({
      value: 'swift/nts',
      label: 'nts',
      selectedLabel: 'swift › nts',
      section: { key: 'swift', heading: 'swift' },
    })
  })
})

describe('compareMachines', () => {
  const machine = (name: string, display_name: string | null = null) => ({ name, display_name })
  const order = (...machines: ReturnType<typeof machine>[]) =>
    [...machines].sort(compareMachines).map((entry) => entry.name)

  it('orders machines by label, case-insensitively, rather than by name', () => {
    const machines = [machine('a', 'zeta'), machine('b', 'Beta'), machine('c'), machine('d', 'alpha')]
    expect(order(...machines)).toEqual(['d', 'b', 'c', 'a'])
  })

  it("orders labels as the browser's language does, rather than by code point", () => {
    expect(order(machine('a', 'Zürich'), machine('b', 'Écrins'), machine('c', 'Fuji'))).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('breaks ties between labels by name', () => {
    expect(order(machine('b', 'Same'), machine('a', 'same'), machine('c', 'SAME'))).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})

describe('entriesNamed', () => {
  // Listed in an order of their own, which is neither that of their names nor of their labels.
  const EXTRA = project('llvm-extra', 'LLVM Extra')
  const projects = [
    { ...LLVM, suites: [suite('nts', 'LLVM test-suite'), suite('libcxx', 'libc++')] },
    { ...EXTRA, suites: [suite('alpha', null, EXTRA)] },
  ]
  const names = (entries: NamedEntry[]) =>
    entries.map(({ project, suite }) => `${project.name}/${suite?.name ?? '*'}`)

  it('names whole projects and suites as listed, or by their names where not', () => {
    const named = entriesNamed(projects, [
      { project: 'llvm', suite: 'nts' },
      { project: 'swift', suite: null },
      { project: 'llvm', suite: 'gone' },
    ])
    expect(named.map(({ project, suite }) => ({ project, suite }))).toEqual([
      { project: LLVM, suite: suite('nts', 'LLVM test-suite') },
      // A suite not listed is named by its own name, under its project's label.
      { project: LLVM, suite: suite('gone') },
      { project: project('swift'), suite: null },
    ])
  })

  it('orders them as the projects and suites are listed, a project before its suites', () => {
    const refs = [
      { project: 'llvm', suite: 'nts' },
      { project: 'llvm-extra', suite: null },
      { project: 'llvm', suite: null },
      { project: 'llvm', suite: 'libcxx' },
      { project: 'llvm-extra', suite: 'alpha' },
    ]
    expect(names(entriesNamed(projects, refs))).toEqual([
      'llvm/*',
      'llvm/nts',
      'llvm/libcxx',
      'llvm-extra/*',
      'llvm-extra/alpha',
    ])
  })

  it("puts what is not listed after what is, at its project's level, by name", () => {
    const refs = [
      { project: 'zeta', suite: 'b' },
      { project: 'llvm', suite: 'gone' },
      { project: 'alpha', suite: null },
      { project: 'zeta', suite: 'a' },
      { project: 'llvm', suite: 'libcxx' },
      { project: 'llvm', suite: 'also-gone' },
      { project: 'zeta', suite: null },
    ]
    expect(names(entriesNamed(projects, refs))).toEqual([
      'llvm/libcxx',
      'llvm/also-gone',
      'llvm/gone',
      'alpha/*',
      'zeta/*',
      'zeta/a',
      'zeta/b',
    ])
  })

  it('orders them by name until the projects are listed, as the API does', () => {
    const refs = [
      { project: 'llvm', suite: 'nts' },
      { project: 'llvm', suite: 'libcxx' },
      { project: 'llvm-extra', suite: null },
      { project: 'llvm', suite: null },
    ]
    expect(names(entriesNamed(undefined, refs))).toEqual([
      'llvm/*',
      'llvm/libcxx',
      'llvm/nts',
      'llvm-extra/*',
    ])
  })

  it('shows a whole project as its label followed by (all), and a suite by its full label', () => {
    const named = entriesNamed(projects, [
      { project: 'llvm', suite: null },
      { project: 'llvm-extra', suite: 'alpha' },
    ])
    expect(named.map(entryLabel)).toEqual(['LLVM (all)', 'LLVM Extra › alpha'])
  })
})

describe('compareEntryLists', () => {
  it('compares the entries in turn, a list before those it starts', () => {
    const projects = [{ ...LLVM, suites: [suite('a'), suite('b')] }]
    const [whole, a, b] = entriesNamed(projects, [
      { project: 'llvm', suite: null },
      { project: 'llvm', suite: 'a' },
      { project: 'llvm', suite: 'b' },
    ])
    expect(compareEntryLists([whole], [a])).toBeLessThan(0)
    expect(compareEntryLists([a, b], [b])).toBeLessThan(0)
    expect(compareEntryLists([a], [a, b])).toBeLessThan(0)
    expect(compareEntryLists([whole, a], [whole, a])).toBe(0)
    expect(compareEntryLists([b], [whole, b])).toBeGreaterThan(0)
  })
})
