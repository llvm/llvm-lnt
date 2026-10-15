import { useEffect, useRef, type RefObject } from 'react'
import { ChipList } from '../../components/chip-list'
import { ErrorMessage } from '../../components/feedback'
import { runsListFailed } from '../../components/side-selection'
import { SHADOW_COLOR } from './chart'
import { runCount } from './loading'
import type { Shadow } from './shadow'
import styles from './compare.module.css'

interface Props {
  shadow: Shadow
  /** The button pinning the shadow, which takes the focus once it is dismissed. */
  pinButton: RefObject<HTMLButtonElement | null>
}

/**
 * What could not be loaded of the shadow (CP8), and its chip, which names it and dismisses it. Once
 * the shadow is pinned, the button pinning it is gone: the focus goes to the chip's button.
 */
export function ShadowStatus({ shadow, pinButton }: Props) {
  const { side, failed, pinned } = shadow
  const chipArea = useRef<HTMLDivElement>(null)
  // Whether the shadow was pinned as of the last render: a shadow the page starts with, from the
  // URL, takes no focus.
  const wasPinned = useRef(pinned)
  useEffect(() => {
    if (pinned && !wasPinned.current) chipArea.current?.querySelector('button')?.focus()
    wasPinned.current = pinned
  }, [pinned])
  return (
    <>
      {runsListFailed(side.runs, side.machines, side.settings.machine) && (
        <ErrorMessage
          context="The shadow's runs could not be listed"
          error={side.runs.error}
          onRetry={() => void side.runs.refetch()}
        />
      )}
      {failed.length > 0 && (
        <ErrorMessage
          context={`The samples of ${runCount(failed.length)} of the shadow could not be loaded`}
          error={failed[0].error}
          onRetry={() => failed.forEach((state) => state.retry())}
        />
      )}
      <div ref={chipArea}>
        <ChipList
          label="Shadow"
          chips={
            pinned
              ? [
                  {
                    key: 'shadow',
                    mark: (
                      <span
                        className={styles.shadowMark}
                        style={{ background: SHADOW_COLOR }}
                        aria-hidden="true"
                      />
                    ),
                    text: `Shadow: ${shadow.display} on ${side.settings.machine}`,
                  },
                ]
              : []
          }
          removeLabel={() => 'Dismiss the shadow'}
          onRemove={shadow.dismiss}
          focusWhenEmpty={() => pinButton.current}
        />
      </div>
    </>
  )
}
