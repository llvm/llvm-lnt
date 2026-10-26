import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { signIn } from '../../test/auth'
import { BARE_SUITE, SUITE } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { gate, main, mockSuites, renderPage } from '../../test/page'
import { server } from '../../test/server'

function newSuite() {
  return screen.getByRole('button', { name: 'New suite' })
}

describe('the Test Suites tab', () => {
  it('lists the suites, each leading to its Schema tab', async () => {
    mockSuites([SUITE, BARE_SUITE])
    renderPage('/admin?tab=suites')

    const list = await main().findByRole('list', { name: 'Test suites' })
    const links = within(list).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['libcxx', 'nts'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/suites/libcxx?tab=schema',
      '/suites/nts?tab=schema',
    ])
    expect(newSuite()).toBeInTheDocument()
  })

  it('says when there are no suites, still offering to create one', async () => {
    signIn('manage')
    mockSuites([])
    renderPage('/admin?tab=suites')

    expect(await main().findByText('There are no test suites yet.')).toBeInTheDocument()
    expect(main().queryByRole('list')).not.toBeInTheDocument()
    await waitFor(() => expect(newSuite()).toBeEnabled())
  })

  it('says it is loading the suites, and why it could not, which it retries', async () => {
    const list = gate()
    server.use(
      mockApi('get', '/api/suites', async () => {
        await list.promise
        return errorResponse(500, 'internal_error', 'The database is down.')
      }),
    )
    renderPage('/admin?tab=suites')

    expect(await main().findByText('Loading test suites...')).toBeInTheDocument()
    await act(async () => list.open())
    expect(await main().findByRole('alert')).toHaveTextContent('The database is down.')

    mockSuites([SUITE])
    fireEvent.click(main().getByRole('button', { name: 'Retry' }))
    expect(await main().findByRole('link', { name: 'libcxx' })).toBeInTheDocument()
  })

  it('creates no suite with a manage token restricted to some suites', async () => {
    signIn('manage', ['nts'])
    mockSuites([SUITE, BARE_SUITE])
    renderPage('/admin?tab=suites')

    await main().findByRole('list', { name: 'Test suites' })
    // Creating a suite addresses none, so it needs an instance-wide token.
    await waitFor(() =>
      expect(newSuite()).toHaveAccessibleDescription(
        "Needs an instance-wide API token with the 'manage' scope. The token in Settings has " +
          "the 'manage' scope only in suite 'nts'.",
      ),
    )
    expect(newSuite()).toBeDisabled()
  })
})
