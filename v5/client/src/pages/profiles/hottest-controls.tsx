import { useId } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { formatAddress, type Instruction } from './instructions'
import type { Hottest } from './use-hottest'
import styles from './profiles.module.css'

/**
 * The buttons, labelled "Hottest", and which of the hottest instructions is highlighted. Focus
 * stays on a button while the table scrolls, so the position is announced, with the instruction's
 * address. A button at its end stays focusable, so that reaching the end does not lose the focus.
 */
export function HottestControls({
  hottest,
  instructions,
}: {
  hottest: Hottest
  instructions: readonly Instruction[]
}) {
  const label = useId()
  const { highlighted } = hottest
  return (
    <div className={styles.hottest} role="group" aria-labelledby={label}>
      <span id={label}>Hottest</span>
      <button
        type="button"
        aria-disabled={!hottest.canPrevious || undefined}
        onClick={hottest.previous}
      >
        ← Previous
      </button>
      <button type="button" aria-disabled={!hottest.canNext || undefined} onClick={hottest.next}>
        Next →
      </button>
      <span role="status" className={styles.hottestPosition}>
        {highlighted && (
          <>
            <VisuallyHidden>Hottest instruction </VisuallyHidden>
            {highlighted.rank + 1} of {highlighted.count}
            <VisuallyHidden>
              , at {formatAddress(instructions[highlighted.instruction].address)}
            </VisuallyHidden>
          </>
        )}
      </span>
    </div>
  )
}
