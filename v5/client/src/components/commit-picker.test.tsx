import { useState } from 'react'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CommitFilters } from '../api/commits'
import { scrollToEnd } from '../test/intersection-observer'
import { SUITE, commit, cursorPage } from '../test/fixtures'
import { gate, mockCommits, mockResolve } from '../test/page'
import { renderWithProviders } from '../test/render'
import { CommitPicker } from './commit-picker'

const TAGGED = commit('abc123', { tag: 'v1', fields: { svn_revision: 'r100', commit_info: null } })
const PLAIN = commit('abc456')
const OTHER = commit('def789', { fields: { svn_revision: 'r200', commit_info: null } })
/** A commit beyond the first page of suggestions. */
const OLD = commit('0ld000', { fields: { svn_revision: 'r1', commit_info: null } })

/** The picker, keeping its value as a page would. */
function renderPicker({
  initial = null as string | null,
  filters = undefined as CommitFilters | undefined,
} = {}) {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <>
        <CommitPicker
          label="Commit"
          schema={SUITE}
          filters={filters}
          value={value}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
        />
        <p data-testid="value">{value ?? 'none'}</p>
        <p>Elsewhere</p>
      </>
    )
  }
  renderWithProviders(<Harness />)
  return { input: screen.getByRole('combobox', { name: 'Commit' }), onChange }
}

function value() {
  return screen.getByTestId('value').textContent
}

function options() {
  return screen.queryAllByRole('option').map((option) => option.textContent)
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }))
}

/**
 * Commits whose value contains the search, as the server would match them, more or less: TAGGED,
 * PLAIN and OTHER on the first page, and OLD on the next.
 */
function serveCommits() {
  return mockCommits((query) => {
    const text = query.get('search') ?? ''
    const matches = [TAGGED, PLAIN, OTHER, OLD].filter((c) => c.value.includes(text))
    if (query.get('cursor') === 'p2') return cursorPage(matches.slice(3))
    return cursorPage(matches.slice(0, 3), matches.length > 3 ? 'p2' : null)
  })
}

describe('CommitPicker', () => {
  it('suggests the commits most recently seen first, by display value', async () => {
    const queries = serveCommits()
    const user = userEvent.setup()
    renderPicker()

    await openList(user)

    await waitFor(() => expect(options()).toEqual(['r100 (v1)', 'abc456', 'r200']))
    expect(queries[0].get('sort')).toBe('-first_seen')
    expect(queries[0].get('limit')).toBe('25')
    expect(queries[0].has('search')).toBe(false)
  })

  it('loads the next page of suggestions when the list is scrolled to its end', async () => {
    const queries = serveCommits()
    const user = userEvent.setup()
    renderPicker()
    await openList(user)
    await waitFor(() => expect(options()).toHaveLength(3))

    scrollToEnd()

    await waitFor(() => expect(options()).toEqual(['r100 (v1)', 'abc456', 'r200', 'r1']))
    expect(queries.map((query) => query.get('cursor'))).toEqual([null, 'p2'])
  })

  it('passes its filters on to the commit list', async () => {
    const queries = serveCommits()
    renderPicker({ filters: { machine: 'linux-x86_64', has_profiles: true } })

    await waitFor(() => expect(queries).toHaveLength(1))
    expect(queries[0].get('machine')).toBe('linux-x86_64')
    expect(queries[0].get('has_profiles')).toBe('true')
  })

  it('searches the server for the text typed', async () => {
    const queries = serveCommits()
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByRole('combobox'), 'abc4')

    await waitFor(() => expect(options()).toEqual(['abc456']))
    expect(queries.at(-1)?.get('search')).toBe('abc4')
  })

  it('never lists the suggestions for a text since changed', async () => {
    const slow = gate()
    const queries = mockCommits(async (query) => {
      const text = query.get('search') ?? ''
      if (text === 'ab') await slow.promise
      return cursorPage([commit(`${text || 'any'}-match`)])
    })
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByRole('combobox'), 'ab')
    await waitFor(() => expect(queries.map((query) => query.get('search'))).toContain('ab'))
    await user.type(screen.getByRole('combobox'), 'c')
    await waitFor(() => expect(options()).toEqual(['abc-match']))

    act(() => slow.open())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(options()).toEqual(['abc-match'])
  })

  it('picks a suggestion that is clicked, showing its display value without resolving it', async () => {
    serveCommits()
    const resolved = mockResolve([TAGGED])
    const user = userEvent.setup()
    const { input, onChange } = renderPicker()

    await openList(user)
    await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))

    expect(value()).toBe('abc123')
    expect(onChange).toHaveBeenCalledWith('abc123')
    expect(input).toHaveValue('r100 (v1)')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resolved).toEqual([])
  })

  it('picks a commit by its commit string, entered with Enter', async () => {
    serveCommits()
    const user = userEvent.setup()
    const { input } = renderPicker()

    await user.type(input, 'def789{Enter}')

    await waitFor(() => expect(value()).toBe('def789'))
    expect(input).toHaveValue('r200')
  })

  it('shows a commit it is given by its display value, resolved through commits/resolve', async () => {
    serveCommits()
    const resolved = mockResolve([OLD])
    const { input } = renderPicker({ initial: OLD.value })

    await waitFor(() => expect(input).toHaveValue('r1'))
    expect(resolved).toEqual([[OLD.value]])
  })

  it('shows a commit it is given as it is, when no commit has that value', async () => {
    serveCommits()
    const resolved = mockResolve([])
    const { input } = renderPicker({ initial: 'deleted' })

    await waitFor(() => expect(resolved).toEqual([['deleted']]))
    expect(input).toHaveValue('deleted')
    expect(value()).toBe('deleted')
  })

  it('clears the selection when the input is emptied', async () => {
    serveCommits()
    mockResolve([TAGGED])
    const user = userEvent.setup()
    const { input, onChange } = renderPicker({ initial: TAGGED.value })
    await waitFor(() => expect(input).toHaveValue('r100 (v1)'))

    await user.clear(input)

    expect(value()).toBe('none')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('keeps its value when left without a pick', async () => {
    serveCommits()
    mockResolve([TAGGED])
    const user = userEvent.setup()
    const { input, onChange } = renderPicker({ initial: TAGGED.value })
    await waitFor(() => expect(input).toHaveValue('r100 (v1)'))

    await user.tripleClick(input)
    await user.keyboard('def')
    await user.click(screen.getByText('Elsewhere'))

    expect(input).toHaveValue('r100 (v1)')
    expect(value()).toBe('abc123')
    expect(onChange).not.toHaveBeenCalled()
  })
})
