import { useState } from 'react'

/**
 * `data`, or the last data it held while it is undefined: when a query for another page fails,
 * say, so that a table can keep showing its last page next to the error, with its pager.
 */
export function useLastData<Data>(data: Data | undefined): Data | undefined {
  const [last, setLast] = useState(data)
  if (data !== undefined && data !== last) setLast(data)
  return data ?? last
}
