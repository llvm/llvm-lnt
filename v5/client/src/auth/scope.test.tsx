import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../api/keys'
import { TOKEN, mockAuth, signIn, unknownToken } from '../test/auth'
import { BARE_SUITE, SUITE } from '../test/fixtures'
import { errorResponse } from '../test/mock-api'
import { providers } from '../test/render'
import { TOKEN_STORAGE_KEY } from './storage-key'
import { grants, useScopeGate, type Scope } from './scope'
import { useAuth } from './use-auth'

const SCOPES: Scope[] = ['read', 'submit', 'triage', 'manage', 'admin']

describe('grants', () => {
  it('follows the hierarchy read < submit < triage < manage < admin', () => {
    for (const [i, scope] of SCOPES.entries()) {
      for (const [j, required] of SCOPES.entries()) {
        for (const suite of ['nts', null]) {
          const granted = grants({ scope, suites: null }, required, suite)
          expect(granted, `${scope} grants ${required}`).toBe(i >= j)
        }
      }
    }
  })

  it('allows only read without a valid token', () => {
    expect(SCOPES.filter((scope) => grants(null, scope, 'nts'))).toEqual(['read'])
  })

  it('grants a restricted key its scope only in its suites, and read elsewhere', () => {
    const key = { scope: 'triage' as const, suites: ['libcxx', 'nts'] }
    const granted = (suite: string | null) => SCOPES.filter((scope) => grants(key, scope, suite))

    expect(granted('nts')).toEqual(['read', 'submit', 'triage'])
    expect(granted('libcxx')).toEqual(['read', 'submit', 'triage'])
    // Suite names are compared exactly.
    expect(granted('NTS')).toEqual(['read'])
    expect(granted('other')).toEqual(['read'])
    expect(granted(null)).toEqual(['read'])
  })

  it('grants only read to a key whose suites were all deleted', () => {
    const key = { scope: 'manage' as const, suites: [] }

    expect(SCOPES.filter((scope) => grants(key, scope, 'nts'))).toEqual(['read'])
    expect(SCOPES.filter((scope) => grants(key, scope, null))).toEqual(['read'])
  })
})

describe('useScopeGate', () => {
  it('disables a control needing more than read without a token, saying which scope', () => {
    const { result } = renderHook(() => useScopeGate('triage', 'nts'), providers())

    expect(result.current).toEqual({
      disabled: true,
      title: "Needs an API token with the 'triage' scope. Set one in Settings.",
    })
  })

  it('never disables a control needing only read', () => {
    const { result } = renderHook(() => useScopeGate('read', 'nts'), providers())

    expect(result.current).toEqual({ disabled: false, title: undefined })
  })

  it('enables a control once the token is found to grant its scope', async () => {
    const checks = signIn('manage')
    const { result } = renderHook(
      () => [
        useScopeGate('submit', 'nts'),
        useScopeGate('manage', null),
        useScopeGate('admin', null),
      ],
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
    expect(checks).toHaveLength(1)
  })

  it('says that an action on no suite needs an instance-wide token, whatever the token', () => {
    const { result } = renderHook(() => useScopeGate('manage', null), providers())

    expect(result.current.title).toBe(
      "Needs an instance-wide API token with the 'manage' scope. Set one in Settings.",
    )
  })

  it("enables a restricted token's control only in its suites, saying why elsewhere", async () => {
    signIn('triage', ['libcxx', 'nts'])
    const { result } = renderHook(
      () => ({
        auth: useAuth(),
        own: useScopeGate('triage', 'nts'),
        other: useScopeGate('triage', 'other'),
        higher: useScopeGate('manage', 'nts'),
        none: useScopeGate('triage', null),
      }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.own).toEqual({ disabled: false, title: undefined })
    expect(result.current.other).toEqual({
      disabled: true,
      title:
        "Needs an API token with the 'triage' scope in suite 'other'. The token in Settings has " +
        "the 'triage' scope only in suites 'libcxx', 'nts'.",
    })
    expect(result.current.higher.title).toBe(
      "Needs an API token with the 'manage' scope in suite 'nts'. The token in Settings has the " +
        "'triage' scope only in suites 'libcxx', 'nts'.",
    )
    expect(result.current.none.title).toBe(
      "Needs an instance-wide API token with the 'triage' scope. The token in Settings has the " +
        "'triage' scope only in suites 'libcxx', 'nts'.",
    )
  })

  it('names the suites by their labels once they are listed (AR22)', async () => {
    signIn('triage', ['libcxx', 'nts'])
    const wrapper = providers()
    wrapper.queryClient.setQueryData(queryKeys.suites, {
      items: [
        { ...SUITE, display_name: 'Microbenchmarks' },
        { ...BARE_SUITE, display_name: 'LLVM' },
      ],
    })
    const { result } = renderHook(
      () => ({ auth: useAuth(), other: useScopeGate('manage', 'libcxx') }),
      wrapper,
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.other.title).toBe(
      "Needs an API token with the 'manage' scope in suite 'Microbenchmarks'. The token in " +
        "Settings has the 'triage' scope only in suites 'LLVM', 'Microbenchmarks'.",
    )
  })

  it('enables no control above read for a token whose suites were all deleted', async () => {
    signIn('triage', [])
    const { result } = renderHook(
      () => ({ auth: useAuth(), gate: useScopeGate('triage', 'nts') }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.gate).toEqual({
      disabled: true,
      title:
        "Needs an API token with the 'triage' scope in suite 'nts'. The token in Settings has " +
        "the 'triage' scope in no suite: the suites it was restricted to have been deleted, so it " +
        'can only read.',
    })
  })

  it('says why a control is disabled when the check failed', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(() => errorResponse(500, 'internal_error', 'The server failed'))
    const { result } = renderHook(
      () => ({ auth: useAuth(), gate: useScopeGate('submit', 'nts') }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('failed'))
    expect(result.current.gate.title).toBe(
      "Needs an API token with the 'submit' scope. The token in Settings could not be checked.",
    )
  })

  it('disables a control while the token is not valid', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(unknownToken)
    const { result } = renderHook(
      () => ({ auth: useAuth(), gate: useScopeGate('submit', 'nts') }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('invalid'))
    expect(result.current.gate).toEqual({
      disabled: true,
      title: "Needs an API token with the 'submit' scope. The token in Settings is not valid.",
    })
  })
})
