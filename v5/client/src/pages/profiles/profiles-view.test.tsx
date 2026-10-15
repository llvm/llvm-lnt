import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../api/keys'
import { profilesPath } from '../../paths'
import { fakeLayout } from '../../test/layout'
import { errorResponse } from '../../test/mock-api'
import { currentUrl, query, renderPage, rowsOf, settle } from '../../test/page'
import { pick, pickOption, selectButton } from '../../test/select'
import {
  ALPHA,
  columnOf,
  heldBack,
  mockWorld,
  profileUuid,
  sideAt,
  sideOf,
} from './profiles-world'

/** Queries within `side`'s column. */
function column(side: 'A' | 'B') {
  return within(columnOf(side)!)
}

/** Wait for `side` to show the function `name`, its instructions loaded. */
async function showsFunction(side: 'A' | 'B', name: string) {
  await waitFor(() => {
    expect(column(side).getByRole('combobox', { name: 'Function' })).toHaveValue(name)
    expect(column(side).getByRole('table', { name: `Instructions of ${name}` })).toBeInTheDocument()
  })
}

/** The suggestions of `side`'s function selector, each with its share, as the list shows them. */
async function functionSuggestions(side: 'A' | 'B', count: number) {
  const user = userEvent.setup()
  await user.click(column(side).getByRole('button', { name: /Show suggestions/ }))
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(count))
  const options = screen.getAllByRole('option').map((option) => option.textContent)
  await user.keyboard('{Escape}')
  return options
}

/** Pick the function `name` on `side`, whose suggestion is named by its share too. */
function pickFunction(side: 'A' | 'B', name: string) {
  return pick('Function', name, columnOf(side)!, new RegExp(`^${name}`))
}

/** The rows of `side`'s instructions, as rendered. */
function instructionRows(side: 'A' | 'B') {
  return rowsOf(column(side).getByRole('table'))
}

/** Clear side A's test, then pick `test`. */
async function clearThenPick(test: string) {
  await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Clear Test' }))
  await waitFor(() => expect(query().test_a).toBeUndefined())
  await pick('Test', test, sideOf('A'))
}

/** The option of run 1 or run 2 of m1 at c1, in a side's run dropdown. */
const RUN_1 = '2026-08-20, 10:00:00 AM 11111111'
const RUN_2 = '2026-08-21, 10:00:00 AM 22222222'

/** Side A showing beta in run 1, and side B alpha's main in run 2, both of m1 at c1. */
const BETA_AND_MAIN =
  profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '2', 'alpha')) +
  '&function_b=main'

/** The URL of side A as ALPHA names it, and of side B showing `test` in the run `hex` of m1. */
function withB(commit: string, hex: string, test: string, extra = '') {
  return profilesPath(sideAt('m1', 'c1', '1', 'alpha'), sideAt('m1', commit, hex, test)) + extra
}

describe('the Profiles page: function selection (PF4)', () => {
  it("starts on the side's hottest function, its instructions shown", async () => {
    fakeLayout()
    mockWorld()
    renderPage(ALPHA)

    await showsFunction('A', 'hot')
    expect(instructionRows('A')).toEqual(['75% | 0x1000 | hot: add', '25% | 0x1004 | hot: ret'])
    // The selected function's share, beside its selector.
    expect(column('A').getByTitle("Share of the profile's cycles")).toHaveTextContent('60%')
    await settle()
    expect(query().function_a).toBeUndefined()
  })

  it('offers the functions hottest first, each with its share', async () => {
    mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')

    expect(await functionSuggestions('A', 3)).toEqual(['hot60%', 'warm30%', 'main10%'])
  })

  it('shows the function the URL names, asking for its instructions at once (PF8)', async () => {
    const runs = heldBack()
    const { disassembled } = mockWorld({ runsAnswer: runs.answer })
    renderPage(`${ALPHA}&function_a=warm`)

    await waitFor(() => expect(disassembled).toEqual([`${profileUuid('1', 'alpha')}/warm`]))
    runs.open()
    await showsFunction('A', 'warm')
    expect(query().function_a).toEqual(['warm'])
  })

  it('drops a function the profile does not have, showing the hottest', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=gone`)

    await showsFunction('A', 'hot')
    await waitFor(() => expect(query().function_a).toBeUndefined())
  })

  it('keeps a function picked in the URL, unless it is the hottest', async () => {
    mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')

    await pickFunction('A', 'main')
    await showsFunction('A', 'main')
    expect(query().function_a).toEqual(['main'])

    await pickFunction('A', 'hot')
    await waitFor(() => expect(query().function_a).toBeUndefined())
  })

  it('says when a profile lists no functions', async () => {
    mockWorld({ functions: { [profileUuid('1', 'alpha')]: {} } })
    renderPage(ALPHA)

    expect(await column('A').findByText('This profile lists no functions.')).toBeInTheDocument()
  })

  it('says when the functions could not be listed, and tries again', async () => {
    let fail = true
    mockWorld({
      functionsAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    renderPage(ALPHA)

    expect(await column('A').findByText(/The functions could not be listed: Boom/)).toBeVisible()
    fail = false
    await userEvent.setup().click(column('A').getByRole('button', { name: 'Retry' }))
    await showsFunction('A', 'hot')
  })

  it("says when the function's instructions could not be loaded, and tries again", async () => {
    let fail = true
    mockWorld({
      disassemblyAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Bang') : undefined),
    })
    renderPage(ALPHA)

    expect(
      await column('A').findByText(/The instructions of hot could not be loaded: Bang/),
    ).toBeVisible()
    // The function is still shown, and can be changed.
    expect(column('A').getByRole('combobox', { name: 'Function' })).toHaveValue('hot')
    fail = false
    await userEvent.setup().click(column('A').getByRole('button', { name: 'Retry' }))
    await showsFunction('A', 'hot')
  })

  it('keeps its function on another profile of the same test that has it', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=warm`)
    await showsFunction('A', 'warm')

    await pickOption('Run', RUN_2, sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '2', 'alpha').run]))
    await showsFunction('A', 'warm')
    expect(query().function_a).toEqual(['warm'])
  })

  it('keeps its function carried over until the new profile lists its functions', async () => {
    const next = profileUuid('2', 'alpha')
    const slow = heldBack((uuid: string) => uuid === next)
    mockWorld({ functionsAnswer: slow.answer })
    renderPage(`${ALPHA}&function_a=warm`)
    await showsFunction('A', 'warm')

    await pickOption('Run', RUN_2, sideOf('A'))
    // The profile is shown, its functions on their way.
    await waitFor(() =>
      expect(column('A').getByText('Loading the functions...')).toBeInTheDocument(),
    )
    slow.open()

    await showsFunction('A', 'warm')
    expect(query().function_a).toEqual(['warm'])
  })

  it('starts afresh on a test cleared, then picked again', async () => {
    mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')
    await pickFunction('A', 'warm')
    await showsFunction('A', 'warm')

    await clearThenPick('alpha')

    await showsFunction('A', 'hot')
    expect(query().function_a).toBeUndefined()
  })

  it("takes the other side's function on a test cleared, then picked again", async () => {
    mockWorld()
    renderPage(
      profilesPath(sideAt('m1', 'c1', '1', 'alpha'), sideAt('m1', 'c1', '2', 'alpha')) +
        '&function_b=main',
    )
    await showsFunction('B', 'main')
    await pickFunction('A', 'warm')
    await showsFunction('A', 'warm')

    await clearThenPick('alpha')

    await showsFunction('A', 'main')
    expect(query().function_a).toEqual(['main'])
  })

  it('carries over what it showed before quick successive picks', async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ runsAnswer: slow.answer })
    renderPage(`${ALPHA}&function_a=warm`)
    await showsFunction('A', 'warm')

    // Another machine, then back, before the first's runs have loaded: m1's latest run is run 2.
    await pick('Machine', 'm2', sideOf('A'))
    await pick('Machine', 'm1', sideOf('A'))
    slow.open()

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '2', 'alpha').run]))
    await showsFunction('A', 'warm')
    expect(query().function_a).toEqual(['warm'])
  })

  it("takes the other side's function when it changes to the other side's test", async () => {
    mockWorld()
    // Side A shows beta's cool in run 1, side B alpha's main in run 2.
    renderPage(`${BETA_AND_MAIN}&function_a=cool`)
    await showsFunction('B', 'main')

    await pick('Test', 'alpha', sideOf('A'))

    await showsFunction('A', 'main')
    expect(query().function_a).toEqual(['main'])
  })

  it("waits for the other side's functions before taking its function", async () => {
    const uuidB = profileUuid('2', 'alpha')
    const slow = heldBack((uuid: string) => uuid === uuidB)
    mockWorld({ functionsAnswer: slow.answer })
    renderPage(BETA_AND_MAIN)
    await showsFunction('A', 'hot')

    await pick('Test', 'alpha', sideOf('A'))
    await settle()
    expect(column('A').queryByRole('table')).not.toBeInTheDocument()
    slow.open()

    await showsFunction('B', 'main')
    await showsFunction('A', 'main')
  })

  it("takes its own hottest when the other side's functions could not be listed", async () => {
    const uuidB = profileUuid('2', 'alpha')
    mockWorld({
      functionsAnswer: (uuid) =>
        uuid === uuidB ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(BETA_AND_MAIN)
    await showsFunction('A', 'hot')

    await pick('Test', 'alpha', sideOf('A'))

    await showsFunction('A', 'hot')
  })

  it('resolves both sides when both change their profile at once', async () => {
    const slow = heldBack()
    mockWorld({ functionsAnswer: slow.answer })
    // Side A shows beta in run 1, side B gamma in run 2: both then pick alpha.
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '2', 'gamma')))
    const testB = within(sideOf('B')).getByRole('combobox', { name: 'Test' })
    await waitFor(() => expect(testB).toBeEnabled())
    await pick('Test', 'alpha', sideOf('A'))
    await pick('Test', 'alpha', sideOf('B'))
    slow.open()

    // Each side's carried function belongs to another test, as does the other side's: each takes
    // its hottest, rather than waiting for the other.
    await showsFunction('A', 'hot')
    await showsFunction('B', 'hot')
  })

  it("does not take the function of another side moving to another test", async () => {
    const moved = [profileUuid('1', 'alpha'), profileUuid('2', 'gamma')]
    const slow = heldBack((uuid: string) => moved.includes(uuid))
    mockWorld({ functionsAnswer: slow.answer })
    renderPage(BETA_AND_MAIN)
    await showsFunction('B', 'main')
    await showsFunction('A', 'hot')

    // Side A goes from beta to alpha, as side B goes from alpha to gamma, both at once.
    await pick('Test', 'alpha', sideOf('A'))
    await pick('Test', 'gamma', sideOf('B'))
    slow.open()

    // Side B's main was alpha's, but side B is about to show gamma: side A takes its own hottest.
    await showsFunction('A', 'hot')
    await settle()
    expect(query().function_a).toBeUndefined()
  })

  it("takes its own hottest when the other side's profile could not be loaded", async () => {
    const uuidB = profileUuid('2', 'alpha')
    mockWorld({
      metadataAnswer: (uuid) =>
        uuid === uuidB ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(BETA_AND_MAIN)
    await showsFunction('A', 'hot')
    expect(await column('B').findByText(/The profile could not be loaded/)).toBeVisible()

    // Side B shows alpha, but cannot say which function: side A does not wait for it.
    await pick('Test', 'alpha', sideOf('A'))

    await showsFunction('A', 'hot')
  })

  it("keeps its hottest function, by name, on another profile of the same test", async () => {
    // Run 2's alpha has warm as its hottest, and hot too.
    mockWorld({
      functions: {
        [profileUuid('2', 'alpha')]: {
          hot: { cycles: 30, instructions: 20 },
          warm: { cycles: 60, instructions: 150 },
        },
      },
    })
    renderPage(ALPHA)
    await showsFunction('A', 'hot')
    expect(query().function_a).toBeUndefined()

    await pickOption('Run', RUN_2, sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '2', 'alpha').run]))
    await showsFunction('A', 'hot')
    await waitFor(() => expect(query().function_a).toEqual(['hot']))
  })

  it('carries nothing over once the side is left without a profile', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=main`)
    await showsFunction('A', 'main')

    // Run 3, at c2, has no profile of alpha: side A is left without a test.
    await pick('Commit', 'c2', sideOf('A'))
    await waitFor(() => expect(query().test_a).toBeUndefined())
    await pick('Commit', 'c1', sideOf('A'))
    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '2', 'alpha').run]))
    await pick('Test', 'alpha', sideOf('A'))

    await showsFunction('A', 'hot')
    expect(query().function_a).toBeUndefined()
  })

  it("takes the function the other side showed before its own profile began changing", async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ runsAnswer: slow.answer })
    // Side A shows beta in run 1, side B alpha's warm in run 2.
    renderPage(
      profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '2', 'alpha')) +
        '&function_b=warm',
    )
    await showsFunction('B', 'warm')
    await showsFunction('A', 'hot')

    // Side B moves to m2, whose runs are on their way, as side A picks alpha.
    await pick('Machine', 'm2', sideOf('B'))
    await pick('Test', 'alpha', sideOf('A'))

    await showsFunction('A', 'warm')
    slow.open()
    await showsFunction('B', 'warm')
  })

  it('keeps showing the profile when its runs fail to load again', async () => {
    let fail = false
    mockWorld({
      runsAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    const { queryClient } = renderPage(ALPHA)
    await showsFunction('A', 'hot')
    const url = currentUrl()

    fail = true
    await act(() =>
      queryClient.refetchQueries({ queryKey: [...queryKeys.runs('libcxx'), 'of-commit'] }),
    )

    await settle()
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
    await showsFunction('A', 'hot')
    expect(currentUrl()).toBe(url)
  })

  it('carries the function picked, not the one shown before', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=warm`)
    await showsFunction('A', 'warm')

    await pickFunction('A', 'main')
    await showsFunction('A', 'main')
    await pickOption('Run', RUN_2, sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '2', 'alpha').run]))
    await showsFunction('A', 'main')
    expect(query().function_a).toEqual(['main'])
  })

  it('shows the function it held for a profile it goes back to', async () => {
    const slow = heldBack((hex: string) => hex === '2')
    mockWorld({ profilesAnswer: slow.answer })
    renderPage(`${ALPHA}&function_a=warm`)
    await showsFunction('A', 'warm')

    await pickOption('Run', RUN_2, sideOf('A'))
    await pickOption('Run', RUN_1, sideOf('A'))

    await showsFunction('A', 'warm')
    await waitFor(() => expect(query().function_a).toEqual(['warm']))
    // Nothing is left carried over: the next pick carries what the side shows now.
    slow.open()
    await pickFunction('A', 'main')
    await pickOption('Run', RUN_2, sideOf('A'))
    await showsFunction('A', 'main')
  })
})

describe('the Profiles page: the counter (PF4)', () => {
  it('re-sorts the functions for another counter, keeping those shown', async () => {
    const { listed, disassembled } = mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')
    expect(selectButton('Counter')).toHaveTextContent('cycles')
    const requests = [listed.length, disassembled.length]

    await pickOption('Counter', 'instructions')

    await waitFor(() => expect(query().counter).toEqual(['instructions']))
    // Hot is no longer the hottest: the URL names it.
    await waitFor(() => expect(query().function_a).toEqual(['hot']))
    expect(column('A').getByRole('combobox', { name: 'Function' })).toHaveValue('hot')
    expect(await functionSuggestions('A', 3)).toEqual(['warm75%', 'main15%', 'hot10%'])
    expect([listed.length, disassembled.length]).toEqual(requests)
  })

  it('goes back to the default when the profiles shown lack the counter, for good', async () => {
    const gammaUuid = profileUuid('2', 'gamma')
    mockWorld({ counters: { [gammaUuid]: { branches: 7 } } })
    renderPage(`${ALPHA}&counter=instructions`)
    await showsFunction('A', 'warm')
    expect(selectButton('Counter')).toHaveTextContent('instructions')

    // Run 2's gamma has only branches.
    await pickOption('Run', RUN_2, sideOf('A'))
    await pick('Test', 'gamma', sideOf('A'))
    await waitFor(() => expect(selectButton('Counter')).toHaveTextContent('branches'))
    expect(query().counter).toBeUndefined()

    // Back to alpha: its default, not the counter dropped.
    await pick('Test', 'alpha', sideOf('A'))
    await waitFor(() => expect(selectButton('Counter')).toHaveTextContent('cycles'))
    expect(query().counter).toBeUndefined()
  })

  it("keeps the counter while another commit's runs load", async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('commit') === 'c1')
    mockWorld({ runsAnswer: slow.answer })
    // Side A shows gamma in run 3 of m1 at c2: run 2 of c1 has a profile of it too.
    renderPage(`${profilesPath(sideAt('m1', 'c2', '3', 'gamma'))}&counter=instructions`)
    await showsFunction('A', 'main')

    await pick('Commit', 'c1', sideOf('A'))
    await waitFor(() => expect(column('A').getByText('Loading the profile...')).toBeVisible())
    expect(query().counter).toEqual(['instructions'])
    slow.open()

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '2', 'gamma').run]))
    await showsFunction('A', 'main')
    expect(query().counter).toEqual(['instructions'])
  })

  it('drops a counter that the profiles shown do not have', async () => {
    mockWorld()
    renderPage(`${ALPHA}&counter=bogus`)

    await showsFunction('A', 'hot')
    await waitFor(() => expect(query().counter).toBeUndefined())
  })

  it("keeps the counter while the only side's profile changes", async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ runsAnswer: slow.answer })
    renderPage(`${ALPHA}&counter=instructions`)
    await showsFunction('A', 'warm')

    await pick('Machine', 'm2', sideOf('A'))
    await settle()
    expect(query().counter).toEqual(['instructions'])
    slow.open()

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m2', 'c1', '4', 'alpha').run]))
    await showsFunction('A', 'warm')
    expect(query().counter).toEqual(['instructions'])
  })

  it('keeps the counter while the runs a URL names are on their way', async () => {
    const slow = heldBack()
    mockWorld({ runsAnswer: slow.answer })
    renderPage(`${ALPHA}&counter=instructions&function_a=main`)

    await settle()
    expect(query().counter).toEqual(['instructions'])
    expect(query().function_a).toEqual(['main'])
    slow.open()
    await showsFunction('A', 'main')
    expect(query().counter).toEqual(['instructions'])
  })

  it("keeps the counter when a side's test is cleared, then another picked", async () => {
    mockWorld()
    renderPage(`${ALPHA}&counter=instructions`)
    await showsFunction('A', 'warm')

    await userEvent.setup().click(within(sideOf('A')).getByRole('button', { name: 'Clear Test' }))
    await settle()
    expect(query().counter).toEqual(['instructions'])
    await pick('Test', 'beta', sideOf('A'))

    await showsFunction('A', 'cool')
    expect(query().counter).toEqual(['instructions'])
  })

  it("resolves a side's hottest only once the other side's profile has loaded", async () => {
    const uuidB = profileUuid('3', 'beta')
    const slow = heldBack((uuid: string) => uuid === uuidB)
    // Side B's profile has instructions only, which makes it the default.
    mockWorld({
      counters: { [uuidB]: { instructions: 200 } },
      metadataAnswer: slow.answer,
    })
    const url = withB('c2', '3', 'beta')
    renderPage(url)

    await settle()
    expect(column('A').queryByRole('table')).not.toBeInTheDocument()
    slow.open()

    // Under instructions, alpha's hottest is warm, and beta's is cool.
    await showsFunction('A', 'warm')
    await showsFunction('B', 'cool')
    expect(selectButton('Counter')).toHaveTextContent('instructions')
    await settle()
    expect(query().function_a).toBeUndefined()
    expect(query().counter).toBeUndefined()
  })

  it("writes a function picked while the other side's profile could not be loaded", async () => {
    const uuidB = profileUuid('3', 'beta')
    mockWorld({
      metadataAnswer: (uuid) =>
        uuid === uuidB ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(withB('c2', '3', 'beta', '&function_a=warm'))

    await showsFunction('A', 'warm')
    expect(await column('B').findByText(/The profile could not be loaded/)).toBeInTheDocument()
    await pickFunction('A', 'main')
    await waitFor(() => expect(query().function_a).toEqual(['main']))
  })

  it('writes a function picked before the counter settles, leaving out the hottest', async () => {
    const uuidB = profileUuid('3', 'beta')
    const slow = heldBack((uuid: string) => uuid === uuidB)
    mockWorld({ metadataAnswer: slow.answer })
    renderPage(withB('c2', '3', 'beta', '&function_a=warm'))
    await showsFunction('A', 'warm')

    // Which function is the hottest is not known yet, with side B's profile on its way.
    await pickFunction('A', 'hot')
    await waitFor(() => expect(query().function_a).toEqual(['hot']))
    slow.open()

    await showsFunction('B', 'hot')
    await waitFor(() => expect(query().function_a).toBeUndefined())
    expect(column('A').getByRole('combobox', { name: 'Function' })).toHaveValue('hot')
  })

  it("drops a function from the URL while the other side's profile failed to load", async () => {
    const uuidB = profileUuid('3', 'beta')
    mockWorld({
      metadataAnswer: (uuid) =>
        uuid === uuidB ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(withB('c2', '3', 'beta', '&function_a=gone'))

    await showsFunction('A', 'hot')
    await waitFor(() => expect(query().function_a).toBeUndefined())
  })

  it('says when the function shown does not have the counter', async () => {
    const uuid = profileUuid('1', 'alpha')
    mockWorld({
      functions: {
        [uuid]: { hot: { cycles: 60 }, warm: { cycles: 30, instructions: 150 } },
      },
    })
    renderPage(`${ALPHA}&counter=instructions&function_a=hot`)

    await showsFunction('A', 'hot')
    expect(
      column('A').getByText('This function does not have the counter instructions.'),
    ).toBeVisible()
  })

  it('says when the profiles shown have no counters', async () => {
    const uuid = profileUuid('1', 'alpha')
    mockWorld({ counters: { [uuid]: {} }, functions: { [uuid]: { main: {} } } })
    fakeLayout()
    renderPage(ALPHA)

    expect(await screen.findByText('The profiles shown have no counters.')).toBeInTheDocument()
    await showsFunction('A', 'main')
    expect(instructionRows('A')).toEqual(['0x1000 | main: add', '0x1004 | main: ret'])
  })

  it('says nothing of the counters while the profile shown loads', async () => {
    const slow = heldBack()
    mockWorld({ metadataAnswer: slow.answer })
    renderPage(ALPHA)

    await waitFor(() => expect(selectButton('Counter')).toHaveTextContent('Loading counters...'))
    expect(screen.queryByText('The profiles shown have no counters.')).not.toBeInTheDocument()
    slow.open()
    await showsFunction('A', 'hot')
    expect(selectButton('Counter')).toHaveTextContent('cycles')
  })

  it('says that no counters were loaded when the only profile shown failed to load', async () => {
    mockWorld({ metadataAnswer: () => errorResponse(500, 'internal_error', 'Boom') })
    renderPage(ALPHA)

    expect(await column('A').findByText(/The profile could not be loaded/)).toBeVisible()
    expect(selectButton('Counter')).toHaveTextContent('No counters loaded')
    expect(screen.queryByText('The profiles shown have no counters.')).not.toBeInTheDocument()
  })

  it("keeps a counter only the other side's profile has, which failed to load", async () => {
    const uuidB = profileUuid('3', 'beta')
    mockWorld({
      counters: { [uuidB]: { branches: 7 } },
      metadataAnswer: (uuid) =>
        uuid === uuidB ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(withB('c2', '3', 'beta', '&counter=branches'))

    await showsFunction('A', 'hot')
    expect(await column('B').findByText(/The profile could not be loaded/)).toBeVisible()
    await settle()
    expect(query().counter).toEqual(['branches'])
  })
})

describe('the Profiles page: values and layout (PF6, PF7)', () => {
  it('shows the values as the Values setting says, which the URL keeps', async () => {
    fakeLayout()
    const { disassembled } = mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')
    const requests = disassembled.length

    await pickOption('Values', 'Absolute')
    await waitFor(() => expect(instructionRows('A')[0]).toBe('45 | 0x1000 | hot: add'))
    expect(query().values).toEqual(['absolute'])
    await pickOption('Values', 'Cumulative %')
    await waitFor(() =>
      expect(instructionRows('A')).toEqual(['75% | 0x1000 | hot: add', '100% | 0x1004 | hot: ret']),
    )
    expect(query().values).toEqual(['cumulative'])
    expect(disassembled.length).toBe(requests)
  })

  it('starts another function at the top, but keeps the place of one fetched again', async () => {
    fakeLayout()
    mockWorld()
    const { queryClient } = renderPage(ALPHA)
    await showsFunction('A', 'hot')
    // Warm's instructions fetched once, so that going back to it shows them at once.
    await pickFunction('A', 'warm')
    await showsFunction('A', 'warm')
    await pickFunction('A', 'hot')
    await showsFunction('A', 'hot')
    const scroller = () => column('A').getByRole('region', { name: /^Instructions of / })

    scroller().scrollTop = 500
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.profiles('libcxx') }))
    await showsFunction('A', 'hot')
    expect(scroller().scrollTop).toBe(500)

    await pickFunction('A', 'warm')
    await showsFunction('A', 'warm')
    expect(scroller().scrollTop).toBe(0)
  })

  it('shows both sides side by side, each with its function', async () => {
    mockWorld()
    renderPage(withB('c2', '3', 'beta'))

    await showsFunction('A', 'hot')
    await showsFunction('B', 'hot')
    expect(screen.getAllByRole('combobox', { name: 'Function' })).toHaveLength(2)
  })

  it('forgets the profiles once left, but not on a visit to another URL of the page', async () => {
    const { metadata } = mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')
    const user = userEvent.setup()

    // Another visit to the page keeps what it fetched.
    await user.click(screen.getByRole('link', { name: 'Profiles' }))
    await user.click(screen.getByRole('button', { name: 'Browser back' }))
    await showsFunction('A', 'hot')
    expect(metadata).toHaveLength(1)

    // Leaving it forgets it.
    await user.click(screen.getByRole('link', { name: 'Compare' }))
    await screen.findByRole('heading', { name: 'Compare' })
    await settle()
    await user.click(screen.getByRole('button', { name: 'Browser back' }))
    await showsFunction('A', 'hot')
    expect(metadata).toHaveLength(2)
  })
})
