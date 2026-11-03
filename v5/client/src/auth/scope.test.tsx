import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../api/keys'
import { TOKEN, entry, mockAuth, signIn, unknownToken, whole } from '../test/auth'
import { suiteRef } from '../api/suites'
import { projectList } from '../test/page'
import { BARE_SUITE, PROJECT, SUITE } from '../test/fixtures'
import { errorResponse } from '../test/mock-api'
import { providers } from '../test/render'
import { TOKEN_STORAGE_KEY } from './storage-key'
import { grants, refusalInEvery, useScopeGate, type Entry, type Scope, type Target } from './scope'
import { useAuth } from './use-auth'

const SCOPES: Scope[] = ['read', 'submit', 'triage', 'manage', 'admin']

const NTS = suiteRef('llvm', 'nts')
const LIBCXX = suiteRef('llvm', 'libcxx')
const OTHER = suiteRef('llvm', 'other')
const LLVM: Target = { project: 'llvm' }

describe('grants', () => {
  it('follows the hierarchy read < submit < triage < manage < admin', () => {
    for (const [i, scope] of SCOPES.entries()) {
      for (const [j, required] of SCOPES.entries()) {
        for (const target of [NTS, LLVM, null]) {
          const granted = grants({ scope, restricted_to: null }, required, target)
          expect(granted, `${scope} grants ${required}`).toBe(i >= j)
        }
      }
    }
  })

  it('allows only read without a valid token', () => {
    expect(SCOPES.filter((scope) => grants(null, scope, NTS))).toEqual(['read'])
  })

  it('grants a restricted key its scope only in its suites, and read elsewhere', () => {
    const key = { scope: 'triage' as const, restricted_to: [entry('libcxx'), entry('nts')] }
    const granted = (target: Target) => SCOPES.filter((scope) => grants(key, scope, target))

    expect(granted(NTS)).toEqual(['read', 'submit', 'triage'])
    expect(granted(LIBCXX)).toEqual(['read', 'submit', 'triage'])
    // Names are compared exactly, and a suite is its project's name and its own.
    expect(granted(suiteRef('llvm', 'NTS'))).toEqual(['read'])
    expect(granted(suiteRef('other', 'nts'))).toEqual(['read'])
    expect(granted(OTHER)).toEqual(['read'])
    // Its suites do not make up their project in full.
    expect(granted(LLVM)).toEqual(['read'])
    expect(granted(null)).toEqual(['read'])
  })

  it('grants a key restricted to a whole project its scope in every suite of it, and on it', () => {
    const key = { scope: 'manage' as const, restricted_to: [whole('llvm')] }
    const granted = (target: Target) => SCOPES.filter((scope) => grants(key, scope, target))

    expect(granted(NTS)).toEqual(['read', 'submit', 'triage', 'manage'])
    expect(granted(OTHER)).toEqual(['read', 'submit', 'triage', 'manage'])
    // Covering the project in full, as creating a suite in it needs.
    expect(granted(LLVM)).toEqual(['read', 'submit', 'triage', 'manage'])
    expect(granted(suiteRef('other', 'nts'))).toEqual(['read'])
    expect(granted({ project: 'other' })).toEqual(['read'])
    expect(granted(null)).toEqual(['read'])
  })

  it('grants only read to a key whose entries were all deleted', () => {
    const key = { scope: 'manage' as const, restricted_to: [] }

    expect(SCOPES.filter((scope) => grants(key, scope, NTS))).toEqual(['read'])
    expect(SCOPES.filter((scope) => grants(key, scope, null))).toEqual(['read'])
  })
})

describe('useScopeGate', () => {
  it('disables a control needing more than read without a token, saying which scope', () => {
    const { result } = renderHook(() => useScopeGate('triage', NTS), providers())

    expect(result.current).toEqual({
      disabled: true,
      title: "Needs an API token with the 'triage' scope. Set one in Settings.",
    })
  })

  it('never disables a control needing only read', () => {
    const { result } = renderHook(() => useScopeGate('read', NTS), providers())

    expect(result.current).toEqual({ disabled: false, title: undefined })
  })

  it('enables a control once the token is found to grant its scope', async () => {
    const checks = signIn('manage')
    const { result } = renderHook(
      () => [
        useScopeGate('submit', NTS),
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
    signIn('triage', [entry('libcxx'), entry('nts')])
    const { result } = renderHook(
      () => ({
        auth: useAuth(),
        own: useScopeGate('triage', NTS),
        other: useScopeGate('triage', OTHER),
        higher: useScopeGate('manage', NTS),
        project: useScopeGate('triage', LLVM),
        none: useScopeGate('triage', null),
      }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.own).toEqual({ disabled: false, title: undefined })
    expect(result.current.other).toEqual({
      disabled: true,
      title:
        "Needs an API token with the 'triage' scope in suite 'llvm/other'. The token in Settings " +
        "has the 'triage' scope, covering only 'llvm/libcxx', 'llvm/nts'.",
    })
    expect(result.current.higher.title).toBe(
      "Needs an API token with the 'manage' scope in suite 'llvm/nts'. The token in Settings has " +
        "the 'triage' scope, covering only 'llvm/libcxx', 'llvm/nts'.",
    )
    expect(result.current.project.title).toBe(
      "Needs an API token with the 'triage' scope covering project 'llvm' in full. The token in " +
        "Settings has the 'triage' scope, covering only 'llvm/libcxx', 'llvm/nts'.",
    )
    expect(result.current.none.title).toBe(
      "Needs an instance-wide API token with the 'triage' scope. The token in Settings has the " +
        "'triage' scope, covering only 'llvm/libcxx', 'llvm/nts'.",
    )
  })

  it('names the suites by their labels once they are listed (AR22)', async () => {
    signIn('triage', [entry('libcxx'), entry('nts')])
    const wrapper = providers()
    wrapper.queryClient.setQueryData(
      queryKeys.projects,
      projectList(
        [
          { ...SUITE, display_name: 'Microbenchmarks' },
          { ...BARE_SUITE, display_name: 'Test suite' },
        ],
        [{ ...PROJECT, display_name: 'LLVM' }],
      ),
    )
    const { result } = renderHook(
      () => ({
        auth: useAuth(),
        other: useScopeGate('manage', LIBCXX),
        project: useScopeGate('manage', LLVM),
      }),
      wrapper,
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.other.title).toBe(
      "Needs an API token with the 'manage' scope in suite 'LLVM/Microbenchmarks'. The token in " +
        "Settings has the 'triage' scope, covering only 'LLVM/Microbenchmarks', 'LLVM/Test suite'.",
    )
    expect(result.current.project.title).toBe(
      "Needs an API token with the 'manage' scope covering project 'LLVM' in full. The token in " +
        "Settings has the 'triage' scope, covering only 'LLVM/Microbenchmarks', 'LLVM/Test suite'.",
    )
  })

  it('names a whole project of a restricted token by its label, followed by (all)', async () => {
    signIn('manage', [whole('swift'), entry('libcxx'), entry('gone')])
    const wrapper = providers()
    wrapper.queryClient.setQueryData(
      queryKeys.projects,
      projectList(
        [SUITE],
        [
          { ...PROJECT, display_name: 'LLVM' },
          { name: 'swift', display_name: 'Swift' },
        ],
      ),
    )
    const { result } = renderHook(
      () => ({ auth: useAuth(), project: useScopeGate('manage', LLVM) }),
      wrapper,
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.project.title).toBe(
      "Needs an API token with the 'manage' scope covering project 'LLVM' in full. The token in " +
        "Settings has the 'manage' scope, covering only 'LLVM/gone', 'LLVM/libcxx', 'Swift' (all).",
    )
  })

  it('enables no control above read for a token whose entries were all deleted', async () => {
    signIn('triage', [])
    const { result } = renderHook(
      () => ({ auth: useAuth(), gate: useScopeGate('triage', NTS) }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('valid'))
    expect(result.current.gate).toEqual({
      disabled: true,
      title:
        "Needs an API token with the 'triage' scope in suite 'llvm/nts'. The token in Settings " +
        "has the 'triage' scope, covering nothing: what it was restricted to has been deleted, so it " +
        'can only read.',
    })
  })

  it('says why a control is disabled when the check failed', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(() => errorResponse(500, 'internal_error', 'The server failed'))
    const { result } = renderHook(
      () => ({ auth: useAuth(), gate: useScopeGate('submit', NTS) }),
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
      () => ({ auth: useAuth(), gate: useScopeGate('submit', NTS) }),
      providers(),
    )

    await waitFor(() => expect(result.current.auth.status.state).toBe('invalid'))
    expect(result.current.gate).toEqual({
      disabled: true,
      title: "Needs an API token with the 'submit' scope. The token in Settings is not valid.",
    })
  })
})

describe('refusalInEvery', () => {
  const projects = [
    { ...PROJECT, suites: [] },
    { name: 'swift', display_name: 'Swift', suites: [] },
  ]
  const valid = (restricted_to: Entry[] | null) =>
    ({ state: 'valid', key: { scope: 'manage', restricted_to } }) as const

  it('allows an action on a project picked among some to an instance-wide token', () => {
    expect(refusalInEvery('manage', projects, valid(null) as never, projects)).toBeUndefined()
  })

  it('allows it to a token covering one of them in full', () => {
    const token = valid([entry('nts'), whole('swift')]) as never
    expect(refusalInEvery('manage', projects, token, projects)).toBeUndefined()
  })

  it('refuses it to a token restricted to single suites while the projects load', () => {
    const suites = valid([entry('nts')]) as never
    expect(refusalInEvery('manage', undefined, suites, undefined)).toBe(
      "Needs an API token with the 'manage' scope covering a project in full. The token in " +
        "Settings has the 'manage' scope, covering only 'llvm/nts'.",
    )
    // Unlike one listing a whole project, which may well cover one of them in full.
    const project = valid([entry('nts'), whole('swift')]) as never
    expect(refusalInEvery('manage', undefined, project, undefined)).toBeUndefined()
    expect(refusalInEvery('manage', undefined, valid(null) as never, undefined)).toBeUndefined()
  })

  it('says why the token covers none of them in full', () => {
    expect(refusalInEvery('manage', projects, valid([entry('nts')]) as never, projects)).toBe(
      "Needs an API token with the 'manage' scope covering a project in full. The token in " +
        "Settings has the 'manage' scope, covering only 'llvm/nts'.",
    )
    // Naming the project when there is only one.
    expect(refusalInEvery('manage', [PROJECT], valid([]) as never, projects)).toBe(
      "Needs an API token with the 'manage' scope covering project 'llvm' in full. The token in " +
        "Settings has the 'manage' scope, covering nothing: what it was restricted to has been " +
        'deleted, so it can only read.',
    )
  })
})
