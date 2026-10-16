import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { cursorPage, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { server } from '../../test/server'
import { profilesPath } from '../../paths'
import { currentUrl, gate, main, query, renderPage, settle } from '../../test/page'
import { clearCombobox, pick, pickOption, selectButton } from '../../test/select'
import {
  ALPHA,
  columnOf,
  expectDefault,
  field,
  heldBack,
  mockWorld,
  profileShown,
  profileUuid,
  sideAt,
  sideOf,
} from './profiles-world'

/** The options of the test combobox of `side`, once its list is opened. */
async function testOptions(side: 'A' | 'B') {
  const user = userEvent.setup()
  // The test combobox is the side's last.
  const buttons = within(sideOf(side)).getAllByRole('button', { name: /Show suggestions/ })
  await user.click(buttons.at(-1)!)
  const options = (await screen.findAllByRole('option')).map((option) => option.textContent)
  await user.keyboard('{Escape}')
  return options
}

/** The URL of side A as ALPHA names it, and of side B showing `test` in the run `hex`. */
function withB(machine: string, commit: string, hex: string, test: string) {
  return profilesPath(sideAt('m1', 'c1', '1', 'alpha'), sideAt(machine, commit, hex, test))
}

describe('the Profiles page: side selection (PF2)', () => {
  it('says what each control waits for, and that a test is to be selected', async () => {
    mockWorld()
    renderPage('/profiles')

    expect(
      await main().findByText('Select a test on either side to see its profile.'),
    ).toBeInTheDocument()
    expect(field('Machine', 'A')).toBeDisabled()
    expect(field('Machine', 'A')).toHaveAttribute('placeholder', 'Select a suite first')
    expect(field('Commit', 'A')).toHaveAttribute('placeholder', 'Select a machine first')
    expect(selectButton('Run', sideOf('A'))).toHaveTextContent('Select a commit first')
    expect(selectButton('Run', sideOf('A'))).toBeDisabled()
    expect(field('Test', 'A')).toBeDisabled()
    expect(field('Test', 'A')).toHaveAttribute('placeholder', 'Select a run first')
  })

  it('selects the latest run with profiles once a commit is picked, linking to it', async () => {
    const { commits } = mockWorld()
    renderPage('/profiles')

    await pickOption('Suite', 'libcxx', await screen.findByRole('region', { name: 'Side A' }))
    await pick('Machine', 'm1', sideOf('A'))
    await pick('Commit', 'c1', sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    expect(commits.every((q) => q.get('has_profiles') === 'true')).toBe(true)
    expect(selectButton('Run', sideOf('A'))).toHaveTextContent('2026-08-21, 10:00:00 AM 22222222')
    expect(within(sideOf('A')).getByRole('link', { name: /^Run 22222222/ })).toHaveAttribute(
      'href',
      `/suites/libcxx/runs/${uuidOf('2')}`,
    )
    expect(await testOptions('A')).toEqual(['alpha', 'gamma'])
    expect(query().test_a).toBeUndefined()
    expect(main().getByText('Select a test on either side to see its profile.')).toBeVisible()
  })

  it('asks for the runs with profiles, in the order they were measured', async () => {
    const { runs } = mockWorld()
    renderPage(ALPHA)

    await profileShown('A')
    expect(runs.length).toBeGreaterThan(0)
    for (const q of runs) {
      expect(q.get('has_profiles')).toBe('true')
      expect(q.get('sort')).toBe('measured_at')
    }
  })

  it('lists the runs with profiles in the order they were measured', async () => {
    mockWorld()
    renderPage(ALPHA)

    await waitFor(() => expect(selectButton('Run', sideOf('A'))).toBeEnabled())
    const user = userEvent.setup()
    await user.click(selectButton('Run', sideOf('A')))
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent)
    expect(options).toEqual([
      '2026-08-20, 10:00:00 AM 11111111',
      '2026-08-21, 10:00:00 AM 22222222',
    ])
  })

  it('shows the profile a URL names, as the Run Detail page links to it (PF1)', async () => {
    const { metadata } = mockWorld()
    renderPage(ALPHA)

    await profileShown('A')
    expect(metadata).toEqual([profileUuid('1', 'alpha')])
    expect(field('Test', 'A')).toHaveValue('alpha')
    expect(columnOf('B')).not.toBeInTheDocument()
    await settle()
    expect(currentUrl()).toBe(ALPHA)
  })

  it('keeps the commit when another machine has profiles at it, with its latest run', async () => {
    const { commits } = mockWorld()
    renderPage(ALPHA)
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c1'))

    await pick('Machine', 'm2', sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('4')]))
    expect(query().commit_a).toEqual(['c1'])
    // Run 4 has a profile of alpha.
    expect(query().test_a).toEqual(['alpha'])
    const lookup = commits.find((q) => q.get('machine') === 'm2' && q.get('commit') === 'c1')
    expect(lookup?.get('has_profiles')).toBe('true')
  })

  it('clears the commit, run and test when another machine has no profiles at it', async () => {
    mockWorld()
    renderPage(`/profiles?suite_a=libcxx&machine_a=m1&commit_a=c2&run_a=${uuidOf('3')}&test_a=beta`)
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c2'))

    await pick('Machine', 'm2', sideOf('A'))

    await waitFor(() => expect(query().commit_a).toBeUndefined())
    expect(query().run_a).toBeUndefined()
    expect(query().test_a).toBeUndefined()
  })

  it('says when a machine has no profiles at all', async () => {
    mockWorld()
    renderPage('/profiles?suite_a=libcxx&machine_a=m3')

    await waitFor(() =>
      expect(field('Commit', 'A')).toHaveAttribute('placeholder', 'No profiles on this machine'),
    )
    expect(field('Commit', 'A')).toBeEnabled()
  })

  it('keeps the test on another commit whose latest run has a profile of it', async () => {
    mockWorld()
    renderPage(profilesPath(sideAt('m1', 'c2', '3', 'gamma')))
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c2'))

    await pick('Commit', 'c1', sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    expect(query().test_a).toEqual(['gamma'])
  })

  it("drops side B's test when the new run lacks it, going back to side A's", async () => {
    mockWorld()
    // Side A shows alpha in run 1, side B gamma in run 2, both of m1 at c1.
    renderPage(withB('m1', 'c1', '2', 'gamma'))
    await waitFor(() => expect(field('Commit', 'B')).toHaveValue('c1'))

    // m2 has profiles at c1 too, in run 4, of alpha only.
    await pick('Machine', 'm2', sideOf('B'))

    await waitFor(() => expect(query().run_b).toEqual([uuidOf('4')]))
    await waitFor(() => expect(query().test_b).toBeUndefined())
    await waitFor(() => expectDefault(field('Test', 'B'), 'alpha'))
    await profileShown('B')
  })

  it("keeps the test across runs, or goes back to side A's on side B", async () => {
    const { metadata } = mockWorld()
    // Side A shows alpha in run 1, side B gamma in run 2, both of m1 at c1.
    renderPage(withB('m1', 'c1', '2', 'gamma'))
    await waitFor(() => expect(field('Test', 'B')).toHaveValue('gamma'))

    // Run 2 has a profile of alpha too: side A keeps it.
    await pickOption('Run', '2026-08-21, 10:00:00 AM 22222222', sideOf('A'))
    await waitFor(() => expect(metadata).toContain(profileUuid('2', 'alpha')))
    await profileShown('A')
    expect(query().run_a).toEqual([uuidOf('2')])
    expect(query().test_a).toEqual(['alpha'])

    // Run 1 has no profile of gamma, but one of side A's alpha, side B's default.
    await pickOption('Run', '2026-08-20, 10:00:00 AM 11111111', sideOf('B'))
    await waitFor(() => expect(query().test_b).toBeUndefined())
    await waitFor(() => expectDefault(field('Test', 'B'), 'alpha'))
  })

  it("never takes side B's test when its new run has no profile of its own", async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ runsAnswer: slow.answer })
    // Side A shows alpha in run 1, side B beta in run 3.
    renderPage(withB('m1', 'c2', '3', 'beta'))
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c1'))

    // Another machine, then another commit, before the runs of either have loaded.
    await pick('Machine', 'm2', sideOf('A'))
    await pick('Commit', 'c3', sideOf('A'))
    slow.open()

    // Run 5 has a profile of beta only.
    await waitFor(() => expect(query().run_a).toEqual([uuidOf('5')]))
    await waitFor(() => expect(query().test_a).toBeUndefined())
    expect(query().test_b).toEqual(['beta'])
  })

  it("defaults side B's test to side A's, once side B has a commit", async () => {
    mockWorld()
    renderPage(ALPHA)
    await waitFor(() => expect(field('Test', 'A')).toHaveValue('alpha'))

    await pickOption('Suite', 'libcxx', sideOf('B'))
    await pick('Machine', 'm2', sideOf('B'))
    expect(field('Test', 'B')).toHaveAttribute('placeholder', 'Select a run first')
    await pick('Commit', 'c1', sideOf('B'))

    await waitFor(() => expect(query().run_b).toEqual([uuidOf('4')]))
    await waitFor(() => expect(columnOf('B')).toBeInTheDocument())
    await profileShown('B')
    expectDefault(field('Test', 'B'), 'alpha')
    // Side B's test is not its own: there is nothing to clear.
    expect(within(sideOf('B')).queryByRole('button', { name: 'Clear Test' })).toBeNull()
    expect(query().test_b).toBeUndefined()
  })

  it("leaves side B without a test when its run has no profile of side A's", async () => {
    mockWorld()
    renderPage(ALPHA)
    await waitFor(() => expect(field('Test', 'A')).toHaveValue('alpha'))

    await pickOption('Suite', 'libcxx', sideOf('B'))
    await pick('Machine', 'm2', sideOf('B'))
    await pick('Commit', 'c3', sideOf('B'))

    await waitFor(() => expect(query().run_b).toEqual([uuidOf('5')]))
    // Its tests are listed: beta only.
    await waitFor(() => expect(field('Test', 'B')).toBeEnabled())
    expect(query().test_b).toBeUndefined()
    expect(columnOf('B')).not.toBeInTheDocument()
  })

  it('drops the function from the URL whenever a pick changes the profile', async () => {
    // The new profile's functions are held back: the function goes with the pick, not once the new
    // profile's is known.
    const beta = profileUuid('1', 'beta')
    const slow = heldBack((uuid: string) => uuid === beta)
    mockWorld({ functionsAnswer: slow.answer })
    renderPage(`${ALPHA}&function_a=main`)
    await profileShown('A')
    expect(query().function_a).toEqual(['main'])

    await pick('Test', 'beta', sideOf('A'))

    await waitFor(() => expect(query().test_a).toEqual(['beta']))
    expect(query().function_a).toBeUndefined()
    slow.open()
    await profileShown('A')
  })

  it('clears the run, the test and the function with the commit', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=main`)
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c1'))

    await clearCombobox('Commit', sideOf('A'))

    await waitFor(() => expect(query().commit_a).toBeUndefined())
    expect(query().run_a).toBeUndefined()
    expect(query().test_a).toBeUndefined()
    expect(query().function_a).toBeUndefined()
    expect(query().machine_a).toEqual(['m1'])
  })

  it('clears the function with the test', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=main`)
    await waitFor(() => expect(field('Test', 'A')).toBeEnabled())

    await clearCombobox('Test', sideOf('A'))

    await waitFor(() => expect(query().test_a).toBeUndefined())
    expect(query().function_a).toBeUndefined()
    expect(query().run_a).toEqual([uuidOf('1')])
  })

  it('clears everything below the suite when another suite is picked', async () => {
    mockWorld()
    renderPage(ALPHA)
    await waitFor(() => expect(field('Test', 'A')).toHaveValue('alpha'))

    await pickOption('Suite', 'other', sideOf('A'))

    await waitFor(() => expect(currentUrl()).toBe('/profiles?suite_a=other'))
  })
})

describe('the Profiles page: URL state (PF9)', () => {
  it('selects the latest run for a commit named without one, checking the test there', async () => {
    mockWorld()
    renderPage('/profiles?suite_a=libcxx&machine_a=m1&commit_a=c1&test_a=gamma')

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    await profileShown('A')
    expect(query().test_a).toEqual(['gamma'])
  })

  it('selects the latest run in place of one not listed, dropping a test it lacks', async () => {
    mockWorld()
    renderPage(
      `${profilesPath(sideAt('m1', 'c1', '3', 'beta'))}&function_a=main`,
    )

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    await waitFor(() => expect(query().test_a).toBeUndefined())
    expect(query().function_a).toBeUndefined()
  })

  it("drops a test the run has no profile of, rather than take the other side's", async () => {
    mockWorld()
    renderPage(
      `/profiles?suite_a=libcxx&machine_a=m1&commit_a=c1&run_a=${uuidOf('1')}&test_a=gamma` +
        `&suite_b=libcxx&machine_b=m1&commit_b=c1&run_b=${uuidOf('2')}&test_b=alpha`,
    )

    await waitFor(() => expect(query().test_a).toBeUndefined())
    expect(query().test_b).toEqual(['alpha'])
  })

  it('drops what is named without what it depends on', async () => {
    mockWorld()
    renderPage(
      `/profiles?suite_a=libcxx&machine_a=m1&run_a=${uuidOf('1')}&test_a=alpha&function_a=main` +
        '&suite_b=libcxx&function_b=main&machine_b=m1&commit_b=c1&run_b=',
    )

    await waitFor(() => expect(query().run_a).toBeUndefined())
    expect(query().test_a).toBeUndefined()
    expect(query().function_a).toBeUndefined()
    expect(query().function_b).toBeUndefined()
    expect(query().machine_a).toEqual(['m1'])
  })

  it('drops a suite or a machine that does not exist, without reporting its runs', async () => {
    mockWorld({
      runsAnswer: (q) =>
        q.get('machine') === 'bogus'
          ? errorResponse(404, 'not_found', 'No such machine')
          : undefined,
    })
    renderPage(
      '/profiles?suite_a=libcxx&machine_a=bogus&commit_a=c1&test_a=alpha&suite_b=nope&machine_b=m1',
    )

    await waitFor(() => expect(currentUrl()).toBe('/profiles?suite_a=libcxx'))
    expect(screen.queryByText(/could not be (listed|looked up)/)).not.toBeInTheDocument()
  })

  it('drops an unknown Values setting', async () => {
    mockWorld()
    renderPage(`${ALPHA}&values=bogus`)

    await waitFor(() => expect(query().values).toBeUndefined())
    expect(query().test_a).toEqual(['alpha'])
  })

  it('sends the requests a URL calls for at once, before checking its values (PF8)', async () => {
    const runs = heldBack()
    const { metadata } = mockWorld({ runsAnswer: runs.answer })
    renderPage(ALPHA)

    await waitFor(() => expect(metadata).toEqual([profileUuid('1', 'alpha')]))
    // Shown only once the runs say that run 1 is the side's.
    expect(columnOf('A')).toHaveTextContent('Loading the profile...')
    runs.open()
    await profileShown('A')
  })

  it('starts afresh when the page is visited again, forgetting a pick under way', async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('commit') === 'c2')
    mockWorld({ runsAnswer: slow.answer })
    // Side A shows alpha in run 1, side B gamma in run 2.
    renderPage(withB('m1', 'c1', '2', 'gamma'))
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c1'))
    const user = userEvent.setup()

    // Side A carries alpha over to c2, whose runs are on their way.
    await pick('Commit', 'c2', sideOf('A'))
    await waitFor(() => expect(query().commit_a).toEqual(['c2']))
    await user.click(screen.getByRole('link', { name: 'Profiles' }))
    await waitFor(() => expect(currentUrl()).toBe('/profiles'))
    await user.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(query().commit_a).toEqual(['c2']))
    slow.open()

    // Run 3 has no profile of alpha. Loaded from the URL, side A drops it rather than take gamma.
    await waitFor(() => expect(query().run_a).toEqual([uuidOf('3')]))
    await waitFor(() => expect(query().test_a).toBeUndefined())
  })
})

describe('the Profiles page: layout and data flow (PF7, PF8)', () => {
  it('gives each side that shows a profile a column', async () => {
    mockWorld()
    renderPage(withB('m1', 'c2', '3', 'beta'))

    await waitFor(() => expect(columnOf('B')).toBeInTheDocument())
    expect(columnOf('A')).toBeInTheDocument()
    expect(main().queryByText('Select a test on either side to see its profile.')).toBeNull()
  })

  it('gives side B the full width when it alone shows a profile', async () => {
    mockWorld()
    renderPage(profilesPath({}, sideAt('m1', 'c2', '3', 'beta')))

    await profileShown('B')
    expect(columnOf('A')).not.toBeInTheDocument()
    expect(columnOf('B')!.parentElement!.style.getPropertyValue('--columns')).toBe('1')
  })

  it("keeps a side's column while its profile changes", async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ runsAnswer: slow.answer })
    renderPage(ALPHA)
    await profileShown('A')

    await pick('Machine', 'm2', sideOf('A'))

    expect(columnOf('A')).toHaveTextContent('Loading the profile...')
    slow.open()
    await waitFor(() => expect(query().run_a).toEqual([uuidOf('4')]))
    await profileShown('A')
  })

  it('fetches a profile two sides show once', async () => {
    const { metadata } = mockWorld()
    renderPage(withB('m1', 'c1', '1', 'alpha'))

    await profileShown('B')
    expect(metadata).toEqual([profileUuid('1', 'alpha')])
  })

  it('says when the runs could not be listed, and tries again', async () => {
    let fail = true
    mockWorld({
      runsAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    renderPage(ALPHA)

    const side = await screen.findByRole('region', { name: 'Side A' })
    expect(await within(side).findByText(/The runs could not be listed: Boom/)).toBeInTheDocument()
    expect(columnOf('A')).toBeInTheDocument()
    fail = false
    await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Retry' }))
    await profileShown('A')
  })

  it('tries listing the suites again', async () => {
    let fail = true
    mockWorld()
    server.use(
      mockApi('get', '/api/suites', () =>
        fail ? (errorResponse(500, 'internal_error', 'No suites') as never) : undefined,
      ),
    )
    renderPage(ALPHA)

    expect(await main().findByText(/The test suites could not be listed: No suites/)).toBeVisible()
    fail = false
    await userEvent.setup().click(main().getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c1'))
    await profileShown('A')
  })

  it("reports nothing of the profiles of a run that turns out not to be the side's", async () => {
    // Run 4 is m2's. Its profiles fail while m1's runs, which do not hold it, are on their way.
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm1')
    const failed = gate()
    mockWorld({
      runsAnswer: slow.answer,
      profilesAnswer: (hex) => {
        if (hex !== '4') return undefined
        failed.open()
        return errorResponse(500, 'internal_error', 'Boom')
      },
    })
    renderPage(profilesPath(sideAt('m1', 'c1', '4', 'alpha')))

    await failed.promise
    await screen.findByRole('region', { name: 'Side A' })
    await settle()
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
    slow.open()
    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    await profileShown('A')
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
  })

  it("says when the run's profiles could not be listed, not affecting the other side", async () => {
    mockWorld({
      profilesAnswer: (hex) =>
        hex === '1' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(withB('m1', 'c2', '3', 'beta'))

    expect(
      await within(await screen.findByRole('region', { name: 'Side A' })).findByText(
        /The run's profiles could not be listed: Boom/,
      ),
    ).toBeInTheDocument()
    await profileShown('B')
    expect(within(sideOf('B')).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reports runs that could not be listed while the suites could not be either', async () => {
    mockWorld({ runsAnswer: () => errorResponse(500, 'internal_error', 'Boom') })
    server.use(
      mockApi('get', '/api/suites', () => errorResponse(500, 'internal_error', 'No suites')),
    )
    renderPage(ALPHA)

    expect(
      await main().findByText(/The test suites could not be listed: No suites/),
    ).toBeInTheDocument()
    expect(
      await within(sideOf('A')).findByText(/The runs could not be listed: Boom/),
    ).toBeInTheDocument()
    expect(columnOf('A')).not.toHaveTextContent('Loading')
  })

  it("tries listing the run's profiles again", async () => {
    let fail = true
    mockWorld({
      profilesAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    renderPage(ALPHA)

    expect(
      await within(await screen.findByRole('region', { name: 'Side A' })).findByText(
        /The run's profiles could not be listed: Boom/,
      ),
    ).toBeInTheDocument()
    expect(field('Test', 'A')).toBeDisabled()
    fail = false
    await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(field('Test', 'A')).toBeEnabled())
    await profileShown('A')
  })

  it('says while the runs load, and when the commit has none with profiles', async () => {
    const slow = gate()
    mockWorld({
      runsAnswer: async (q) => {
        if (q.get('commit') !== 'c2') return undefined
        await slow.promise
        return HttpResponse.json(cursorPage([]))
      },
    })
    renderPage('/profiles?suite_a=libcxx&machine_a=m1&commit_a=c2')

    await waitFor(() =>
      expect(selectButton('Run', sideOf('A'))).toHaveTextContent('Loading runs...'),
    )
    slow.open()
    await waitFor(() =>
      expect(selectButton('Run', sideOf('A'))).toHaveTextContent('No runs with profiles'),
    )
    expect(selectButton('Run', sideOf('A'))).toBeDisabled()
  })

  it('says when a profile could not be loaded, in its column', async () => {
    let fail = true
    mockWorld({
      metadataAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    renderPage(ALPHA)

    expect(
      await within(columnOf('A')!).findByText(/The profile could not be loaded: Boom/),
    ).toBeInTheDocument()
    fail = false
    await userEvent.setup().click(within(columnOf('A')!).getByRole('button', { name: 'Retry' }))
    expect(
      await within(columnOf('A')!).findByRole('combobox', { name: 'Function' }),
    ).toHaveValue('hot')
  })
})
