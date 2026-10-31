import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import type { PlotData, PlotHoverEvent, PlotMouseEvent } from 'plotly.js'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { queryKeys } from '../../api/keys'
import type { Suite } from '../../api/suites'
import type { ChartProps } from '../../components/chart'
import {
  BARE_SUITE,
  SUITE,
  commit,
  inProject,
  machine,
  PROJECT,
  metric,
  trendPoint,
} from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  main,
  mockMachines,
  mockResolve,
  mockSuites,
  mockTrends,
  query,
  renderPage,
} from '../../test/page'
import { chartProps } from '../../test/chart-props'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'
import { machineColor } from './sparkline'

// The tests check what the cards hand Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/**
 * libcxx, with metrics of each kind on the Dashboard: one with a unit and its abbreviation, one
 * whose unit is its abbreviation, and a numeric one with neither; and off it, a numeric one and
 * one that is not numeric.
 */
const DASH_SUITE: Suite = {
  ...SUITE,
  metrics: [
    SUITE.metrics[0],
    metric('cycles', {
      display_name: 'Cycles',
      unit: 'cycles',
      unit_abbrev: 'cycles',
      dashboard: true,
    }),
    metric('exit_status', { type: 'integer' }),
    metric('compile_status', { type: 'integer', dashboard: true }),
    metric('hash', { type: 'text' }),
  ],
}

/** A suite whose only metric is not numeric. */
const TEXT_SUITE: Suite = {
  ...BARE_SUITE,
  name: 'text_only',
  metrics: [metric('hash', { type: 'text' })],
}

/** A suite with numeric metrics, none of them on the Dashboard. */
const UNCHOSEN_SUITE: Suite = {
  ...BARE_SUITE,
  name: 'unchosen',
  metrics: [metric('size', { type: 'integer' }), metric('hash', { type: 'text' })],
}

const RAN = { last_run_at: '2026-08-25T14:22:41Z' }

/** Two machines with a point each at two commits. */
const POINTS = [
  trendPoint('m1', 10, 1.5),
  trendPoint('m1', 20, 1.6),
  trendPoint('m2', 10, 2.5),
  trendPoint('m2', 20, 2.4),
]

/** The suite's machines, as `GET /machines` lists them, with runs unless they are in `idle`. */
function mockMachineNames(names: string[], { idle = [] }: { idle?: string[] } = {}) {
  return mockMachines(() => ({
    items: names.map((name) => machine(name, idle.includes(name) ? {} : RAN)),
  }))
}

/** The Dashboard of DASH_SUITE alone, with POINTS for every metric, on m1 and m2. */
function renderDashboard(url = '/') {
  mockSuites([DASH_SUITE])
  mockMachineNames(['m1', 'm2'])
  const trends = mockTrends(() => POINTS)
  mockResolve()
  return { trends, ...renderPage(url) }
}

/** The section of the project labelled `project`. */
function projectSection(project: string) {
  return within(main().getByRole('region', { name: project }))
}

/** The section of the suite labelled `suite`, in the section of the project labelled `project`. */
function section(suite: string, project = 'llvm') {
  return within(projectSection(project).getByRole('region', { name: suite }))
}

async function card(name: string, suite = 'libcxx', project = 'llvm') {
  const projectRegion = await main().findByRole('region', { name: project })
  const region = await within(projectRegion).findByRole('region', { name: suite })
  return within(await within(region).findByRole('article', { name }))
}

/** The chart of the card `name`, once drawn, and the props it was last rendered with. */
async function chartOf(name: string, suite = 'libcxx', project = 'llvm') {
  const element = await (await card(name, suite, project)).findByRole('img', { hidden: true })
  return { element, props: () => chartProps(element) }
}

/** The link the chart of the card `name` is in. */
async function chartLink(name: string) {
  const { element } = await chartOf(name)
  return element.closest('a')!
}

/** Fail `GET /api/projects`. */
function failProjects() {
  server.use(
    mockApi('get', '/api/projects', () => errorResponse(500, 'internal_error', 'No projects.')),
  )
}

function hoverEvent(curveNumber: number) {
  return { points: [{ curveNumber }] } as PlotHoverEvent & PlotMouseEvent
}

describe('the Dashboard', () => {
  it('heads projects by their labels, and suites by their own, in AR22 order', async () => {
    const extra = { name: 'extra', display_name: 'LLVM Extra' }
    mockSuites([
      DASH_SUITE,
      { ...TEXT_SUITE, display_name: 'A text suite' },
      inProject({ ...UNCHOSEN_SUITE, name: 'alpha' }, extra),
    ])
    mockMachineNames(['m1'])
    mockTrends(() => POINTS)
    mockResolve()
    renderPage('/')

    await chartOf('compile_status')
    // The project 'llvm' before 'LLVM Extra', whatever its suites are called.
    const projects = main().getAllByRole('heading', { level: 2 })
    expect(projects.map((h) => h.textContent)).toEqual(['llvm', 'LLVM Extra'])
    // Each heading leads to the project's suites on the Test Suites page (TS1).
    const extraLink = projectSection('LLVM Extra').getByRole('link', { name: 'LLVM Extra' })
    expect(extraLink).toHaveAttribute('href', '/projects/extra')
    const suitesOf = (project: string) =>
      projectSection(project)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
    expect(suitesOf('llvm')).toEqual(['A text suite', 'libcxx'])
    expect(suitesOf('LLVM Extra')).toEqual(['alpha'])
  })

  it('says that a project has no test suites', async () => {
    mockSuites([TEXT_SUITE], { projects: [PROJECT, { name: 'swift', display_name: null }] })
    renderPage('/')

    expect(await main().findByText('No test suites.')).toBeInTheDocument()
    expect(projectSection('swift').getByText('No test suites.')).toBeInTheDocument()
    expect(projectSection('swift').queryByRole('region')).not.toBeInTheDocument()
  })

  it('shows a section per suite, and a card per metric on the Dashboard, in schema order', async () => {
    mockSuites([DASH_SUITE, TEXT_SUITE])
    mockMachineNames(['m1'])
    mockTrends(() => POINTS)
    mockResolve()
    renderPage('/')

    await chartOf('compile_status')
    const headings = main().getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual(['libcxx', 'text_only'])
    const cards = section('libcxx').getAllByRole('article')
    expect(cards.map((article) => article.getAttribute('aria-label'))).toEqual([
      'Execution Time',
      'Cycles',
      'compile_status',
    ])
    // The title is the metric's label, then its unit as AR6 writes it, when it has one.
    expect(
      section('libcxx')
        .getAllByRole('heading', { level: 4 })
        .map((h) => h.textContent),
    ).toEqual(['Execution Time — seconds (s)', 'Cycles — cycles', 'compile_status'])
  })

  it('says that a suite has no numeric metrics, and asks nothing about it', async () => {
    mockSuites([TEXT_SUITE])
    const asked = mockMachines(() => ({ items: [] }))
    renderPage('/')

    expect(await main().findByText('This suite has no numeric metrics.')).toBeInTheDocument()
    expect(section('text_only').queryByRole('article')).not.toBeInTheDocument()
    expect(section('text_only').queryByRole('link')).not.toBeInTheDocument()
    expect(asked).toEqual([])
  })

  it('leads to the schema of a suite that shows none of its metrics, and asks nothing', async () => {
    mockSuites([UNCHOSEN_SUITE])
    const asked = mockMachines(() => ({ items: [] }))
    renderPage('/')

    expect(
      await main().findByText(/^This suite shows no metrics on the Dashboard\./),
    ).toBeInTheDocument()
    expect(section('unchosen').queryByRole('article')).not.toBeInTheDocument()
    expect(section('unchosen').getByRole('link', { name: 'its schema' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/unchosen?tab=schema',
    )
    expect(asked).toEqual([])
  })

  it('shows the five tracked machines most recently active, the same on every card', async () => {
    mockSuites([DASH_SUITE])
    const machines = mockMachineNames(['m6', 'm5', 'idle', 'm4', 'm3', 'm2', 'm1'], {
      idle: ['idle'],
    })
    const trends = mockTrends(() => POINTS)
    mockResolve()
    renderPage('/')

    await chartOf('compile_status')
    expect(machines.map((query) => query.toString())).toEqual(['tracked=true&sort=-last_run_at'])
    // A machine without runs has no trend, and so is left out.
    const shown = ['m6', 'm5', 'm4', 'm3', 'm2']
    expect(trends.map((query) => [query.get('metric'), query.getAll('machine')])).toEqual([
      ['execution_time', shown],
      ['cycles', shown],
      ['compile_status', shown],
    ])
    expect(trends.every((query) => query.get('last_n') === '500')).toBe(true)
  })

  it('gives a machine the same colour on every card', async () => {
    mockSuites([DASH_SUITE])
    mockMachineNames(['m1', 'm2'])
    // m1 has no data for cycles: m2 keeps its colour there all the same.
    mockTrends((query) => (query.get('metric') === 'cycles' ? POINTS.slice(2) : POINTS))
    mockResolve()
    renderPage('/')

    const colours = (data: ChartProps['data']) =>
      data.map((trace) => [(trace as PlotData).name, (trace as PlotData).line.color])
    expect(colours((await chartOf('Execution Time')).props().data)).toEqual([
      ['m1', machineColor(0)],
      ['m2', machineColor(1)],
    ])
    expect(colours((await chartOf('Cycles')).props().data)).toEqual([['m2', machineColor(1)]])
  })

  it('says so when no tracked machine has runs, and asks for no trend', async () => {
    mockSuites([DASH_SUITE])
    mockMachineNames(['idle'], { idle: ['idle'] })
    const trends = mockTrends(() => [])
    renderPage('/')

    expect(await main().findByText('No tracked machine has runs yet.')).toBeInTheDocument()
    expect(main().queryByRole('article')).not.toBeInTheDocument()
    expect(trends).toEqual([])
  })

  it("shows why the suite's machines could not be loaded, and tries again", async () => {
    mockSuites([DASH_SUITE])
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/machines', () =>
        errorResponse(500, 'internal_error', 'The machines broke.'),
      ),
    )
    mockTrends(() => POINTS)
    mockResolve()
    renderPage('/')

    expect(await main().findByRole('alert')).toHaveTextContent('The machines broke.')
    mockMachineNames(['m1'])
    fireEvent.click(main().getByRole('button', { name: 'Retry' }))
    await chartOf('Execution Time')
  })

  it('says so when there are no projects', async () => {
    mockSuites([], { projects: [] })
    renderPage('/')

    expect(await main().findByText('There are no projects yet.')).toBeInTheDocument()
  })

  it('says that it is loading the projects', async () => {
    const slow = gate()
    mockSuites([], { projects: [], wait: () => slow.promise })
    renderPage('/')

    expect(await main().findByRole('status')).toHaveTextContent('Loading projects...')
    act(() => slow.open())
    expect(await main().findByText('There are no projects yet.')).toBeInTheDocument()
  })

  it('shows why the projects could not be loaded, and tries again', async () => {
    failProjects()
    renderPage('/')

    expect(await main().findByRole('alert')).toHaveTextContent(
      'The projects could not be loaded: No projects.',
    )
    expect(selectButton('Project')).toBeDisabled()
    mockSuites([], { projects: [] })
    fireEvent.click(main().getByRole('button', { name: 'Retry' }))
    expect(await main().findByText('There are no projects yet.')).toBeInTheDocument()
  })

  it('keeps showing the page when the projects fetched again cannot be', async () => {
    const { queryClient } = renderDashboard()
    await chartOf('Execution Time')

    failProjects()
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.projects }))

    expect(await card('Execution Time')).toBeTruthy()
    expect(main().queryByText(/No projects/)).not.toBeInTheDocument()
    // The filter stays usable meanwhile.
    expect(selectButton('Project')).toBeEnabled()
    await pickOption('Project', 'llvm')
    await waitFor(() => expect(currentUrl()).toBe('/?project=llvm'))
  })

  describe('the project filter', () => {
    const LIBCXX = { name: 'libcxx', display_name: 'libc++' }
    const SWIFT = { name: 'swift', display_name: null }
    const BENCHMARKS = inProject({ ...DASH_SUITE, name: 'benchmarks' }, LIBCXX)
    const NTS = inProject({ ...DASH_SUITE, name: 'nts' })

    /** libcxx, with benchmarks, llvm, with nts, and swift, without suites. */
    function mockProjects({ wait }: { wait?: () => Promise<void> } = {}) {
      const store = mockSuites([BENCHMARKS, NTS], { projects: [LIBCXX, PROJECT, SWIFT], wait })
      const machines = mockMachineNames(['m1', 'm2'])
      const trends = mockTrends(() => POINTS)
      mockResolve()
      return { store, machines, trends }
    }

    /** The path of every request sent from now on, in order. */
    function recordPaths() {
      const paths: string[] = []
      const listener = ({ request }: { request: Request }) => {
        paths.push(new URL(request.url).pathname)
      }
      server.events.on('request:start', listener)
      onTestFinished(() => server.events.removeListener('request:start', listener))
      return paths
    }

    const projectHeadings = () =>
      main()
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent)

    it('offers every project, by label in AR22 order, and all of them by default', async () => {
      mockProjects()
      renderPage('/')

      await chartOf('Execution Time', 'nts')
      expect(selectButton('Project')).toHaveTextContent('All projects')
      expect(projectHeadings()).toEqual(['libc++', 'llvm', 'swift'])
      fireEvent.click(selectButton('Project'))
      const options = await screen.findAllByRole('option')
      expect(options.map((option) => option.textContent)).toEqual([
        'All projects',
        'libc++',
        'llvm',
        'swift',
      ])
    })

    it('shows the project of the URL alone, and fetches only what it shows', async () => {
      const paths = recordPaths()
      mockProjects()
      renderPage('/?project=libcxx')

      await chartOf('Execution Time', 'benchmarks', 'libc++')
      expect(selectButton('Project')).toHaveTextContent('libc++')
      expect(projectHeadings()).toEqual(['libc++'])
      // Everything asked of a project is asked of libcxx, the list of projects aside.
      const inProjects = paths.filter((path) => path.startsWith('/api/projects/'))
      expect(inProjects).not.toEqual([])
      expect(inProjects.filter((path) => !path.startsWith('/api/projects/libcxx/'))).toEqual([])
    })

    it('keeps the project picked in the URL, in place of the history entry', async () => {
      mockProjects()
      renderPage('/projects')
      fireEvent.click(await screen.findByRole('link', { name: 'LNT' }))
      await chartOf('Execution Time', 'benchmarks', 'libc++')

      await pickOption('Project', 'libc++')
      await waitFor(() => expect(currentUrl()).toBe('/?project=libcxx'))
      expect(projectHeadings()).toEqual(['libc++'])

      await pickOption('Project', 'All projects')
      await waitFor(() => expect(currentUrl()).toBe('/'))
      expect(projectHeadings()).toEqual(['libc++', 'llvm', 'swift'])

      // Back leaves the Dashboard rather than stepping back through the projects picked (AR2).
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
      await waitFor(() => expect(currentUrl()).toBe('/projects'))
    })

    it('keeps the sections of the project picked as they are', async () => {
      const { machines } = mockProjects()
      renderPage('/')
      // The second project, whose sections move to the top of the page.
      const { element } = await chartOf('Execution Time', 'nts', 'llvm')
      const asked = machines.length

      await pickOption('Project', 'llvm')
      await waitFor(() => expect(projectHeadings()).toEqual(['llvm']))

      // The same chart, rather than one drawn again in a section mounted again.
      expect(element).toBeInTheDocument()
      expect(machines).toHaveLength(asked)
    })

    it('names the project of the URL by its name until the projects are listed', async () => {
      const slow = gate()
      mockProjects({ wait: () => slow.promise })
      renderPage('/?project=libcxx')

      expect(await main().findByRole('status')).toHaveTextContent('Loading projects...')
      expect(selectButton('Project')).toHaveTextContent('libcxx')
      expect(selectButton('Project')).toBeDisabled()
      act(() => slow.open())

      await waitFor(() => expect(selectButton('Project')).toHaveTextContent('libc++'))
      expect(selectButton('Project')).toBeEnabled()
      expect(currentUrl()).toBe('/?project=libcxx')
    })

    it('drops a project that does not exist, once the projects are listed (AR2)', async () => {
      const slow = gate()
      mockProjects({ wait: () => slow.promise })
      renderPage('/?project=nope')

      expect(await main().findByRole('status')).toHaveTextContent('Loading projects...')
      expect(currentUrl()).toBe('/?project=nope')
      act(() => slow.open())

      await waitFor(() => expect(currentUrl()).toBe('/'))
      expect(selectButton('Project')).toHaveTextContent('All projects')
      expect(projectHeadings()).toEqual(['libc++', 'llvm', 'swift'])
    })

    it('keeps a project while the projects cannot be listed', async () => {
      failProjects()
      renderPage('/?project=nope')

      expect(await main().findByRole('alert')).toHaveTextContent('No projects.')
      expect(currentUrl()).toBe('/?project=nope')
    })

    it('drops the project once a list fetched again no longer holds it', async () => {
      const { store } = mockProjects()
      const { queryClient } = renderPage('/?project=libcxx')
      await chartOf('Execution Time', 'benchmarks', 'libc++')

      // Renamed or deleted elsewhere.
      store.projects = [PROJECT, SWIFT]
      store.suites = [NTS]
      await act(() => queryClient.refetchQueries({ queryKey: queryKeys.projects }))

      await waitFor(() => expect(currentUrl()).toBe('/'))
      expect(projectHeadings()).toEqual(['llvm', 'swift'])
    })

    it('goes with the commit range, each kept as the other changes', async () => {
      const { trends } = mockProjects()
      renderPage('/?project=libcxx&range=100')

      await chartOf('Execution Time', 'benchmarks', 'libc++')
      expect(screen.getByRole('button', { name: 'Last 100' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(trends.map((query) => query.get('last_n'))).toEqual(['100', '100', '100'])

      fireEvent.click(screen.getByRole('button', { name: 'Last 1000' }))
      await waitFor(() => expect(query()).toEqual({ project: ['libcxx'], range: ['1000'] }))

      await pickOption('Project', 'All projects')
      await waitFor(() => expect(currentUrl()).toBe('/?range=1000'))
    })
  })

  describe('the commit range', () => {
    it('is 500 commits by default, and kept in the URL otherwise', async () => {
      const { trends } = renderDashboard()

      const last500 = await screen.findByRole('button', { name: 'Last 500' })
      expect(last500).toHaveAttribute('aria-pressed', 'true')
      await chartOf('compile_status')

      fireEvent.click(screen.getByRole('button', { name: 'Last 100' }))

      await waitFor(() => expect(currentUrl()).toBe('/?range=100'))
      expect(screen.getByRole('button', { name: 'Last 100' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(last500).toHaveAttribute('aria-pressed', 'false')
      await waitFor(() =>
        expect(trends.filter((query) => query.get('last_n') === '100')).toHaveLength(3),
      )

      fireEvent.click(last500)
      await waitFor(() => expect(currentUrl()).toBe('/'))
    })

    it('is read from the URL', async () => {
      const { trends } = renderDashboard('/?range=1000')

      await chartOf('compile_status')
      expect(screen.getByRole('button', { name: 'Last 1000' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(trends.map((query) => query.get('last_n'))).toEqual(['1000', '1000', '1000'])
    })

    it('drops a range that is not offered from the URL', async () => {
      renderDashboard('/?range=7')

      await waitFor(() => expect(currentUrl()).toBe('/'))
      expect(await screen.findByRole('button', { name: 'Last 500' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })

    it("shows each card loading while another range's trend arrives", async () => {
      mockSuites([DASH_SUITE])
      mockMachineNames(['m1', 'm2'])
      const slow = gate()
      mockTrends(async (query) => {
        if (query.get('last_n') === '100') await slow.promise
        return POINTS
      })
      mockResolve()
      renderPage('/')
      await chartOf('Execution Time')

      fireEvent.click(screen.getByRole('button', { name: 'Last 100' }))

      const executionTime = await card('Execution Time')
      expect(await executionTime.findByRole('status')).toHaveTextContent('Loading...')
      expect(executionTime.queryByRole('img', { hidden: true })).not.toBeInTheDocument()
      const title = executionTime.getByRole('link', { name: 'Execution Time' })
      expect(title).toHaveAttribute('aria-disabled', 'true')
      expect(title).toHaveAttribute('title', 'The trend is loading.')
      act(() => slow.open())
      await chartOf('Execution Time')
    })
  })

  describe('a card', () => {
    it('shows why its trend could not be loaded, and tries again', async () => {
      mockSuites([DASH_SUITE])
      mockMachineNames(['m1', 'm2'])
      let broken = true
      server.use(
        mockApi('get', '/api/projects/{project}/suites/{suite}/trends', () =>
          broken
            ? errorResponse(500, 'internal_error', 'No trend.')
            : HttpResponse.json({ items: POINTS }),
        ),
      )
      mockResolve()
      renderPage('/')

      const executionTime = await card('Execution Time')
      expect(await executionTime.findByRole('alert')).toHaveTextContent('No trend.')
      // Its title leads nowhere: the card does not know which machines have data (AR8).
      const title = executionTime.getByRole('link', { name: 'Execution Time' })
      expect(title).toHaveAttribute('aria-disabled', 'true')
      expect(title).toHaveAttribute('title', 'The trend could not be loaded.')
      broken = false
      fireEvent.click(executionTime.getByRole('button', { name: 'Retry' }))
      await chartOf('Execution Time')
    })

    it('says so when no machine has a trend for its metric', async () => {
      mockSuites([DASH_SUITE])
      mockMachineNames(['m1', 'm2'])
      mockTrends((query) => (query.get('metric') === 'cycles' ? [] : POINTS))
      mockResolve()
      renderPage('/')

      const cycles = await card('Cycles')
      expect(await cycles.findByText('No machine has a trend for this metric.')).toBeInTheDocument()
      const title = cycles.getByRole('link', { name: 'Cycles' })
      expect(title).toHaveAttribute('aria-disabled', 'true')
      expect(title).toHaveAttribute('title', 'No machine has a trend for this metric.')
    })

    it("labels each point with its machine, its commit's display value and its value", async () => {
      mockSuites([DASH_SUITE])
      mockMachineNames(['m1'])
      mockTrends(() => [trendPoint('m1', 10, 1.5, { tag: 'llvm-22' }), trendPoint('m1', 20, 1.6)])
      const revision = (svn_revision: string) => ({ svn_revision, commit_info: null })
      mockResolve([
        commit('commit-10', { tag: 'llvm-22', fields: revision('r10') }),
        commit('commit-20', { fields: revision('r20') }),
      ])
      renderPage('/')

      const { props } = await chartOf('Execution Time')
      await waitFor(() =>
        expect((props().data[0] as PlotData).text).toEqual([
          '<b>m1</b><br>r10 (llvm-22)<br>1.5 s',
          '<b>m1</b><br>r20<br>1.6 s',
        ]),
      )
      // The same, in words, for assistive technology.
      expect(
        (await card('Execution Time')).getByText('Latest values: m1, 1.6 s at r20.'),
      ).toBeInTheDocument()
    })

    it('shows commit strings, with their tags, when the commits cannot be resolved', async () => {
      mockSuites([DASH_SUITE])
      mockMachineNames(['m1'])
      mockTrends(() => [trendPoint('m1', 10, 1.5, { tag: 'llvm-22' }), trendPoint('m1', 20, 1.6)])
      server.use(
        mockApi('post', '/api/projects/{project}/suites/{suite}/commits/resolve', () =>
          errorResponse(500, 'internal_error', 'No commits.'),
        ),
      )
      renderPage('/')

      const { props } = await chartOf('Execution Time')
      expect((props().data[0] as PlotData).text).toEqual([
        '<b>m1</b><br>commit-10 (llvm-22)<br>1.5 s',
        '<b>m1</b><br>commit-20<br>1.6 s',
      ])
    })
  })

  describe('the links to the Graph', () => {
    it("lead to the card's metric on the machines it has data for", async () => {
      mockSuites([DASH_SUITE])
      mockMachineNames(['m1', 'm2', 'm3'])
      mockTrends(() => POINTS)
      mockResolve()
      renderPage('/')

      const graph = '/graph?project=llvm&suite=libcxx&machine=m1&machine=m2&metric=cycles'
      expect(await chartLink('Cycles')).toHaveAttribute('href', graph)
      const title = (await card('Cycles')).getByRole('link', { name: 'Cycles' })
      expect(title).toHaveAttribute('href', graph)
    })

    it('lead to the machine of the trace hovered on the chart', async () => {
      renderDashboard()
      const { props } = await chartOf('Cycles')
      const link = await chartLink('Cycles')

      act(() => props().onHover!(hoverEvent(1)))
      expect(new URL(link.href).searchParams.getAll('machine')).toEqual(['m2'])

      act(() => props().onUnhover!(hoverEvent(1)))
      expect(new URL(link.href).searchParams.getAll('machine')).toEqual(['m1', 'm2'])
    })

    it('lead a click on a trace to its machine, even right after Plotly reports it', async () => {
      renderDashboard()
      const { props } = await chartOf('Cycles')
      const link = await chartLink('Cycles')

      // Plotly reports the click, then clicks the link, with no render between them.
      act(() => {
        props().onClick!(hoverEvent(1))
        fireEvent.click(link)
      })

      await waitFor(() =>
        expect(currentUrl()).toBe('/graph?project=llvm&suite=libcxx&machine=m2&metric=cycles'),
      )
    })

    it('do not redraw the chart as a trace is hovered', async () => {
      renderDashboard()
      const { props } = await chartOf('Cycles')
      const drawn = props().data

      act(() => props().onHover!(hoverEvent(0)))
      act(() => props().onUnhover!(hoverEvent(0)))

      expect(props().data).toBe(drawn)
    })

    it('leave the chart out of the tab order and away from assistive technology', async () => {
      renderDashboard()

      const link = await chartLink('Cycles')
      expect(link).toHaveAttribute('tabindex', '-1')
      expect(link).toHaveAttribute('aria-hidden', 'true')
      expect((await card('Cycles')).getAllByRole('link')).toHaveLength(1)
    })
  })
})
