import { act, renderHook, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { authedApi, unwrap } from '../api/client'
import { TOKEN, apiKey, mockAuth, signIn, unknownToken } from '../test/auth'
import { errorResponse, mockApi } from '../test/mock-api'
import { providers, renderWithProviders } from '../test/render'
import { server } from '../test/server'
import { useAuth } from './use-auth'

const OTHER = 'b'.repeat(64)

/** Send an authenticated request, and return the Authorization header it carried. */
async function sentHeader(): Promise<string | null> {
  let header: string | null = null
  server.use(
    mockApi('get', '/api/admin/api-keys', ({ request }) => {
      header = request.headers.get('Authorization')
      return HttpResponse.json({ items: [] })
    }),
  )
  await unwrap(authedApi.GET('/api/admin/api-keys'))
  return header
}

describe('the token authenticated requests carry', () => {
  it('is checked when the app loads, whether or not anything shows the check', async () => {
    const checks = signIn('admin')
    renderWithProviders(<p>Nothing about the token here</p>)

    await waitFor(() => expect(checks).toHaveLength(1))
    await waitFor(async () => expect(await sentHeader()).toBe(`Bearer ${TOKEN}`))
  })

  it('is the stored one, once its check has succeeded', async () => {
    signIn('admin')
    const { result } = renderHook(useAuth, providers())

    await waitFor(() => expect(result.current.status.state).toBe('valid'))
    expect(await sentHeader()).toBe(`Bearer ${TOKEN}`)
  })

  it('is none while the check is under way', async () => {
    signIn('admin')
    mockAuth(() => new Promise<never>(() => {}))
    const { result } = renderHook(useAuth, providers())

    await waitFor(() => expect(result.current.status.state).toBe('checking'))
    expect(await sentHeader()).toBeNull()
  })

  it('is none once a check has failed, for any reason', async () => {
    signIn('admin')
    mockAuth(() => errorResponse(500, 'internal_error', 'The server failed'))
    const { result } = renderHook(useAuth, providers())

    await waitFor(() => expect(result.current.status.state).toBe('failed'))
    expect(await sentHeader()).toBeNull()
  })

  it('is the one entered last, even if an earlier one is accepted after it', async () => {
    let answerFirst: () => void = () => {}
    server.use(
      mockApi('get', '/api/auth', ({ request }) => {
        if (request.headers.get('Authorization') === `Bearer ${TOKEN}`) {
          return new Promise((resolve) => {
            answerFirst = () => resolve(HttpResponse.json({ key: apiKey('read') }))
          })
        }
        return HttpResponse.json({ key: apiKey('admin') })
      }),
    )
    const { result } = renderHook(useAuth, providers())

    act(() => result.current.setToken(TOKEN))
    act(() => result.current.setToken(OTHER))
    await waitFor(() => expect(result.current.status.state).toBe('valid'))
    act(() => answerFirst())
    expect(await sentHeader()).toBe(`Bearer ${OTHER}`)
  })

  it('is checked again only once, however many requests are refused at once', async () => {
    let revoked = false
    const checks = mockAuth(() =>
      revoked ? unknownToken() : HttpResponse.json({ key: apiKey('admin') }),
    )
    const { result } = renderHook(useAuth, providers())
    act(() => result.current.setToken(TOKEN))
    await waitFor(() => expect(result.current.status.state).toBe('valid'))

    revoked = true
    server.use(mockApi('get', '/api/admin/api-keys', () => unknownToken()))
    const refused = [1, 2, 3].map(() => unwrap(authedApi.GET('/api/admin/api-keys')).catch(() => {}))
    await Promise.all(refused)
    await waitFor(() => expect(result.current.status.state).toBe('invalid'))
    expect(checks).toHaveLength(2)
  })

  it('stays accepted when a token replaced since is refused', async () => {
    const checks = mockAuth(() => HttpResponse.json({ key: apiKey('admin') }))
    let refuse: () => void = () => {}
    server.use(
      mockApi('get', '/api/admin/api-keys', () => {
        return new Promise((resolve) => (refuse = () => resolve(unknownToken())))
      }),
    )
    const { result } = renderHook(useAuth, providers())
    act(() => result.current.setToken(TOKEN))
    await waitFor(() => expect(result.current.status.state).toBe('valid'))

    // Sent with TOKEN, and refused only once OTHER has replaced it.
    const stale = unwrap(authedApi.GET('/api/admin/api-keys')).catch(() => {})
    act(() => result.current.setToken(OTHER))
    await waitFor(() => expect(result.current.status.state).toBe('valid'))
    refuse()
    await stale
    expect(result.current.status.state).toBe('valid')
    expect(checks).toEqual([`Bearer ${TOKEN}`, `Bearer ${OTHER}`])
  })

  it('is checked without the line breaks a paste may have left in it', async () => {
    const checks = mockAuth(() => HttpResponse.json({ key: apiKey('admin') }))
    const { result } = renderHook(useAuth, providers())

    act(() => result.current.setToken(`${TOKEN.slice(0, 32)}\r\n${TOKEN.slice(32)}`))
    await waitFor(() => expect(result.current.status.state).toBe('valid'))
    expect(checks).toEqual([`Bearer ${TOKEN}`])
  })

  it('is not valid if it cannot be sent at all, which no retry would change', async () => {
    // A check that reached the server would fail the test: there is no handler for it.
    const { result } = renderHook(useAuth, providers())

    act(() => result.current.setToken(`${TOKEN.slice(0, 32)}\u2022${TOKEN.slice(32)}`))
    await waitFor(() => expect(result.current.status.state).toBe('invalid'))
  })

  it('is none once the check has refused it, even though it succeeded before', async () => {
    let revoked = false
    mockAuth(() => (revoked ? unknownToken() : HttpResponse.json({ key: apiKey('admin') })))
    const { result } = renderHook(useAuth, providers())
    result.current.setToken(TOKEN)
    await waitFor(() => expect(result.current.status.state).toBe('valid'))

    revoked = true
    result.current.recheck()
    await waitFor(() => expect(result.current.status.state).toBe('invalid'))
    expect(await sentHeader()).toBeNull()
  })
})
