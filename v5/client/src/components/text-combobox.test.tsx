import { useState } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '../test/render'
import type { Suggestion } from './suggestions'
import { TextCombobox } from './text-combobox'

const BRANCHES: Suggestion[] = ['main', 'release/19.x', 'release/20.x'].map((name) => ({
  key: name,
  text: name,
}))

/** The combobox in a form, as InlineEdit holds it, which reports each submission's text. */
function BranchForm({
  initial = '',
  all = BRANCHES,
  onSubmit = () => {},
  saving = false,
}: {
  initial?: string
  /** The suggestions, or null while they load. */
  all?: Suggestion[] | null
  onSubmit?: (text: string) => void
  saving?: boolean
}) {
  const [text, setText] = useState(initial)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(text)
      }}
    >
      <TextCombobox
        label="Branch"
        text={text}
        onChange={setText}
        suggestions={all ?? undefined}
        isReadOnly={saving}
      />
      <button type="submit">Save</button>
    </form>
  )
}

function renderForm(props: Parameters<typeof BranchForm>[0] = {}) {
  const onSubmit = vi.fn<(text: string) => void>()
  renderWithProviders(<BranchForm onSubmit={onSubmit} {...props} />)
  return { onSubmit, user: userEvent.setup() }
}

function input() {
  return screen.getByRole('combobox', { name: 'Branch' })
}

function options() {
  return screen.queryAllByRole('option').map((option) => option.textContent)
}

function listbox() {
  return screen.queryByRole('listbox')
}

function option(name: string) {
  return screen.getByRole('option', { name })
}

async function openList(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Show suggestions/ }))
}

/** Whether a list is shown at any point while `act` runs, even for a moment. */
async function listShownDuring(act: () => Promise<void>) {
  let shown = false
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof Element &&
          (node.matches('[role="listbox"]') || node.querySelector('[role="listbox"]'))
        ) {
          shown = true
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  await act()
  await Promise.resolve()
  observer.disconnect()
  return shown
}

describe('TextCombobox', () => {
  it('lists every suggestion for the text it opened with, and filters them by typed text', async () => {
    const { user } = renderForm({ initial: 'main' })

    await openList(user)
    expect(options()).toEqual(['main', 'release/19.x', 'release/20.x'])
    await user.clear(input())
    await user.type(input(), 'REL')
    expect(options()).toEqual(['release/19.x', 'release/20.x'])
  })

  it('lists every suggestion again once the text is back to the one it opened with, or picked', async () => {
    const { user } = renderForm({ initial: 'main' })

    await user.type(input(), 'x{Backspace}')
    expect(options()).toHaveLength(3)

    await user.click(option('release/19.x'))
    await user.type(input(), 'x{Backspace}')
    expect(options()).toHaveLength(3)
  })

  it('lists every suggestion when opened from its button or with ArrowDown, whatever the text', async () => {
    const { user } = renderForm()

    await user.type(input(), 'relase')
    expect(listbox()).toBeNull()
    await openList(user)
    expect(options()).toHaveLength(3)

    await user.keyboard('{Escape}')
    await user.keyboard('{ArrowDown}')
    expect(options()).toHaveLength(3)

    // Typing filters them again.
    await user.type(input(), '/1')
    expect(listbox()).toBeNull()
  })

  it('fills the input with a suggestion clicked, saving nothing, then lists them all again', async () => {
    const { user, onSubmit } = renderForm()

    await user.type(input(), '20')
    await user.click(option('release/20.x'))

    expect(input()).toHaveValue('release/20.x')
    expect(listbox()).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
    await openList(user)
    expect(options()).toHaveLength(3)
  })

  it('fills the input with a suggestion moved to from the keyboard on Enter, and saves on the next', async () => {
    const { user, onSubmit } = renderForm()

    await user.type(input(), 'release')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(input()).toHaveValue('release/20.x')
    expect(listbox()).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('release/20.x')
  })

  it('saves the text typed on Enter, closing the list, with a suggestion under the pointer', async () => {
    const { user, onSubmit } = renderForm()

    // Pasted rather than typed: React Aria highlights nothing on hover after typing.
    await user.click(input())
    await user.paste('rel')
    await user.hover(option('release/19.x'))
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('rel')
    expect(input()).toHaveValue('rel')
    expect(listbox()).toBeNull()
  })

  it('picks the suggestion moved to from the keyboard, wherever the pointer then goes', async () => {
    const { user, onSubmit } = renderForm()

    await openList(user)
    await user.keyboard('{ArrowDown}')
    // React Aria keeps the highlight where the keyboard moved it.
    await user.hover(option('release/20.x'))
    await user.keyboard('{Enter}')

    expect(input()).toHaveValue('main')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('picks the suggestion moved to from the keyboard, even once the pointer is on it', async () => {
    const { user, onSubmit } = renderForm()

    await openList(user)
    await user.keyboard('{ArrowDown}')
    await user.hover(option('main'))
    await user.keyboard('{Enter}')

    expect(input()).toHaveValue('main')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('picks a suggestion the pointer highlighted once the keyboard has moved back to it', async () => {
    const { user } = renderForm()

    await openList(user)
    await user.hover(option('release/19.x'))
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')

    expect(input()).toHaveValue('release/19.x')
  })

  it('saves the text typed on Enter once the text has changed, or the list has closed, since moving to a suggestion', async () => {
    const { user, onSubmit } = renderForm()

    await user.type(input(), 'release')
    await user.keyboard('{ArrowDown}')
    await user.type(input(), '/2')
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenLastCalledWith('release/2')

    await openList(user)
    await user.keyboard('{ArrowDown}{Escape}')
    await openList(user)
    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenLastCalledWith('release/2')
    expect(input()).toHaveValue('release/2')
  })

  it('leaves an Enter ending an input method composition alone', async () => {
    const { user, onSubmit } = renderForm()

    await user.click(input())
    await user.paste('rel')
    await user.hover(option('release/19.x'))
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })

    expect(listbox()).not.toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('never picks a suggestion on Tab, which keeps the text typed', async () => {
    const { user } = renderForm()

    await user.click(input())
    await user.paste('rel')
    await user.hover(option('release/19.x'))
    await user.tab()
    expect(input()).toHaveValue('rel')
    expect(listbox()).toBeNull()

    await user.click(input())
    await user.keyboard('{ArrowDown}{Tab}')
    expect(input()).toHaveValue('rel')
  })

  it('closes the list on Escape, keeping the text, typed or picked', async () => {
    const { user } = renderForm()

    await user.type(input(), 'rel')
    await user.keyboard('{Escape}')
    expect(input()).toHaveValue('rel')
    expect(listbox()).toBeNull()

    await openList(user)
    await user.click(option('release/19.x'))
    await openList(user)
    await user.keyboard('{Escape}')
    expect(input()).toHaveValue('release/19.x')

    // Nor the text of the suggestion picked, once the text has changed.
    await user.type(input(), '-rc{Escape}')
    expect(input()).toHaveValue('release/19.x-rc')
  })

  it('shows no list while no suggestion matches, not even for a moment, and shows it again once one does', async () => {
    const { user } = renderForm()

    await user.type(input(), 'rela')
    expect(await listShownDuring(() => user.type(input(), 'sex'))).toBe(false)
    expect(listbox()).toBeNull()

    await user.type(input(), '{Backspace}{Backspace}{Backspace}{Backspace}')
    expect(options()).toEqual(['release/19.x', 'release/20.x'])
  })

  it('says that the suggestions are loading until they are', async () => {
    const { user } = renderForm({ all: null })

    await user.type(input(), 'rel')
    expect(listbox()).toHaveTextContent('Loading...')
  })

  it('cannot be changed while saving', async () => {
    const { user } = renderForm({ initial: 'main', saving: true })

    await user.type(input(), 'x')
    expect(input()).toHaveValue('main')
  })
})
