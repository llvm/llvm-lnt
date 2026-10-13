import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { headersOf, main, query, renderPage, search, table } from '../../test/page'
import { mockClipboard } from '../../test/clipboard'
import { COMPARED, comparison, mockWorld, NOISY, runBox, showBox } from './compare-world'

/** The tests the comparison table lists, in order, without the geomean. */
const listedTests = async () => (await comparison()).slice(1).map((row) => row.split(' | ')[0])

describe('the comparison table (CP2)', () => {
  it('sorts by Delta % descending by default, N/A last, and by any column on request', async () => {
    mockWorld({
      samples: {
        '1': [
          ['a', 1],
          ['b', 2],
          ['c', 0],
        ],
        '2': [['a', 1]],
        '3': [
          ['a', 2],
          ['b', 1],
          ['c', 1],
        ],
      },
    })
    renderPage(COMPARED)

    expect((await comparison()).map((row) => row.split(' | ')[0])).toEqual([
      'Geomean',
      'a',
      'b',
      'c',
    ])
    await userEvent.setup().click(screen.getByRole('button', { name: /^Test/ }))
    expect(query().sort).toEqual(['test'])
    await userEvent.setup().click(screen.getByRole('button', { name: /^Delta %/ }))
    expect((await comparison()).map((row) => row.split(' | ')[0])).toEqual([
      'Geomean',
      'b',
      'a',
      'c',
    ])
    expect(query().sort).toEqual(['delta_pct'])
  })

  it('says how many samples and runs make each value', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    const row = screen.getAllByRole('row')[2]
    expect(within(row).getAllByText('2', { selector: '[title]' })[0]).toHaveAttribute(
      'title',
      '2 samples across 2 runs',
    )
    expect(within(row).getByText('+100.00%')).toHaveAttribute(
      'title',
      'A: 2 samples across 2 runs, B: 1 sample across 1 run',
    )
  })

  it('filters the tests by name, which the geomean and the summary follow', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    search('Filter tests', 'b')

    await waitFor(async () =>
      expect(await comparison()).toEqual([
        'Geomean | N/A | N/A | N/A | N/A | N/A | N/A',
        'b | 2 | N/A | N/A | N/A | N/A | N/A',
      ]),
    )
    expect(screen.getByText('1 of 1 matching tests shown (3 total)')).toBeInTheDocument()
    await waitFor(() => expect(query().test_filter).toEqual(['b']))
  })

  it('says when no test matches the filter', async () => {
    mockWorld()
    renderPage(`${COMPARED}&test_filter=zzz`)

    expect(await screen.findByText('No tests match the filter.')).toBeInTheDocument()
  })
})

describe('hidden tests (CP2)', () => {
  it('hides a test from the comparison, but not from the table', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(showBox('d'))

    expect(await listedTests()).toEqual(['d', 'a', 'b', 'c'])
    expect(screen.getByText('3 of 4 tests shown')).toBeInTheDocument()
    await waitFor(() => expect(query().hidden_test).toEqual(['d']))
    // The geomean is a's alone.
    expect((await comparison())[0]).toBe(
      'Geomean | 100 | 100.5 | 0.5 | +0.50% | 1.0050 | Regressed',
    )
  })

  it('hides a test with a click on its row, and leaves it hidden whatever the filter', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('cell', { name: 'd' }))
    expect(showBox('d')).not.toBeChecked()
    search('Filter tests', 'b')
    await waitFor(async () => expect(await listedTests()).toEqual(['b']))
    search('Filter tests', '')
    await waitFor(async () => expect(await listedTests()).toHaveLength(4))
    await user.click(screen.getByRole('checkbox', { name: 'Hide noise' }))
    await waitFor(async () => expect(await listedTests()).toEqual(['d', 'b', 'c']))

    expect(showBox('d')).not.toBeChecked()
    expect(query().hidden_test).toEqual(['d'])
  })

  it('hides a range of the rows as they are sorted, with Shift held', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(showBox('d'))
    await user.keyboard('{Shift>}')
    await user.click(showBox('b'))
    await user.keyboard('{/Shift}')

    await waitFor(() => expect(query().hidden_test).toEqual(['a', 'b', 'd']))
    expect(showBox('c')).toBeChecked()
  })

  it('hides or shows every row from the header', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&test_filter=a`)
    await comparison()
    const user = userEvent.setup()
    const header = screen.getByRole('checkbox', { name: 'Show all tests shown' })

    await user.click(header)
    await waitFor(() => expect(query().hidden_test).toEqual(['a']))
    expect(screen.getByText('0 of 1 matching tests shown (4 total)')).toBeInTheDocument()
    await user.click(header)
    await waitFor(() => expect(query().hidden_test).toBeUndefined())
  })

  it('shows a test alone with a double-click, and every test again with another', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.dblClick(screen.getByRole('cell', { name: 'a' }))
    await waitFor(() => expect(query().hidden_test).toEqual(['b', 'c', 'd']))
    await user.dblClick(screen.getByRole('cell', { name: 'a' }))
    await waitFor(() => expect(query().hidden_test).toBeUndefined())
  })

  it('restores the hidden tests of the URL, forgetting those the comparison does not hold', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=d&hidden_test=zzz`)
    await comparison()

    expect(showBox('d')).not.toBeChecked()
    await waitFor(() => expect(query().hidden_test).toEqual(['d']))
  })

  it('keeps the hidden tests while a side has no run selected', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=b`)
    await comparison()
    const user = userEvent.setup()

    // Run 2 first: run 1 alone still has b, which run 2 alone would not, and forget.
    await user.click(runBox('2', 'A'))
    await user.click(runBox('1', 'A'))
    expect(await main().findByText('Select a run for side A.')).toBeInTheDocument()
    await user.click(runBox('1', 'A'))

    await comparison()
    expect(showBox('b')).not.toBeChecked()
    expect(query().hidden_test).toEqual(['b'])
  })

  it('offers nothing to copy when every row is hidden', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Show all tests shown' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Copy as CSV' })).not.toBeInTheDocument(),
    )
  })

  it('says when there are too many hidden tests for the URL', async () => {
    const tests = Array.from({ length: 12 }, (_, i): [string, number] => [`t${i}`, i + 1])
    mockWorld({ samples: { '1': tests, '2': tests, '3': tests } })
    renderPage(COMPARED)
    await comparison()

    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Show all tests shown' }))

    expect(await screen.findByText('(too many hidden to reflect in the URL)')).toBeInTheDocument()
    expect(query().hidden_test).toBeUndefined()
  })
})

describe('optional columns (CP2)', () => {
  it('adds the columns of a statistic from the Columns menu, which stays open', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Mean' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Samples' }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
    await waitFor(() => expect(query().columns).toEqual(['samples', 'mean']))
    await user.keyboard('{Escape}')
    expect(headersOf(await table('Comparison')).slice(1)).toEqual([
      'Test',
      'Value A',
      'Value B',
      'Delta',
      // Sorted by it, descending.
      'Delta %▼',
      'Ratio',
      'Samples A',
      'Samples B',
      'Mean A',
      'Mean B',
      'Status',
    ])
  })

  it("shows each side's statistics, empty on the geomean and N/A without samples", async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&columns=mean&columns=pvalue`)

    const rows = await comparison()
    // The geomean's statistics are empty.
    expect(rows[0].split(' | ').slice(6)).toEqual(['', '', '', '', '', 'Regressed'])
    expect(rows.find((row) => row.startsWith('b |'))).toBe(
      'b | 2 | N/A | N/A | N/A | N/A | 1 | 0 | 2 | N/A | N/A | N/A',
    )
    expect(rows.find((row) => row.startsWith('d |'))).toBe(
      'd | 2 | 3 | 1 | +50.00% | 1.5000 | 2 | 1 | 2 | 3 | N/A | Regressed',
    )
  })

  it('sorts by a statistic, back to the default sort once its column is hidden', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=mean&sort=-mean_a`)
    expect(await listedTests()).toEqual(['a', 'b', 'd', 'c'])
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Mean' }))
    await user.keyboard('{Escape}')

    await waitFor(() => expect(query().sort).toBeUndefined())
    expect(await listedTests()).toEqual(['d', 'a', 'b', 'c'])
  })

  it('shows the p-value whether or not its knob is enabled, 0 for a deterministic change', async () => {
    const tight = (base: number) =>
      [0, 1, 2, 1, 0].map((i): [string, number] => ['b', base + i / 100])
    mockWorld({
      samples: {
        '1': [['a', 2], ['a', 2], ...tight(1)],
        '2': [],
        '3': [['a', 3], ['a', 3], ...tight(2)],
      },
    })
    renderPage(`${COMPARED}&columns=pvalue`)

    const rows = await comparison()
    expect(
      rows
        .find((row) => row.startsWith('a |'))
        ?.split(' | ')
        .at(-2),
    ).toBe('0')
    // A tiny p-value, in exponent notation.
    expect(
      rows
        .find((row) => row.startsWith('b |'))
        ?.split(' | ')
        .at(-2),
    ).toMatch(/^\d\.\d\de-\d+$/)
  })

  it('sorts by a statistic from its header, and keeps the sort when another column goes', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&columns=mean`)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /^Mean B/ }))
    await waitFor(() => expect(query().sort).toEqual(['mean_b']))
    expect(await listedTests()).toEqual(['d', 'c', 'a', 'b'])

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Samples' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(query().columns).toEqual(['mean']))
    expect(query().sort).toEqual(['mean_b'])
  })

  it('is used from the keyboard, finding a statistic by its name', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    screen.getByRole('button', { name: 'Columns' }).focus()
    await user.keyboard('{Enter}')
    // Typing moves to the statistic whose name starts with what is typed. A space would be taken as
    // more of it, so Enter toggles it.
    await user.keyboard('st')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(query().columns).toEqual(['stddev']))
  })

  it('drops a sort by a column that is not shown', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&sort=mean_a`)
    await comparison()

    await waitFor(() => expect(query().sort).toBeUndefined())
  })

  it('copies the statistics shown as CSV', async () => {
    const writeText = mockClipboard()
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&hidden_test=a&hidden_test=b&hidden_test=c`)
    await comparison()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const [header, geomean, ...lines] = writeText.mock.calls[0][0].split('\r\n')
    expect(header).toBe('Test,Value A,Value B,Delta,Delta %,Ratio,Samples A,Samples B,Status')
    // Empty statistics on the geomean, whose values are d's, at full precision.
    expect(geomean).toMatch(/^Geomean,2,[\d.]+,[\d.]+,[\d.]+,[\d.]+,,,Regressed$/)
    expect(lines).toEqual(['d,2,3,1,50,1.5,2,1,Regressed'])
  })
})

describe('Copy as CSV (CP2)', () => {
  it('copies the compared rows, in the order they are sorted in, with the geomean first', async () => {
    const writeText = mockClipboard()
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=b`)
    await comparison()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const [header, geomean, ...lines] = writeText.mock.calls[0][0].split('\r\n')
    expect(header).toBe('Test,Value A,Value B,Delta,Delta %,Ratio,Status')
    // At full precision: the geomeans of 2 and 100, and of 3 and 100.5.
    expect(geomean).toMatch(
      /^Geomean,14\.14213562373095\d*,17\.3637553541853\d*,[\d.]+,[\d.]+,[\d.]+,Regressed$/,
    )
    expect(lines).toEqual([
      'd,2,3,1,50,1.5,Regressed',
      'a,100,100.5,0.5,0.5,1.005,Regressed',
      'c,,5,,,,',
    ])
  })
})
