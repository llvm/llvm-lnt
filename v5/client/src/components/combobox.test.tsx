import { useState } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { api, unwrap, type Schemas } from '../api/client'
import { errorResponse, mockApi } from '../test/mock-api'
import { scrollToEnd } from '../test/intersection-observer'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { Combobox } from './combobox'
import { useLocalSuggestions, useServerSuggestions, type Suggestion } from './suggestions'

const MACHINES: Suggestion[] = ['linux-x86_64', 'linux-aarch64', 'macos-arm64'].map((name) => ({
  key: name,
  text: name,
}))

interface PickerProps {
  machines?: Suggestion[]
  initial?: Suggestion | null
  onSubmit?: () => void
  onPendingChange?: (pending: boolean) => void
}

/** What the picker holds, which outside elements' roles hide while its list is open. */
function value() {
  return screen.getByTestId('value').textContent
}

function input() {
  return screen.getByRole('combobox')
}

function options() {
  return screen.queryAllByRole('option').map((option) => option.textContent)
}

function listbox() {
  return screen.queryByRole('listbox')
}

/** Open the list with its button, as a mouse user does. */
async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }))
}

function MachinePicker({
  machines = MACHINES,
  initial = null,
  onSubmit,
  onPendingChange,
}: PickerProps) {
  const [picked, setPicked] = useState(initial)
  const suggestions = useLocalSuggestions(machines)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit?.()
      }}
    >
      <Combobox
        label="Machine"
        value={picked}
        onChange={setPicked}
        suggestions={suggestions}
        onPendingChange={onPendingChange}
      />
      <p data-testid="value">{picked?.key ?? 'none'}</p>
      <p>Elsewhere</p>
    </form>
  )
}

describe('Combobox with local suggestions', () => {
  it('narrows the suggestions to those containing the text, whatever its case', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker />)

    await openList(user)
    expect(options()).toEqual(['linux-x86_64', 'linux-aarch64', 'macos-arm64'])
    await user.type(input(), 'LINUX')
    expect(options()).toEqual(['linux-x86_64', 'linux-aarch64'])
  })

  it('picks a suggestion moved to with the arrow keys, on Enter', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker />)

    await user.type(input(), 'linux')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(value()).toBe('linux-aarch64')
    expect(input()).toHaveValue('linux-aarch64')
    expect(listbox()).toBeNull()
  })

  it('picks a suggestion that is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker />)

    await openList(user)
    await user.click(screen.getByRole('option', { name: 'macos-arm64' }))
    expect(value()).toBe('macos-arm64')
    expect(input()).toHaveValue('macos-arm64')
    expect(listbox()).toBeNull()
  })

  it('offers every suggestion again once one is picked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker initial={MACHINES[2]} />)

    await openList(user)
    expect(options()).toHaveLength(3)
  })

  it('puts back the text of its value when left without a pick', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker initial={MACHINES[0]} />)

    // Typed over the whole text, which never empties the input.
    await user.tripleClick(input())
    await user.keyboard('mac')
    await user.click(screen.getByText('Elsewhere'))
    expect(input()).toHaveValue('linux-x86_64')
    expect(value()).toBe('linux-x86_64')
  })

  it('clears its value when the input is emptied', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker initial={MACHINES[0]} />)

    await user.clear(input())
    expect(value()).toBe('none')
    await user.click(screen.getByText('Elsewhere'))
    expect(input()).toHaveValue('')
  })

  it('clears its value with its clear button, keeping the focus in the input', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker initial={MACHINES[0]} />)

    await user.click(screen.getByRole('button', { name: 'Clear Machine' }))

    expect(value()).toBe('none')
    expect(input()).toHaveValue('')
    expect(input()).toHaveFocus()
    expect(listbox()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear Machine' })).not.toBeInTheDocument()
  })

  it('empties text typed but not picked with its clear button', async () => {
    const user = userEvent.setup()
    const onPendingChange = vi.fn()
    renderWithProviders(<MachinePicker onPendingChange={onPendingChange} />)
    expect(screen.queryByRole('button', { name: 'Clear Machine' })).not.toBeInTheDocument()

    await user.type(input(), 'linux')
    // While the list is open, React Aria hides the button from assistive technology, which takes
    // its name away; a mouse can still click it.
    await user.click(screen.getByLabelText('Clear Machine'))

    expect(input()).toHaveValue('')
    expect(value()).toBe('none')
    expect(onPendingChange).toHaveBeenLastCalledWith(false)
    // As when the text is deleted, the list stays open, with every suggestion.
    expect(options()).toEqual(['linux-x86_64', 'linux-aarch64', 'macos-arm64'])
  })

  it('says so when no suggestion matches', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker />)

    await user.type(input(), 'windows')
    expect(within(listbox()!).getByText('No matches.')).toBeInTheDocument()
  })

  it('picks the suggestion whose text is exactly the one entered, without highlighting it', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    renderWithProviders(<MachinePicker onSubmit={onSubmit} />)

    await user.type(input(), '  linux-x86_64 {Enter}')
    expect(value()).toBe('linux-x86_64')
    expect(input()).toHaveValue('linux-x86_64')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('picks the highlighted suggestion on Enter, even when the text matches another', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker machines={NESTED} />)

    await user.type(input(), 'mac')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(value()).toBe('macos-arm64')
  })

  it('leaves the text as it is on Enter when no suggestion is exactly the text', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker initial={MACHINES[0]} />)

    await user.tripleClick(input())
    await user.keyboard('macos{Enter}')
    expect(input()).toHaveValue('macos')
    expect(options()).toEqual(['macos-arm64'])
    expect(value()).toBe('linux-x86_64')
  })

  it('closes the list on Escape, putting back the text of its value', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker initial={MACHINES[0]} />)

    await user.tripleClick(input())
    await user.keyboard('mac{Escape}')
    expect(listbox()).toBeNull()
    expect(input()).toHaveValue('linux-x86_64')
    expect(value()).toBe('linux-x86_64')
  })

  it('holds an Enter pressed before the suggestions have loaded', async () => {
    const user = userEvent.setup()
    function Loading({ machines }: { machines?: Suggestion[] }) {
      const [picked, setPicked] = useState<Suggestion | null>(null)
      const suggestions = useLocalSuggestions(machines)
      return (
        <>
          <Combobox label="Machine" value={picked} onChange={setPicked} suggestions={suggestions} />
          <p data-testid="value">{picked?.key ?? 'none'}</p>
        </>
      )
    }
    const { rerender } = renderWithProviders(<Loading />)

    await user.click(input())
    await user.paste('macos-arm64')
    await user.keyboard('{Enter}')
    expect(value()).toBe('none')
    rerender(<Loading machines={MACHINES} />)
    await waitFor(() => expect(value()).toBe('macos-arm64'))
  })

  it('shows why its suggestions could not be loaded, rather than loading for ever', async () => {
    const user = userEvent.setup()
    function Failed() {
      const suggestions = useLocalSuggestions(undefined, new Error('The machines failed to load'))
      return <Combobox label="Machine" value={null} onChange={() => {}} suggestions={suggestions} />
    }
    renderWithProviders(<Failed />)

    await openList(user)
    expect(within(listbox()!).getByText('The machines failed to load')).toBeInTheDocument()
  })

  it('says whether its input holds text that is not its value', async () => {
    const user = userEvent.setup()
    const onPendingChange = vi.fn()
    renderWithProviders(<MachinePicker initial={MACHINES[0]} onPendingChange={onPendingChange} />)
    const pending = () => onPendingChange.mock.lastCall?.[0]
    expect(pending()).toBe(false)

    await user.tripleClick(input())
    await user.keyboard('mac')
    expect(pending()).toBe(true)
    await user.click(screen.getByRole('option', { name: 'macos-arm64' }))
    expect(pending()).toBe(false)

    await user.type(input(), 'x')
    expect(pending()).toBe(true)
    await user.keyboard('{Backspace}')
    expect(pending()).toBe(false)
    await user.type(input(), 'x')
    await user.click(screen.getByText('Elsewhere'))
    expect(pending()).toBe(false)
    await user.clear(input())
    expect(pending()).toBe(false)
  })

  it('picks nothing on Enter when several suggestions are exactly the text', async () => {
    const user = userEvent.setup()
    renderWithProviders(<MachinePicker machines={TWINS} />)

    await user.type(input(), '(untitled){Enter}')
    expect(value()).toBe('none')
  })
})

/** One machine's name is part of the other's. */
const NESTED: Suggestion[] = [
  { key: 'mac', text: 'mac' },
  { key: 'macos-arm64', text: 'macos-arm64' },
]

/** Two regressions without a title. */
const TWINS: Suggestion[] = [
  { key: 'r1', text: '(untitled)' },
  { key: 'r2', text: '(untitled)' },
]

type Commit = Schemas['Commit']

function commit(value: string, shortSha: string | null = null): Commit {
  return { value, ordinal: null, tag: null, fields: { short_sha: shortSha } }
}

const COMMITS = [
  commit('45c41247f82e5691425542de829d568cdc2fb580', '45c4124'),
  commit('8bb5e216937e6b541f351aa1637c67e85a43ada0', '8bb5e21'),
  commit('014621ede7c175aece29796adcaf5000f891cf0c', '014621e'),
  commit('experiment-vectorizer-v2'),
]

/** Two per page, so that a picker over COMMITS has more to load. */
const PAGE_SIZE = 2

interface Requests {
  /** The search and cursor of each request, as `search@cursor`. */
  seen: string[]
  /** Answer the requests held back so far. */
  release: () => void
}

/**
 * Serves GET commits over COMMITS, matching `search=` on the commit string and short SHA as a
 * searchable field would. While `hold` is set, requests wait until released.
 */
function serveCommits({ hold = false } = {}): Requests {
  const seen: string[] = []
  const waiting: (() => void)[] = []
  server.use(
    mockApi('get', '/api/suites/{testsuite}/commits', async ({ request }) => {
      const url = new URL(request.url)
      const search = url.searchParams.get('search') ?? ''
      const cursor = url.searchParams.get('cursor')
      seen.push(`${search}@${cursor ?? ''}`)
      if (hold) await new Promise<void>((resolve) => waiting.push(resolve))
      const matches = COMMITS.filter(
        (c) => c.value.includes(search) || String(c.fields.short_sha ?? '').includes(search),
      )
      const start = cursor === null ? 0 : Number(cursor)
      const next = start + PAGE_SIZE < matches.length ? String(start + PAGE_SIZE) : null
      return HttpResponse.json({
        items: matches.slice(start, start + PAGE_SIZE),
        cursor: { next, previous: null },
      })
    }),
  )
  return { seen, release: () => waiting.splice(0).forEach((resolve) => resolve()) }
}

/** A commit picker's suggestion: the display value, picked by the commit string too. */
function toSuggestion(c: Commit): Suggestion {
  const display = c.fields.short_sha
  return typeof display === 'string'
    ? { key: c.value, text: display, aliases: [c.value] }
    : { key: c.value, text: c.value }
}

function ServerCommitPicker({ initial = null, delayMs }: { initial?: Suggestion | null; delayMs?: number }) {
  const [picked, setPicked] = useState(initial)
  const suggestions = useServerSuggestions({
    queryKey: ['commits', 'nts'],
    fetchPage: (search, cursor, signal) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/commits', {
          params: {
            path: { testsuite: 'nts' },
            query: { search: search || undefined, cursor, sort: '-first_seen', limit: PAGE_SIZE },
          },
          signal,
        }),
      ),
    toSuggestion,
    delayMs,
  })
  return (
    <>
      <Combobox label="Commit" value={picked} onChange={setPicked} suggestions={suggestions} />
      <p data-testid="value">{picked?.key ?? 'none'}</p>
      <p>Elsewhere</p>
    </>
  )
}

describe('Combobox options', () => {
  function renderWith(props: { isReadOnly?: boolean; hideLabel?: boolean }) {
    function Picker() {
      const suggestions = useLocalSuggestions(MACHINES)
      return (
        <Combobox
          label="Machine"
          value={MACHINES[0]}
          onChange={() => {}}
          suggestions={suggestions}
          {...props}
        />
      )
    }
    renderWithProviders(<Picker />)
  }

  it('can keep its label for assistive technology only', () => {
    renderWith({ hideLabel: true })

    expect(screen.getByRole('combobox', { name: 'Machine' })).toBeInTheDocument()
    expect(screen.getByText('Machine').closest('[style]')).toHaveStyle({ position: 'absolute' })
  })

  it('can be read-only: shown and focusable, but not changed', async () => {
    const user = userEvent.setup()
    renderWith({ isReadOnly: true })

    await user.click(input())
    await user.keyboard('x{ArrowDown}')

    expect(input()).toHaveFocus()
    expect(input()).toHaveValue('linux-x86_64')
    expect(input()).toHaveAttribute('readOnly')
    expect(listbox()).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear Machine' })).not.toBeInTheDocument()
  })
})

describe('Combobox with server-side suggestions', () => {
  it('offers the first page of suggestions, and loads more at the end of the list', async () => {
    const requests = serveCommits()
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker />)

    await openList(user)
    await waitFor(() => expect(options()).toEqual(['45c4124', '8bb5e21']))
    scrollToEnd()
    await waitFor(() => expect(options()).toHaveLength(4))
    expect(options()[3]).toBe('experiment-vectorizer-v2')
    expect(requests.seen).toEqual(['@', '@2'])
  })

  it('starts again from the first page when the server rejects a cursor (I2)', async () => {
    const requests = serveCommits()
    let rejected = false
    server.use(
      mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
        if (rejected || new URL(request.url).searchParams.get('cursor') === null) return undefined
        rejected = true
        requests.seen.push('rejected')
        return errorResponse(400, 'invalid_request', 'This cursor is not valid.')
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker />)

    await openList(user)
    await waitFor(() => expect(options()).toHaveLength(2))
    scrollToEnd()
    await waitFor(() => expect(requests.seen).toEqual(['@', 'rejected', '@']))
    scrollToEnd()
    await waitFor(() => expect(options()).toHaveLength(4))
  })

  it('stops loading more once loading more fails, and says why', async () => {
    const requests = serveCommits()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
        if (new URL(request.url).searchParams.get('cursor') === null) return undefined
        requests.seen.push('failed')
        return errorResponse(500, 'internal_error', 'The server failed.')
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker />)

    await openList(user)
    await waitFor(() => expect(options()).toHaveLength(2))
    scrollToEnd()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The server failed.'))
    // The end of the list stays in view, which must not load more again (and again).
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests.seen.filter((request) => request === 'failed').length).toBeLessThanOrEqual(3)
    expect(options()).toHaveLength(2)
  })

  it('searches once the user stops typing, for the whole text', async () => {
    const requests = serveCommits()
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker />)

    await user.type(input(), '8bb')
    await waitFor(() => expect(options()).toEqual(['8bb5e21']))
    expect(requests.seen).toEqual(['@', '8bb@'])
  })

  it('says that it is loading until the first suggestions arrive', async () => {
    const requests = serveCommits({ hold: true })
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker />)

    await openList(user)
    expect(within(listbox()!).getByText('Loading...')).toBeInTheDocument()
    requests.release()
    await waitFor(() => expect(options()).toHaveLength(2))
  })

  it('shows why the suggestions could not be loaded', async () => {
    server.use(
      mockApi('get', '/api/suites/{testsuite}/commits', () =>
        errorResponse(404, 'not_found', "Test suite 'nts' not found"),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker />)

    await openList(user)
    await waitFor(() =>
      expect(within(listbox()!).getByText("Test suite 'nts' not found")).toBeInTheDocument(),
    )
  })

  it('picks a pasted commit string on Enter, once the search for it has answered', async () => {
    const requests = serveCommits({ hold: true })
    const user = userEvent.setup()
    // Long enough that only the search Enter sends at once can be sent within the test.
    renderWithProviders(<ServerCommitPicker delayMs={60_000} />)

    await user.click(input())
    await user.paste(COMMITS[2].value)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requests.seen).toContain(`${COMMITS[2].value}@`))
    expect(value()).toBe('none')

    requests.release()
    await waitFor(() => expect(value()).toBe(COMMITS[2].value))
    expect(input()).toHaveValue('014621e')
    expect(listbox()).toBeNull()
  })

  it('searches a held Enter at once, even for typed text', async () => {
    const requests = serveCommits()
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker delayMs={60_000} />)

    await user.type(input(), 'experiment-vectorizer-v2{Enter}')
    await waitFor(() => expect(value()).toBe('experiment-vectorizer-v2'))
    expect(requests.seen).toEqual(['@', 'experiment-vectorizer-v2@'])
  })

  it('leaves the text as it is when a held Enter finds no exact match', async () => {
    const requests = serveCommits({ hold: true })
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker initial={toSuggestion(COMMITS[0])} delayMs={60_000} />)

    await user.tripleClick(input())
    await user.paste('8bb')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requests.seen).toContain('8bb@'))
    requests.release()
    await waitFor(() => expect(options()).toEqual(['8bb5e21']))
    expect(input()).toHaveValue('8bb')
    expect(value()).toBe(COMMITS[0].value)
  })

  it('drops a held Enter when the user leaves before the search answers', async () => {
    const requests = serveCommits({ hold: true })
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker delayMs={60_000} />)

    await user.click(input())
    await user.paste(COMMITS[1].value)
    await user.keyboard('{Enter}')
    await user.tab()
    expect(input()).toHaveValue('')
    await waitFor(() => expect(requests.seen).toContain(`${COMMITS[1].value}@`))
    requests.release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(value()).toBe('none')
  })

  it('drops a held Enter when the text changes before the search answers', async () => {
    const requests = serveCommits({ hold: true })
    const user = userEvent.setup()
    renderWithProviders(<ServerCommitPicker delayMs={60_000} />)

    await user.click(input())
    await user.paste(COMMITS[1].value)
    await user.keyboard('{Enter}')
    await user.type(input(), 'x')
    requests.release()
    // The answer for the text Enter was pressed on, shown until the one for the new text arrives.
    await waitFor(() => expect(options()).toEqual(['8bb5e21']))
    expect(value()).toBe('none')
    expect(input()).toHaveValue(`${COMMITS[1].value}x`)
  })

  it('keeps a value that is not among its suggestions', async () => {
    serveCommits()
    const user = userEvent.setup()
    // Not on the first page, as a commit restored from the URL need not be.
    const restored = toSuggestion(COMMITS[3])
    renderWithProviders(<ServerCommitPicker initial={restored} />)

    await openList(user)
    await waitFor(() => expect(options()).toHaveLength(2))
    await user.type(input(), 'zz{Escape}')
    expect(input()).toHaveValue('experiment-vectorizer-v2')
    expect(listbox()).toBeNull()
    await user.type(input(), 'zz')
    await user.click(screen.getByText('Elsewhere'))
    expect(input()).toHaveValue('experiment-vectorizer-v2')
    expect(value()).toBe('experiment-vectorizer-v2')
  })

  it("shows a value's text that arrives later, unless the user is typing", async () => {
    const user = userEvent.setup()
    function Given({ value }: { value: Suggestion | null }) {
      const suggestions = useLocalSuggestions(undefined)
      return <Combobox label="Commit" value={value} onChange={() => {}} suggestions={suggestions} />
    }
    // As a commit restored from the URL is shown until its display value is resolved.
    const unresolved = { key: COMMITS[0].value, text: COMMITS[0].value }
    const { rerender } = renderWithProviders(<Given value={unresolved} />)
    expect(input()).toHaveValue(COMMITS[0].value)

    rerender(<Given value={toSuggestion(COMMITS[0])} />)
    expect(input()).toHaveValue('45c4124')

    await user.tripleClick(input())
    await user.keyboard('typing')
    rerender(<Given value={toSuggestion(COMMITS[1])} />)
    expect(input()).toHaveValue('typing')
  })
})
