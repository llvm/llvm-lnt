import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { schemaOf, type ProjectName, type Suite } from '../../api/suites'
import { TOKEN_STORAGE_KEY } from '../../auth/storage-key'
import { TOKEN, changeInAnotherTab, entry, signIn, whole } from '../../test/auth'
import { dragByKeyboard, press } from '../../test/drag-reorder'
import { BARE_SUITE, SUITE, cursorPage } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  chipLink,
  chipTexts,
  currentUrl,
  gate,
  mockMachines,
  mockRuns,
  mockSuites,
  projectOf,
  renderPage,
  type SuiteStore,
} from '../../test/page'
import { server } from '../../test/server'

const SWIFT: ProjectName = { name: 'swift', display_name: 'Swift' }

/** A third suite of llvm, with a display name. */
const THIRD: Suite = { ...BARE_SUITE, name: 'third', display_name: 'Third' }

beforeEach(() => {
  mockMachines(() => ({ items: [] }))
  mockRuns(() => cursorPage([]))
})

/** The button putting the row of suites in its reordering mode, or leaving it. */
function toggle() {
  return screen.getByRole('button', { name: /^(Reorder suites|Done)$/ })
}

/** The grip dragging the suite labelled `label`, in the reordering mode. */
function grip(label: string) {
  return screen.getByRole('button', { name: `Drag suite ${label}` })
}

/** The list item of the suite labelled `label`, in the reordering mode. */
function chipItem(label: string) {
  return grip(label).closest('li')!
}

/**
 * The labels of the suites' chips in the reordering mode, in order: their own text, without their
 * grips' and the reasons these give for being disabled.
 */
function reorderedTexts() {
  return within(screen.getByRole('list', { name: 'Test suites' }))
    .getAllByRole('listitem')
    .map((item) =>
      [...item.firstElementChild!.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(''),
    )
}

interface Options {
  fail?: () => ReturnType<typeof errorResponse>
  wait?: () => Promise<void>
}

/**
 * Answer the reordering of a project's suites (E10) by applying it to `store`, once `wait`
 * resolves, or with `fail`; returns each request's project, body and `Authorization`.
 */
function mockReorder(store: SuiteStore, { fail, wait }: Options = {}) {
  const sent: { project: string; body: unknown; auth: string | null }[] = []
  server.use(
    mockApi('patch', '/api/projects/{project}/suites', async ({ request, params }) => {
      const body = await request.json()
      sent.push({ project: params.project, body, auth: request.headers.get('Authorization') })
      await wait?.()
      if (fail) return fail()
      const held = store.suites.filter((suite) => projectOf(suite).name === params.project)
      const reordered = body.order.map((name) => held.find((suite) => suite.name === name)!)
      store.suites = [...store.suites.filter((suite) => !held.includes(suite)), ...reordered]
      return HttpResponse.json({ items: reordered.map((suite) => schemaOf(suite as Suite)) })
    }),
  )
  return sent
}

/**
 * The Projects page at llvm's first suite, llvm holding three suites, to a holder of `manage`
 * restricted to `restrictedTo` unless null, once the token is accepted.
 */
async function renderRow({
  restrictedTo = null,
}: { restrictedTo?: Parameters<typeof signIn>[1] } = {}) {
  signIn('manage', restrictedTo)
  const stdlib = { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }
  const store = mockSuites([SUITE, BARE_SUITE, THIRD, stdlib])
  renderPage('/projects/llvm/suites/libcxx')
  await waitFor(() => expect(toggle()).toBeEnabled())
  return store
}

describe('reordering the suites', () => {
  it('needs two suites or more', async () => {
    signIn('manage')
    mockSuites([SUITE, { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }])
    renderPage('/projects/swift/suites/stdlib')

    await waitFor(() => expect(chipTexts('Test suites')).toEqual(['stdlib']))
    expect(screen.queryByRole('button', { name: 'Reorder suites' })).not.toBeInTheDocument()
  })

  it('needs a token covering the project in full, saying what it does and needs', async () => {
    signIn('manage', [entry('libcxx')])
    mockSuites()
    renderPage('/projects/llvm/suites/libcxx')

    await waitFor(() =>
      expect(toggle()).toHaveAttribute(
        'title',
        "Reorder suites: Needs an API token with the 'manage' scope covering project 'llvm' in " +
          "full. The token in Settings has the 'manage' scope, covering only 'llvm › libcxx'.",
      ),
    )
    expect(toggle()).toBeDisabled()
  })

  it('makes the chips draggable by a grip, rather than links, until Done', async () => {
    await renderRow({ restrictedTo: [whole('llvm')] })
    expect(toggle()).toHaveAttribute('title', 'Reorder suites')
    const button = toggle()

    fireEvent.click(button)

    expect(screen.queryByRole('navigation', { name: 'Test suites' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'libcxx' })).not.toBeInTheDocument()
    expect(reorderedTexts()).toEqual(['libcxx', 'nts', 'Third'])
    expect(grip('libcxx')).toBeEnabled()
    // Not a link, but the current one all the same.
    expect(chipItem('libcxx')).toHaveAttribute('aria-current', 'true')
    expect(chipItem('nts')).not.toHaveAttribute('aria-current')
    // The same button, which keeps the focus.
    expect(button).toHaveAccessibleName('Done')
    fireEvent.click(button)
    expect(button).toHaveAccessibleName('Reorder suites')
    expect(chipTexts('Test suites')).toEqual(['libcxx', 'nts', 'Third'])
    expect(chipLink('Test suites', 'libcxx')).toHaveAttribute('aria-current', 'page')
  })

  it('shows where a suite would go with a line beside a chip', async () => {
    await renderRow()
    fireEvent.click(toggle())

    act(() => grip('Third').focus())
    act(() => press('Enter'))
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName('Leave suite Third where it is'),
    )
    expect(chipItem('Third')).toHaveClass('dragging')
    // From the last place, round to the first.
    act(() => press('Tab'))

    expect(document.activeElement).toHaveAccessibleName('Before suite libcxx')
    expect(chipItem('libcxx')).toHaveClass('horizontal', 'before')
    act(() => press('Escape'))
    expect(chipItem('libcxx')).not.toHaveClass('before')
  })

  it("sends the project's suites in their new order on a drop, and shows them so", async () => {
    const store = await renderRow()
    const sent = mockReorder(store)
    fireEvent.click(toggle())

    await dragByKeyboard('Drag suite Third', 'Before suite nts')

    await waitFor(() => expect(sent).toHaveLength(1))
    await waitFor(() => expect(grip('Third')).not.toHaveAttribute('aria-disabled'))
    expect(reorderedTexts()).toEqual(['libcxx', 'Third', 'nts'])
    expect(sent).toEqual([
      { project: 'llvm', body: { order: ['libcxx', 'third', 'nts'] }, auth: `Bearer ${TOKEN}` },
    ])
    expect(grip('Third')).toHaveFocus()
    // Without fetching the list again.
    expect(store.requests).toBe(1)
    fireEvent.click(toggle())
    expect(chipTexts('Test suites')).toEqual(['libcxx', 'Third', 'nts'])
  })

  it('shows the new order while saving, even once the mode is left, dropping nothing else', async () => {
    const store = await renderRow()
    const held = gate()
    const sent = mockReorder(store, { wait: () => held.promise })
    fireEvent.click(toggle())

    await dragByKeyboard('Drag suite nts', 'Before suite libcxx')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(reorderedTexts()).toEqual(['nts', 'libcxx', 'Third'])
    expect(chipItem('nts')).toHaveClass('dragging')
    expect(grip('Third')).toHaveAttribute('aria-disabled', 'true')
    act(() => grip('Third').focus())
    act(() => press('Enter'))
    expect(screen.queryByRole('button', { name: /^Before suite/ })).toBeNull()
    fireEvent.click(toggle())
    expect(chipTexts('Test suites')).toEqual(['nts', 'libcxx', 'Third'])

    await act(async () => held.open())
    await waitFor(() => expect(store.suites.map((suite) => suite.name)).toContain('nts'))
    expect(chipTexts('Test suites')).toEqual(['nts', 'libcxx', 'Third'])
    expect(sent).toHaveLength(1)
  })

  it('still shows the save in progress once the project is selected again', async () => {
    const store = await renderRow()
    const held = gate()
    const sent = mockReorder(store, { wait: () => held.promise })
    fireEvent.click(toggle())
    await dragByKeyboard('Drag suite nts', 'Before suite libcxx')
    await waitFor(() => expect(sent).toHaveLength(1))

    fireEvent.click(chipLink('Projects', 'Swift'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/stdlib'))
    fireEvent.click(chipLink('Projects', 'llvm'))
    await waitFor(() => expect(chipTexts('Test suites')).toEqual(['nts', 'libcxx', 'Third']))
    fireEvent.click(toggle())

    // Busy: no other save can start until this one is done.
    expect(chipItem('nts')).toHaveClass('dragging')
    expect(grip('Third')).toHaveAttribute('aria-disabled', 'true')
    await act(async () => held.open())
    await waitFor(() => expect(grip('Third')).not.toHaveAttribute('aria-disabled'))
    expect(reorderedTexts()).toEqual(['nts', 'libcxx', 'Third'])
    expect(sent).toHaveLength(1)
  })

  it('can always be left, even once the token no longer allows dragging', async () => {
    await renderRow()
    fireEvent.click(toggle())

    act(() => changeInAnotherTab(TOKEN_STORAGE_KEY, null))

    await waitFor(() => expect(grip('nts')).toHaveAttribute('aria-disabled', 'true'))
    expect(grip('nts')).toHaveAccessibleDescription(/^Needs an API token/)
    expect(grip('nts')).toHaveAttribute('title', expect.stringMatching(/^Needs an API token/))
    expect(toggle()).toBeEnabled()
    fireEvent.click(toggle())
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAccessibleName('Reorder suites')
  })

  it('forgets why a drop failed once the mode is left', async () => {
    const store = await renderRow()
    fireEvent.click(toggle())
    mockReorder(store, { fail: () => errorResponse(409, 'retry', 'The project was busy.') })
    await dragByKeyboard('Drag suite nts', 'Before suite libcxx')
    expect(await screen.findByRole('alert')).toHaveTextContent('The project was busy.')

    fireEvent.click(toggle())

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaves the mode for another project', async () => {
    await renderRow()
    fireEvent.click(toggle())

    fireEvent.click(chipLink('Projects', 'Swift'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/stdlib'))
    fireEvent.click(chipLink('Projects', 'llvm'))

    await waitFor(() => expect(chipTexts('Test suites')).toEqual(['libcxx', 'nts', 'Third']))
    expect(toggle()).toHaveAccessibleName('Reorder suites')
  })

  it('stays in the mode with a single suite left', async () => {
    const store = await renderRow()
    fireEvent.click(toggle())
    // The others were deleted elsewhere, which the order sent leaves out.
    store.suites = [SUITE]
    mockReorder(store, { fail: () => errorResponse(400, 'invalid_request', 'Out of date.') })

    await dragByKeyboard('Drag suite libcxx', 'After suite nts')

    await waitFor(() => expect(reorderedTexts()).toEqual(['libcxx']))
    expect(grip('libcxx')).toBeInTheDocument()
    fireEvent.click(toggle())
    expect(screen.queryByRole('button', { name: /^(Reorder suites|Done)$/ })).toBeNull()
  })

  it('says why a drop failed, and lists the suites again if it was out of date', async () => {
    const store = await renderRow()
    fireEvent.click(toggle())
    // Created elsewhere, which the order sent leaves out.
    store.suites = [...store.suites, { ...BARE_SUITE, name: 'new' }]
    const message =
      "The order must name each of the test suites of project 'llvm' exactly once, but it leaves " +
      "out 'new'."
    mockReorder(store, { fail: () => errorResponse(400, 'invalid_request', message) })

    await dragByKeyboard('Drag suite nts', 'Before suite libcxx')

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    await waitFor(() => expect(reorderedTexts()).toEqual(['libcxx', 'nts', 'Third', 'new']))
    expect(store.requests).toBe(2)
  })

  it('puts the suite back and says why if the save fails, without listing them again', async () => {
    const store = await renderRow()
    fireEvent.click(toggle())
    mockReorder(store, { fail: () => errorResponse(409, 'retry', 'The project was busy.') })

    await dragByKeyboard('Drag suite nts', 'Before suite libcxx')

    expect(await screen.findByRole('alert')).toHaveTextContent('The project was busy.')
    expect(reorderedTexts()).toEqual(['libcxx', 'nts', 'Third'])
    expect(chipItem('nts')).not.toHaveClass('dragging')
    expect(grip('nts')).toHaveFocus()
    expect(store.requests).toBe(1)
  })

  it('says that the project was not found once deleted elsewhere', async () => {
    const store = await renderRow()
    fireEvent.click(toggle())
    store.projects = [SWIFT]
    store.suites = store.suites.filter((suite) => projectOf(suite).name === 'swift')
    mockReorder(store, { fail: () => errorResponse(404, 'not_found', "Project 'llvm' not found") })

    await dragByKeyboard('Drag suite nts', 'Before suite libcxx')

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent("Project 'llvm' not found."),
    )
    expect(chipTexts('Projects')).toEqual(['Swift'])
  })
})
