import clsx from 'clsx'
import { plural } from '../../format'
import { CATEGORIES, CATEGORY_LABELS, COMPARABLE, formatShare, type Category } from './comparison'
import styles from './compare.module.css'

const isComparable = (category: Category) => (COMPARABLE as readonly string[]).includes(category)

const NA_HELP =
  'Tests with a value on both sides, but a Value A of 0: their Delta %, Ratio and Status are ' +
  'N/A. Tests with a value on one side only count in Only in A or Only in B.'

/**
 * How many tests fall in each category (CP4), with the share of each comparable category among the
 * comparable tests. A category with none is muted rather than left out, so that the bar's layout
 * stays as it is. A share's denominator, and what N/A counts, are explained on hover.
 */
export function SummaryBar({ counts }: { counts: Record<Category, number> }) {
  const comparable = COMPARABLE.reduce((sum, category) => sum + counts[category], 0)
  return (
    <ul className={styles.summary} aria-label="Summary">
      {CATEGORIES.map((category) => {
        const count = counts[category]
        const share = isComparable(category) && comparable > 0
        const tooltip = share
          ? `Out of the ${plural(comparable, 'test')} improved, regressed, noise or unchanged.`
          : category === 'na'
            ? NA_HELP
            : undefined
        return (
          <li key={category} className={clsx(styles.category, count === 0 && styles.muted)}>
            <span className={clsx(styles.dot, styles[category])} aria-hidden="true" />
            <span title={tooltip} className={tooltip && styles.explained}>
              {CATEGORY_LABELS[category]}{' '}
              {share ? `${count} (${formatShare(count, comparable)})` : count}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
