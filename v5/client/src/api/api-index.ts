import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import { queryKeys } from './keys'

/**
 * The commit of LNT the server was built from, from the API index (E1): null until the index has
 * loaded, if it cannot be, or if the server does not know it. Asked for once, and never refreshed,
 * so that it stays the revision of the server the page was loaded from (see AR4).
 */
export function useRevision(): string | null {
  const { data } = useQuery({
    queryKey: queryKeys.index,
    queryFn: ({ signal }) => unwrap(api.GET('/api', { signal })),
    staleTime: Infinity,
  })
  return data?.revision ?? null
}
