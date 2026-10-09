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
