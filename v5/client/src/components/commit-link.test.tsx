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
import { CommitCardButton, CommitLink, ListedCommitLink } from './commit-link'
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
  await switchToFakeTimers()
  return rendered
}

/** Once the page has rendered, which takes real time, switch to fake timers. */
async function switchToFakeTimers() {
  await screen.findByText('Elsewhere')
  vi.useFakeTimers()
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

/** The link, rather than its card's link to the same page. */
function link() {
  const links = screen.getAllByRole('link', { name: /^(r593922|014621)/ })
  return links.find((link) => link.closest('[role="group"]') === null)!
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

  it.each([
    ['outside the card', async () => {}],
    [
      'inside the card',
      async () => {
        await user.click(within(card()).getByRole('button', { name: 'Copy commit' }))
      },
    ],
  ])(
    'does not consume Escape, which whatever else it is for still gets, with the focus %s',
    async (_, focus) => {
      const keys: KeyboardEvent[] = []
      const onKeyDown = (event: KeyboardEvent) => keys.push(event)
      await renderLink()
      mockClipboard()
      document.addEventListener('keydown', onKeyDown)
      try {
        await open()
        await focus()
        await user.keyboard('{Escape}')
        expect(keys.map((event) => [event.key, event.defaultPrevented])).toEqual([
          ['Escape', false],
        ])
        expect(queryCard()).toBeNull()
      } finally {
        document.removeEventListener('keydown', onKeyDown)
      }
    },
  )

  it('does not open on Escape before its delay has passed', async () => {
    await renderLink()
    await user.hover(link())
    await wait(OPEN_DELAY_MS - 1)
    await user.keyboard('{Escape}')
    await wait(OPEN_DELAY_MS * 10)
    expect(queryCard()).toBeNull()
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

  it('closes when its link moves, rather than be left behind', async () => {
    await renderLink()
    const rect = (top: number) => DOMRect.fromRect({ x: 10, y: top, width: 50, height: 16 })
    const at = vi.spyOn(link(), 'getBoundingClientRect').mockReturnValue(rect(100))
    await open()
    // Not for less than a pixel.
    at.mockReturnValue(rect(100.5))
    await wait(100)
    expect(queryCard()).not.toBeNull()

    // Moved by what need not render it again, such as a box holding it growing (GR11).
    at.mockReturnValue(rect(120))
    await wait(20)

    expect(queryCard()).toBeNull()
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
    await user.click(within(card()).getByRole('button', { name: 'Copy commit' }))
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

describe('a ⓘ', () => {
  /** Render the ⓘ between a text box and another, as `renderLink` does. */
  async function renderButton() {
    renderWithProviders(
      <>
        <input aria-label="Search" />
        <CommitCardButton schema={SUITE} value={HASH} commit={FULL} aria-label="Commit r593922">
          ⓘ
        </CommitCardButton>
        <input aria-label="After" />
        <p>Elsewhere</p>
      </>,
    )
    await switchToFakeTimers()
  }

  const button = () => screen.getByRole('button', { name: 'Commit r593922' })
  const commitPageLink = () => within(card()).getByRole('link', { name: HASH })
  const leave = () => user.hover(screen.getByText('Elsewhere'))

  it('is a button, which opens its card on hover, as a link does', async () => {
    await renderButton()
    expect(button()).not.toHaveAttribute('href')
    expect(button()).toHaveAttribute('aria-expanded', 'false')
    await user.hover(button())
    await wait(OPEN_DELAY_MS)
    expect(button()).toHaveAttribute('aria-expanded', 'true')
    expect(button()).toHaveAttribute('aria-details', card().id)
    expect(button()).toHaveAttribute('aria-controls', card().id)

    await leave()
    await wait(CLOSE_DELAY_MS)
    expect(queryCard()).toBeNull()
    expect(button()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens its card at once when clicked, and keeps it open wherever the pointer goes', async () => {
    await renderButton()
    await user.click(button())
    expect(card()).toHaveAccessibleName('r593922 (llvm-22.0)')
    expect(button()).toHaveAttribute('aria-expanded', 'true')
    expect(button()).toHaveFocus()

    // Over the card and out of it, the card's own leaving closing nothing either.
    await user.hover(card())
    await leave()
    await wait(CLOSE_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()
  })

  it('keeps open the card that hovering opened, and closes it when clicked again', async () => {
    await renderButton()
    await user.hover(button())
    await wait(OPEN_DELAY_MS)
    await user.click(button())
    await leave()
    await wait(CLOSE_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()

    await user.click(button())
    expect(queryCard()).toBeNull()
    // Not opened again by the pointer still on it, until it leaves and comes back.
    await wait(OPEN_DELAY_MS * 10)
    expect(queryCard()).toBeNull()
    await leave()
    await user.hover(button())
    await wait(OPEN_DELAY_MS)
    expect(queryCard()).not.toBeNull()
  })

  it('opens its card when pressed while hovering is about to', async () => {
    await renderButton()
    await user.hover(button())
    await wait(OPEN_DELAY_MS - 1)
    await user.click(button())
    await leave()
    await wait(OPEN_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()
  })

  it('keeps its card open when tapped, until tapped again', async () => {
    await renderButton()
    await user.pointer({ keys: '[TouchA]', target: button() })
    expect(queryCard()).not.toBeNull()
    await wait(CLOSE_DELAY_MS * 10)
    expect(queryCard()).not.toBeNull()
    await user.pointer({ keys: '[TouchA]', target: button() })
    expect(queryCard()).toBeNull()
  })

  it.each(['{Enter}', ' '])('keeps its card open when activated with %s', async (key) => {
    await renderButton()
    await user.tab()
    await user.tab()
    expect(button()).toHaveFocus()
    // Not on focus alone.
    await wait(OPEN_DELAY_MS * 10)
    expect(queryCard()).toBeNull()

    await user.keyboard(key)
    expect(queryCard()).not.toBeNull()
    expect(button()).toHaveFocus()
  })

  it('leads Tab into the card it keeps open, and Shift+Tab back to it', async () => {
    await renderButton()
    await user.click(button())
    await user.tab()
    expect(commitPageLink()).toHaveFocus()
    await user.tab({ shift: true })
    expect(button()).toHaveFocus()
    expect(queryCard()).not.toBeNull()
  })

  it('leaves Tab alone when its card is not kept open', async () => {
    await renderButton()
    await user.hover(button())
    await wait(OPEN_DELAY_MS)
    button().focus()
    await user.tab()
    expect(screen.getByRole('textbox', { name: 'After' })).toHaveFocus()
  })

  it('closes its card on Escape, giving the focus back to it', async () => {
    await renderButton()
    await user.click(button())
    await user.tab()
    await user.keyboard('{Escape}')
    expect(queryCard()).toBeNull()
    expect(button()).toHaveFocus()
  })

  it('closes its card on a press outside both, leaving the focus where the press put it', async () => {
    await renderButton()
    await user.click(button())
    await user.click(within(card()).getByText('Ordinal'))
    expect(queryCard()).not.toBeNull()
    await user.tab()
    expect(commitPageLink()).toHaveFocus()

    await user.click(screen.getByRole('textbox', { name: 'After' }))
    expect(queryCard()).toBeNull()
    expect(screen.getByRole('textbox', { name: 'After' })).toHaveFocus()
  })

  it('closes its card when the focus moves to another element outside both', async () => {
    await renderButton()
    await user.click(button())
    act(() => screen.getByRole('textbox', { name: 'Search' }).focus())
    expect(queryCard()).toBeNull()
  })

  it('keeps its card open when the focus leaves the window', async () => {
    await renderButton()
    await user.click(button())
    act(() => button().blur())
    expect(queryCard()).not.toBeNull()
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
    // The commit string, linking to the commit's page, with the button copying it after it.
    expect(values[0]).toHaveTextContent(HASH)
    expect(within(values[0]).getByRole('link', { name: HASH })).toHaveAttribute(
      'href',
      `/suites/libcxx/commits/${HASH}`,
    )
    const copy = within(values[0]).getByRole('button', { name: 'Copy commit' })
    expect(copy).toHaveAttribute('title', 'Copy commit')
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

    await user.click(copy)
    expect(writeText).toHaveBeenCalledWith(HASH)
    await waitFor(() => expect(copy).toHaveAccessibleName('Copied.'))
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
