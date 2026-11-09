import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { ApiKey } from '../auth/credentials'
import { authedApi, unwrap, type Schemas } from './client'
import { queryKeys } from './keys'

export type { ApiKey }
export type ApiKeyList = Schemas['ApiKeyList']

/** The longest name a key can have (E11). */
export const NAME_LENGTH = 256

/**
 * Every API key of the instance, newest first, revoked ones included (E11). Listing them needs an
 * `admin` token, so it is asked for only while `enabled` says that one has been accepted.
 */
export function useApiKeys(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: ({ signal }) => unwrap(authedApi.GET('/api/admin/api-keys', { signal })),
    select: (list) => list.items,
    enabled,
  })
}

/** What every change of a key is saved under, so that the keys table knows when one is under way. */
export const CHANGE_KEY = ['change-api-key'] as const

/**
 * Show the key `prefix` as `update` makes it, after a write to it, without waiting for the list. A
 * list on its way could land after the write's answer, and show the key as it was: it is cancelled
 * first, and its owner asks for the list again unless the token is about to be checked again.
 */
export async function updateCachedKey(
  queryClient: QueryClient,
  prefix: string,
  update: (key: ApiKey) => ApiKey,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.apiKeys })
  queryClient.setQueryData<ApiKeyList>(
    queryKeys.apiKeys,
    (list) =>
      list && { items: list.items.map((item) => (item.prefix === prefix ? update(item) : item)) },
  )
}
