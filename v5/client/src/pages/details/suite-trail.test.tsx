import { act, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../api/keys'
import { SUITE } from '../../test/fixtures'
import { trail } from '../../test/page'
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
    ['runs', 'Runs', '/suites/libcxx'],
    ['machines', 'Machines', '/suites/libcxx?tab=machines'],
    ['commits', 'Commits', '/suites/libcxx?tab=commits'],
    ['regressions', 'Regressions', '/suites/libcxx?tab=regressions'],
  ] as const)('links to the suite, then to its %s tab with no search or filter', (tab, label, href) => {
    renderWithProviders(<SuiteTrail suite="libcxx" tab={tab} />)

    expect(links()).toEqual([
      ['libcxx', '/suites/libcxx'],
      [label, href],
    ])
  })

  it('names the suite by its label once the suites are listed, without listing them', async () => {
    const { queryClient } = renderWithProviders(<SuiteTrail suite="libcxx" tab="runs" />)
    expect(links()[0]).toEqual(['libcxx', '/suites/libcxx'])

    act(() => {
      const items = [{ ...SUITE, display_name: 'Microbenchmarks' }]
      queryClient.setQueryData(queryKeys.suites, { items })
    })

    await waitFor(() => expect(links()[0]).toEqual(['Microbenchmarks', '/suites/libcxx']))
  })

  it('encodes the suite in its links, and shows it as it is', () => {
    renderWithProviders(<SuiteTrail suite="a/b?c" tab="machines" />)

    expect(links()).toEqual([
      ['a/b?c', '/suites/a%2Fb%3Fc'],
      ['Machines', '/suites/a%2Fb%3Fc?tab=machines'],
    ])
  })
})
