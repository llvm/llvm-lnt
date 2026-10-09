import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Dialog, DialogTrigger } from 'react-aria-components'
import clsx from 'clsx'
import { errorMessage } from '../api/client'
import { Popover } from '../components/popover'
import { useAuth, type TokenStatus } from './use-auth'
import styles from './settings-menu.module.css'

/**
 * The navbar's Settings button, and the panel it opens, which holds the API token (AR2). The navbar
 * styles the button, with `className`, so that it looks like the links beside it.
 */
export function SettingsMenu({ className }: { className?: string }) {
  return (
    <DialogTrigger>
      <Button className={className}>Settings</Button>
      <Popover placement="bottom end" className={styles.popover}>
        <Dialog className={styles.panel} aria-label="Settings">
          <SettingsPanel />
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}

function SettingsPanel() {
  const { status, setToken, clearToken, recheck } = useAuth()
  const [draft, setDraft] = useState('')
  const inputId = useId()

  const save = (event: FormEvent) => {
    event.preventDefault()
    setToken(draft)
    setDraft('')
  }

  return (
    <>
      <form onSubmit={save}>
        <label htmlFor={inputId} className={styles.label}>API token</label>
        <div className={styles.row}>
          <input
            id={inputId}
            className={styles.input}
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
      <div className={styles.row}>
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
    </>
  )
}

function statusText(status: TokenStatus): ReactNode {
  switch (status.state) {
    case 'none':
      return 'No token set.'
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
      return 'This token is not valid: it is malformed, unknown to the server, or revoked.'
    case 'failed':
      return `The token could not be checked: ${errorMessage(status.error)}`
  }
}

function StatusLine({ status }: { status: TokenStatus }) {
  const failed = status.state === 'invalid' || status.state === 'failed'
  return (
    <p className={clsx(styles.status, failed && styles.error)} role="status">
      {statusText(status)}
    </p>
  )
}
