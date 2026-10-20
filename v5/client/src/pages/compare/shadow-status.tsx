import { useEffect, useRef, type RefObject } from 'react'
import { ChipList } from '../../components/chip-list'
import { ErrorMessage } from '../../components/feedback'
import { shadowLook } from './chart'
import type { Shadows } from './shadows'
import styles from './compare.module.css'

interface Props {
  shadows: Shadows
  /**
   * The button pinning a shadow, which takes the focus once the last shadow is dismissed. While
   * there is no comparison, there is no such button, and the focus goes back to the page.
   */
  pinButton: RefObject<HTMLButtonElement | null>
}

/**
 * What could not be loaded of the shadows (CP8), and their chips, which name them, show their
 * colours and markers, and dismiss them. A shadow just pinned gives the focus to its chip's button,
 * since side B, as it is, can no longer be pinned.
 */
export function ShadowStatus({ shadows: { shadows, failures, dismiss }, pinButton }: Props) {
  const chipArea = useRef<HTMLDivElement>(null)
  // How many shadows there were as of the last render. Only pinning adds one: the shadows the page
  // starts with, from the URL, take no focus.
  const count = useRef(shadows.length)
  useEffect(() => {
    if (shadows.length > count.current) {
      const buttons = chipArea.current?.querySelectorAll('button')
      buttons?.[buttons.length - 1]?.focus()
    }
    count.current = shadows.length
  }, [shadows.length])
  const labels = new Map(shadows.map(({ key, label }) => [key, label]))
  return (
    <>
      {failures.error !== null && (
        <ErrorMessage
          context="A shadow could not be loaded"
          error={failures.error}
          onRetry={failures.retry}
        />
      )}
      <div ref={chipArea}>
        <ChipList
          label="Shadows"
          chips={shadows.map(({ key, label }, i) => {
            const { color, marker } = shadowLook(i)
            return {
              key,
              mark: (
                <span className={styles.shadowMark} style={{ color }} aria-hidden="true">
                  {marker.char}
                </span>
              ),
              text: `Shadow: ${label}`,
            }
          })}
          removeLabel={(chip) => `Dismiss the shadow ${labels.get(chip.key)}`}
          onRemove={dismiss}
          focusWhenEmpty={() => pinButton.current}
        />
      </div>
    </>
  )
}
