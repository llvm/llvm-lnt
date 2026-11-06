import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { refOf, reorderSuites, type Project, type Suite } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { Reorderable, ReorderGrip } from '../../components/drag-reorder'
import { useReorderTarget } from '../../components/drag-reorder-target'
import { ErrorMessage } from '../../components/feedback'
import { ReorderIcon } from '../../components/icons'
import { useSavedOrder } from '../../components/use-saved-order'
import { suiteLabel } from '../../labels'
import { ChipLinks } from './chip-links'
import { suiteTabPath, type TabId } from './settings'
import styles from './test-suites.module.css'

/** What the button putting the row in its reordering mode is named, and says on hover (TS1). */
const REORDER = 'Reorder suites'

interface Props {
  /** The project selected, which has suites. */
  project: Project
  /** The name of the suite selected, if one is. */
  selected: string | undefined
  /** The tab a chip leads to. */
  tab: TabId
}

/**
 * The row of the chips of the suites of `project` (TS1), with, when it has two or more, a button
 * putting the row in a reordering mode, where each chip has a grip dragging it sideways instead of
 * being a link, and each drop saves the new order (AR24). That needs `manage` covering the project
 * in full. The mode is the row's own: a row for another project starts without it.
 */
export function SuiteChips({ project, selected, tab }: Props) {
  const queryClient = useQueryClient()
  const gate = useScopeGate('manage', { project: project.name })
  const [reordering, setReordering] = useState(false)
  // In the order the row shows them in, which is the new one while it is saved, in the mode or out
  // of it once left meanwhile.
  const order = useSavedOrder(
    ['reorder', 'suites', project.name],
    project.suites,
    nameOf,
    (saved) => reorderSuites(queryClient, project.name, saved),
  )
  const suites = order.items
  const labelOf = useCallback(
    (name: string) => {
      const suite = project.suites.find((entry) => entry.name === name)
      return `suite ${suite === undefined ? name : suiteLabel(suite)}`
    },
    [project.suites],
  )

  // The same button in both modes, so that it keeps the focus: the icon entering the mode, which
  // needs the scope, and "Done" leaving it, which never does.
  const toggle =
    reordering || project.suites.length >= 2 ? (
      <button
        type="button"
        className={reordering ? undefined : styles.reorderToggle}
        aria-label={reordering ? undefined : REORDER}
        title={reordering ? undefined : gate.title ? `${REORDER}: ${gate.title}` : REORDER}
        disabled={!reordering && gate.disabled}
        onClick={() => {
          // What a drop in the mode said, gone with it.
          order.clearError()
          setReordering(!reordering)
        }}
      >
        {reordering ? 'Done' : <ReorderIcon />}
      </button>
    ) : null

  return (
    <>
      <div className={styles.suiteRow}>
        {reordering ? (
          <Reorderable {...order.list} labelOf={labelOf} orientation="horizontal">
            <ul className={styles.chips} aria-label="Test suites">
              {suites.map((suite) => (
                <ReorderChip
                  key={suite.name}
                  suite={suite}
                  selected={suite.name === selected}
                  reason={gate.title}
                />
              ))}
            </ul>
          </Reorderable>
        ) : (
          <ChipLinks
            label="Test suites"
            chips={suites.map((suite) => ({
              key: suite.name,
              text: suiteLabel(suite),
              to: suiteTabPath(refOf(suite), tab),
            }))}
            selected={selected}
          />
        )}
        {toggle}
      </div>
      {order.error !== null && <ErrorMessage error={order.error} />}
    </>
  )
}

interface ChipProps {
  suite: Suite
  selected: boolean
  /** Why the suite cannot be dragged, if it cannot: the scope it needs. */
  reason: string | undefined
}

/**
 * A suite's chip in the reordering mode: not a link, with a grip dragging it, and where another
 * suite is dropped. The selected one still stands out, and says so to assistive technology.
 */
function ReorderChip({ suite, selected, reason }: ChipProps) {
  const element = useRef<HTMLLIElement>(null)
  const target = useReorderTarget({ itemKey: suite.name, element })
  return (
    <li ref={element} {...target} aria-current={selected ? 'true' : undefined}>
      <span className={clsx(styles.chip, styles.reorderChip)}>
        <ReorderGrip itemKey={suite.name} reason={reason} />
        {suiteLabel(suite)}
      </span>
    </li>
  )
}

const nameOf = (suite: Suite) => suite.name
