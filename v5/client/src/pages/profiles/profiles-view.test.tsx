import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../api/keys'
import { REF } from '../../test/fixtures'
import { profilesPath } from '../../paths'
import { fakeLayout } from '../../test/layout'
import { errorResponse } from '../../test/mock-api'
import { currentUrl, query, renderPage, rowsOf, settle } from '../../test/page'
import { clearCombobox, pick, pickOption, selectButton } from '../../test/select'
import {
  ALPHA,
  columnOf,
  field,
  showsDefaultFunction,
  functionField,
  heldBack,
  mockWorld,
  profileUuid,
  sideAt,
  pickFunction,
  showsFunction,
  sideOf,
} from './profiles-world'

/** Queries within `side`'s column. */
function column(side: 'A' | 'B') {
  return within(columnOf(side)!)
}

/**
 * Check that `side`'s function selector suggests the functions named `names`, in order: each with
 * its share, as assistive technology reads it.
 */
async function expectSuggestions(side: 'A' | 'B', names: string[]) {
  const user = userEvent.setup()
  await user.click(column(side).getByRole('button', { name: /Show suggestions/ }))
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(names.length))
  const options = screen.getAllByRole('option')
  names.forEach((name, i) => expect(screen.getByRole('option', { name })).toBe(options[i]))
  await user.keyboard('{Escape}')
}

/** The rows of `side`'s instructions, as rendered. */
function instructionRows(side: 'A' | 'B') {
  return rowsOf(column(side).getByRole('table'))
}

/** Clear side A's test, then pick `test`. */
async function clearThenPick(test: string) {
  await clearCombobox('Test', sideOf('A'))
  await waitFor(() => expect(query().test_a).toBeUndefined())
  await pick('Test', test, sideOf('A'))
}

/** The option of run 1 or run 2 of m1 at c1, in a side's run dropdown. */
const RUN_1 = '2026-08-20, 10:00:00 AM 11111111'
const RUN_2 = '2026-08-21, 10:00:00 AM 22222222'

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
    const badge = column('A').getByTitle("Share of the profile's cycles")
    expect(within(badge).getByText('60% of cycles')).toBeInTheDocument()
    await settle()
    expect(query().function_a).toBeUndefined()
  })

  it("cannot clear side A's function", async () => {
    const user = userEvent.setup()
    mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')
    expect(column('A').queryByRole('button', { name: 'Clear Function' })).not.toBeInTheDocument()

    await user.clear(functionField('A'))
    await user.tab()

    await showsFunction('A', 'hot')
  })

  it('offers the functions hottest first, each with its share', async () => {
    mockWorld()
    renderPage(ALPHA)
    await showsFunction('A', 'hot')

    await expectSuggestions('A', [
      'hot, 60% of cycles',
      'warm, 30% of cycles',
      'main, 10% of cycles',
    ])
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
    expect(functionField('A')).toHaveValue('hot')
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

  it("never takes side B's function, even on side B's test", async () => {
    mockWorld()
    // Side A shows beta in run 1, side B alpha's main, picked on it, in run 2.
    renderPage(
      profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '2', 'alpha')) +
        '&function_b=main',
    )
    await showsFunction('B', 'main')

    await pick('Test', 'alpha', sideOf('A'))

    await showsFunction('A', 'hot')
    expect(query().function_a).toBeUndefined()
  })

  it('resolves both sides when both change their profile at once', async () => {
    const slow = heldBack()
    mockWorld({ functionsAnswer: slow.answer })
    // Side A shows beta in run 1, side B gamma in run 2: both then pick alpha.
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '2', 'gamma')))
    const testB = field('Test', 'B')
    await waitFor(() => expect(testB).toBeEnabled())
    await pick('Test', 'alpha', sideOf('A'))
    await pick('Test', 'alpha', sideOf('B'))
    slow.open()

    // Side A's carried function belongs to another test: side A takes its hottest, which side B
    // shows by default.
    await showsFunction('A', 'hot')
    await showsDefaultFunction('hot')
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

  it('keeps showing the profile when its runs fail to load again', async () => {
    let fail = false
    mockWorld({
      runsAnswer: () => (fail ? errorResponse(500, 'internal_error', 'Boom') : undefined),
    })
    const { queryClient } = renderPage(ALPHA)
    await showsFunction('A', 'hot')
    const url = currentUrl()

    fail = true
    await act(() => queryClient.refetchQueries({ queryKey: [...queryKeys.runs(REF), 'of-commit'] }))

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

  it('keeps its function in the URL on going back to a profile already loaded', async () => {
    mockWorld()
    renderPage(`${ALPHA}&function_a=warm`)
    await showsFunction('A', 'warm')

    await pickOption('Run', RUN_2, sideOf('A'))
    await showsFunction('A', 'warm')
    await waitFor(() => expect(query().function_a).toEqual(['warm']))
    // Back to run 1, whose profile is loaded already.
    await pickOption('Run', RUN_1, sideOf('A'))

    await waitFor(() => expect(query().run_a).toEqual([sideAt('m1', 'c1', '1', 'alpha').run]))
    await showsFunction('A', 'warm')
    await waitFor(() => expect(query().function_a).toEqual(['warm']))
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
    expect(functionField('A')).toHaveValue('hot')
    await expectSuggestions('A', [
      'warm, 75% of instructions',
      'main, 15% of instructions',
      'hot, 10% of instructions',
    ])
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

    await clearCombobox('Test', sideOf('A'))
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

    // Under instructions, alpha's hottest is warm, which side B's beta does not have.
    await showsFunction('A', 'warm')
    await waitFor(() =>
      expect(functionField('B')).toHaveAttribute('placeholder', 'Select a function'),
    )
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

    await showsDefaultFunction('hot')
    await waitFor(() => expect(query().function_a).toBeUndefined())
    expect(functionField('A')).toHaveValue('hot')
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
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.profiles(REF) }))
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
    await showsDefaultFunction('hot')
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

/**
 * An answer for `mockWorld` that gives alpha's hot function the instructions whose counters are
 * `counters`, at addresses 0x2000, 0x2004 and so on, with the text `insn {index}`.
 */
function hotInstructions(counters: Record<string, number>[]) {
  return (key: string) => {
    if (!key.endsWith('/hot')) return undefined
    return HttpResponse.json({
      name: 'hot',
      counters: { cycles: 60, instructions: 20 },
      disassembly_format: 'llvm-objdump',
      instructions: counters.map((values, i) => ({
        address: 0x2000 + 4 * i,
        counters: values,
        text: `insn ${i}`,
      })),
    })
  }
}

/** Instructions whose cycles are `cycles`, and whose instructions are `instructions`. */
function withCounters(cycles: number[], instructions: number[] = cycles) {
  return cycles.map((value, i) => ({ cycles: value, instructions: instructions[i] }))
}

/**
 * Show side A's hot function, laid out, with the instructions whose counters are `counters`, at the
 * URL `url`. Returns what `renderPage` does.
 */
async function showHot(counters: Record<string, number>[], url = ALPHA) {
  fakeLayout()
  mockWorld({ disassemblyAnswer: hotInstructions(counters) })
  const page = renderPage(url)
  await showsFunction('A', 'hot')
  return page
}

/** Pick the counter `name`, and wait for side A's instructions to show it. */
async function showCounter(name: string) {
  await pickOption('Counter', name)
  await waitFor(() => expect(column('A').getByRole('columnheader', { name })).toBeVisible())
}

/** Side A's Previous and Next buttons, and where they have got to. */
function hottest() {
  const group = column('A').getByRole('group', { name: 'Hottest' })
  return {
    previous: within(group).getByRole('button', { name: /Previous/ }),
    next: within(group).getByRole('button', { name: /Next/ }),
    status: within(group).getByRole('status'),
  }
}

/** The text of side A's highlighted instruction, if any. */
function highlighted() {
  return column('A').queryByRole('row', { current: true })?.textContent ?? null
}

/** Press side A's Next or Previous button. */
async function step(button: 'next' | 'previous') {
  await userEvent.setup().click(hottest()[button])
}

describe('the Profiles page: hottest instructions (PF5)', () => {
  it('steps from the hottest instruction to the coldest, leaving out those of 0', async () => {
    await showHot(withCounters([0, 5, 20, 5, 0, 10]))
    expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
    expect(hottest().next).not.toHaveAttribute('aria-disabled')
    expect(highlighted()).toBeNull()
    expect(hottest().status).toHaveTextContent(/^$/)

    // By value, ties in the order of the instructions.
    const order = ['insn 2', 'insn 5', 'insn 1', 'insn 3']
    for (const [i, text] of order.entries()) {
      await step('next')
      await waitFor(() => expect(highlighted()).toContain(text))
      if (i === 0) expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
      else expect(hottest().previous).not.toHaveAttribute('aria-disabled')
    }
    expect(hottest().status).toHaveTextContent('Hottest instruction 4 of 4, at 0x200c')
    expect(hottest().next).toHaveAttribute('aria-disabled', 'true')
    // A button at its end keeps the focus, and does nothing.
    expect(hottest().next).toHaveFocus()
    await step('next')
    expect(highlighted()).toContain('insn 3')

    await step('previous')
    await waitFor(() => expect(highlighted()).toContain('insn 1'))
    expect(hottest().status).toHaveTextContent('Hottest instruction 3 of 4, at 0x2004')
    expect(hottest().next).not.toHaveAttribute('aria-disabled')
    await step('previous')
    await step('previous')
    await waitFor(() => expect(highlighted()).toContain('insn 2'))
    expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
    await step('previous')
    expect(highlighted()).toContain('insn 2')
  })

  it('scrolls to the instruction it highlights', async () => {
    const cycles = Array.from({ length: 300 }, (_, i) => (i === 250 ? 100 : 1))
    await showHot(withCounters(cycles))
    expect(column('A').queryByText('insn 250')).not.toBeInTheDocument()

    await step('next')
    await waitFor(() => expect(highlighted()).toContain('insn 250'))
  })

  it('keeps nothing of where it got to in the URL', async () => {
    await showHot(withCounters([1, 2]))
    await settle()
    const url = currentUrl()

    await step('next')
    await waitFor(() => expect(highlighted()).toContain('insn 1'))
    await settle()
    expect(currentUrl()).toBe(url)
  })

  it('starts again from before the hottest on another counter', async () => {
    await showHot(withCounters([1, 3, 2], [3, 1, 2]))
    await step('next')
    await step('next')
    await waitFor(() => expect(highlighted()).toContain('insn 2'))

    await showCounter('instructions')
    expect(highlighted()).toBeNull()
    expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
    expect(hottest().status).toHaveTextContent(/^$/)
    // Going back to the counter starts again too.
    await showCounter('cycles')
    expect(highlighted()).toBeNull()
    await showCounter('instructions')
    await step('next')
    await waitFor(() => expect(highlighted()).toContain('insn 0'))
  })

  it('starts again from before the hottest on another function', async () => {
    await showHot(withCounters([1, 3, 2]))
    await step('next')
    await waitFor(() => expect(highlighted()).toContain('insn 1'))

    await pickFunction('A', 'warm')
    await showsFunction('A', 'warm')
    expect(highlighted()).toBeNull()
    await pickFunction('A', 'hot')
    await showsFunction('A', 'hot')
    expect(highlighted()).toBeNull()
    expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
  })

  it('keeps where it got to when the instructions are fetched again', async () => {
    const { queryClient } = await showHot(withCounters([1, 3, 2]))
    await step('next')
    await step('next')
    await waitFor(() => expect(highlighted()).toContain('insn 2'))

    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.profiles(REF) }))
    await showsFunction('A', 'hot')
    expect(highlighted()).toContain('insn 2')
    expect(hottest().status).toHaveTextContent('Hottest instruction 2 of 3')
  })

  it('cannot step when no instruction has a value', async () => {
    await showHot(withCounters([0, 0]))

    expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
    expect(hottest().next).toHaveAttribute('aria-disabled', 'true')
    await step('next')
    expect(highlighted()).toBeNull()
  })

  it('cannot step when the function does not have the counter', async () => {
    await showHot([{ cycles: 1 }, { cycles: 2 }], `${ALPHA}&counter=instructions&function_a=hot`)
    expect(
      column('A').getByText('This function does not have the counter instructions.'),
    ).toBeVisible()

    expect(hottest().next).toHaveAttribute('aria-disabled', 'true')
    expect(hottest().previous).toHaveAttribute('aria-disabled', 'true')
  })
})
