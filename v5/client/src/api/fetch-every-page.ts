import { rejectsCursor, type CursorPage } from './use-cursor-pages'

/**
 * Every item of a cursor-paginated endpoint (I2), fetching its pages one after the other with
 * `fetchPage`, which fetches the page at `cursor`, the first one when it is null. For a list the
 * caller needs whole before it can use any of it; one shown as it arrives uses `useCursorPages`.
 *
 * If the server rejects the cursor of a later page, which may only mean that the server or the
 * suite's schema changed meanwhile (I2), the pages are fetched again from the first, once.
 */
export function fetchEveryPage<Item>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<Item>>,
): Promise<Item[]> {
  return fetchPages(fetchPage, true)
}

async function fetchPages<Item>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<Item>>,
  restart: boolean,
): Promise<Item[]> {
  const items: Item[] = []
  let cursor: string | null = null
  do {
    let page: CursorPage<Item>
    try {
      page = await fetchPage(cursor)
    } catch (error) {
      if (restart && cursor !== null && rejectsCursor(error)) return fetchPages(fetchPage, false)
      throw error
    }
    items.push(...page.items)
    cursor = page.cursor.next
  } while (cursor !== null)
  return items
}
