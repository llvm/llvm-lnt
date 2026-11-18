import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { currentUrl, query, renderPage } from '../../test/page'
import { pickOption } from '../../test/select'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import {
  CLASSIFIED,
  COMPARED,
  comparison,
  listedTests,
  mockWorld,
  NOISY,
  showBox,
  statusOf,
} from './compare-world'

// The page renders its chart, which Plotly cannot draw in jsdom (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/** The summary bar's text, a category per item. */
const summary = () =>
  within(screen.getByRole('list', { name: 'Summary' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent)

/** The tooltip of `test`'s status. */
const statusTitle = (test: string) =>
  within(screen.getByRole('row', { name: new RegExp(`^Show ${test} `) }))
    .getByText(/^(Improved|Regressed|Unchanged|Inconclusive)$/)
    .getAttribute('title')

describe('the classification (CP1, CP2)', () => {
  it("classifies each test from the confidence interval of its runs' values", async () => {
    mockWorld(CLASSIFIED)
    renderPage(COMPARED)

    expect(await comparison()).toEqual([
      'Geomean | 20.59 | 23.22 | 2.627 | +12.76% | 1.1276 | Regressed',
      'neg | 0.5 | 1 | 0.5 | +100.00% | 2.0000 | Inconclusive',
      'up | 101 | 151 | 50 | +49.50% | 1.4950 | Regressed',
      'wild | 150 | 205 | 55 | +36.67% | 1.3667 | Inconclusive',
      'one | 10 | 10.05 | 0.05 | +0.50% | 1.0050 | Inconclusive',
      'flat | 100.1 | 100.2 | 0.1 | +0.10% | 1.0010 | Unchanged',
      'down | 10.05 | 5.025 | -5.025 | -50.00% | 0.5000 | Improved',
      'only | 1 | N/A | N/A | N/A | N/A | N/A',
    ])
  })

  it('says on hover what the status says of the change, or why it has no interval', async () => {
    mockWorld(CLASSIFIED)
    renderPage(COMPARED)
    await comparison()

    expect(statusTitle('up')).toMatch(/^90% CI: \+49\.51% \[\+43\.86%, \+55\.38%\], beyond the margin$/)
    expect(statusTitle('flat')).toMatch(/^90% CI: \+0\.10% \[.*\], within the margin$/)
    expect(statusTitle('wild')).toMatch(/^90% CI: .*, straddles an edge of the margin$/)
    expect(statusTitle('one')).toBe(
      'Only 1 run on side A: a CI needs at least 2 runs on each side',
    )
    expect(statusTitle('neg')).toBe("A run's value is 0 or negative: the change has no CI")
    // Neither the geomean's nor an N/A one says anything.
    expect(screen.getAllByText(/^(Regressed|N\/A)$/, { selector: '[title]' })).toHaveLength(1)
  })

  it('classifies every test as inconclusive with a single run on a side', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)

    expect(await statusOf('d')).toBe('Inconclusive')
    expect(statusTitle('d')).toBe('Only 1 run on side B: a CI needs at least 2 runs on each side')
  })

  it('reclassifies the tests as the margin is typed, once typing pauses', async () => {
    mockWorld(CLASSIFIED)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    const margin = screen.getByRole('textbox', { name: 'Margin' })
    expect(margin).toHaveValue('5')

    await user.clear(margin)
    await user.type(margin, '60')
    // Not yet: neither 6 on the way, nor 60.
    expect(query().margin).toBeUndefined()
    await waitFor(() => expect(query().margin).toEqual(['60']))
    await waitFor(async () => expect(await statusOf('up')).toBe('Unchanged'))
    expect(await statusOf('down')).toBe('Improved')
  })

  it('keeps the last valid margin while the text is not one, an empty one included', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&margin=0`)
    await comparison()
    const user = userEvent.setup()
    const margin = screen.getByRole('textbox', { name: 'Margin' })

    for (const text of ['-1', 'abc', '']) {
      await user.clear(margin)
      if (text !== '') await user.type(margin, text)
      expect(margin).toHaveAttribute('aria-invalid', 'true')
    }
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().margin).toEqual(['0'])
    // With a margin of 0, only an exact equality is unchanged.
    expect(await statusOf('flat')).toBe('Inconclusive')
  })

  it('reclassifies the tests at the confidence picked', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&margin=40`)
    expect(await statusOf('up')).toBe('Regressed')

    await pickOption('Confidence', '99%')

    await waitFor(() => expect(query().confidence).toEqual(['99']))
    await waitFor(async () => expect(await statusOf('up')).toBe('Inconclusive'))
    expect(statusTitle('up')).toMatch(/^99% CI: /)
  })

  it('falls back on the default margin and confidence for values it does not accept', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&margin=-1&confidence=85`)
    await comparison()

    await waitFor(() => expect(query().margin).toBeUndefined())
    expect(query().confidence).toBeUndefined()
    expect(screen.getByRole('textbox', { name: 'Margin' })).toHaveValue('5')
    expect(statusTitle('up')).toMatch(/^90% CI: /)
  })

  it("loads a link with the old noise settings, ignoring them and leaving them as they are", async () => {
    mockWorld(CLASSIFIED)
    const old = '&noise_pct=50&noise_pval=0.01&noise_floor=1000&hide_noise=true'
    renderPage(`${COMPARED}${old}`)

    expect(await listedTests()).toEqual(['neg', 'up', 'wild', 'one', 'flat', 'down', 'only'])
    expect(await statusOf('flat')).toBe('Unchanged')
    expect(currentUrl()).toContain(old)
  })
})

describe('Hide unchanged and Hide inconclusive (CP1)', () => {
  it('hides those rows from the table, but neither from the summary bar nor the count', async () => {
    mockWorld(CLASSIFIED)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('checkbox', { name: 'Hide unchanged' }))
    await waitFor(() => expect(query().hide_unchanged).toEqual(['true']))
    await waitFor(async () => expect(await listedTests()).not.toContain('flat'))
    await user.click(screen.getByRole('checkbox', { name: 'Hide inconclusive' }))
    await waitFor(() => expect(query().hide_inconclusive).toEqual(['true']))

    await waitFor(async () => expect(await listedTests()).toEqual(['up', 'down', 'only']))
    expect(screen.getByText('3 of 3 tests shown')).toBeInTheDocument()
    expect(summary()).toEqual([
      'Improved 1 (16.7%)',
      'Regressed 1 (16.7%)',
      'Unchanged 1 (16.7%)',
      'Inconclusive 3 (50%)',
      'Only in A 1',
      'Only in B 0',
      'Zero baseline 0',
    ])
  })

  it('says which of them leaves no row', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&test_filter=flat&hide_unchanged=true`)
    expect(await screen.findByText('Every matching test is unchanged.')).toBeInTheDocument()
  })

  it('says so when both leave no row', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&test_filter=a&hide_unchanged=true&hide_inconclusive=true`)
    expect(
      await screen.findByText('Every matching test is unchanged or inconclusive.'),
    ).toBeInTheDocument()
  })
})

describe('the filters (CP1)', () => {
  const open = () => userEvent.setup().click(screen.getByRole('button', { name: /^Filters/ }))

  it('narrow the rows, the count and the summary bar, passing the tests that cannot be compared', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&min_delta_pct=40`)

    // Neither flat nor one changes by 40%: only those that can be compared are filtered.
    expect(await listedTests()).toEqual(['neg', 'up', 'down', 'only'])
    expect(screen.getByText('4 of 4 matching tests shown · 7 tests in total')).toBeInTheDocument()
    expect(summary()).toEqual([
      'Improved 1 (33.3%)',
      'Regressed 1 (33.3%)',
      'Unchanged 0 (0%)',
      'Inconclusive 1 (33.3%)',
      'Only in A 1',
      'Only in B 0',
      'Zero baseline 0',
    ])
    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveTextContent('Filters (1)')
  })

  it('leave out the tests without a p-value from P-value at most', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&max_pvalue=1`)

    expect(await listedTests()).toEqual(['up', 'wild', 'flat', 'down', 'only'])
  })

  it('apply Absolute at least to the larger absolute value, the threshold included', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&min_abs=151`)

    expect(await listedTests()).toEqual(['up', 'wild', 'only'])
  })

  it('leave the hidden tests as they are, and the header and a double-click alone', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&min_delta_pct=40&hide_inconclusive=true`)
    expect(await listedTests()).toEqual(['up', 'down', 'only'])
    const user = userEvent.setup()

    await user.click(screen.getByRole('checkbox', { name: 'Show all tests shown' }))
    await waitFor(() => expect(query().hidden_test).toEqual(['down', 'only', 'up']))
    await user.dblClick(screen.getByRole('cell', { name: 'up' }))
    await waitFor(() => expect(query().hidden_test).toEqual(['down', 'only']))
    expect(showBox('up')).toBeChecked()
  })

  it('say when they leave none of the rows the test filter keeps', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&min_abs=1000&test_filter=^(up|down)$&test_filter_regex=true`)
    expect(await screen.findByText('No matching test passes the filters.')).toBeInTheDocument()
    expect(screen.getByText('0 of 0 matching tests shown · 7 tests in total')).toBeInTheDocument()
  })

  it('say when they leave no row, without a test filter', async () => {
    mockWorld({ samples: { '1': [['a', 1]], '2': [['a', 1]], '3': [['a', 2]] } })
    renderPage(`${COMPARED}&min_abs=1000`)
    expect(await screen.findByText('No test passes the filters.')).toBeInTheDocument()
  })

  it('leave the test filter to say when it keeps no row', async () => {
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&min_abs=1000&test_filter=nothing`)
    expect(await screen.findByText('No tests match the filter.')).toBeInTheDocument()
  })

  it('enable a filter with its value, and apply a value typed once typing pauses', async () => {
    mockWorld(CLASSIFIED)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    const close = () => user.keyboard('{Escape}')

    await open()
    await user.click(screen.getByRole('checkbox', { name: '|Delta %| at least' }))
    await waitFor(() => expect(query().min_delta_pct).toEqual(['1']))
    await close()
    await waitFor(async () => expect(await listedTests()).not.toContain('flat'))

    await open()
    const threshold = screen.getByRole('textbox', { name: '|Delta %| at least threshold' })
    await user.clear(threshold)
    await user.type(threshold, '45')
    // Once typing pauses.
    await waitFor(() => expect(query().min_delta_pct).toEqual(['45']))
    await close()
    await waitFor(async () => expect(await listedTests()).toEqual(['neg', 'up', 'down', 'only']))

    await open()
    await user.click(screen.getByRole('checkbox', { name: '|Delta %| at least' }))
    await waitFor(() => expect(query().min_delta_pct).toBeUndefined())
    await close()
    await waitFor(async () => expect(await listedTests()).toHaveLength(7))
  })

  it('apply a value typed as the panel closes, before typing pauses', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&min_delta_pct=1`)
    await comparison()
    const user = userEvent.setup()
    await open()

    const threshold = screen.getByRole('textbox', { name: '|Delta %| at least threshold' })
    await user.clear(threshold)
    await user.type(threshold, '60')
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Filters' })).not.toBeInTheDocument()
    expect(query().min_delta_pct).toEqual(['60'])
    // And the panel opens again on the value applied.
    await open()
    expect(screen.getByRole('textbox', { name: '|Delta %| at least threshold' })).toHaveValue('60')
  })

  it('apply only the value typed once typing pauses, and none once disabled meanwhile', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&min_delta_pct=1`)
    await comparison()
    const user = userEvent.setup()
    await open()
    const threshold = screen.getByRole('textbox', { name: '|Delta %| at least threshold' })

    await user.clear(threshold)
    await user.type(threshold, '60')
    // Not yet: neither 6 on the way, nor 60.
    expect(query().min_delta_pct).toEqual(['1'])
    await user.click(screen.getByRole('checkbox', { name: '|Delta %| at least' }))
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().min_delta_pct).toBeUndefined()

    // Enabled again, with the value typed.
    await user.click(screen.getByRole('checkbox', { name: '|Delta %| at least' }))
    expect(query().min_delta_pct).toEqual(['60'])
  })

  it("disable a filter's value while the filter is disabled", async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    await open()
    const threshold = screen.getByRole('textbox', { name: '|Delta %| at least threshold' })
    const filter = screen.getByRole('checkbox', { name: '|Delta %| at least' })

    for (const name of ['|Delta %| at least', 'P-value at most', 'Absolute at least'])
      expect(screen.getByRole('textbox', { name: `${name} threshold` })).toBeDisabled()
    await user.click(filter)
    expect(threshold).toBeEnabled()
    expect(query().min_delta_pct).toEqual(['1'])

    // Disabled with text that is not a value: nothing is applied, and the text stays as it is.
    await user.clear(threshold)
    await user.type(threshold, 'abc')
    await user.click(filter)
    expect(query().min_delta_pct).toBeUndefined()
    expect(threshold).toBeDisabled()
    expect(threshold).toHaveValue('abc')
    expect(threshold).toHaveAttribute('aria-invalid', 'true')

    // Enabled again, with the last valid value.
    await user.click(filter)
    expect(threshold).toBeEnabled()
    expect(query().min_delta_pct).toEqual(['1'])
  })

  it("keep a disabled filter's value as the panel closes", async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    const threshold = () => screen.getByRole('textbox', { name: '|Delta %| at least threshold' })
    const filter = () => screen.getByRole('checkbox', { name: '|Delta %| at least' })

    // Disabled before typing pauses, so that only closing the panel can keep 60.
    await open()
    await user.click(filter())
    await user.clear(threshold())
    await user.type(threshold(), '60')
    await user.click(filter())
    await user.keyboard('{Escape}')
    expect(query().min_delta_pct).toBeUndefined()

    await open()
    expect(threshold()).toBeDisabled()
    expect(threshold()).toHaveValue('60')
    await user.click(filter())
    expect(query().min_delta_pct).toEqual(['60'])
  })

  it('start collapsed', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    expect(screen.getByRole('button', { name: /^Filters/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('checkbox', { name: '|Delta %| at least' })).not.toBeInTheDocument()
  })

  it('keep applying the last valid value while the text is not one', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&max_pvalue=0.05`)
    await comparison()
    const user = userEvent.setup()
    await open()

    const threshold = screen.getByRole('textbox', { name: 'P-value at most threshold' })
    await user.clear(threshold)
    await user.type(threshold, '2')

    expect(threshold).toHaveAttribute('aria-invalid', 'true')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().max_pvalue).toEqual(['0.05'])
  })

  it('leave a filter disabled when the URL gives it a value it does not accept', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&max_pvalue=2&min_abs=abc&min_delta_pct=-1`)
    await comparison()

    await waitFor(() => expect(query().max_pvalue).toBeUndefined())
    expect(query().min_abs).toBeUndefined()
    expect(query().min_delta_pct).toBeUndefined()
    await open()
    const threshold = screen.getByRole('textbox', { name: 'P-value at most threshold' })
    expect(threshold).toBeDisabled()
    expect(threshold).toHaveValue('0.05')
  })
})
