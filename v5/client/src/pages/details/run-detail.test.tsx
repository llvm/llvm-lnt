import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import { signIn, TOKEN } from '../../test/auth'
import { SUITE, commit, cursorPage, machine, runDetail, sample, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  infoRows,
  main,
  mockMachines,
  mockRegressions,
  mockResolve,
  mockRuns,
  mockSuites,
  queryOf,
  recording,
  renderPage,
  rowsOf,
  search,
  table,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'

const UUID = uuidOf('a')
const PAGE = `/suites/libcxx/runs/${UUID}`
const RUN = runDetail('a', { machine: 'linux-x86_64', commit: 'abc123' })
/** The run's commit, which has an ordinal, and so may have a commit before it. */
const ORDERED = commit('abc123', {
  ordinal: 100,
  tag: 'v1',
  fields: { svn_revision: 'r100', commit_info: null },
})
const PREVIOUS = commit('prev99', { ordinal: 99 })

/** A suite whose first metric is not numeric, so that the default is the second. */
const MIXED: SuiteSchema = {
  ...SUITE,
  metrics: [
    { ...SUITE.metrics[0], name: 'status', type: 'text', display_name: 'Status' },
    SUITE.metrics[0],
    { ...SUITE.metrics[0], name: 'size', type: 'integer', display_name: 'Code Size' },
  ],
}

type Respond = (query: URLSearchParams) => Response | Promise<Response>

interface Options {
  url?: string
  suite?: SuiteSchema
  run?: () => Response | Promise<Response>
  /** The run's commit, as `commits/resolve` knows it: null if it no longer exists. */
  commit?: Schemas['Commit'] | null
  /** The answer to the lookup of the commit before the run's on its machine. */
  previous?: Respond
  /** The answer to each request for samples; by default, `samples` on one page. */
  samplePages?: (query: URLSearchParams, request: Request) => Response | Promise<Response>
  samples?: Schemas['Sample'][]
  /** The answer to the list of the run's profiles; by default, none. */
  profiles?: () => Response
}

/** The run's profiles list, naming `tests`. */
function profilesOf(...tests: string[]) {
  return () =>
    HttpResponse.json({ items: tests.map((test, i) => ({ test, uuid: uuidOf(String(i)) })) })
}

/**
 * The page at `url`, `RUN`'s by default, with what it reads mocked. Returns the queries of the
 * previous commit's lookup and of the samples.
 */
function renderRun({
  url = PAGE,
  suite = SUITE,
  run = () => HttpResponse.json(RUN),
  commit = ORDERED,
  previous = () => HttpResponse.json(cursorPage([PREVIOUS])),
  samples = [],
  samplePages = () => HttpResponse.json(cursorPage(samples)),
  profiles = profilesOf(),
}: Options = {}) {
  const lookups = recording(previous)
  const sampleQueries: URLSearchParams[] = []
  mockSuites([suite])
  mockResolve(commit ? [commit] : [])
  server.use(
    mockApi('get', '/api/suites/{testsuite}/runs/{uuid}', () => run()),
    mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => lookups.answer(request)),
    mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/samples', ({ request }) => {
      const query = new URL(request.url).searchParams
      sampleQueries.push(query)
      return samplePages(query, request)
    }),
    mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/profiles', () => profiles()),
  )
  renderPage(url)
  return { lookups: lookups.queries, sampleQueries }
}

/** The test names of the rows of `table`. */
function testsOf(table: HTMLElement) {
  return rowsOf(table).map((row) => row.split(' | ')[0])
}

describe('the Run Detail page', () => {
  it('shows the run, its commit by display value, and its parameters by key', async () => {
    renderRun({
      run: () =>
        HttpResponse.json({
          ...RUN,
          run_parameters: { start_time: '2026-08-14T01:57:57', build: { opt: 'O3' }, jobs: 8 },
        }),
    })

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(`Run: ${UUID}`)
    await waitFor(async () =>
      expect(await infoRows('Run')).toEqual([
        ['UUID', UUID],
        ['Machine', 'linux-x86_64'],
        ['Commit', 'r100 (v1)'],
        ['Submitted', '2026-08-25, 2:22:41 PM'],
        ['build', '{"opt":"O3"}'],
        ['jobs', '8'],
        ['start_time', '2026-08-14T01:57:57'],
      ]),
    )
    expect(main().getByRole('link', { name: 'linux-x86_64' })).toHaveAttribute(
      'href',
      '/suites/libcxx/machines/linux-x86_64',
    )
    expect(main().getByRole('link', { name: 'r100 (v1)' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/abc123',
    )
  })

  it('shows only the error for a run that does not exist', async () => {
    renderRun({
      run: () => errorResponse(404, 'not_found', `Run '${UUID}' not found in test suite 'libcxx'`),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    expect(screen.queryByRole('heading', { name: 'Samples' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('fetches the samples alongside the run', async () => {
    const answer = gate()
    const { sampleQueries } = renderRun({
      run: async () => {
        await answer.promise
        return HttpResponse.json(RUN)
      },
    })

    await waitFor(() => expect(sampleQueries).toHaveLength(1))
    act(() => answer.open())
    expect(await table('Samples')).toBeInTheDocument()
  })

  describe('its comparisons', () => {
    it('compare the run alone with whatever the user picks', async () => {
      renderRun()

      const link = await main().findByRole('link', { name: 'Compare with...' })
      expect(queryOf(link)).toEqual({
        suite_a: 'libcxx',
        machine_a: 'linux-x86_64',
        commit_a: 'abc123',
        runs_a: UUID,
        metric: 'execution_time',
      })
    })

    it('compare the run with every run at the commit before it on its machine', async () => {
      const { lookups } = renderRun()

      // A link once the commit before is known, and no link at all until then.
      const name = 'Compare with previous commit'
      await waitFor(() => expect(main().getByRole('link', { name })).toHaveAttribute('href'))
      const link = main().getByRole('link', { name })
      expect(queryOf(link)).toEqual({
        suite_a: 'libcxx',
        machine_a: 'linux-x86_64',
        commit_a: 'prev99',
        suite_b: 'libcxx',
        machine_b: 'linux-x86_64',
        commit_b: 'abc123',
        runs_b: UUID,
        metric: 'execution_time',
      })
      expect(link).toHaveAttribute('title', 'Compare with prev99')
      expect(Object.fromEntries(lookups[0])).toEqual({
        machine: 'linux-x86_64',
        before_commit: 'abc123',
        sort: '-ordinal',
        limit: '1',
      })
    })

    it.each<[string, Options, string]>([
      [
        'the machine has no earlier commit',
        { previous: () => HttpResponse.json(cursorPage([])) },
        'linux-x86_64 has no runs at an earlier commit.',
      ],
      [
        'the commit has no ordinal',
        { commit: commit('abc123') },
        'This commit has no ordinal.',
      ],
      [
        'the commit was deleted meanwhile',
        { commit: null },
        "The previous commit could not be looked up: Commit 'abc123' no longer exists.",
      ],
      [
        'the lookup fails',
        { previous: () => errorResponse(500, 'internal_error', 'Boom') },
        'The previous commit could not be looked up: Boom',
      ],
    ])('cannot compare with the previous commit when %s, saying why', async (_, options, why) => {
      const { lookups } = renderRun(options)

      const link = await main().findByRole('link', { name: 'Compare with previous commit' })
      await waitFor(() => expect(link).toHaveAttribute('title', why))
      expect(link).toHaveAttribute('aria-disabled', 'true')
      expect(link).not.toHaveAttribute('href')
      expect(link).toHaveAccessibleDescription(why)
      // The API refuses to look up the commit before one that has no ordinal.
      if (options.commit !== undefined) expect(lookups).toEqual([])
    })

    it('cannot compare with the previous commit while it is being looked up', async () => {
      const answer = gate()
      renderRun({
        previous: async () => {
          await answer.promise
          return HttpResponse.json(cursorPage([PREVIOUS]))
        },
      })

      const link = await main().findByRole('link', { name: 'Compare with previous commit' })
      await waitFor(() => expect(link).toHaveAttribute('title', 'Looking up the previous commit...'))
      expect(link).toHaveAttribute('aria-disabled', 'true')
      act(() => answer.open())

      await waitFor(() =>
        expect(main().getByRole('link', { name: 'Compare with previous commit' })).toHaveAttribute(
          'href',
        ),
      )
    })
  })

  describe('Delete run', () => {
    it('needs manage scope', async () => {
      signIn('triage')
      renderRun()

      const button = await screen.findByRole('button', { name: 'Delete run' })
      await waitFor(() =>
        expect(button).toHaveAttribute('title', expect.stringMatching(/has the 'triage' scope/)),
      )
      expect(button).toBeDisabled()
    })

    it('is confirmed by typing the start of the UUID, then shows the machine', async () => {
      signIn('manage')
      const deleted: (string | null)[] = []
      server.use(
        mockApi('delete', '/api/suites/{testsuite}/runs/{uuid}', ({ request }) => {
          deleted.push(request.headers.get('Authorization'))
          return new HttpResponse(null, { status: 204 })
        }),
        mockApi('get', '/api/suites/{testsuite}/machines/{machine_name}', ({ params }) =>
          HttpResponse.json(machine(params.machine_name)),
        ),
      )
      mockRegressions()
      mockRuns(() => cursorPage([]))
      mockMachines(() => ({ items: [] }))
      renderRun()
      const button = await screen.findByRole('button', { name: 'Delete run' })
      await waitFor(() => expect(button).toBeEnabled())

      fireEvent.click(button)
      const prompt = screen.getByRole('form', { name: 'Confirmation' })
      expect(prompt).toHaveTextContent('Type aaaaaaaa to confirm')
      fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: 'aaaaaaaa' } })
      fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx/machines/linux-x86_64'))
      expect(deleted).toEqual([`Bearer ${TOKEN}`])
      expect(await screen.findByText('No runs on this machine yet.')).toBeInTheDocument()
    })

    it('stops loading the run’s samples once the page is left', async () => {
      signIn('manage')
      const aborted: string[] = []
      const { sampleQueries } = renderRun({
        // A second page that never arrives.
        samplePages: async (query, request) => {
          const cursor = query.get('cursor')
          if (cursor === null) return HttpResponse.json(cursorPage([sample('a')], 'p2'))
          request.signal.addEventListener('abort', () => aborted.push(cursor))
          return new Promise<Response>(() => {})
        },
      })
      const cursors = () => sampleQueries.map((query) => query.get('cursor'))
      server.use(
        mockApi(
          'delete',
          '/api/suites/{testsuite}/runs/{uuid}',
          () => new HttpResponse(null, { status: 204 }),
        ),
        mockApi('get', '/api/suites/{testsuite}/machines/{machine_name}', ({ params }) =>
          HttpResponse.json(machine(params.machine_name)),
        ),
      )
      mockRegressions()
      mockRuns(() => cursorPage([]))
      const button = await screen.findByRole('button', { name: 'Delete run' })
      await waitFor(() => expect(button).toBeEnabled())
      await waitFor(() => expect(cursors()).toEqual([null, 'p2']))

      fireEvent.click(button)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'aaaaaaaa' } })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx/machines/linux-x86_64'))
      await waitFor(() => expect(aborted).toEqual(['p2']))
      expect(cursors()).toEqual([null, 'p2'])
    })
  })

  describe('its metric', () => {
    it('is the first numeric one by default, and offers every metric, labelled', async () => {
      renderRun({ suite: MIXED, samples: [sample('a', { status: 'ok', execution_time: 1.5 })] })

      expect(await screen.findByRole('button', { name: 'Execution Time Metric' })).toBeVisible()
      const samples = await table('Samples')
      expect(within(samples).getAllByRole('columnheader')[1]).toHaveTextContent('Execution Time')
      fireEvent.click(selectButton('Metric'))
      expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
        'Status',
        'Execution Time',
        'Code Size',
      ])
      expect(currentUrl()).toBe(PAGE)
    })

    it('is restored from the URL, and passed on to the comparisons', async () => {
      renderRun({ suite: MIXED, url: `${PAGE}?metric=size`, samples: [sample('a', { size: 1234 })] })

      expect(rowsOf(await table('Samples'))).toEqual(['a | 1234'])
      expect(selectButton('Metric')).toHaveTextContent('Code Size')
      const link = main().getByRole('link', { name: 'Compare with...' })
      expect(queryOf(link).metric).toBe('size')
    })

    it('is kept in the URL as it changes, except at its default', async () => {
      renderRun({ suite: MIXED })
      await table('Samples')

      await pickOption('Metric', 'Status')
      await waitFor(() => expect(currentUrl()).toBe(`${PAGE}?metric=status`))
      await pickOption('Metric', 'Execution Time')
      await waitFor(() => expect(currentUrl()).toBe(PAGE))
      // The comparisons name the metric even at its default.
      expect(queryOf(main().getByRole('link', { name: 'Compare with...' })).metric).toBe(
        'execution_time',
      )
    })

    it.each([['nope'], ['execution_time']])(
      'is left out of the URL when the URL names %s',
      async (name) => {
        renderRun({ url: `${PAGE}?metric=${name}` })

        await waitFor(() => expect(currentUrl()).toBe(PAGE))
        expect(await screen.findByRole('button', { name: 'Execution Time Metric' })).toBeVisible()
      },
    )

    it('is not offered by a suite that has none', async () => {
      renderRun({
        suite: { ...SUITE, metrics: [] },
        samples: [sample('a')],
      })

      const samples = await table('Samples')
      expect(within(samples).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Test',
      ])
      expect(screen.queryByRole('button', { name: / Metric$/ })).not.toBeInTheDocument()
    })
  })

  describe('its samples', () => {
    it('are sorted by test, a row per sample, with the metric’s value and profile links', async () => {
      renderRun({
        samples: [
          sample('b/test', { execution_time: 2.123456789 }),
          sample('a/test', { execution_time: 1 }),
          sample('b/test', { execution_time: 66655.7123 }),
          sample('c/test', {}),
        ],
        profiles: profilesOf('b/test'),
      })

      const samples = await table('Samples')
      await waitFor(() =>
        expect(rowsOf(samples)).toEqual([
          'a/test | 1 | ',
          'b/test | 2.12346 | Profile',
          'b/test | 66655.7 | Profile',
          'c/test | -- | ',
        ]),
      )
      expect(within(samples).getAllByRole('link', { name: 'Profile' })[0]).toHaveAttribute(
        'href',
        `/profiles?suite_a=libcxx&run_a=${UUID}&test_a=b%2Ftest`,
      )
      expect(main().getByRole('status')).toHaveTextContent('4 samples')
    })

    it('have no profile column when the run has no profiles', async () => {
      renderRun({ samples: [sample('a', { execution_time: 1 })] })

      const samples = await table('Samples')
      expect(within(samples).getAllByRole('columnheader')).toHaveLength(2)
    })

    it('never say the run has none while they are arriving', async () => {
      const answer = gate()
      const seen = new Set<string>()
      const observer = new MutationObserver(() => {
        for (const text of ['This run has no samples.', '0 samples']) {
          if (document.body.textContent?.includes(text)) seen.add(text)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      renderRun({
        samplePages: async () => {
          await answer.promise
          return HttpResponse.json(cursorPage([sample('a')]))
        },
      })
      await screen.findByRole('heading', { name: 'Samples' })
      act(() => answer.open())

      expect(await screen.findByText('1 sample')).toBeInTheDocument()
      observer.disconnect()
      expect([...seen]).toEqual([])
    })

    it('are shown as they arrive, with a count of those so far', async () => {
      const second = gate()
      const { sampleQueries } = renderRun({
        samplePages: async (query) => {
          if (!query.has('cursor')) {
            return HttpResponse.json(cursorPage([sample('b'), sample('a')], 'p2'))
          }
          await second.promise
          return HttpResponse.json(cursorPage([sample('c')]))
        },
      })

      const samples = await table('Samples')
      expect(await screen.findByText('Loading samples... 2 so far.')).toBeInTheDocument()
      expect(testsOf(samples)).toEqual(['a', 'b'])
      act(() => second.open())

      expect(await screen.findByText('3 samples')).toBeInTheDocument()
      expect(testsOf(samples)).toEqual(['a', 'b', 'c'])
      expect(sampleQueries[0].get('limit')).toBe('10000')
      expect(sampleQueries[1].get('cursor')).toBe('p2')
    })

    it('are filtered by test name, as a case-insensitive substring of plain text', async () => {
      renderRun({ samples: [sample('std::sort/8'), sample('std::find/8'), sample('Sort/16')] })
      const samples = await table('Samples')

      search('Filter tests', 'sort')
      await waitFor(() => expect(testsOf(samples)).toEqual(['Sort/16', 'std::sort/8']))
      expect(main().getByRole('status')).toHaveTextContent('2 of 3 samples matching')

      // Plain text: what would be regex syntax elsewhere matches as it is (AR2).
      search('Filter tests', '^std')
      expect(await within(samples).findByText('No tests match the filter.')).toBeInTheDocument()
    })

    it('keep their filter in the URL once typing pauses, trimmed, and take it up from there', async () => {
      renderRun({
        url: `${PAGE}?test_filter=find`,
        samples: [sample('std::sort/8'), sample('std::find/8'), sample('sort/ x')],
      })

      const samples = await table('Samples')
      const filter = screen.getByRole('searchbox', { name: 'Filter tests' })
      expect(filter).toHaveValue('find')
      expect(testsOf(samples)).toEqual(['std::find/8'])
      expect(main().getByRole('status')).toHaveTextContent('1 of 3 samples matching')

      fireEvent.change(filter, { target: { value: 'sort/ ' } })
      // The input follows the keyboard at once, the rows just after, and the URL once typing
      // pauses, both with the text trimmed.
      expect(filter).toHaveValue('sort/ ')
      await waitFor(() => expect(testsOf(samples)).toEqual(['sort/ x', 'std::sort/8']))
      await waitFor(() => expect(currentUrl()).toBe(`${PAGE}?test_filter=sort%2F`))
    })

    it('give way to the error when the first page fails, with a retry', async () => {
      let fail = true
      renderRun({
        samplePages: () =>
          fail
            ? errorResponse(500, 'internal_error', 'The server failed')
            : HttpResponse.json(cursorPage([sample('a')])),
      })

      expect(await main().findByRole('alert')).toHaveTextContent('The server failed')
      expect(screen.queryByRole('table', { name: 'Samples' })).not.toBeInTheDocument()
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      expect(testsOf(await table('Samples'))).toEqual(['a'])
    })

    it('say they are incomplete when a later page fails, and offer to load the rest', async () => {
      let fail = true
      const { sampleQueries } = renderRun({
        samplePages: (query) => {
          if (!query.has('cursor')) return HttpResponse.json(cursorPage([sample('a')], 'p2'))
          return fail
            ? errorResponse(500, 'internal_error', 'The server failed')
            : HttpResponse.json(cursorPage([sample('b')]))
        },
      })

      expect(await main().findByRole('alert')).toHaveTextContent('The server failed')
      expect(main().getByRole('status')).toHaveTextContent(
        '1 sample (incomplete: loading the rest failed)',
      )
      expect(testsOf(await table('Samples'))).toEqual(['a'])
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      await waitFor(() => expect(main().getByRole('status')).toHaveTextContent('2 samples'))
      expect(testsOf(await table('Samples'))).toEqual(['a', 'b'])
      expect(sampleQueries.map((query) => query.get('cursor'))).toEqual([null, 'p2', 'p2'])
    })

    it('say when the run has none', async () => {
      renderRun()

      expect(await screen.findByText('This run has no samples.')).toBeInTheDocument()
      expect(main().getByRole('status')).toHaveTextContent('0 samples')
    })

    it('say when the profiles could not be listed, still showing the samples', async () => {
      renderRun({
        samples: [sample('a', { execution_time: 1 })],
        profiles: () => errorResponse(500, 'internal_error', 'No profiles today'),
      })

      expect(await main().findByRole('alert')).toHaveTextContent(
        'The profiles could not be listed: No profiles today',
      )
      expect(rowsOf(await table('Samples'))).toEqual(['a | 1'])
      expect(main().getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })
  })
})
