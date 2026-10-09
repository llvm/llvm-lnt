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
  error: Error | null
  /** The table and its pager, rendered once there is something to show. */
  children: ReactNode
}

/** What every tab of the page has: a search above its table, and its loading and error states. */
export function TabContent({
  search,
  searchLabel,
  placeholder,
  controls,
  toolbar,
  isPending,
  error,
  children,
}: Props) {
  return (
    <>
      <ControlsPanel>
        {controls}
        <SearchInput search={search} label={searchLabel} placeholder={placeholder} />
      </ControlsPanel>
      {toolbar}
      {error && <ErrorMessage error={error} />}
      {isPending && !error ? <Loading /> : children}
    </>
  )
}
