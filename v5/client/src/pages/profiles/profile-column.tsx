import { createContext, memo, useContext, useMemo } from 'react'
import { Combobox } from '../../components/combobox'
import { ErrorMessage, Loading } from '../../components/feedback'
import { useLocalSuggestions, type Suggestion } from '../../components/suggestions'
import type { Counters } from './counters'
import { functionShare, type ProfileFunction } from './functions'
import { InstructionTable } from './instruction-table'
import { instructionValues, type ValueMode } from './instructions'
import { ShareBadge } from './share-badge'
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
      {/* Whatever came before the profile and failed says so in the side's controls. */}
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
        functions={list.data}
        ordered={ordered}
        selected={name ?? null}
        counter={counter}
        profile={profile}
        onPick={functions.pick}
      />
      {name ? (
        <Disassembly
          // Another profile or function starts at the top, but a refetch of the same keeps its place.
          key={`${uuid}/${name}`}
          name={name}
          disassembly={functions.disassembly}
          counter={counter}
          values={values}
        />
      ) : (
        <Loading label="Loading the function..." />
      )}
    </>
  )
}

/** What a suggestion of the function selector needs to show its function's share. */
interface Shares {
  byName: ReadonlyMap<string, ProfileFunction>
  counter: string | undefined
  profile: Counters
}

/**
 * Given to the suggestions rather than built into how they are rendered, so that the counter
 * changing renders again only the suggestions in view, rather than every one (see `Combobox`).
 */
const SharesContext = createContext<Shares | null>(null)

/** A function among the suggestions, and its share of the profile (PF4). */
function FunctionSuggestion({ suggestion }: { suggestion: Suggestion }) {
  const shares = useContext(SharesContext)!
  const fn = shares.byName.get(suggestion.key)!
  return (
    <span className={styles.suggestion}>
      <span className={styles.functionName}>{suggestion.text}</span>
      <ShareBadge share={functionShare(fn, shares.counter, shares.profile)} counter={shares.counter} />
    </span>
  )
}

function renderSuggestion(suggestion: Suggestion) {
  return <FunctionSuggestion suggestion={suggestion} />
}

interface SelectorProps {
  functions: readonly ProfileFunction[]
  /** The functions, hottest first under the counter. */
  ordered: readonly ProfileFunction[]
  /** The function selected, once known. */
  selected: string | null
  counter: string | undefined
  /** The profile's top-level counters. */
  profile: Counters
  onPick(name: string): void
}

/**
 * A combobox over the profile's functions, hottest first under the counter, each with its share of
 * the profile (PF4). It fills its column, as a function's name can be long, and lists only the
 * functions in view, as a profile can list thousands. Rendered again only when what it shows
 * changes, which the Values, say, do not.
 */
const FunctionSelector = memo(function FunctionSelector({
  functions,
  ordered,
  selected,
  counter,
  profile,
  onPick,
}: SelectorProps) {
  // The same suggestion for a function whatever the order, so that sorting the functions again
  // reorders the suggestions rather than replaces them.
  const suggestionOf = useMemo(
    () => new Map(functions.map((fn) => [fn.name, { key: fn.name, text: fn.name }])),
    [functions],
  )
  const all = useMemo(() => ordered.map((fn) => suggestionOf.get(fn.name)!), [ordered, suggestionOf])
  const byName = useMemo(() => new Map(functions.map((fn) => [fn.name, fn])), [functions])
  const shares = useMemo(() => ({ byName, counter, profile }), [byName, counter, profile])
  const suggestions = useLocalSuggestions(all)
  const value = selected === null ? null : (suggestionOf.get(selected) ?? null)
  const selectedFunction = selected === null ? undefined : byName.get(selected)
  return (
    <div className={styles.functionRow}>
      <SharesContext.Provider value={shares}>
        <Combobox
          label="Function"
          fill
          value={value}
          // A function cannot be cleared: the side always shows one.
          onChange={(picked) => picked && onPick(picked.key)}
          suggestions={suggestions}
          renderSuggestion={renderSuggestion}
          virtualized
        />
      </SharesContext.Provider>
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

/** The instructions of the function `name`, once they have loaded. */
function Disassembly({ name, disassembly, counter, values }: DisassemblyProps) {
  const instructions = disassembly.data?.instructions
  const shown = useMemo(
    () =>
      instructions === undefined || counter === undefined
        ? undefined
        : instructionValues(instructions, counter),
    [instructions, counter],
  )
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
    <InstructionTable
      label={`Instructions of ${name}`}
      instructions={instructions}
      counter={counter}
      values={shown}
      mode={values}
    />
  )
}
