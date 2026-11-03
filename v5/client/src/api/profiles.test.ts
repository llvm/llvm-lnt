import { QueryObserver } from '@tanstack/react-query'
import { HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { mockApi } from '../test/mock-api'
import { server } from '../test/server'
import { createQueryClient } from './query-client'
import {
  disassemblyQuery,
  forgetProfiles,
  profileFunctionsQuery,
  profileKey,
  profileQuery,
} from './profiles'
import { suiteRef } from './suites'

const LIBCXX = suiteRef('llvm', 'libcxx')

const UUID = '6f1c2a9e-3b7d-4e58-9a1f-0c8d2e4b7a63'

describe('profileFunctionsQuery', () => {
  it('gives the functions of the profile', async () => {
    const functions = [{ name: 'main', counters: { cycles: 10 }, length: 2 }]
    server.use(
      mockApi(
        'get',
        '/api/projects/{project}/suites/{suite}/profiles/{uuid}/functions',
        ({ params }) => {
          expect(params).toEqual({ project: 'llvm', suite: 'libcxx', uuid: UUID })
          return HttpResponse.json({ items: functions })
        },
      ),
    )

    const data = await createQueryClient().fetchQuery(profileFunctionsQuery(LIBCXX, UUID))

    expect(data).toEqual(functions)
  })
})

describe('disassemblyQuery', () => {
  it('names the function as it is, whatever characters it has', async () => {
    // A name can hold a `/` (I1), and characters that a query string must escape.
    const name = 'operator/(a&b, c=d) #1 ?'
    const disassembly = {
      name,
      counters: { cycles: 5 },
      disassembly_format: 'llvm-objdump',
      instructions: [{ address: 4096, counters: { cycles: 5 }, text: 'ret' }],
    }
    server.use(
      mockApi(
        'get',
        '/api/projects/{project}/suites/{suite}/profiles/{uuid}/disassembly',
        ({ request }) => {
          expect(new URL(request.url).searchParams.getAll('function')).toEqual([name])
          return HttpResponse.json(disassembly)
        },
      ),
    )

    const data = await createQueryClient().fetchQuery(disassemblyQuery(LIBCXX, UUID, name))

    expect(data).toEqual(disassembly)
  })
})

describe('forgetProfiles', () => {
  const unsubscribes: (() => void)[] = []
  afterEach(() => unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe()))

  const SHOWN = disassemblyQuery(LIBCXX, UUID, 'main').queryKey
  const HIDDEN = [
    profileQuery(LIBCXX, UUID).queryKey,
    profileFunctionsQuery(suiteRef('llvm', 'nts'), 'other-uuid').queryKey,
  ]
  const KEPT = [['suite', 'llvm', 'libcxx', 'runs'], ['projects']]

  function observe(
    queryClient: ReturnType<typeof createQueryClient>,
    queryKey: readonly unknown[],
  ) {
    const observer = new QueryObserver(queryClient, { queryKey, enabled: false })
    unsubscribes.push(observer.subscribe(() => {}))
  }

  it('keeps profile data for good until it is forgotten', () => {
    for (const options of [
      profileQuery(LIBCXX, UUID),
      profileFunctionsQuery(LIBCXX, UUID),
      disassemblyQuery(LIBCXX, UUID, 'main'),
    ]) {
      expect(options.queryKey.slice(0, 5)).toEqual(profileKey(LIBCXX, UUID))
      expect(options.staleTime).toBe(Infinity)
      expect(options.gcTime).toBe(Infinity)
    }
  })

  it("drops every suite's profile data that nothing observes once the task is over", async () => {
    const queryClient = createQueryClient()
    for (const key of [SHOWN, ...HIDDEN, ...KEPT]) queryClient.setQueryData(key, 'data')
    observe(queryClient, SHOWN)

    forgetProfiles(queryClient)
    expect(queryClient.getQueryData(HIDDEN[0])).toBe('data')
    // What a page mounted again at once observes before then is kept.
    observe(queryClient, HIDDEN[0])
    await new Promise((resolve) => setTimeout(resolve))

    expect(queryClient.getQueryData(HIDDEN[0])).toBe('data')
    expect(queryClient.getQueryData(HIDDEN[1])).toBeUndefined()
    for (const key of [SHOWN, ...KEPT]) expect(queryClient.getQueryData(key)).toBe('data')
  })
})
