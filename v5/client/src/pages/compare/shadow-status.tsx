import { useEffect, useRef, type RefObject } from 'react'
import { ChipList } from '../../components/chip-list'
import { ErrorMessage } from '../../components/feedback'
import { runCount } from './loading'
import { formatShadow, type Shadows } from './shadow'
import styles from './compare.module.css'

interface Props {
  shadows: Shadows
  /** The button pinning the shadow, which takes the focus once it is dismissed. */
  pinButton: RefObject<HTMLButtonElement | null>
}

/**
 * What could not be loaded of the shadows (CP8), and their chips, which name them and dismiss them.
 * Focus goes to the newest chip on pin, and to the pin button when the last chip is dismissed.
 */
export function ShadowStatus({ shadows, pinButton }: Props) {
  const { items, failedSamples, runsListError } = shadows
  const chipArea = useRef<HTMLDivElement>(null)
  // Whether shadows were added as of the last render: a shadow the page starts with, from the
  // URL, takes no focus.
  const previousCount = useRef(items.length)
  useEffect(() => {
    if (items.length > previousCount.current) {
      const buttons = chipArea.current?.querySelectorAll('button')
      if (buttons && buttons.length > 0) {
        buttons[buttons.length - 1].focus()
      }
    }
    previousCount.current = items.length
  }, [items.length])

  return (
    <>
      {runsListError && (
        <ErrorMessage
          context="The shadow's runs could not be listed"
          error={runsListError.error}
          onRetry={runsListError.retry}
        />
      )}
      {failedSamples.length > 0 && (
        <ErrorMessage
          context={`The samples of ${runCount(failedSamples.length)} of the shadow could not be loaded`}
          error={failedSamples[0].error}
          onRetry={() => failedSamples.forEach((state) => state.retry())}
        />
      )}
      <div ref={chipArea}>
        <ChipList
          label="Shadow"
          chips={items.map((item) => ({
            key: formatShadow(item.spec),
            mark: (
              <span
                className={styles.shadowMark}
                style={{ background: item.color }}
                aria-hidden="true"
              />
            ),
            text: `Shadow: ${item.display} on ${item.spec.machine}`,
          }))}
          removeLabel={() => 'Dismiss the shadow'}
          onRemove={(key) => shadows.dismiss(key)}
          focusWhenEmpty={() => pinButton.current}
        />
      </div>
    </>
  )
}
