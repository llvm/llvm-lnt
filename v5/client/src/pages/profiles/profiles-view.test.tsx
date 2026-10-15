import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { profilesPath } from '../../paths'
import { fakeLayout } from '../../test/layout'
import { errorResponse } from '../../test/mock-api'
import { query, renderPage, rowsOf, settle } from '../../test/page'
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
    expect(column('A').getByTitle("Share of the profile's cycles")).toHaveTextContent(
      '60%',
    )
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

    expect(
      await column('A').findByText('This profile lists no functions.'),
    ).toBeInTheDocument()
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
    const slow = heldBack((uuid: string) => uuid === next)
    const next = profileUuid('2', 'alpha')
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
    const slow = heldBack((uuid: string) => uuid === uuidB)
    const uuidB = profileUuid('2', 'alpha')
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
    await waitFor(() => expect(within(sideOf('B')).getByRole('combobox', { name: 'Test' })).toBeEnabled())
    await pick('Test', 'alpha', sideOf('A'))
    await pick('Test', 'alpha', sideOf('B'))
    slow.open()

    // Each side's carried function belongs to another test, as does the other side's: each takes
    // its hottest, rather than waiting for the other.
    await showsFunction('A', 'hot')
    await showsFunction('B', 'hot')
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
    const slow = heldBack((uuid: string) => uuid === uuidB)
    const uuidB = profileUuid('3', 'beta')
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
    expect(
      await column('B').findByText(/The profile could not be loaded/),
    ).toBeInTheDocument()
    await pickFunction('A', 'main')
    await waitFor(() => expect(query().function_a).toEqual(['main']))
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
