import { useState } from 'react'
import { act, screen, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CommitFilters } from '../api/commits'
import { scrollToEnd } from '../test/intersection-observer'
import { SUITE, commit, cursorPage } from '../test/fixtures'
import type { Commit } from '../schema'
import { errorResponse, mockApi } from '../test/mock-api'
import { gate, mockCommits, mockResolve, recording } from '../test/page'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { CommitPicker } from './commit-picker'

const TAGGED = commit('abc123', { tag: 'v1', fields: { svn_revision: 'r100', commit_info: null } })
const PLAIN = commit('abc456')
const OTHER = commit('def789', { fields: { svn_revision: 'r200', commit_info: null } })
/** A commit beyond the first page of suggestions. */
const OLD = commit('0ld000', { fields: { svn_revision: 'r1', commit_info: null } })

interface HarnessProps {
  filters?: CommitFilters
  /** A value the page sets, from outside the picker. */
  given?: string | null
}

/**
 * The picker, keeping its value as a page would. `setFilters` gives it other filters, and `give`
 * sets its value from outside, as a page navigated to another URL would.
 */
function renderPicker({
  initial = null as string | null,
  filters = undefined as CommitFilters | undefined,
} = {}) {
  const onChange = vi.fn()
  function Harness({ filters, given }: HarnessProps) {
    const [value, setValue] = useState(initial)
    const [seen, setSeen] = useState(given)
    if (given !== seen) {
      setSeen(given)
      setValue(given ?? null)
    }
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
  let props: HarnessProps = { filters }
  const { rerender } = renderWithProviders(<Harness {...props} />)
  const update = (changes: HarnessProps) => {
    props = { ...props, ...changes }
    rerender(<Harness {...props} />)
  }
  return {
    input: screen.getByRole('combobox', { name: 'Commit' }),
    onChange,
    // A copy, as a page building its filters afresh would pass.
    setFilters: (next: CommitFilters) => update({ filters: { ...next } }),
    give: (next: string) => update({ given: next }),
  }
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

/** The commits with a run on each machine: every one on linux, and only TAGGED on darwin. */
const ON_MACHINE: Record<string, Commit[]> = {
  linux: [TAGGED, PLAIN, OTHER, OLD],
  darwin: [TAGGED],
}

/**
 * The commits the server would list, more or less: those on the `machine=` given, if any, whose
 * value contains the search, or is the `commit=` given. Without filters, TAGGED, PLAIN and OTHER
 * are on the first page, and OLD on the next. A machine of neither is a 404 (E3).
 */
function serveCommits() {
  const { queries, answer } = recording((query) => {
    const text = query.get('search') ?? ''
    const exact = query.get('commit')
    const onMachine = ON_MACHINE[query.get('machine') ?? 'linux']
    if (onMachine === undefined) return null
    const matches = onMachine.filter(
      (c) => c.value.includes(text) && (exact === null || c.value === exact),
    )
    if (query.get('cursor') === 'p2') return cursorPage(matches.slice(3))
    return cursorPage(matches.slice(0, 3), matches.length > 3 ? 'p2' : null)
  })
  server.use(
    mockApi('get', '/api/suites/{testsuite}/commits', async ({ request }) => {
      const page = await answer(request)
      return page ? HttpResponse.json(page) : errorResponse(404, 'not_found', 'No such machine')
    }),
  )
  return queries
}

/** The lookups of a commit given to the picker (AR2), among the requests `queries` recorded. */
function lookups(queries: URLSearchParams[]) {
  return queries.filter((query) => query.has('commit'))
}

/** Let any request a render triggers go out, and its answer come back. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50))
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
    // Without a value, there is nothing to look up.
    expect(lookups(queries)).toEqual([])
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
    await settle()
    expect(options()).toEqual(['abc-match'])
  })

  it('picks a suggestion that is clicked, showing its display value without looking it up', async () => {
    const queries = serveCommits()
    const user = userEvent.setup()
    const { input, onChange } = renderPicker()

    await openList(user)
    await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))

    expect(value()).toBe('abc123')
    expect(onChange).toHaveBeenCalledWith('abc123')
    expect(input).toHaveValue('r100 (v1)')
    await settle()
    expect(lookups(queries)).toEqual([])
  })

  it('picks a commit by its commit string, entered with Enter', async () => {
    serveCommits()
    const user = userEvent.setup()
    const { input } = renderPicker()

    await user.type(input, 'def789{Enter}')

    await waitFor(() => expect(value()).toBe('def789'))
    expect(input).toHaveValue('r200')
  })

  it('shows a commit it is given by its display value, looked up under its filters', async () => {
    const queries = serveCommits()
    const resolved = mockResolve([OLD])
    const { input } = renderPicker({ initial: OLD.value, filters: { machine: 'linux' } })

    await waitFor(() => expect(input).toHaveValue('r1'))
    const [lookup] = lookups(queries)
    expect(lookup.get('commit')).toBe(OLD.value)
    // The request of its suggestions, narrowed to the commit.
    expect(lookup.get('machine')).toBe('linux')
    expect(lookup.get('sort')).toBe('-first_seen')
    expect(resolved).toEqual([])
  })

  it.each([
    // A commit deleted since the URL naming it was shared, say.
    ['no commit has', { initial: 'deleted' }],
    // A machine with no run at that commit.
    ['its filters exclude', { initial: PLAIN.value, filters: { machine: 'darwin' } }],
  ])('is cleared when it is given a commit that %s', async (_, options) => {
    serveCommits()
    const { input, onChange } = renderPicker(options)

    await waitFor(() => expect(value()).toBe('none'))
    expect(onChange).toHaveBeenCalledWith(null)
    expect(input).toHaveValue('')
  })

  it.each([
    [500, 'internal_error'],
    [404, 'not_found'],
  ])('keeps a commit it is given when looking it up fails with a %i', async (status, code) => {
    // A failed request shows nothing about the commit (AR2 "State"): the server may be down, or the
    // machine of the filters may be the one that is unknown.
    const failed = gate()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
        const query = new URL(request.url).searchParams
        if (!query.has('commit')) return HttpResponse.json(cursorPage([]))
        failed.open()
        return errorResponse(status, code, 'No luck')
      }),
    )
    const { input, onChange } = renderPicker({ initial: OLD.value, filters: { machine: 'gone' } })

    await failed.promise
    await settle()
    expect(value()).toBe(OLD.value)
    expect(input).toHaveValue(OLD.value)
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([
    [
      'picked',
      async () => {
        const user = userEvent.setup()
        const picker = renderPicker({ filters: { machine: 'linux' } })
        await openList(user)
        await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))
        return picker
      },
    ],
    [
      'given',
      async () => {
        const picker = renderPicker({ initial: TAGGED.value, filters: { machine: 'linux' } })
        await waitFor(() => expect(picker.input).toHaveValue('r100 (v1)'))
        return picker
      },
    ],
  ])('checks a commit %s under other filters against the new ones, keeping its text', async (
    _,
    setUp,
  ) => {
    serveCommits()
    const { input, setFilters } = await setUp()

    const slow = gate()
    const queries = mockCommits(async () => {
      await slow.promise
      return cursorPage([TAGGED])
    })
    setFilters({ machine: 'darwin' })

    await waitFor(() => expect(lookups(queries)).toHaveLength(1))
    expect(lookups(queries)[0].get('machine')).toBe('darwin')
    // No flicker to the commit string while the lookup is under way.
    expect(input).toHaveValue('r100 (v1)')
    act(() => slow.open())
    await settle()
    expect(input).toHaveValue('r100 (v1)')
    expect(value()).toBe(TAGGED.value)
  })

  it('never offers the suggestions of its previous filters while the new ones load', async () => {
    // Otherwise one could be picked, and taken for a commit the new filters offer.
    serveCommits()
    const user = userEvent.setup()
    const { setFilters } = renderPicker({ filters: { machine: 'linux' } })
    await openList(user)
    await waitFor(() => expect(options()).toEqual(['r100 (v1)', 'abc456', 'r200']))

    const slow = gate()
    mockCommits(async () => {
      await slow.promise
      return cursorPage([TAGGED])
    })
    setFilters({ machine: 'darwin' })

    await waitFor(() => expect(options()).not.toContain('abc456'))
    expect(options()).not.toContain('r100 (v1)')
    act(() => slow.open())
    await waitFor(() => expect(options()).toEqual(['r100 (v1)']))
  })

  it('never shows the previous commit while looking up one it is given', async () => {
    serveCommits()
    const { input, give } = renderPicker({ initial: TAGGED.value })
    await waitFor(() => expect(input).toHaveValue('r100 (v1)'))

    const slow = gate()
    const queries = mockCommits(async () => {
      await slow.promise
      return cursorPage([OTHER])
    })
    give(OTHER.value)

    await waitFor(() => expect(lookups(queries)).toHaveLength(1))
    expect(input).toHaveValue(OTHER.value)
    act(() => slow.open())
    await waitFor(() => expect(input).toHaveValue('r200'))
  })

  it('is cleared when its filters change to ones that exclude the commit picked', async () => {
    serveCommits()
    const user = userEvent.setup()
    const { input, onChange, setFilters } = renderPicker({ filters: { machine: 'linux' } })
    await openList(user)
    await user.click(await screen.findByRole('option', { name: 'abc456' }))

    setFilters({ machine: 'darwin' })

    await waitFor(() => expect(value()).toBe('none'))
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(input).toHaveValue('')
  })

  it('does not look up a commit picked again when the filters only look different', async () => {
    const queries = serveCommits()
    const user = userEvent.setup()
    const { setFilters } = renderPicker({ filters: { machine: 'linux' } })
    await openList(user)
    await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))

    setFilters({ machine: 'linux' })

    await settle()
    expect(lookups(queries)).toEqual([])
  })

  it('keeps a commit picked after an earlier lookup of it found nothing', async () => {
    // The lookup's answer for the commit stays cached, but no longer says anything once the commit
    // has been picked from the suggestions, as it can be if it was created since.
    mockCommits((query) => cursorPage(query.has('commit') ? [] : [PLAIN]))
    const user = userEvent.setup()
    const { input } = renderPicker({ initial: PLAIN.value })
    await waitFor(() => expect(value()).toBe('none'))

    await openList(user)
    await user.click(await screen.findByRole('option', { name: 'abc456' }))

    await settle()
    expect(value()).toBe(PLAIN.value)
    expect(input).toHaveValue('abc456')
  })

  it('clears the selection when the input is emptied', async () => {
    serveCommits()
    const user = userEvent.setup()
    const { input, onChange } = renderPicker({ initial: TAGGED.value })
    await waitFor(() => expect(input).toHaveValue('r100 (v1)'))

    await user.clear(input)

    expect(value()).toBe('none')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('keeps its value when left without a pick', async () => {
    serveCommits()
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
