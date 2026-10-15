import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { uuidOf } from '../../test/fixtures'
import { errorResponse } from '../../test/mock-api'
import { profilesPath } from '../../paths'
import { currentUrl, gate, main, query, renderPage, settle } from '../../test/page'
import { pick, pickOption, selectButton } from '../../test/select'
import { ALPHA, columnOf, mockWorld, profileUuid, sideAt, sideOf } from './profiles-world'

/** The combobox labelled `label` of `side`. */
function field(label: string, side: 'A' | 'B') {
  return within(sideOf(side)).getByRole('combobox', { name: label })
}

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

    await waitFor(() => expect(columnOf('A')).not.toHaveTextContent('Loading'))
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
    renderPage(`/profiles?suite_a=libcxx&machine_a=m1&commit_a=c2&run_a=${uuidOf('3')}&test_a=gamma`)
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c2'))

    await pick('Commit', 'c1', sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    expect(query().test_a).toEqual(['gamma'])
  })

  it("takes the other side's test when the new run has no profile of its own", async () => {
    mockWorld()
    // Side A shows alpha in run 1, side B gamma in run 2, both of m1 at c1.
    renderPage(withB('m1', 'c1', '2', 'gamma'))
    await waitFor(() => expect(field('Commit', 'B')).toHaveValue('c1'))

    // m2 has profiles at c1 too, in run 4, of alpha only.
    await pick('Machine', 'm2', sideOf('B'))

    await waitFor(() => expect(query().run_b).toEqual([uuidOf('4')]))
    await waitFor(() => expect(query().test_b).toEqual(['alpha']))
  })

  it('keeps the test across runs, or takes the other side’s', async () => {
    mockWorld()
    // Side A shows alpha in run 1, side B gamma in run 2, both of m1 at c1.
    renderPage(withB('m1', 'c1', '2', 'gamma'))
    await waitFor(() => expect(field('Test', 'B')).toHaveValue('gamma'))

    // Run 2 has a profile of alpha too: side A keeps it.
    await pickOption('Run', '2026-08-21, 10:00:00 AM 22222222', sideOf('A'))
    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    await settle()
    expect(query().test_a).toEqual(['alpha'])

    // Run 1 has no profile of gamma, but one of side A's alpha, which side B takes.
    await pickOption('Run', '2026-08-20, 10:00:00 AM 11111111', sideOf('B'))
    await waitFor(() => expect(query().test_b).toEqual(['alpha']))
  })

  it("starts side B on side A's test", async () => {
    mockWorld()
    renderPage(ALPHA)
    await waitFor(() => expect(field('Test', 'A')).toHaveValue('alpha'))

    await pickOption('Suite', 'libcxx', sideOf('B'))
    await pick('Machine', 'm2', sideOf('B'))
    await pick('Commit', 'c1', sideOf('B'))

    await waitFor(() => expect(query().test_b).toEqual(['alpha']))
    expect(query().run_b).toEqual([uuidOf('4')])
    await waitFor(() => expect(columnOf('B')).toBeInTheDocument())
  })

  it('leaves side B without a test when its run has no profile of side A’s', async () => {
    mockWorld()
    renderPage(ALPHA)
    await waitFor(() => expect(field('Test', 'A')).toHaveValue('alpha'))

    await pickOption('Suite', 'libcxx', sideOf('B'))
    await pick('Machine', 'm2', sideOf('B'))
    await pick('Commit', 'c3', sideOf('B'))

    await waitFor(() => expect(query().run_b).toEqual([uuidOf('5')]))
    await settle()
    expect(query().test_b).toBeUndefined()
    expect(columnOf('B')).not.toBeInTheDocument()
  })

  it('drops the function from the URL whenever a pick changes the profile', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=main`)
    await waitFor(() => expect(field('Test', 'A')).toHaveValue('alpha'))
    expect(query().function_a).toEqual(['main'])

    await pick('Test', 'beta', sideOf('A'))

    await waitFor(() => expect(query().test_a).toEqual(['beta']))
    expect(query().function_a).toBeUndefined()
  })

  it('clears the run, the test and the function with the commit', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=main`)
    await waitFor(() => expect(field('Commit', 'A')).toHaveValue('c1'))

    await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Clear Commit' }))

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

    await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Clear Test' }))

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
  it('selects the latest run for a commit named without one, and checks the test there', async () => {
    mockWorld()
    renderPage('/profiles?suite_a=libcxx&machine_a=m1&commit_a=c1&test_a=gamma')

    await waitFor(() => expect(query().run_a).toEqual([uuidOf('2')]))
    await settle()
    expect(query().test_a).toEqual(['gamma'])
  })

  it('selects the latest run in place of one not listed, dropping a test it lacks', async () => {
    mockWorld()
    renderPage(
      `/profiles?suite_a=libcxx&machine_a=m1&commit_a=c1&run_a=${uuidOf('3')}&test_a=beta&function_a=main`,
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
        q.get('machine') === 'bogus' ? errorResponse(404, 'not_found', 'No such machine') : undefined,
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
    const runs = gate()
    const { metadata } = mockWorld({
      runsAnswer: async () => {
        await runs.promise
        return undefined
      },
    })
    renderPage(ALPHA)

    await waitFor(() => expect(metadata).toEqual([profileUuid('1', 'alpha')]))
    // Shown only once the runs say that run 1 is the side's.
    expect(columnOf('A')).toHaveTextContent('Loading the profile...')
    runs.open()
    await waitFor(() => expect(columnOf('A')).not.toHaveTextContent('Loading'))
  })

  it('starts afresh when the page is visited again, forgetting a pick under way', async () => {
    const slow = gate()
    mockWorld({
      runsAnswer: async (q) => {
        if (q.get('commit') === 'c2') await slow.promise
        return undefined
      },
    })
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

  it("keeps a side's column while its profile changes", async () => {
    const slow = gate()
    mockWorld({
      runsAnswer: async (q) => {
        if (q.get('machine') === 'm2') await slow.promise
        return undefined
      },
    })
    renderPage(ALPHA)
    await waitFor(() => expect(columnOf('A')).not.toHaveTextContent('Loading'))

    await pick('Machine', 'm2', sideOf('A'))

    expect(columnOf('A')).toHaveTextContent('Loading the profile...')
    slow.open()
    await waitFor(() => expect(query().run_a).toEqual([uuidOf('4')]))
    await waitFor(() => expect(columnOf('A')).not.toHaveTextContent('Loading'))
  })

  it('fetches a profile two sides show once', async () => {
    const { metadata } = mockWorld()
    renderPage(withB('m1', 'c1', '1', 'alpha'))

    await waitFor(() => expect(columnOf('B')).not.toHaveTextContent('Loading'))
    expect(metadata).toEqual([profileUuid('1', 'alpha')])
  })

  it('says when the runs could not be listed, and tries again', async () => {
    let fail = true
    mockWorld({
      runsAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    renderPage(ALPHA)

    expect(
      await within(sideOf('A')).findByText(/The runs could not be listed: Boom/),
    ).toBeInTheDocument()
    expect(columnOf('A')).toBeInTheDocument()
    fail = false
    await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(columnOf('A')).not.toHaveTextContent('Loading'))
  })

  it("says when the run's profiles could not be listed, without affecting the other side", async () => {
    mockWorld({
      profilesAnswer: (hex) =>
        hex === '1' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(withB('m1', 'c2', '3', 'beta'))

    expect(
      await within(sideOf('A')).findByText(/The run's profiles could not be listed: Boom/),
    ).toBeInTheDocument()
    await waitFor(() => expect(columnOf('B')).not.toHaveTextContent('Loading'))
    expect(within(sideOf('B')).queryByRole('alert')).not.toBeInTheDocument()
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
    await waitFor(() => expect(columnOf('A')).toBeEmptyDOMElement())
  })
})
