import type { ReactNode } from 'react'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { SearchInput } from '../../components/search-input'
import type { ServerSearch } from '../../components/use-server-search'

interface Props {
  search: ServerSearch
  searchLabel: string
  placeholder: string
  /** Filters shown in the controls panel before the search, if the tab has any. */
  controls?: ReactNode
  /** Shown between the controls panel and the table, whatever state the table is in. */
  toolbar?: ReactNode
  isPending: boolean
  /** Why the rows asked for could not be fetched, shown in place of the table and its pager. */
  error: Error | null
  onRetry(): void
  /** The table and its pager, rendered once there is something to show. */
  children: ReactNode
}

/**
 * What every tab of the page has: a search above its table, and its loading and error states. A
 * failure takes the place of the table, rather than leave up rows for another page or search (AR2
 * "Paginated tables").
 */
export function TabContent({
  search,
  searchLabel,
  placeholder,
  controls,
  toolbar,
  isPending,
  error,
  onRetry,
  children,
}: Props) {
  return (
    <>
      <ControlsPanel>
        {controls}
        <SearchInput search={search} label={searchLabel} placeholder={placeholder} />
      </ControlsPanel>
      {toolbar}
      {error ? (
        <ErrorMessage error={error} onRetry={onRetry} />
      ) : isPending ? (
        <Loading />
      ) : (
        children
      )}
    </>
  )
}
