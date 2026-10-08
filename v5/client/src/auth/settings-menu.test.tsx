import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { PERMISSION_DENIED, authedApi, errorMessage, unwrap } from '../api/client'
import { errorResponse, mockApi } from '../test/mock-api'
import { TOKEN, apiKey, changeInAnotherTab, mockAuth, signIn, unknownToken } from '../test/auth'
import { renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { SettingsMenu } from './settings-menu'
import { TOKEN_STORAGE_KEY } from './storage-key'

const OTHER = 'b'.repeat(64)

function renderMenu() {
  return renderWithProviders(<SettingsMenu />)
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  return screen.getByRole('region', { name: 'Settings' })
}

function enterToken(token: string) {
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

function status() {
  return screen.getByRole('status')
}

/** Another tab stores `token`, or clears it if null. */
function changeTokenInAnotherTab(token: string | null) {
  act(() => changeInAnotherTab(TOKEN_STORAGE_KEY, token))
}

function deleteRun() {
  return authedApi.DELETE('/api/suites/{testsuite}/runs/{uuid}', {
    params: { path: { testsuite: 'nts', uuid: '573af861-8303-4a5b-a643-b8321e0142c4' } },
  })
}

describe('Settings panel', () => {
  it('opens and closes from the navbar button', () => {
    renderMenu()
    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button).toHaveAttribute('aria-expanded', 'false')

    openPanel()
    expect(button).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(button)
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
  })

  it('closes on Escape within it, returning focus to its button', () => {
    renderMenu()

    openPanel()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByLabelText('API token'), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus()
  })

  it('closes on a click outside it, but not on one inside it', () => {
    renderMenu()

    const panel = openPanel()
    fireEvent.pointerDown(panel)
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
  })

  it('closes when keyboard focus leaves it, and only then', () => {
    renderWithProviders(
      <>
        <SettingsMenu />
        <button type="button">Elsewhere</button>
      </>,
    )
    openPanel()
    const input = screen.getByLabelText('API token')

    fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Save' }) })
    fireEvent.blur(input, { relatedTarget: null })
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument()

    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    fireEvent.blur(input, { relatedTarget: elsewhere })
    expect(screen.queryByRole('region', { name: 'Settings' })).toBeNull()
    expect(elsewhere).not.toHaveFocus()
  })

  it('masks the token input', () => {
    renderMenu()
    openPanel()

    expect(screen.getByLabelText('API token')).toHaveAttribute('type', 'password')
  })

  it('says that no token is set, and checks nothing', () => {
    // No handler for GET /api/auth: a check would fail the test.
    renderMenu()
    openPanel()

    expect(status()).toHaveTextContent('No token set')
    expect(screen.queryByRole('button', { name: 'Clear token' })).toBeNull()
  })

  it('checks a stored token when the app loads, and shows its key', async () => {
    const checks = signIn('manage')
    renderMenu()
    openPanel()

    await waitFor(() => expect(status()).toHaveTextContent('Using key manage-key (aaaaaaaa)'))
    expect(status()).toHaveTextContent('with manage scope')
    expect(checks).toEqual([`Bearer ${TOKEN}`])
  })

  it('checks a token when it is entered, and stores it', async () => {
    const checks = mockAuth(() => HttpResponse.json({ key: apiKey('triage', { name: 'bot' }) }))
    renderMenu()
    openPanel()

    enterToken(`  ${TOKEN} `)
    expect(status()).toHaveTextContent('Checking the token...')
    await waitFor(() => expect(status()).toHaveTextContent('Using key bot'))
    expect(checks).toEqual([`Bearer ${TOKEN}`])
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN)
  })

  it('leaves the token nowhere in the page once it is saved', async () => {
    signIn('admin')
    renderMenu()
    openPanel()

    enterToken(TOKEN)
    await waitFor(() => expect(status()).toHaveTextContent('Using key'))
    expect(screen.getByLabelText('API token')).toHaveValue('')
    expect(document.documentElement.outerHTML).not.toContain(TOKEN)
  })

  it('checks a token entered again, even the one already stored', async () => {
    const checks = signIn('read')
    renderMenu()
    openPanel()
    await waitFor(() => expect(status()).toHaveTextContent('Using key'))

    enterToken(TOKEN)
    await waitFor(() => expect(checks).toHaveLength(2))
    await waitFor(() => expect(status()).toHaveTextContent('Using key'))
  })

  it('does not save an empty token', () => {
    renderMenu()
    openPanel()

    fireEvent.change(screen.getByLabelText('API token'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('says that a token the API refuses is not valid', async () => {
    mockAuth(unknownToken)
    renderMenu()
    openPanel()

    enterToken(TOKEN)
    await waitFor(() => expect(status()).toHaveTextContent('This token is not valid'))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('says that a token that cannot be sent is not valid, not why sending it failed', async () => {
    renderMenu()
    openPanel()

    enterToken(`${TOKEN.slice(0, 32)}\u2022${TOKEN.slice(32)}`)
    await waitFor(() => expect(status()).toHaveTextContent('This token is not valid'))
    expect(status()).not.toHaveTextContent('TypeError')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('says that the check failed, and retries it', async () => {
    let fail = true
    const checks = mockAuth(() =>
      fail
        ? errorResponse(500, 'internal_error', 'The server failed')
        : HttpResponse.json({ key: apiKey('admin') }),
    )
    renderMenu()
    openPanel()

    enterToken(TOKEN)
    await waitFor(() =>
      expect(status()).toHaveTextContent('The token could not be checked: The server failed'),
    )

    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(status()).toHaveTextContent('with admin scope'))
    expect(checks).toHaveLength(2)
  })

  it('clears the token', async () => {
    signIn('admin')
    renderMenu()
    openPanel()
    await waitFor(() => expect(status()).toHaveTextContent('Using key'))

    fireEvent.click(screen.getByRole('button', { name: 'Clear token' }))
    expect(status()).toHaveTextContent('No token set')
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('keeps the token entered last, whichever check answers last', async () => {
    let answerFirst: () => void = () => {}
    server.use(
      mockApi('get', '/api/auth', ({ request }) => {
        const header = request.headers.get('Authorization')
        if (header === `Bearer ${TOKEN}`) {
          return new Promise((resolve) => {
            answerFirst = () => resolve(HttpResponse.json({ key: apiKey('read', { name: 'first' }) }))
          })
        }
        return HttpResponse.json({ key: apiKey('admin', { name: 'second' }) })
      }),
    )
    renderMenu()
    openPanel()

    enterToken(TOKEN)
    enterToken(OTHER)
    await waitFor(() => expect(status()).toHaveTextContent('Using key second'))
    act(() => answerFirst())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(status()).toHaveTextContent('Using key second')
  })

  it('takes up, and checks, a token another tab enters or clears', async () => {
    const checks = mockAuth(() => HttpResponse.json({ key: apiKey('submit', { name: 'other' }) }))
    renderMenu()
    openPanel()

    changeTokenInAnotherTab(OTHER)
    await waitFor(() => expect(status()).toHaveTextContent('Using key other'))
    expect(checks).toEqual([`Bearer ${OTHER}`])

    changeTokenInAnotherTab(null)
    expect(status()).toHaveTextContent('No token set')
  })

  it('checks the token again when a request sent with it gets a 401', async () => {
    let revoked = false
    const checks = mockAuth(() =>
      revoked ? unknownToken() : HttpResponse.json({ key: apiKey('manage') }),
    )
    server.use(
      mockApi('delete', '/api/suites/{testsuite}/runs/{uuid}', () => unknownToken()),
    )
    renderMenu()
    openPanel()
    enterToken(TOKEN)
    await waitFor(() => expect(status()).toHaveTextContent('Using key'))

    revoked = true
    const error = await unwrap(deleteRun()).catch((error: unknown) => error)
    expect(errorMessage(error)).toBe(PERMISSION_DENIED)
    await waitFor(() => expect(status()).toHaveTextContent('This token is not valid'))
    expect(checks).toHaveLength(2)
  })

  it('does not check the token again when a request sent with it gets a 403', async () => {
    const checks = signIn('submit')
    server.use(
      mockApi('delete', '/api/suites/{testsuite}/runs/{uuid}', () =>
        errorResponse(403, 'forbidden', "This endpoint requires the 'manage' scope"),
      ),
    )
    renderMenu()
    openPanel()
    await waitFor(() => expect(status()).toHaveTextContent('Using key'))

    const error = await unwrap(deleteRun()).catch((error: unknown) => error)
    expect(errorMessage(error)).toBe(PERMISSION_DENIED)
    expect(status()).toHaveTextContent('with submit scope')
    expect(checks).toHaveLength(1)
  })
})
