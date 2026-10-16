import { act, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../api/keys'
import { errorResponse } from '../../test/mock-api'
import { profilesPath } from '../../paths'
import { headersOf, renderPage, rowsOf } from '../../test/page'
import { pick, pickOption } from '../../test/select'
import type { Counters } from './counters'
import { columnOf, heldBack, mockWorld, profileShown, profileUuid, sideAt } from './profiles-world'

/** Side A's profile, of alpha in run 1, and side B's, of beta in run 3. */
const UUID_A = profileUuid('1', 'alpha')
const UUID_B = profileUuid('3', 'beta')

/** Side A showing alpha in run 1 of m1 at c1, and side B beta in run 3 of m1 at c2. */
const BOTH = profilesPath(sideAt('m1', 'c1', '1', 'alpha'), sideAt('m1', 'c2', '3', 'beta'))

/**
 * Top-level counters that differ in every way the comparison tells apart: a decrease, an increase,
 * one too small to show, one of A's that is 0, and one that only a side has.
 */
const COUNTERS: Record<string, Counters> = {
  [UUID_A]: { cycles: 1000, faults: 3, instructions: 100000, 'l1-misses': 0, stalls: 10 },
  [UUID_B]: { cycles: 800, instructions: 99960, 'l1-misses': 4, misses: 5, stalls: 12.5 },
}

function comparison() {
  return screen.getByRole('table', { name: 'Counter comparison' })
}

function headers() {
  return headersOf(comparison())
}

/** The row comparing the functions shown: the table's last. */
function functionRow() {
  return rowsOf(comparison()).at(-1)
}

/** The Difference shown as `text`, with its bar, if any. */
function difference(text: string) {
  const shown = within(comparison()).getByText(text).parentElement!
  return { shown, bar: shown.querySelector('.differenceBar') as HTMLElement | null }
}

describe('the Profiles page: counter comparison (PF3)', () => {
  it('compares the counters of two profiles, and the functions they show', async () => {
    mockWorld({ counters: COUNTERS })
    renderPage(BOTH)

    // Each side's hottest function under cycles: alpha's hot and beta's hot.
    await waitFor(() =>
      expect(rowsOf(comparison())).toEqual([
        'cycles | 1000 | 800 | -20%',
        'faults | 3 | N/A | N/A',
        'instructions | 100000 | 99960 | 0%',
        'l1-misses | 0 | 4 | N/A',
        'misses | N/A | 5 | N/A',
        'stalls | 10 | 12.5 | +25%',
        'Function cycles | 60 | 50 | -16.7%',
      ]),
    )
    expect(headers()).toEqual(['Counter', 'A', 'B', 'Difference'])
  })

  it('colors a decrease green and an increase red, with a bar, but not 0%', async () => {
    mockWorld({ counters: COUNTERS })
    renderPage(BOTH)
    await waitFor(() => expect(within(comparison()).getByText('-20%')).toBeInTheDocument())

    const decrease = difference('-20%')
    expect(decrease.shown).toHaveClass('decrease')
    expect(decrease.bar).toHaveStyle({ width: '20%' })
    const increase = difference('+25%')
    expect(increase.shown).toHaveClass('increase')
    expect(increase.bar).toHaveStyle({ width: '25%' })
    // -0.04%, which shows as 0%.
    const none = difference('0%')
    expect(none.shown).not.toHaveClass('decrease')
    expect(none.shown).not.toHaveClass('increase')
    expect(none.bar).toBeNull()
  })

  it('fills the bar from a Difference of 100% up', async () => {
    mockWorld({ counters: { [UUID_A]: { cycles: 100 }, [UUID_B]: { cycles: 350 } } })
    renderPage(BOTH)

    await waitFor(() => expect(within(comparison()).getByText('+250%')).toBeInTheDocument())
    expect(difference('+250%').bar).toHaveStyle({ width: '100%' })
  })

  it('compares the functions shown under the counter shown, whatever their names', async () => {
    mockWorld()
    // Side B shows a function of its own, cool, rather than side A's.
    renderPage(`${BOTH}&function_b=cool`)
    await waitFor(() => expect(functionRow()).toBe('Function cycles | 60 | 40 | -33.3%'))

    await pickOption('Counter', 'instructions')
    await waitFor(() => expect(functionRow()).toBe('Function instructions | 20 | 100 | +400%'))
    await pick('Function', 'warm', columnOf('A')!, /^warm, /)
    await waitFor(() => expect(functionRow()).toBe('Function instructions | 150 | 100 | -33.3%'))
  })

  it('gives N/A for a function without the counter, or a profile that lists none', async () => {
    mockWorld({
      functions: { [UUID_A]: { hot: { cycles: 60 } }, [UUID_B]: {} },
    })
    renderPage(`${BOTH}&counter=instructions`)

    await waitFor(() => expect(functionRow()).toBe('Function instructions | N/A | N/A | N/A'))
    expect(within(columnOf('B')!).getByText('This profile lists no functions.')).toBeVisible()
  })

  it("leaves a side's function value empty until its function is known", async () => {
    const functions = heldBack((uuid: string) => uuid === UUID_B)
    mockWorld({ functionsAnswer: functions.answer })
    renderPage(BOTH)

    await profileShown('A')
    expect(functionRow()).toBe('Function cycles | 60 |  | ')
    functions.open()
    await waitFor(() => expect(functionRow()).toBe('Function cycles | 60 | 50 | -16.7%'))
  })

  it("leaves the value empty while a side's function is not among those listed", async () => {
    // Side A's functions, once fetched again, no longer list warm, which side A holds.
    let dropWarm = false
    mockWorld({
      functionsAnswer: (uuid) =>
        dropWarm && uuid === UUID_A
          ? HttpResponse.json({ items: [{ name: 'hot', counters: { cycles: 60 }, length: 2 }] })
          : undefined,
    })
    // Side B shows hot, picked on it: beta has no warm to take by default.
    const { queryClient } = renderPage(`${BOTH}&function_b=hot`)
    await pick('Function', 'warm', columnOf('A')!, /^warm, /)
    await waitFor(() => expect(functionRow()).toBe('Function cycles | 30 | 50 | +66.7%'))

    dropWarm = true
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.profiles('libcxx') }))
    await waitFor(() => expect(functionRow()).toBe('Function cycles |  | 50 | '))
  })

  it("keeps the columns while a side's counters load, showing the other side's", async () => {
    const metadata = heldBack((uuid: string) => uuid === UUID_B)
    mockWorld({ metadataAnswer: metadata.answer })
    renderPage(BOTH)

    await waitFor(() =>
      expect(rowsOf(comparison())).toEqual([
        'cycles | 100 |  | ',
        'instructions | 200 |  | ',
        // Side A's hottest function waits for side B's profile, which may change the counter.
        'Function cycles |  |  | ',
      ]),
    )
    expect(headers()).toEqual(['Counter', 'A', 'B', 'Difference'])
    metadata.open()
    await waitFor(() =>
      expect(rowsOf(comparison())).toEqual([
        'cycles | 100 | 100 | 0%',
        'instructions | 200 | 200 | 0%',
        'Function cycles | 60 | 50 | -16.7%',
      ]),
    )
  })

  it("keeps the columns when a side's counters cannot be loaded", async () => {
    mockWorld({
      metadataAnswer: (uuid) =>
        uuid === UUID_B ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(BOTH)

    expect(await within(columnOf('B')!).findByText(/The profile could not be loaded/)).toBeVisible()
    await profileShown('A')
    expect(headers()).toEqual(['Counter', 'A', 'B', 'Difference'])
    expect(rowsOf(comparison())).toEqual([
      'cycles | 100 |  | ',
      'instructions | 200 |  | ',
      'Function cycles | 60 |  | ',
    ])
  })

  it.each([
    {
      side: 'A' as const,
      url: profilesPath(sideAt('m1', 'c1', '1', 'alpha')),
      rows: [
        'cycles | 1000',
        'faults | 3',
        'instructions | 100000',
        'l1-misses | 0',
        'stalls | 10',
      ],
    },
    {
      side: 'B' as const,
      url: profilesPath({}, sideAt('m1', 'c2', '3', 'beta')),
      rows: [
        'cycles | 800',
        'instructions | 99960',
        'l1-misses | 4',
        'misses | 5',
        'stalls | 12.5',
      ],
    },
  ])('lists the counters of side $side, shown alone', async ({ side, url, rows }) => {
    mockWorld({ counters: COUNTERS })
    renderPage(url)

    await profileShown(side)
    expect(headers()).toEqual(['Counter', 'Value'])
    expect(rowsOf(comparison())).toEqual(rows)
  })

  it('says while the counters load, even under a counter the URL names', async () => {
    const metadata = heldBack()
    mockWorld({ metadataAnswer: metadata.answer })
    renderPage(`${BOTH}&counter=cycles`)

    await waitFor(() => expect(rowsOf(comparison())).toEqual(['Loading counters...']))
    expect(headers()).toEqual(['Counter', 'A', 'B', 'Difference'])
  })

  it('says when no counters could be loaded', async () => {
    mockWorld({ metadataAnswer: () => errorResponse(500, 'internal_error', 'Boom') })
    renderPage(BOTH)

    await waitFor(() => expect(rowsOf(comparison())).toEqual(['No counters loaded']))
  })

  it('says when the profiles shown have no counters', async () => {
    mockWorld({ counters: { [UUID_A]: {}, [UUID_B]: {} } })
    renderPage(BOTH)

    await waitFor(() => expect(rowsOf(comparison())).toEqual(['No counters']))
    expect(screen.getByText('The profiles shown have no counters.')).toBeInTheDocument()
  })
})
