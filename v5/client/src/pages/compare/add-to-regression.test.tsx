import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { entry, signIn } from '../../test/auth'
import { cursorPage, regression, regressionDetail, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { mockCreateRegression, mockRegressions, renderPage } from '../../test/page'
import { pick, pickOption } from '../../test/select'
import { server } from '../../test/server'
import { COMPARED, comparison, mockWorld, sideOf, SUITES } from './compare-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

// So that the test of the batch limit need not compare ten thousand tests.
vi.mock('../../api/regressions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/regressions')>()),
  INDICATOR_BATCH: 2,
}))

type IndicatorObject = Schemas['IndicatorObject']

/** An indicator of COMPARED's side B: m1, for the metric compared. */
const indicator = (test: string): IndicatorObject => ({
  machine: 'm1',
  test,
  metric: 'execution_time',
})

/** The regressions of side B's suite, the newest first. */
const REGRESSIONS = [regression('e', { title: 'Older' }), regression('f', { title: null })]

/** Answer `POST regressions/{uuid}/indicators` with `added`, recording each request. */
function mockAdd(added: number) {
  const requests: { uuid: string; indicators: IndicatorObject[] }[] = []
  server.use(
    mockApi(
      'post',
      '/api/projects/{project}/suites/{suite}/regressions/{uuid}/indicators',
      async ({ request, params }) => {
        const { indicators } = await request.json()
        requests.push({ uuid: params.uuid, indicators })
        return HttpResponse.json({ added, indicators: [] })
      },
    ),
  )
  return requests
}

const toggle = () => screen.getByRole('button', { name: 'Add to regression' })

/**
 * Render `url` signed in for triage, and open the panel once the comparison shows. Returns the
 * queries the picker sent for REGRESSIONS.
 */
async function openPanel(url = COMPARED) {
  const queries = mockRegressions(() => cursorPage(REGRESSIONS))
  signIn('triage')
  renderPage(url)
  await comparison()
  await waitFor(() => expect(toggle()).toBeEnabled())
  await userEvent.setup().click(toggle())
  return queries
}

const createForm = () => screen.getByRole('form', { name: 'Create new regression' })
const addForm = () => screen.getByRole('form', { name: 'Add to existing' })

describe('Add to Regression (CP9)', () => {
  it('is disabled without the triage scope', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAttribute('title', expect.stringMatching(/triage/))
  })

  it("needs the triage scope in side B's suite, whatever side A's", async () => {
    mockWorld()
    // Side A in other, side B in libcxx.
    const url = COMPARED.replace('suite_a=libcxx', 'suite_a=other')
    signIn('triage', [entry('libcxx')])
    const { unmount } = renderPage(url)
    await comparison()
    await waitFor(() => expect(toggle()).toBeEnabled())
    unmount()

    signIn('triage', [entry('other')])
    renderPage(url)
    await comparison()
    await waitFor(() =>
      expect(toggle()).toHaveAttribute(
        'title',
        "Needs an API token with the 'triage' scope in suite 'llvm/libcxx'. The token in " +
          "Settings has the 'triage' scope only in suite 'llvm/other'.",
      ),
    )
    expect(toggle()).toBeDisabled()
  })

  it('says when there is no comparison yet', async () => {
    mockWorld()
    signIn('triage')
    renderPage(COMPARED.replace('&metric=execution_time', ''))
    await waitFor(() => expect(toggle()).toHaveAttribute('title', 'There is no comparison yet.'))
    expect(toggle()).toBeDisabled()
  })

  it('says what the indicators are, and the commit a new regression is attributed to', async () => {
    mockWorld()
    await openPanel()

    // a and c have a value on side B, and b has none.
    const targets = screen.getByText('Covers:').closest('dl')!
    expect([...targets.children].map((row) => row.textContent)).toEqual([
      'Covers:2 selected tests',
      'Test Suite:llvm/libcxx',
      'Metric:Execution Time',
      'Machine:m1',
      'Commit:c2',
    ])
    expect(
      screen.getByText('1 test compared has no value on side B, and is left out.'),
    ).toBeInTheDocument()
  })

  it("names side B's suite by its label (AR22)", async () => {
    const [libcxx, ...others] = SUITES
    mockWorld({ suites: [{ ...libcxx, display_name: 'Microbenchmarks' }, ...others] })
    await openPanel()

    expect(screen.getByText('Test Suite:').closest('div')).toHaveTextContent(
      'Test Suite:llvm/Microbenchmarks',
    )
  })

  it("creates a regression of side B's commit, with the compared tests B has a value for", async () => {
    mockWorld()
    const requests = mockCreateRegression(regressionDetail('d', { title: 'Slow' }))
    // Test a is hidden, and b has no value on side B: only c makes an indicator.
    await openPanel(`${COMPARED}&hidden_test=a`)
    const user = userEvent.setup()
    await user.type(within(createForm()).getByLabelText('Title'), ' Slow ')
    await user.click(within(createForm()).getByRole('button', { name: 'Create regression' }))

    const status = await screen.findByText(/Regression created:/)
    expect(requests).toEqual([
      {
        project: 'llvm',
        suite: 'libcxx',
        body: { title: 'Slow', commit: 'c2', indicators: [indicator('c')] },
      },
    ])
    expect(within(status).getByRole('link', { name: 'Slow' })).toHaveAttribute(
      'href',
      `/projects/llvm/suites/libcxx/regressions/${uuidOf('d')}`,
    )
    expect(screen.queryByRole('form', { name: 'Create new regression' })).not.toBeInTheDocument()

    // Opening the panel again forgets the message, and the title.
    await user.click(toggle())
    expect(screen.queryByText(/Regression created:/)).not.toBeInTheDocument()
    expect(within(createForm()).getByLabelText('Title')).toHaveValue('')
  })

  it('makes indicators of the rows the table compares, on side B as the sides are now', async () => {
    // Run 3 is m1's at c2, and run 4 m2's: c is noise, and e is on run 3 only.
    mockWorld({
      samples: {
        '3': [
          ['a', 4],
          ['c', 5.01],
          ['d', 2],
          ['e', 7],
        ],
        '4': [
          ['a', 1],
          ['c', 5],
          ['d', 1],
        ],
      },
    })
    const requests = mockCreateRegression(regressionDetail('d', { title: 'Slow' }))
    mockRegressions(() => cursorPage(REGRESSIONS))
    // The filter leaves out d, "Hide noise" c, and a is hidden: once swapped, side B is other's m1
    // at c2, and only e makes an indicator.
    const query = new URLSearchParams({
      project_a: 'llvm',
      suite_a: 'other',
      machine_a: 'm1',
      commit_a: 'c2',
      project_b: 'llvm',
      suite_b: 'libcxx',
      machine_b: 'm2',
      commit_b: 'c2',
      metric: 'execution_time',
      noise_pct: '1',
      hide_noise: 'true',
      hidden_test: 'a',
      test_filter: '^[ace]$',
      test_filter_regex: 'true',
    })
    signIn('triage')
    renderPage(`/compare?${query}`)
    await comparison()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(toggle()).toBeEnabled())
    await user.click(toggle())
    await user.click(within(createForm()).getByRole('button', { name: 'Create regression' }))

    await screen.findByText(/Regression created:/)
    expect(requests).toEqual([
      {
        project: 'llvm',
        suite: 'other',
        body: { title: null, commit: 'c2', indicators: [indicator('e')] },
      },
    ])
  })

  it('offers the regression created when the panel is opened again', async () => {
    mockWorld()
    await openPanel()
    const regressions = [...REGRESSIONS]
    mockRegressions(() => cursorPage(regressions))
    const created = regressionDetail('d', { title: 'Slow' })
    mockCreateRegression(created)
    const user = userEvent.setup()
    await user.click(within(createForm()).getByRole('button', { name: 'Create regression' }))
    await screen.findByText(/Regression created:/)
    regressions.unshift(regression('d', { title: 'Slow' }))

    await user.click(toggle())
    await user.click(within(addForm()).getByRole('button', { name: /Show suggestions/ }))
    expect(await screen.findByRole('option', { name: 'Slow' })).toBeInTheDocument()
  })

  it('cannot be closed while a request is under way, and gives the focus back', async () => {
    mockWorld()
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    await openPanel()
    server.use(
      mockApi('post', '/api/projects/{project}/suites/{suite}/regressions', async () => {
        await held
        return HttpResponse.json(regressionDetail('d'), { status: 201 })
      }),
    )
    await userEvent
      .setup()
      .click(within(createForm()).getByRole('button', { name: 'Create regression' }))

    await waitFor(() => expect(toggle()).toBeDisabled())
    release()
    await screen.findByText(/Regression created:/)
    expect(toggle()).toHaveFocus()
  })

  it('creates an untitled regression, linked by its short UUID', async () => {
    mockWorld()
    const requests = mockCreateRegression(regressionDetail('d', { title: null }))
    await openPanel()
    await userEvent
      .setup()
      .click(within(createForm()).getByRole('button', { name: 'Create regression' }))

    const status = await screen.findByText(/Regression created:/)
    expect(requests[0].body).toEqual({
      title: null,
      commit: 'c2',
      indicators: [indicator('a'), indicator('c')],
    })
    expect(within(status).getByRole('link')).toHaveTextContent(/^dddddddd…$/)
  })

  it('adds the indicators to a regression picked, saying how many already existed', async () => {
    mockWorld()
    const requests = mockAdd(1)
    const queries = await openPanel()

    // An untitled regression is offered by its short UUID.
    const picker = within(addForm()).getByRole('combobox', { name: 'Regression' })
    await userEvent.setup().type(picker, 'u')
    expect(await screen.findByRole('option', { name: '(untitled) ffffffff…' })).toBeVisible()
    await pick('Regression', 'Older')
    await userEvent.setup().click(within(addForm()).getByRole('button', { name: 'Add indicators' }))

    const status = await screen.findByText(/Added 1 indicator to/)
    expect(status).toHaveTextContent('Added 1 indicator to Older. 1 indicator already existed.')
    expect(requests).toEqual([{ uuid: uuidOf('e'), indicators: [indicator('a'), indicator('c')] }])
    expect(queries[0].get('sort')).toBe('-created_at')
    expect(within(status).getByRole('link', { name: 'Older' })).toHaveAttribute(
      'href',
      `/projects/llvm/suites/libcxx/regressions/${uuidOf('e')}`,
    )
  })

  it('adds nothing while the picker holds text that was not picked', async () => {
    mockWorld()
    const requests = mockAdd(2)
    await openPanel()
    const user = userEvent.setup()
    await pick('Regression', 'Older')
    await user.type(within(addForm()).getByRole('combobox', { name: 'Regression' }), 'x')

    // Hidden from the accessibility tree while the list is open, which leaves it without a name,
    // but there to be clicked.
    const add = within(addForm()).getByText('Add indicators')
    const reason = within(addForm()).getByText(
      'Pick a regression from the list, or clear the field.',
    )
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAttribute('aria-describedby', reason.id)
    await user.click(add)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests).toEqual([])
  })

  it('stays open, saying why, when the regression cannot be created', async () => {
    mockWorld()
    server.use(
      mockApi('post', '/api/projects/{project}/suites/{suite}/regressions', () =>
        errorResponse(500, 'internal_error', 'Boom'),
      ),
    )
    await openPanel()
    await userEvent
      .setup()
      .click(within(createForm()).getByRole('button', { name: 'Create regression' }))

    expect(await within(createForm()).findByRole('alert')).toHaveTextContent('Boom')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it("forgets the regression picked when side B's suite changes, or the sides are swapped", async () => {
    mockWorld()
    await openPanel()
    const user = userEvent.setup()
    const picker = () => within(addForm()).getByRole('combobox', { name: 'Regression' })

    await pick('Regression', 'Older')
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(picker()).toHaveValue(''))

    await pick('Regression', 'Older')
    await pickOption('Suite', 'llvm/other', sideOf('B'))
    await waitFor(() => expect(picker()).toHaveValue(''))
  })

  it('says why in the panel when there is nothing to add, which can still be closed', async () => {
    mockWorld()
    await openPanel()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Show all tests shown' }))

    expect(await screen.findByText('No compared test has a value on side B.')).toBeInTheDocument()
    expect(within(createForm()).getByRole('button', { name: 'Create regression' })).toBeDisabled()
    await user.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toBeDisabled()
  })

  it('is disabled when one request cannot carry every indicator', async () => {
    mockWorld({
      samples: {
        '1': [['a', 1]],
        '2': [['a', 3]],
        '3': [
          ['a', 4],
          ['c', 5],
          ['d', 6],
        ],
      },
    })
    signIn('triage')
    renderPage(COMPARED)
    await comparison()

    await waitFor(() =>
      expect(toggle()).toHaveAttribute(
        'title',
        'One request can add at most 2 indicators: hide some tests.',
      ),
    )
    expect(toggle()).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Show d' }))
    await waitFor(() => expect(toggle()).toBeEnabled())
  })
})
