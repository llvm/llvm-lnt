import type { CursorPagerState } from '../api/use-cursor-pager'
import styles from './pagination.module.css'

/**
 * Previous and Next below a table over a cursor-paginated endpoint (AR2 "Paginated tables"), from
 * `useCursorPager`.
 */
export function CursorPager({
  pager,
  label,
}: {
  pager: CursorPagerState<unknown>
  /** The pager's accessible name, e.g. `Runs pagination`: a page may have several. */
  label: string
}) {
  return (
    <nav className={styles.pager} aria-label={label}>
      <button type="button" disabled={!pager.hasPrevious} onClick={pager.previous}>
        ← Previous
      </button>
      <button type="button" disabled={!pager.hasNext} onClick={pager.next}>
        Next →
      </button>
    </nav>
  )
}

interface OffsetPagerProps {
  /** The pager's accessible name, e.g. `Machines pagination`: a page may have several. */
  label: string
  /** The offset of the page shown. */
  offset: number
  /** The page size the pages were asked for with. */
  limit: number
  /** How many items the page shown holds. */
  count: number
  /** I2's `total`: how many items match, across every page. */
  total: number
  /** No page can be asked for, because one is on its way. */
  disabled?: boolean
  onChange(offset: number): void
}

/** Previous and Next below a table over an offset-paginated endpoint, with the range shown. */
export function OffsetPager({
  label,
  offset,
  limit,
  count,
  total,
  disabled = false,
  onChange,
}: OffsetPagerProps) {
  const range = count === 0 ? `0 of ${total}` : `${offset + 1}-${offset + count} of ${total}`
  return (
    <nav className={styles.pager} aria-label={label}>
      <button
        type="button"
        disabled={disabled || offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        ← Previous
      </button>
      <span className={styles.range}>{range}</span>
      <button
        type="button"
        disabled={disabled || offset + count >= total}
        onClick={() => onChange(offset + count)}
      >
        Next →
      </button>
    </nav>
  )
}
