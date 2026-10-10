import { useQuery } from '@tanstack/react-query'
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
