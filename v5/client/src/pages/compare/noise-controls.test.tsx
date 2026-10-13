import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { query, renderPage } from '../../test/page'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { COMPARED, comparison, mockWorld, NOISY } from './compare-world'

// The page renders its chart, which Plotly cannot draw in jsdom (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

const statusOf = async (test: string) =>
  (await comparison())
    .find((row) => row.startsWith(`${test} |`))
    ?.split(' | ')
    .at(-1)

describe('noise (CP1)', () => {
  it('classifies as noise the tests a knob catches, saying why on hover', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)

    expect(await statusOf('a')).toBe('Noise')
    expect(await statusOf('d')).toBe('Regressed')
    expect(screen.getByText('Noise', { selector: '[title]' })).toHaveAttribute(
      'title',
      'Delta 0.5% below 1% threshold',
    )
  })

  it('enables a knob with its value, and applies a value typed once typing pauses', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Noise filtering/ }))
    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    await waitFor(() => expect(query().noise_pct).toEqual(['1']))
    await waitFor(async () => expect(await statusOf('a')).toBe('Noise'))

    const threshold = screen.getByRole('textbox', { name: 'Delta % below threshold' })
    await user.clear(threshold)
    await user.type(threshold, '60')
    // Once typing pauses.
    await waitFor(() => expect(query().noise_pct).toEqual(['60']), { timeout: 2000 })
    await waitFor(async () => expect(await statusOf('d')).toBe('Noise'))

    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    await waitFor(() => expect(query().noise_pct).toBeUndefined())
    await waitFor(async () => expect(await statusOf('d')).toBe('Regressed'))
  })

  it('applies only the value typed once typing pauses, and none once disabled meanwhile', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)
    await comparison()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Noise filtering/ }))
    const threshold = screen.getByRole('textbox', { name: 'Delta % below threshold' })

    await user.clear(threshold)
    await user.type(threshold, '60')
    // Not yet: neither 6 on the way, nor 60.
    expect(query().noise_pct).toEqual(['1'])
    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().noise_pct).toBeUndefined()

    // Enabled again, with the value typed.
    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    expect(query().noise_pct).toEqual(['60'])
  })

  it('starts collapsed, and hides the noise on request', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)
    await comparison()
    const user = userEvent.setup()

    expect(screen.getByRole('button', { name: /Noise filtering/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('checkbox', { name: 'Delta % below' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Hide noise' }))

    expect(query().hide_noise).toEqual(['true'])
    await waitFor(async () => expect(await statusOf('a')).toBeUndefined())
  })

  it('lists every knob that classified a test as noise', async () => {
    mockWorld({
      samples: {
        '1': [
          ['a', 1],
          ['a', 2],
        ],
        '2': [['a', 1]],
        '3': [
          ['a', 1.004],
          ['a', 2],
        ],
      },
    })
    renderPage(`${COMPARED}&noise_pct=50&noise_pval=0.05&noise_floor=10`)

    expect(await statusOf('a')).toBe('Noise')
    expect(screen.getByText('Noise', { selector: '[title]' }).getAttribute('title')).toMatch(
      /^Delta .*% below 50% threshold\np-value .* above 0.05\nmax\(\|A\|, \|B\|\) = .* below floor of 10$/,
    )
  })

  it('keeps applying the last valid value while the text is not one', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pval=0.05`)
    await comparison()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Noise filtering/ }))

    const threshold = screen.getByRole('textbox', { name: 'P-value above threshold' })
    await user.clear(threshold)
    await user.type(threshold, '2')

    expect(threshold).toHaveAttribute('aria-invalid', 'true')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().noise_pval).toEqual(['0.05'])
  })

  it('leaves a knob disabled when the URL gives it a value it does not accept', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pval=2&noise_floor=abc`)
    await comparison()

    await waitFor(() => expect(query().noise_pval).toBeUndefined())
    expect(query().noise_floor).toBeUndefined()
  })

  it('hides the noise from the table, but not from the summary bar', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1&hide_noise=true`)

    expect((await comparison()).map((row) => row.split(' | ')[0])).toEqual([
      'Geomean',
      'd',
      'b',
      'c',
    ])
    expect(screen.getByText('3 of 3 tests shown')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Summary' })).toHaveTextContent('Noise 1 (50%)')
  })

  it('says when every matching test is classified as noise', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1&hide_noise=true&test_filter=a`)

    expect(
      await screen.findByText('Every matching test is classified as noise.'),
    ).toBeInTheDocument()
  })
})
