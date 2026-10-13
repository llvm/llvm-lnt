import type { RefObject } from 'react'
import { ChipList } from '../../components/chip-list'
import { ErrorMessage } from '../../components/feedback'
import { SHADOW_COLOR } from './chart'
import { runCount } from './loading'
import type { Shadow } from './shadow'
import { runsListFailed } from './use-side'
import styles from './compare.module.css'

interface Props {
  shadow: Shadow
  /** What holds the chip, whose button takes the focus once the shadow is pinned. */
  chipArea: RefObject<HTMLDivElement | null>
  /** The button pinning the shadow, which takes the focus once it is dismissed. */
  pinButton: RefObject<HTMLButtonElement | null>
}

/** What could not be loaded of the shadow (CP8), and its chip, which names it and dismisses it. */
export function ShadowStatus({ shadow, chipArea, pinButton }: Props) {
  const { side, failed, pinned } = shadow
  return (
    <>
      {runsListFailed(side) && (
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
