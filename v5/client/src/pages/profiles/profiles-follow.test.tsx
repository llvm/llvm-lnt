import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { uuidOf } from '../../test/fixtures'
import { errorResponse } from '../../test/mock-api'
import { query, renderPage, rowsOf, settle } from '../../test/page'
import { clearCombobox, pick, pickOption } from '../../test/select'
import { profilesPath } from '../../paths'
import {
  columnOf,
  expectFollowing,
  field,
  followsFunction,
  functionField,
  heldBack,
  mockWorld,
  pickFunction,
  profileShown,
  profileUuid,
  showsFunction,
  sideAt,
  sideOf,
} from './profiles-world'

/**
 * Side A showing `test` in run 1 of m1 at c1, and side B in run `hex` of m1 at c1 following it,
 * with the query parameters `extra`.
 */
function withBFollowing(test: string, hex: string, extra = '') {
  return profilesPath(sideAt('m1', 'c1', '1', test), sideAt('m1', 'c1', hex)) + extra
}

describe('the Profiles page: side B follows side A (PF2)', () => {
  it("follows side A's test as it changes, while its run has a profile of it", async () => {
    mockWorld()
    // Run 2 has profiles of gamma and alpha, but not of beta.
    renderPage(withBFollowing('beta', '2'))
    await profileShown('A')
    await waitFor(() => expect(field('Test', 'B')).toBeEnabled())
    expect(field('Test', 'B')).toHaveAttribute('placeholder', 'Select a test')
    expect(field('Test', 'B')).not.toHaveAccessibleDescription()
    expect(columnOf('B')).not.toBeInTheDocument()

    await pick('Test', 'alpha', sideOf('A'))

    await profileShown('B')
    expectFollowing(field('Test', 'B'), 'alpha')
    expect(query().test_b).toBeUndefined()
  })

  it("shows side A's test while it checks it against its run", async () => {
    const slow = heldBack((hex: string) => hex === '2')
    mockWorld({ profilesAnswer: slow.answer })
    renderPage(withBFollowing('alpha', '2'))

    // Not "Loading tests...", which would flicker between two showings of the same name.
    await waitFor(() => expectFollowing(field('Test', 'B'), 'alpha'))
    slow.open()
    await profileShown('B')
    expectFollowing(field('Test', 'B'), 'alpha')
  })

  it('loses the test with side A', async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '2'))
    await profileShown('B')

    await clearCombobox('Test', sideOf('A'))

    await waitFor(() => expect(columnOf('B')).not.toBeInTheDocument())
    expect(field('Test', 'B')).toHaveAttribute('placeholder', 'Select a test')
    expect(screen.getByText('Select a test on either side to see its profile.')).toBeVisible()
  })

  it("keeps a test picked on side B, even side A's, as side A's changes", async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '1'))
    await profileShown('B')

    await pick('Test', 'alpha', sideOf('B'))
    await waitFor(() => expect(query().test_b).toEqual(['alpha']))
    expect(field('Test', 'B')).toHaveValue('alpha')
    expect(field('Test', 'B')).not.toHaveAccessibleDescription()
    await pick('Test', 'beta', sideOf('A'))

    // Side B follows side A's function, beta's hottest, by name, whatever the test.
    await followsFunction('hot')
    expect(field('Test', 'B')).toHaveValue('alpha')
    expect(query().test_b).toEqual(['alpha'])
    expect(query().function_b).toBeUndefined()
  })

  it("follows side A's test again once its own is cleared", async () => {
    mockWorld()
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '1', 'alpha')))
    await followsFunction('hot')

    await clearCombobox('Test', sideOf('B'))

    await waitFor(() => expectFollowing(field('Test', 'B'), 'beta'))
    await followsFunction('hot')
    expect(query().test_b).toBeUndefined()
  })

  it("drops a test of its own that its run has no profile of, following side A's", async () => {
    mockWorld()
    // Run 2 has no profile of beta.
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'alpha'), sideAt('m1', 'c1', '2', 'beta')))

    await waitFor(() => expect(query().test_b).toBeUndefined())
    await waitFor(() => expectFollowing(field('Test', 'B'), 'alpha'))
    await profileShown('B')
  })

  it('follows nothing without a commit', async () => {
    mockWorld()
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'alpha'), { suite: 'libcxx', machine: 'm1' }))
    await profileShown('A')

    expect(field('Test', 'B')).toHaveAttribute('placeholder', 'Select a run first')
    expect(columnOf('B')).not.toBeInTheDocument()
  })
})

describe('the Profiles page: side B follows side A (PF4)', () => {
  it("follows side A's function as it changes, leaving it out of the URL", async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '2', '&function_a=warm'))
    await followsFunction('warm')

    await pickFunction('A', 'main')

    await followsFunction('main')
    expect(query().function_a).toEqual(['main'])
    expect(query().function_b).toBeUndefined()
    // The counter comparison compares the same function on both sides.
    expect(rowsOf(screen.getByRole('table', { name: 'Counter comparison' })).at(-1)).toBe(
      'Function cycles | 10 | 10 | 0%',
    )
  })

  it("keeps showing side A's function while side A's profile changes", async () => {
    const slow = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ runsAnswer: slow.answer })
    renderPage(withBFollowing('alpha', '2', '&function_a=warm'))
    await followsFunction('warm')

    // m2 has a profile of alpha at c1, in run 4, whose runs are on their way.
    await pick('Machine', 'm2', sideOf('A'))
    await settle()
    expect(columnOf('A')).toHaveTextContent('Loading the profile...')

    // Side B never shows another function, nor none, meanwhile.
    await followsFunction('warm')
    slow.open()
    await showsFunction('A', 'warm')
    await followsFunction('warm')
  })

  it("waits for side A's function, not yet known, as side A's profile changes", async () => {
    // Side A's functions of alpha in run 1 are on their way, and so are the runs of m2.
    const functions = heldBack((uuid: string) => uuid === profileUuid('1', 'alpha'))
    const runs = heldBack((q: URLSearchParams) => q.get('machine') === 'm2')
    mockWorld({ functionsAnswer: functions.answer, runsAnswer: runs.answer })
    renderPage(withBFollowing('alpha', '2'))
    await waitFor(() => expect(columnOf('B')).toHaveTextContent('Loading the function...'))

    // Side A does not know its function yet, which is not none.
    await pick('Machine', 'm2', sideOf('A'))
    await settle()
    expect(columnOf('B')).toHaveTextContent('Loading the function...')
    expect(functionField('B')).not.toHaveAttribute('placeholder', 'Select a function')

    runs.open()
    await showsFunction('A', 'hot')
    await followsFunction('hot')
    functions.open()
  })

  for (const failing of ['metadata', 'functions'] as const) {
    it(`shows no function once side A's new ${failing} cannot be loaded`, async () => {
      // m2 has a profile of alpha at c1, in run 4, whose ${failing} cannot be loaded.
      const fails = (uuid: string) =>
        uuid === profileUuid('4', 'alpha')
          ? errorResponse(500, 'internal_error', 'Boom')
          : undefined
      mockWorld(failing === 'metadata' ? { metadataAnswer: fails } : { functionsAnswer: fails })
      renderPage(withBFollowing('alpha', '2', '&function_a=warm'))
      await followsFunction('warm')

      await pick('Machine', 'm2', sideOf('A'))

      await waitFor(() =>
        expect(functionField('B')).toHaveAttribute('placeholder', 'Select a function'),
      )
      expect(within(columnOf('B')!).queryByRole('table')).not.toBeInTheDocument()
    })
  }

  it("waits for side A's function on side A's next test, rather than show none", async () => {
    const alphaA = profileUuid('1', 'alpha')
    const slow = heldBack((uuid: string) => uuid === alphaA)
    mockWorld({ functionsAnswer: slow.answer })
    // Side B shows its own alpha in run 2, following side A's function, beta's hot.
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'beta'), sideAt('m1', 'c1', '2', 'alpha')))
    await followsFunction('hot')

    // Side A's functions of alpha are on their way: side B's profile is the same.
    await pick('Test', 'alpha', sideOf('A'))
    await settle()
    expect(columnOf('B')).toHaveTextContent('Loading the function...')
    expect(functionField('B')).not.toHaveAttribute('placeholder', 'Select a function')
    slow.open()

    await showsFunction('A', 'hot')
    await followsFunction('hot')
  })

  it("shows side A's function on side A's next test once it is known", async () => {
    const beta = profileUuid('1', 'beta')
    const slow = heldBack((uuid: string) => uuid === beta)
    mockWorld({ functionsAnswer: slow.answer })
    renderPage(withBFollowing('alpha', '1', '&function_a=warm'))
    await followsFunction('warm')

    await pick('Test', 'beta', sideOf('A'))
    // Side B shows beta in run 1, the same profile as side A's: neither knows its function yet.
    await settle()
    expect(within(columnOf('B')!).queryByRole('table')).not.toBeInTheDocument()
    slow.open()

    await showsFunction('A', 'hot')
    await followsFunction('hot')
  })

  it('shows no function when its profile lacks the one side A shows', async () => {
    // Run 2's alpha has no warm.
    mockWorld({
      functions: {
        [profileUuid('2', 'alpha')]: {
          hot: { cycles: 60, instructions: 20 },
          main: { cycles: 10, instructions: 30 },
        },
      },
    })
    renderPage(withBFollowing('alpha', '2', '&function_a=warm'))
    await showsFunction('A', 'warm')

    await waitFor(() =>
      expect(functionField('B')).toHaveAttribute('placeholder', 'Select a function'),
    )
    expect(functionField('B')).toHaveValue('')
    expect(within(columnOf('B')!).queryByRole('table')).not.toBeInTheDocument()
    expect(columnOf('B')).not.toHaveTextContent('Loading')
    expect(rowsOf(screen.getByRole('table', { name: 'Counter comparison' })).at(-1)).toBe(
      'Function cycles | 30 | N/A | N/A',
    )
    expect(query().function_b).toBeUndefined()

    await pickFunction('B', 'main')
    await showsFunction('B', 'main')
    expect(query().function_b).toEqual(['main'])
  })

  it("keeps a function picked on side B, even its hottest or side A's", async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '2', '&function_a=warm'))
    await followsFunction('warm')

    await pickFunction('B', 'hot')
    await showsFunction('B', 'hot')
    expect(query().function_b).toEqual(['hot'])
    await pickFunction('B', 'warm')
    await showsFunction('B', 'warm')
    expect(query().function_b).toEqual(['warm'])
    expect(functionField('B')).not.toHaveAccessibleDescription()

    // Its own function stays as side A's changes.
    await pickFunction('A', 'main')
    await showsFunction('A', 'main')
    await showsFunction('B', 'warm')
  })

  it("follows side A's function again once its own is cleared", async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '2', '&function_a=warm&function_b=main'))
    await showsFunction('B', 'main')

    await clearCombobox('Function', columnOf('B')!)

    await followsFunction('warm')
    expect(query().function_b).toBeUndefined()
  })

  it('keeps its own function whatever test it shows, while its profile has it', async () => {
    mockWorld()
    // Both alpha and beta have a main.
    renderPage(withBFollowing('alpha', '1', '&function_b=main'))
    await showsFunction('B', 'main')

    await pick('Test', 'beta', sideOf('A'))
    await waitFor(() => expectFollowing(field('Test', 'B'), 'beta'))
    await showsFunction('B', 'main')
    // Neither picking a test of its own nor clearing it drops its function.
    await pick('Test', 'alpha', sideOf('B'))
    await waitFor(() => expect(query().test_b).toEqual(['alpha']))
    await showsFunction('B', 'main')
    await clearCombobox('Test', sideOf('B'))
    await waitFor(() => expectFollowing(field('Test', 'B'), 'beta'))
    await showsFunction('B', 'main')
    expect(query().function_b).toEqual(['main'])
  })

  it('drops its own function once its profile does not have it, following side A\'s', async () => {
    // Run 1's beta has no main.
    mockWorld({
      functions: { [profileUuid('1', 'beta')]: { hot: { cycles: 50, instructions: 50 } } },
    })
    renderPage(withBFollowing('alpha', '1', '&function_b=main'))
    await showsFunction('B', 'main')

    await pick('Test', 'beta', sideOf('A'))

    await followsFunction('hot')
    expect(query().function_b).toBeUndefined()
  })

  it('shows no function on another test than side A\'s that lacks side A\'s', async () => {
    mockWorld()
    // Side B's gamma has no hot, which side A's alpha shows.
    renderPage(profilesPath(sideAt('m1', 'c1', '1', 'alpha'), sideAt('m1', 'c1', '2', 'gamma')))
    await showsFunction('A', 'hot')

    await waitFor(() =>
      expect(functionField('B')).toHaveAttribute('placeholder', 'Select a function'),
    )
    expect(functionField('B')).not.toHaveAccessibleDescription()
    expect(within(columnOf('B')!).queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows no function, rather than load forever, while side A shows none', async () => {
    mockWorld()
    // Side A has a commit, but no test.
    renderPage(
      profilesPath(
        { suite: 'libcxx', machine: 'm1', commit: 'c1' },
        sideAt('m1', 'c1', '2', 'alpha'),
      ),
    )

    await waitFor(() =>
      expect(functionField('B')).toHaveAttribute('placeholder', 'Select a function'),
    )
    expect(columnOf('B')).not.toHaveTextContent('Loading')
    expect(columnOf('A')).not.toBeInTheDocument()
  })

  it("shows no function while side A's functions could not be listed", async () => {
    mockWorld({
      functionsAnswer: (uuid) =>
        uuid === profileUuid('1', 'alpha')
          ? errorResponse(500, 'internal_error', 'Boom')
          : undefined,
    })
    renderPage(withBFollowing('alpha', '2'))

    expect(await within(columnOf('A')!).findByText(/could not be listed/)).toBeVisible()
    await waitFor(() =>
      expect(functionField('B')).toHaveAttribute('placeholder', 'Select a function'),
    )
  })

  it("keeps its own function on another run of side A's test that has it", async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '1', '&function_a=warm&function_b=main'))
    await showsFunction('B', 'main')

    await pickOption('Run', '2026-08-21, 10:00:00 AM 22222222', sideOf('B'))

    await waitFor(() => expect(query().run_b).toEqual([uuidOf('2')]))
    await showsFunction('B', 'main')
    expect(query().function_b).toEqual(['main'])
  })

  it('keeps the function it follows when the counter changes', async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '2', '&function_a=main'))
    await followsFunction('main')

    await pickOption('Counter', 'instructions')

    const header = () => within(columnOf('B')!).getByRole('columnheader', { name: 'instructions' })
    await waitFor(() => expect(header()).toBeVisible())
    await followsFunction('main')
    expect(query().function_b).toBeUndefined()
  })

  it('restores what the URL says: its own test and function, or those it follows', async () => {
    mockWorld()
    renderPage(withBFollowing('alpha', '2', '&function_a=warm&function_b=main'))

    await showsFunction('B', 'main')
    expectFollowing(field('Test', 'B'), 'alpha')
    expect(query().function_b).toEqual(['main'])
    expect(query().test_b).toBeUndefined()
  })
})
