import { memo, useCallback, useDeferredValue, useMemo } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { Combobox } from '../../components/combobox'
import { ErrorMessage, Loading } from '../../components/feedback'
import { useLocalSuggestions, type Suggestion } from '../../components/suggestions'
import type { Counters } from './counters'
import { functionShare, shareText, type ProfileFunction } from './functions'
import { HottestControls } from './hottest-controls'
import { InstructionTable } from './instruction-table'
import { instructionValues, type ValueMode } from './instructions'
import { defaultFromA } from './defaults'
import { ShareBadge } from './share-badge'
import { useHottest } from './use-hottest'
import type { SideFunctions } from './use-functions'
import type { ProfileSide } from './use-side'
import styles from './profiles.module.css'

interface Props {
  side: ProfileSide
  functions: SideFunctions
  /** The counter shown, if the profiles shown have any. */
  counter: string | undefined
  values: ValueMode
}

/**
 * What a side shows of its profile, in its column (PF7): its function selector (PF4), and the
 * selected function's disassembly (PF5).
 */
export function ProfileColumn({ side, functions, counter, values }: Props) {
  const { status, metadata } = side
  return (
    <section className={styles.column} aria-label={`Profile ${side.id.toUpperCase()}`}>
      {status.kind === 'pending' && <Loading label="Loading the profile..." />}
      {/* Earlier failures, such as the runs', show in the side's controls. */}
      {status.kind === 'failed' && metadata.isError && (
        <ErrorMessage
          context="The profile could not be loaded"
          error={metadata.error}
          onRetry={() => void metadata.refetch()}
        />
      )}
      {status.kind === 'shown' && (
        <Functions
          uuid={status.uuid}
          profile={status.profile.counters}
          functions={functions}
          counter={counter}
          values={values}
        />
      )}
    </section>
  )
}

interface FunctionsProps extends Omit<Props, 'side'> {
  /** The UUID of the profile shown. */
  uuid: string
  /** Its top-level counters. */
  profile: Counters
}

/** The profile's functions, the one selected, and its instructions. */
function Functions({ uuid, profile, functions, counter, values }: FunctionsProps) {
  const { functions: list, ordered, name } = functions
  if (list.isError) {
    return (
      <ErrorMessage
        context="The functions could not be listed"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    )
  }
  if (list.data === undefined || ordered === undefined) {
    return <Loading label="Loading the functions..." />
  }
  if (list.data.length === 0) return <p className={styles.note}>This profile lists no functions.</p>
  return (
    <>
      <FunctionSelector
        // A new profile mounts a new selector, because its deferred re-sort must not mix the
        // functions of two profiles.
        key={uuid}
        functions={list.data}
        ordered={ordered}
        selected={name}
        isDefault={functions.isDefault}
        counter={counter}
        profile={profile}
        onPick={functions.pick}
        onClear={functions.clear}
      />
      {name === undefined && <Loading label="Loading the function..." />}
      {/* None while side B's profile does not have its default function, or while side A shows
          none (PF4). */}
      {name && (
        <Disassembly
          // A new profile or function scrolls back to the top. A refetch of the same one keeps the
          // scroll position.
          key={`${uuid}/${name}`}
          name={name}
          disassembly={functions.disassembly}
          counter={counter}
          values={values}
        />
      )}
    </>
  )
}

interface SelectorProps {
  functions: readonly ProfileFunction[]
  /** The functions, hottest first under the counter. */
  ordered: readonly ProfileFunction[]
  /** The function selected, once known: none while side B's profile lacks its default one. */
  selected: string | null | undefined
  /** Whether side B shows that function, or none, because it is side B's default (PF4). */
  isDefault: boolean
  counter: string | undefined
  /** The profile's top-level counters. */
  profile: Counters
  onPick(name: string): void
  /** Clears the side's own function, if it can be cleared. */
  onClear: (() => void) | undefined
}

/**
 * A combobox over the profile's functions, hottest first under the counter, each with its share of
 * the profile (PF4). It fills its column, because function names can be long. It only renders the
 * functions in view, because a profile can list thousands. It renders again only when what it
 * shows changes, so a change to the Values does not touch it.
 */
const FunctionSelector = memo(function FunctionSelector({
  functions,
  ordered,
  selected,
  isDefault,
  counter,
  profile,
  onPick,
  onClear,
}: SelectorProps) {
  // Re-sort for a new counter in a deferred render, after the rest of the page shows the counter,
  // so that the re-sort does not hold up the page.
  const view = useDeferredValue(useMemo(() => ({ ordered, counter }), [ordered, counter]))
  const all = useMemo(
    () => view.ordered.map((fn) => ({ key: fn.name, text: fn.name })),
    [view.ordered],
  )
  const byName = useMemo(() => new Map(functions.map((fn) => [fn.name, fn])), [functions])
  const suggestions = useLocalSuggestions(all)
  // Memoized, because a new function renders every suggestion again.
  const renderSuggestion = useCallback(
    (suggestion: Suggestion) => {
      const share = functionShare(byName.get(suggestion.key)!, view.counter, profile)
      return (
        <>
          <span className={styles.suggestion} aria-hidden="true">
            <span className={styles.functionName}>{suggestion.text}</span>
            <ShareBadge share={share} counter={view.counter} />
          </span>
          {/* What the option reads as, in one piece: "warm, 75% of cycles". */}
          <VisuallyHidden elementType="span">
            {share === undefined || view.counter === undefined
              ? suggestion.text
              : `${suggestion.text}, ${shareText(share, view.counter)}`}
          </VisuallyHidden>
        </>
      )
    },
    [byName, view.counter, profile],
  )
  const selectedFunction = selected == null ? undefined : byName.get(selected)
  return (
    <div className={styles.functionRow}>
      <Combobox
        // The counter sets the order of the suggestions, so a new counter mounts a new combobox.
        // React Aria takes far longer to reorder thousands of suggestions than to list them anew,
        // and reordering would make a counter change lag (PF5).
        key={view.counter}
        label="Function"
        fill
        // Side B's default function is shown as inherited, rather than as its value.
        value={selected == null || isDefault ? null : { key: selected, text: selected }}
        placeholder={selected === null ? 'Select a function' : undefined}
        inherited={isDefault ? defaultFromA(selected) : undefined}
        // Clearing the function picked on side B brings back its default. Side A always shows one.
        onChange={(picked) => (picked ? onPick(picked.key) : onClear?.())}
        suggestions={suggestions}
        renderSuggestion={renderSuggestion}
        virtualized
      />
      {selectedFunction && (
        <ShareBadge share={functionShare(selectedFunction, counter, profile)} counter={counter} />
      )}
    </div>
  )
})

interface DisassemblyProps {
  name: string
  disassembly: SideFunctions['disassembly']
  counter: string | undefined
  values: ValueMode
}

/**
 * The instructions of the function `name`, once they have loaded, and the buttons that step through
 * the hottest of them.
 */
function Disassembly({ name, disassembly, counter, values }: DisassemblyProps) {
  const instructions = disassembly.data?.instructions
  const shown = useMemo(
    () =>
      instructions === undefined || counter === undefined
        ? undefined
        : instructionValues(instructions, counter),
    [instructions, counter],
  )
  const hottest = useHottest(shown, counter)
  if (disassembly.isError) {
    return (
      <ErrorMessage
        context={`The instructions of ${name} could not be loaded`}
        error={disassembly.error}
        onRetry={() => void disassembly.refetch()}
      />
    )
  }
  if (instructions === undefined) return <Loading label="Loading the instructions..." />
  return (
    <>
      <HottestControls hottest={hottest} instructions={instructions} />
      <InstructionTable
        label={`Instructions of ${name}`}
        instructions={instructions}
        counter={counter}
        values={shown}
        mode={values}
        highlighted={hottest.highlighted?.instruction}
      />
    </>
  )
}
