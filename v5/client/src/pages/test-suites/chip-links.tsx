import type { MouseEvent } from 'react'
import { Link } from 'react-router'
import { isPlainClick } from '../../components/plain-click'
import styles from './test-suites.module.css'

export interface ChipLink {
  key: string
  text: string
  to: string
}

interface Props {
  /** The accessible name of the row. */
  label: string
  chips: ChipLink[]
  /** The key of the selected chip, if one is. */
  selected?: string
  /**
   * What the selected chip is to assistive technology: the page shown, or the current one of its
   * row, such as the project of a suite's page.
   */
  current?: 'page' | 'true'
}

/**
 * A row of chips, each a link, one of which may be selected (TS1). Following one replaces the
 * current history entry, as changing a setting does, so that Back leaves the page rather than
 * picking the chip before (AR2 "State"). A plain click on the selected chip does nothing, rather
 * than start its page again; a modified click still opens it in a new tab (AR2 "Routing").
 */
export function ChipLinks({ label, chips, selected, current = 'page' }: Props) {
  return (
    <nav aria-label={label}>
      <ul className={styles.chips}>
        {chips.map((chip) => {
          const isSelected = chip.key === selected
          return (
            <li key={chip.key}>
              <Link
                to={chip.to}
                replace
                className={styles.chip}
                aria-current={isSelected ? current : undefined}
                onClick={isSelected ? ignorePlainClick : undefined}
              >
                {chip.text}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** Cancel a plain click, which the link would follow. */
function ignorePlainClick(event: MouseEvent) {
  if (isPlainClick(event)) event.preventDefault()
}
