import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { errorMessage } from '../api/client'
import { useAuth, type TokenStatus } from './use-auth'
import './settings-menu.css'

/** The navbar's Settings button, and the panel it opens, which holds the API token (AR2). */
export function SettingsMenu() {
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  // The panel closes on a click outside the menu, on Escape within it, and when keyboard focus
  // leaves it. Focus that goes nowhere (a click on the panel's text) is not leaving it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    setOpen(false)
    button.current?.focus()
  }
  const onBlur = (event: FocusEvent) => {
    const next = event.relatedTarget
    if (next !== null && !event.currentTarget.contains(next)) setOpen(false)
  }

  return (
    <div className="settings-menu" ref={menu} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className="navbar-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        Settings
      </button>
      {open && <SettingsPanel id={panelId} />}
    </div>
  )
}

function SettingsPanel({ id }: { id: string }) {
  const { status, setToken, clearToken, recheck } = useAuth()
  const [draft, setDraft] = useState('')
  const inputId = useId()

  const save = (event: FormEvent) => {
    event.preventDefault()
    setToken(draft)
    setDraft('')
  }

  return (
    <section id={id} className="settings-panel" aria-label="Settings">
      <form onSubmit={save}>
        <label htmlFor={inputId}>API token</label>
        <div className="settings-row">
          <input
            id={inputId}
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={status.state === 'none' ? 'Paste a token' : 'Paste another token'}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <button type="submit" disabled={draft.trim() === ''}>
            Save
          </button>
        </div>
      </form>
      <div className="settings-row">
        <StatusLine status={status} />
        {status.state === 'failed' && (
          <button type="button" onClick={recheck}>
            Retry
          </button>
        )}
        {status.state !== 'none' && (
          <button type="button" onClick={clearToken}>
            Clear token
          </button>
        )}
      </div>
    </section>
  )
}

function statusText(status: TokenStatus): ReactNode {
  switch (status.state) {
    case 'none':
      return 'No token set. Browsing needs none; changes need one with the scope they require.'
    case 'checking':
      return 'Checking the token...'
    case 'valid':
      return (
        <>
          Using key <strong>{status.key.name}</strong> ({status.key.prefix}), with{' '}
          <strong>{status.key.scope}</strong> scope.
        </>
      )
    case 'invalid':
      return 'This token is not valid: the server does not know it, or it has been revoked.'
    case 'failed':
      return `The token could not be checked: ${errorMessage(status.error)}`
  }
}

function StatusLine({ status }: { status: TokenStatus }) {
  const failed = status.state === 'invalid' || status.state === 'failed'
  return (
    <p className={failed ? 'settings-status settings-status-error' : 'settings-status'} role="status">
      {statusText(status)}
    </p>
  )
}
