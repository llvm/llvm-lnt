import clsx from 'clsx'
import { CATEGORIES, CATEGORY_LABELS, COMPARABLE, formatShare, type Category } from './comparison'
import styles from './compare.module.css'

const isComparable = (category: Category) => (COMPARABLE as readonly string[]).includes(category)

/**
 * How many tests fall in each category (CP4), with the share of each comparable category among the
 * comparable tests. A category with none is muted rather than left out, so that the bar's layout
 * stays as it is.
 */
export function SummaryBar({ counts }: { counts: Record<Category, number> }) {
  const comparable = COMPARABLE.reduce((sum, category) => sum + counts[category], 0)
  return (
    <ul className={styles.summary} aria-label="Summary">
      {CATEGORIES.map((category) => {
        const count = counts[category]
        const share = isComparable(category) && comparable > 0
        return (
          <li key={category} className={clsx(styles.category, count === 0 && styles.muted)}>
            <span className={clsx(styles.dot, styles[category])} aria-hidden="true" />
            {CATEGORY_LABELS[category]}{' '}
            <span
              title={
                isComparable(category)
                  ? `Out of the ${comparable} tests improved, regressed, noise or unchanged.`
                  : undefined
              }
            >
              {share ? `${count} (${formatShare(count, comparable)})` : count}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
