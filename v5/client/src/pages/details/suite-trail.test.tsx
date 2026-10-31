import { act, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../api/keys'
import { suiteRef } from '../../api/suites'
import { PROJECT, REF, SUITE } from '../../test/fixtures'
import { projectList, trail } from '../../test/page'
import { renderWithProviders } from '../../test/render'
import { SuiteTrail } from './suite-trail'

function links() {
  return trail()
    .getAllByRole('link')
    .map((link) => [link.textContent, link.getAttribute('href')])
}

// No request is mocked, so any would fail the test (see setupTests.ts): the trail is shown at once,
// asking nothing of the API, while the suite loads and whether or not it exists.
describe('SuiteTrail', () => {
  it.each([
    ['runs', 'Runs', '/projects/llvm/suites/libcxx'],
    ['machines', 'Machines', '/projects/llvm/suites/libcxx?tab=machines'],
    ['commits', 'Commits', '/projects/llvm/suites/libcxx?tab=commits'],
    ['regressions', 'Regressions', '/projects/llvm/suites/libcxx?tab=regressions'],
  ] as const)(
    'links to the project, the suite, then its %s tab with no search or filter',
    (tab, label, href) => {
      renderWithProviders(<SuiteTrail suite={REF} tab={tab} />)

      expect(links()).toEqual([
        ['llvm', '/projects/llvm'],
        ['libcxx', '/projects/llvm/suites/libcxx'],
        [label, href],
      ])
    },
  )

  it('names the project and the suite by their labels once listed, without listing them', async () => {
    const { queryClient } = renderWithProviders(<SuiteTrail suite={REF} tab="runs" />)
    expect(links().slice(0, 2)).toEqual([
      ['llvm', '/projects/llvm'],
      ['libcxx', '/projects/llvm/suites/libcxx'],
    ])

    act(() => {
      queryClient.setQueryData(
        queryKeys.projects,
        projectList(
          [{ ...SUITE, display_name: 'Microbenchmarks' }],
          [{ ...PROJECT, display_name: 'LLVM' }],
        ),
      )
    })

    // The suite by its own label, its project being named beside it (AR22).
    await waitFor(() =>
      expect(links().slice(0, 2)).toEqual([
        ['LLVM', '/projects/llvm'],
        ['Microbenchmarks', '/projects/llvm/suites/libcxx'],
      ]),
    )
  })

  it('names a suite of another project by its names, whatever the suites of the same name', () => {
    const { queryClient } = renderWithProviders(
      <SuiteTrail suite={suiteRef('other', 'libcxx')} tab="runs" />,
    )
    act(() => {
      queryClient.setQueryData(
        queryKeys.projects,
        projectList([{ ...SUITE, display_name: 'Microbenchmarks' }]),
      )
    })

    expect(links().slice(0, 2)).toEqual([
      ['other', '/projects/other'],
      ['libcxx', '/projects/other/suites/libcxx'],
    ])
  })

  it('encodes the project and the suite in its links, and shows them as they are', () => {
    renderWithProviders(<SuiteTrail suite={suiteRef('p q', 'a/b?c')} tab="machines" />)

    expect(links()).toEqual([
      ['p q', '/projects/p%20q'],
      ['a/b?c', '/projects/p%20q/suites/a%2Fb%3Fc'],
      ['Machines', '/projects/p%20q/suites/a%2Fb%3Fc?tab=machines'],
    ])
  })
})
