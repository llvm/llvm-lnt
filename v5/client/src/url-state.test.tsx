import { act, renderHook, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router'
import { describe, expect, it } from 'vitest'
import { api, unwrap } from './api/client'
import { errorResponse, mockApi } from './test/mock-api'
import { providers } from './test/render'
import { server } from './test/server'
import {
  booleanParam,
  enumListParam,
  enumParam,
  integerParam,
  listParam,
  stringParam,
  trimmedStringParam,
  useDropUnusable,
  useUrlState,
} from './url-state'

const PARAMS = {
  metric: stringParam(),
  machine: listParam(),
  agg: enumParam(['median', 'mean', 'min', 'max'], 'median'),
  offset: integerParam(),
}

const STATES = { state: enumListParam(['detected', 'active', 'fixed']) }
const FLAGS = { on: booleanParam(true), off: booleanParam(false) }

/** The settings, the URL they come from, and `navigate`, starting at `url`. */
function renderSettings(url: string) {
  const { result } = renderHook(
    () => {
      const [state, setState] = useUrlState(PARAMS)
      const { pathname, search } = useLocation()
      return { state, setState, url: pathname + search, navigate: useNavigate() }
    },
    providers({ url }),
  )
  return result
}

describe('useUrlState', () => {
  it('reads every setting from the URL', () => {
    const result = renderSettings('/graph?metric=compile_time&machine=a&machine=b&agg=min&offset=50')

    expect(result.current.state).toEqual({
      metric: 'compile_time',
      machine: ['a', 'b'],
      agg: 'min',
      offset: 50,
    })
  })

  it('uses the defaults for settings the URL leaves out', () => {
    const result = renderSettings('/graph')

    expect(result.current.state).toEqual({ metric: '', machine: [], agg: 'median', offset: 0 })
  })

  it('writes a setting to the URL, leaving out the ones at their default', () => {
    const result = renderSettings('/graph?agg=min')

    act(() => result.current.setState({ metric: 'compile_time', machine: ['a', 'b'], agg: 'median' }))

    expect(result.current.url).toBe('/graph?metric=compile_time&machine=a&machine=b')
    expect(result.current.state.agg).toBe('median')
  })

  it('composes changes made in one go', () => {
    const result = renderSettings('/graph')

    act(() => {
      result.current.setState({ metric: 'compile_time' })
      result.current.setState({ offset: 25 })
    })

    expect(result.current.url).toBe('/graph?metric=compile_time&offset=25')
  })

  it('leaves alone the parameters it does not declare', () => {
    const result = renderSettings('/graph?tab=runs&metric=a')

    act(() => result.current.setState({ metric: 'b' }))

    expect(result.current.url).toBe('/graph?tab=runs&metric=b')
  })

  it('drops a malformed value and uses the default instead', () => {
    const result = renderSettings('/graph?agg=geomean&offset=-3&metric=a&metric=b&machine=m')

    expect(result.current.state).toEqual({ metric: '', machine: ['m'], agg: 'median', offset: 0 })
    expect(result.current.url).toBe('/graph?machine=m')
  })

  it('drops an integer too large to be exact', () => {
    const result = renderSettings('/graph?offset=9007199254740993')

    expect(result.current.state.offset).toBe(0)
    expect(result.current.url).toBe('/graph')
  })

  it('rewrites a value spelled unusually, or at its default, the way it would write it', () => {
    const result = renderSettings('/graph?offset=050&agg=median')

    expect(result.current.state.offset).toBe(50)
    expect(result.current.url).toBe('/graph?offset=50')
  })

  it('keeps the known values of an enumeration list, once each, in the order of its options', () => {
    const { result } = renderHook(
      () => {
        const [state, setState] = useUrlState(STATES)
        const { pathname, search } = useLocation()
        return { state, setState, url: pathname + search }
      },
      providers({ url: '/suites/nts?state=fixed&state=bogus&state=active&state=fixed' }),
    )

    expect(result.current.state.state).toEqual(['active', 'fixed'])
    expect(result.current.url).toBe('/suites/nts?state=active&state=fixed')

    act(() => result.current.setState({ state: ['fixed', 'detected'] }))
    expect(result.current.url).toBe('/suites/nts?state=detected&state=fixed')
    act(() => result.current.setState({ state: [] }))
    expect(result.current.url).toBe('/suites/nts')
  })

  it('reads a boolean spelled true or false, and drops any other spelling', () => {
    const { result } = renderHook(
      () => {
        const [state, setState] = useUrlState(FLAGS)
        const { pathname, search } = useLocation()
        return { state, setState, url: pathname + search }
      },
      providers({ url: '/x?on=false&off=yes' }),
    )

    expect(result.current.state).toEqual({ on: false, off: false })
    expect(result.current.url).toBe('/x?on=false')
    act(() => result.current.setState({ on: true, off: true }))
    expect(result.current.url).toBe('/x?off=true')
  })

  it('reads a trimmed text without the spaces around it, and rewrites it so', () => {
    const { result } = renderHook(
      () => {
        const [state] = useUrlState({ search: trimmedStringParam() })
        const { pathname, search } = useLocation()
        return { state, url: pathname + search }
      },
      providers({ url: '/x?search=%20linux%20x86%20' }),
    )

    expect(result.current.state).toEqual({ search: 'linux x86' })
    expect(result.current.url).toBe('/x?search=linux+x86')
  })

  it('keeps the hash', () => {
    const { result } = renderHook(
      () => {
        const [, setState] = useUrlState(PARAMS)
        return { setState, location: useLocation() }
      },
      providers({ url: '/graph#chart' }),
    )

    act(() => result.current.setState({ metric: 'a' }))

    expect(result.current.location.search).toBe('?metric=a')
    expect(result.current.location.hash).toBe('#chart')
  })

  it('composes changes made by different parts of the page', () => {
    const OTHER = { search: stringParam() }
    const { result } = renderHook(
      () => {
        const [, setOffset] = useUrlState(PARAMS)
        const [, setSearch] = useUrlState(OTHER)
        const { pathname, search } = useLocation()
        return { setOffset, setSearch, url: pathname + search }
      },
      providers({ url: '/suites/nts?offset=50' }),
    )

    act(() => {
      result.current.setSearch({ search: 'x' })
      result.current.setOffset({ offset: 0 })
    })

    expect(result.current.url).toBe('/suites/nts?search=x')
  })

  it('does not navigate for a change that leaves the URL as it is', () => {
    const { result } = renderHook(
      () => {
        const [, setState] = useUrlState(PARAMS)
        return { setState, location: useLocation() }
      },
      providers({ url: '/graph?metric=a&machine=m' }),
    )
    const { key } = result.current.location

    act(() => result.current.setState({ metric: 'a', agg: 'median' }))
    act(() => result.current.setState({ machine: ['m'] }))
    act(() => result.current.setState({}))

    expect(result.current.location.key).toBe(key)
  })

  it('ignores a change made after the path changed', () => {
    const result = renderSettings('/suites/nts')
    const stale = result.current.setState

    act(() => void result.current.navigate('/suites/other?metric=b'))
    act(() => stale({ metric: 'late' }))

    expect(result.current.url).toBe('/suites/other?metric=b')
  })
})

describe('history', () => {
  it('replaces the entry when only the settings change, so that Back leaves the page', () => {
    const result = renderSettings('/')
    act(() => void result.current.navigate('/graph?metric=a'))

    act(() => result.current.setState({ metric: 'b' }))
    act(() => result.current.setState({ metric: 'c' }))
    expect(result.current.url).toBe('/graph?metric=c')

    act(() => void result.current.navigate(-1))
    expect(result.current.url).toBe('/')
  })

  it('adds an entry when the path changes', () => {
    const result = renderSettings('/')

    act(() => void result.current.navigate('/graph?metric=a'))
    expect(result.current.url).toBe('/graph?metric=a')

    act(() => void result.current.navigate(-1))
    expect(result.current.url).toBe('/')
  })
})

describe('useDropUnusable', () => {
  const SUITE_PARAMS = { suite: stringParam() }

  /** A page keeping `suite` only if the suite list has it, starting at `url`. */
  function renderSuitePicker(url: string) {
    const { result } = renderHook(() => {
      const [{ suite }, set] = useUrlState(SUITE_PARAMS)
      const suites = useQuery({
        queryKey: ['suites'],
        queryFn: ({ signal }) => unwrap(api.GET('/api/suites', { signal })),
      })
      useDropUnusable(
        suites,
        (data) => suite === '' || data.items.some((s) => s.name === suite),
        () => set({ suite: '' }),
      )
      const { pathname, search } = useLocation()
      return { suites, url: pathname + search }
    }, providers({ url }))
    return result
  }

  const suite = (name: string) => ({ name, metrics: [], commit_fields: [], machine_fields: [] })

  it('drops a value once a response shows it is unusable', async () => {
    server.use(mockApi('get', '/api/suites', () => HttpResponse.json({ items: [suite('nts')] })))
    const result = renderSuitePicker('/graph?suite=gone&other=1')

    await waitFor(() => expect(result.current.suites.isSuccess).toBe(true))
    expect(result.current.url).toBe('/graph?other=1')
  })

  it('keeps a value the response shows is usable', async () => {
    server.use(mockApi('get', '/api/suites', () => HttpResponse.json({ items: [suite('nts')] })))
    const result = renderSuitePicker('/graph?suite=nts')

    await waitFor(() => expect(result.current.suites.isSuccess).toBe(true))
    expect(result.current.url).toBe('/graph?suite=nts')
  })

  it('drops nothing when the request fails', async () => {
    server.use(mockApi('get', '/api/suites', () => errorResponse(500, 'internal_error', 'Oops')))
    const result = renderSuitePicker('/graph?suite=gone')

    await waitFor(() => expect(result.current.suites.isError).toBe(true))
    expect(result.current.url).toBe('/graph?suite=gone')
  })

  it('settles when the check also rejects the default', async () => {
    server.use(mockApi('get', '/api/suites', () => HttpResponse.json({ items: [suite('nts')] })))
    // Should it not settle, the drops stop after a while, so that the test fails rather than hangs.
    let drops = 0
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      const [{ suite }, set] = useUrlState(SUITE_PARAMS)
      const suites = useQuery({
        queryKey: ['suites'],
        queryFn: ({ signal }) => unwrap(api.GET('/api/suites', { signal })),
      })
      // Wrong for the default, '', which no suite is named: `drop` is called on every render.
      useDropUnusable(
        suites,
        (data) => data.items.some((s) => s.name === suite),
        () => drops++ < 100 && set({ suite: '' }),
      )
      return { suites, location: useLocation() }
    }, providers({ url: '/graph?suite=gone' }))

    await waitFor(() => expect(result.current.suites.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.location.search).toBe(''))
    const { key } = result.current.location
    const settled = renders
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))

    expect(result.current.location.key).toBe(key)
    expect(renders).toBe(settled)
    expect(renders).toBeLessThan(20)
  })

  it('drops nothing on placeholder data', () => {
    let dropped = false
    renderHook(() =>
      useDropUnusable(
        { data: [], isSuccess: true, isPlaceholderData: true },
        () => false,
        () => (dropped = true),
      ),
    )

    expect(dropped).toBe(false)
  })
})
