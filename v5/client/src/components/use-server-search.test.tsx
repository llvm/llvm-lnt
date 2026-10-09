import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_DELAY_MS } from './suggestions'
import { useServerSearch } from './use-server-search'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** The hook, with `search` updated as a page would, from what `onSearch` is called with. */
function renderSearch(initial = '') {
  const onSearch = vi.fn()
  const hook = renderHook(
    ({ search }) =>
      useServerSearch(search, (text) => {
        onSearch(text)
        hook.rerender({ search: text })
      }),
    { initialProps: { search: initial } },
  )
  return { result: hook.result, rerender: hook.rerender, onSearch }
}

describe('useServerSearch', () => {
  it('starts with the text searched for', () => {
    const { result } = renderSearch('linux')

    expect(result.current.text).toBe('linux')
    expect(result.current.pending).toBe(false)
  })

  it('searches once typing pauses, for the text typed last', () => {
    const { result, onSearch } = renderSearch()

    act(() => result.current.setText('l'))
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS - 1))
    act(() => result.current.setText('li'))
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS - 1))
    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(true)

    act(() => vi.advanceTimersByTime(1))
    expect(onSearch.mock.calls).toEqual([['li']])
    expect(result.current.pending).toBe(false)
  })

  it('does not search again for the text already searched for', () => {
    const { result, onSearch } = renderSearch('li')

    act(() => result.current.setText('lin'))
    act(() => result.current.setText('li'))
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))

    expect(onSearch).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(false)
  })

  it('takes up a search changed from outside, such as a page clearing it', () => {
    const { result, rerender, onSearch } = renderSearch('linux')

    rerender({ search: '' })

    expect(result.current.text).toBe('')
    expect(result.current.pending).toBe(false)
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('takes up an earlier search coming back, as when going Back', () => {
    const { result, rerender, onSearch } = renderSearch('linux')

    rerender({ search: '' })
    rerender({ search: 'linux' })

    expect(result.current.text).toBe('linux')
    expect(result.current.pending).toBe(false)
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('takes up a search changed from outside to one it had searched for itself', () => {
    const { result, rerender } = renderSearch()
    act(() => result.current.setText('lin'))
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))

    rerender({ search: '' })
    rerender({ search: 'lin' })

    expect(result.current.text).toBe('lin')
  })

  it('keeps what was typed while its own search was landing', () => {
    const onSearch = vi.fn()
    const hook = renderHook(({ search }) => useServerSearch(search, onSearch), {
      initialProps: { search: '' },
    })

    act(() => hook.result.current.setText('lin'))
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))
    expect(onSearch.mock.calls).toEqual([['lin']])
    // The page takes the search up only after the user typed on.
    act(() => hook.result.current.setText('linux'))
    hook.rerender({ search: 'lin' })

    expect(hook.result.current.text).toBe('linux')
    expect(hook.result.current.pending).toBe(true)
  })

  it('searches for an emptied input too', () => {
    const { result, onSearch } = renderSearch('li')

    act(() => result.current.setText(''))
    act(() => vi.advanceTimersByTime(SEARCH_DELAY_MS))

    expect(onSearch.mock.calls).toEqual([['']])
  })
})
