import type { ReactNode } from 'react'
import { ControlsPanel } from '../../components/controls-panel'
import { Loaded } from '../../components/feedback'
import { SearchInput } from '../../components/search-input'
import type { ServerSearch } from '../../components/use-server-search'

interface Props<Data> {
  search: ServerSearch
  searchLabel: string
  placeholder: string
  /** Filters shown in the controls panel before the search, if the tab has any. */
  controls?: ReactNode
  /** Shown between the controls panel and the table, whatever state the table is in. */
  toolbar?: ReactNode
  /** The rows asked for, if they have arrived, or those of another page or search meanwhile. */
  data: Data | undefined
  /** Why the rows asked for could not be fetched, shown in place of the table and its pager. */
  error: Error | null
  onRetry(): void
  /** The table and its pager. */
  children(data: Data): ReactNode
}

/**
 * What every tab of the page has: a search above its table, and its loading and error states. A
 * failure takes the place of the table, rather than leave up rows for another page or search (AR7).
 */
export function TabContent<Data>({
  search,
  searchLabel,
  placeholder,
  controls,
  toolbar,
  data,
  error,
  onRetry,
  children,
}: Props<Data>) {
  return (
    <>
      <ControlsPanel>
        {controls}
        <SearchInput search={search} label={searchLabel} placeholder={placeholder} />
      </ControlsPanel>
      {toolbar}
      <Loaded data={data} error={error} onRetry={onRetry}>
        {children}
      </Loaded>
    </>
  )
}
