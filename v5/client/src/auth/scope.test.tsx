import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TOKEN, mockAuth, signIn, unknownToken } from '../test/auth'
import { errorResponse } from '../test/mock-api'
import { providers } from '../test/render'
import { TOKEN_STORAGE_KEY } from './storage-key'
import { grants, useGrantedScope, useScopeGate, type Scope } from './scope'
import { useAuth } from './use-auth'

const SCOPES: Scope[] = ['read', 'submit', 'triage', 'manage', 'admin']

describe('grants', () => {
  it('follows the hierarchy read < submit < triage < manage < admin', () => {
    for (const [i, granted] of SCOPES.entries()) {
      for (const [j, required] of SCOPES.entries()) {
        expect(grants(granted, required), `${granted} grants ${required}`).toBe(i >= j)
      }
    }
  })

  it('allows only read without a valid token', () => {
    expect(SCOPES.filter((scope) => grants(null, scope))).toEqual(['read'])
  })
})

describe('useScopeGate', () => {
  it('disables a control needing more than read without a token, saying which scope', () => {
    const { result } = renderHook(() => useScopeGate('triage'), providers())

    expect(result.current).toEqual({
      disabled: true,
      title: "Needs an API token with the 'triage' scope. Set one in Settings.",
    })
  })

  it('never disables a control needing only read', () => {
    const { result } = renderHook(() => useScopeGate('read'), providers())

    expect(result.current).toEqual({ disabled: false, title: undefined })
  })

  it('enables a control once the token is found to grant its scope', async () => {
    signIn('manage')
    const { result } = renderHook(
      () => [useScopeGate('submit'), useScopeGate('manage'), useScopeGate('admin')],
      providers(),
    )

    expect(result.current.map((gate) => gate.disabled)).toEqual([true, true, true])
    expect(result.current[0].title).toBe(
      "Needs an API token with the 'submit' scope. The token in Settings is still being checked.",
    )
    await waitFor(() =>
      expect(result.current.map((gate) => gate.disabled)).toEqual([false, false, true]),
    )
    expect(result.current[2].title).toBe(
      "Needs an API token with the 'admin' scope. The token in Settings has the 'manage' scope.",
    )
  })

  it('says, while the token is being checked, that its scope is not known yet', async () => {
    const checks = signIn('admin')
    const { result } = renderHook(useGrantedScope, providers())

    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe('admin'))
    expect(checks).toHaveLength(1)
  })

  it('says why a control is disabled when the check failed', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(() => errorResponse(500, 'internal_error', 'The server failed'))
    const { result } = renderHook(
      () => ({ auth: useAuth(), scope: useGrantedScope(), gate: useScopeGate('submit') }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('failed'))
    expect(result.current.scope).toBeNull()
    expect(result.current.gate.title).toBe(
      "Needs an API token with the 'submit' scope. The token in Settings could not be checked.",
    )
  })

  it('disables a control while the token is not valid', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(unknownToken)
    const { result } = renderHook(
      () => ({ auth: useAuth(), scope: useGrantedScope(), gate: useScopeGate('submit') }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('invalid'))
    expect(result.current.scope).toBeNull()
    expect(result.current.gate).toEqual({
      disabled: true,
      title: "Needs an API token with the 'submit' scope. The token in Settings is not valid.",
    })
  })
})
