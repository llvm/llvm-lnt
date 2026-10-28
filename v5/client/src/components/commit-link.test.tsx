import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitChanged } from '../api/commits'
import type { SuiteSchema } from '../api/suites'
import { mockClipboard } from '../test/clipboard'
import { NO_REPOSITORY, SUITE, commit } from '../test/fixtures'
import { errorResponse, mockApi } from '../test/mock-api'
import { mockResolve } from '../test/page'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import type { Commit } from '../schema'
import { CommitLink, ListedCommitLink } from './commit-link'
import { CLOSE_DELAY_MS, OPEN_DELAY_MS } from './use-hover-card'

const HASH = '014621ede7c175aece29796adcaf5000f891cf0c'

/** A suite with fields of every kind a card shows differently. */
const FIELDS_SUITE: SuiteSchema = {
  ...SUITE,
  commit_fields: [
    ...SUITE.commit_fields,
    {
      name: 'author',
      type: 'text',
      display_name: 'Author',
      searchable: false,
      display: false,
      listed: false,
    },
    {
      name: 'review',
      type: 'text',
      display_name: null,
      searchable: false,
      display: false,
      listed: false,
    },
    {
      name: 'committed_at',
      type: 'datetime',
      display_name: null,
      searchable: false,
      display: false,
      listed: false,
    },
  ],
}

const FULL = commit(HASH, {
  ordinal: 593922,
  tag: 'llvm-22.0',
  fields: {
    svn_revision: 'r593922',
    commit_info: '[libc++] Optimize std::find\n\nA long description.',
    author: null,
    review: 'https://github.com/llvm/llvm-project/pull/1',
    committed_at: '2026-08-25T14:22:41Z',
  },
})

let user: ReturnType<typeof userEvent.setup>

afterEach(async () => {
  // Some timers outlive a test, such as the one after which React Aria stops ignoring the mouse
  // events that follow a touch: run them, so that no test depends on the one before it.
  await act(() => vi.runOnlyPendingTimersAsync())
  vi.useRealTimers()
})

/** Let `ms` pass, and whatever it lets happen. */
function wait(ms: number) {
  return act(() => vi.advanceTimersByTimeAsync(ms))
}

/**
 * Render the link, between other things, and once the page has rendered, which takes real time,
 * switch to fake timers, to control when the card opens and closes.
 */
async function renderLink({
  schema = SUITE,
  given = FULL as Commit | null,
  value = HASH,
  listed = true,
} = {}) {
  const rendered = renderWithProviders(
    <>
      <input aria-label="Search" />
      {listed ? (
        <ListedCommitLink schema={schema} value={value} commit={given ?? undefined} />
      ) : (
        <CommitLink schema={schema} value={value} />
      )}
      <p>Elsewhere</p>
    </>,
  )
  await screen.findByText('Elsewhere')
  vi.useFakeTimers()
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  return rendered
}

function link() {
  return screen.getByRole('link', { name: /^(r593922|014621)/ })
}

function card() {
  return screen.getByRole('group')
}

function queryCard() {
  return screen.queryByRole('group')
}

async function open() {
  await user.hover(link())
  await wait(OPEN_DELAY_MS)
  return card()
}

describe('the hover mechanics', () => {
  it('opens once the pointer has rested on the link for a while', async () => {
    await renderLink()
    await user.hover(link())
    await wait(OPEN_DELAY_MS - 1)
    expect(queryCard()).toBeNull()
    await wait(1)
    expect(card()).toHaveAccessibleName('r593922 (llvm-22.0)')
  })

  it('does not open when the pointer leaves the link before then', async () => {
    await renderLink()
    await user.hover(link())
    await wait(OPEN_DELAY_MS - 1)
    await user.hover(screen.getByText('Elsewhere'))
    await wait(OPEN_DELAY_MS)
    expect(queryCard()).toBeNull()
  })

  it('stays open while the pointer is on the card, and closes a while after it leaves both', async () => {
    await renderLink()
    await user.hover(link())
    await wait(OPEN_DELAY_MS)
    await user.hover(card())
    await wait(CLOSE_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()

    await user.hover(screen.getByText('Elsewhere'))
    await wait(CLOSE_DELAY_MS - 1)
    expect(queryCard()).not.toBeNull()
    await wait(1)
    expect(queryCard()).toBeNull()
  })

  it('stays open when the pointer comes back to the link in time', async () => {
    await renderLink()
    await open()
    await user.hover(screen.getByText('Elsewhere'))
    await wait(CLOSE_DELAY_MS - 1)
    await user.hover(link())
    await wait(CLOSE_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()
  })

  it('closes on Escape, and opens again only once the pointer has left the link', async () => {
    await renderLink()
    await open()
    await user.keyboard('{Escape}')
    expect(queryCard()).toBeNull()
    await wait(OPEN_DELAY_MS * 2)
    expect(queryCard()).toBeNull()

    await user.hover(screen.getByText('Elsewhere'))
    await open()
    expect(queryCard()).not.toBeNull()
  })

  it('does not consume Escape, which whatever else it is for still gets', async () => {
    const onKeyDown = vi.fn()
    await renderLink()
    document.addEventListener('keydown', onKeyDown)
    try {
      await open()
      await user.keyboard('{Escape}')
      expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ defaultPrevented: false }))
    } finally {
      document.removeEventListener('keydown', onKeyDown)
    }
  })

  it('stays open on the card after one closed under the pointer', async () => {
    await renderLink()
    await open()
    await user.hover(card())
    await user.keyboard('{Escape}')
    expect(queryCard()).toBeNull()

    await open()
    await user.hover(card())
    await wait(CLOSE_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()
  })

  it('does not open on keyboard focus', async () => {
    await renderLink()
    await user.tab()
    await user.tab()
    expect(link()).toHaveFocus()
    await wait(OPEN_DELAY_MS * 10)
    expect(queryCard()).toBeNull()
  })

  it('does not open on touch', async () => {
    await renderLink()
    const touched = vi.fn()
    link().addEventListener('pointerover', (event) => touched(event.pointerType))
    await user.pointer({ keys: '[TouchA>]', target: link() })
    expect(touched).toHaveBeenCalledWith('touch')
    await wait(OPEN_DELAY_MS * 10)
    expect(queryCard()).toBeNull()
  })

  it('gives the focus back to the link when it closes with the focus inside', async () => {
    await renderLink()
    mockClipboard()
    await user.click(screen.getByRole('textbox', { name: 'Search' }))
    await open()
    await user.click(within(card()).getByRole('button', { name: 'Copy' }))
    await user.hover(screen.getByText('Elsewhere'))
    await wait(CLOSE_DELAY_MS + 100)
    expect(queryCard()).toBeNull()
    expect(link()).toHaveFocus()
  })

  it('refers the link to the card as its details while open', async () => {
    await renderLink()
    expect(link()).not.toHaveAttribute('aria-details')
    const shown = await open()
    expect(link()).toHaveAttribute('aria-details', shown.id)
  })
})

describe('the content', () => {
  it('shows the commit, its ordinal and every field it has a value for, in schema order', async () => {
    await renderLink({ schema: FIELDS_SUITE })
    // After `renderLink`, whose `userEvent.setup` installs a clipboard of its own.
    const writeText = mockClipboard()
    const shown = await open()

    expect(within(shown).getByText('r593922 (llvm-22.0)')).toBeInTheDocument()
    const labels = within(shown)
      .getAllByRole('term')
      .map((term) => term.textContent)
    // Not the author, which has no value.
    expect(labels).toEqual([
      'Commit',
      'Ordinal',
      'svn_revision',
      'commit_info',
      'review',
      'committed_at',
    ])
    const values = within(shown).getAllByRole('definition')
    expect(values[0]).toHaveTextContent(HASH)
    expect(values[1]).toHaveTextContent('593922')
    expect(values[2]).toHaveTextContent('r593922')
    // Cut to two lines, but whole in the page.
    expect(values[3].firstElementChild).toHaveClass('clamped')
    expect(values[3]).toHaveTextContent('[libc++] Optimize std::find A long description.')
    expect(within(values[4]).getByRole('link')).toHaveAttribute(
      'href',
      'https://github.com/llvm/llvm-project/pull/1',
    )
    expect(values[5]).toHaveTextContent('2026-08-25, 2:22:41 PM')

    await user.click(within(shown).getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(HASH)
  })

  it('has no ordinal row for a commit without one, and its commit string as its heading', async () => {
    await renderLink({ given: commit(HASH) })
    await open()
    expect(card()).toHaveAccessibleName(HASH)
    const labels = within(card())
      .getAllByRole('term')
      .map((term) => term.textContent)
    expect(labels).toEqual(['Commit'])
  })

  it('links the commit into the repository', async () => {
    await renderLink()
    expect(within(await open()).getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      `https://github.com/llvm/llvm-project/commit/${HASH}`,
    )
  })

  it('does not when the suite has no template of a commit URL', async () => {
    await renderLink({ schema: { ...SUITE, repository: NO_REPOSITORY } })
    expect(within(await open()).queryByRole('link', { name: /^View/ })).toBeNull()
  })
})

describe('the data', () => {
  it('uses the commit the page loaded, without asking for it', async () => {
    const requests = mockResolve([FULL])
    await renderLink()
    await open()
    await wait(100)
    expect(requests).toEqual([])
  })

  it('fetches a commit the page has not loaded, only once shown', async () => {
    const requests = mockResolve([FULL])
    await renderLink({ given: null })
    await wait(100)
    expect(requests).toEqual([])

    await open()
    expect(within(card()).getByRole('status')).toHaveTextContent('Loading the commit...')
    await waitFor(() => expect(card()).toHaveAccessibleName('r593922 (llvm-22.0)'))
    expect(requests).toEqual([[HASH]])
  })

  it('says why it could not fetch the commit, and tries again', async () => {
    let fail = true
    server.use(
      mockApi('post', '/api/suites/{testsuite}/commits/resolve', () =>
        fail
          ? errorResponse(500, 'internal', 'Boom.')
          : HttpResponse.json({ results: { [HASH]: FULL }, not_found: [] }),
      ),
    )
    await renderLink({ given: null })
    await open()
    await waitFor(() =>
      expect(within(card()).getByRole('alert')).toHaveTextContent('Could not load the commit'),
    )

    fail = false
    await user.click(within(card()).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(card()).toHaveAccessibleName('r593922 (llvm-22.0)'))
  })

  it('says that a commit deleted since no longer exists, without offering to try again', async () => {
    mockResolve([])
    await renderLink({ given: null })
    await open()
    await waitFor(() =>
      expect(within(card()).getByText('This commit no longer exists.')).toBeInTheDocument(),
    )
    expect(within(card()).queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('shares the resolution of a link that resolves its own commit', async () => {
    const requests = mockResolve([FULL])
    await renderLink({ listed: false })
    await waitFor(() => expect(link()).toHaveTextContent('r593922 (llvm-22.0)'))
    await open()
    await wait(100)
    expect(requests).toEqual([[HASH]])
  })

  it('shows a fetched commit as changed since', async () => {
    mockResolve([FULL])
    const { queryClient } = await renderLink({ given: null })
    await open()
    await waitFor(() => expect(card()).toHaveAccessibleName('r593922 (llvm-22.0)'))
    await user.hover(screen.getByText('Elsewhere'))
    await wait(CLOSE_DELAY_MS)

    mockResolve([{ ...FULL, tag: 'llvm-23.0' }])
    await act(() => commitChanged(queryClient, SUITE.name))
    await open()
    await waitFor(() => expect(card()).toHaveAccessibleName('r593922 (llvm-23.0)'))
  })
})
