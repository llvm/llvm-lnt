import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type RefObject,
} from 'react'
import { Button, Dialog, DialogTrigger, VisuallyHidden } from 'react-aria-components'
import { HelpLabel } from '../../components/help-label'
import { Popover } from '../../components/popover'
import { Select } from '../../components/select'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { parseNumber } from '../../format'
import type { FilterKey } from './comparison'
import { CONFIDENCES, FILTER_PARAMS, filterSettings, type Settings } from './settings'
import shared from '../../components/dropdown.module.css'
import styles from './compare.module.css'

interface Filter {
  key: FilterKey
  label: string
  /** What the filter does, said on hover. */
  help: string
  /** The values the filter accepts, both included, and its value until the user gives another. */
  min: number
  max: number
  initial: number
}

/** The filters (CP1). */
const FILTERS: Filter[] = [
  {
    key: 'deltaPct',
    label: '|Delta %| at least',
    help: 'Leaves out the tests that can be compared whose absolute Delta % is below this.',
    min: 0,
    max: Infinity,
    initial: 1,
  },
  {
    key: 'pValue',
    label: 'P-value at most',
    help:
      "Leaves out the tests that can be compared whose p-value, from Welch's t-test on the logs " +
      "of the runs' values, is above this, and those without one: with fewer than 2 runs on a " +
      "side, or a run's value of 0 or less.",
    min: 0,
    max: 1,
    initial: 0.05,
  },
  {
    key: 'abs',
    label: 'Absolute at least',
    help:
      'Leaves out the tests that can be compared whose two values are both below this in ' +
      "absolute value, in the metric's unit.",
    min: 0,
    max: Infinity,
    initial: 0,
  },
]

const MARGIN_HELP =
  'How large a change must be to matter, as a ratio: with 5%, beyond ×1.05 or ÷1.05. A test is ' +
  'unchanged when the confidence interval of its change lies within the margin, improved or ' +
  'regressed when it lies beyond it, and inconclusive otherwise.'

const CONFIDENCE_HELP =
  "The confidence level of the interval of each test's change, which the margin classifies the " +
  'test by. A higher one leaves more tests inconclusive.'

const CONFIDENCE_OPTIONS = CONFIDENCES.map((value) => ({ value, label: `${value}%` }))

type Classification = Pick<
  Settings,
  | 'margin'
  | 'confidence'
  | 'hide_unchanged'
  | 'hide_inconclusive'
  | (typeof FILTER_PARAMS)[FilterKey]
>

interface Props {
  settings: Classification
  /** Memoize it. */
  update(changes: Partial<Classification>): void
}

/**
 * How the tests are classified, and which are shown (CP1): the margin and the confidence level,
 * "Hide unchanged" and "Hide inconclusive", and the "Filters" button, which opens the filters in a
 * panel below it, each enabled with its checkbox, and its value typed.
 */
export function ClassificationControls({ settings, update }: Props) {
  // The value of each filter as the panel last closed, which a disabled filter opens on again: the
  // URL holds only those of the enabled filters.
  const kept = useRef<KeptValues>({})
  const filters = filterSettings(settings)
  const enabled = FILTERS.filter((filter) => filters[filter.key] !== null).length
  return (
    <div className={styles.classification}>
      <MarginInput value={settings.margin} onChange={(margin) => update({ margin })} />
      <Select
        label="Confidence"
        help={CONFIDENCE_HELP}
        options={CONFIDENCE_OPTIONS}
        value={settings.confidence}
        onChange={(confidence) => update({ confidence })}
      />
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={settings.hide_unchanged}
          onChange={(event) => update({ hide_unchanged: event.target.checked })}
        />
        Hide unchanged
      </label>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={settings.hide_inconclusive}
          onChange={(event) => update({ hide_inconclusive: event.target.checked })}
        />
        Hide inconclusive
      </label>
      <DialogTrigger>
        <Button>
          Filters{enabled > 0 ? ` (${enabled})` : ''} <span aria-hidden="true">▾</span>
        </Button>
        <Popover placement="bottom start">
          <Dialog className={styles.filters} aria-label="Filters">
            {FILTERS.map((filter) => (
              <FilterInput
                key={filter.key}
                filter={filter}
                value={filters[filter.key]}
                kept={kept}
                onChange={(key, value) => update({ [FILTER_PARAMS[key]]: value })}
              />
            ))}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  )
}

/**
 * The text typed for a number between `min` and `max`, both included, starting from `start`, and
 * the last valid value typed: while the text is not a valid value, its input shows the red halo
 * (AR11), and the last valid value stays in use.
 */
function useNumberText(start: number, min: number, max: number) {
  const [text, setText] = useState(String(start))
  const [valid, setValid] = useState(start)
  const parse = (value: string) => parseNumber(value.trim(), min, max)
  const onText = (value: string) => {
    setText(value)
    const parsed = parse(value)
    if (parsed !== undefined) setValid(parsed)
  }
  const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`
  return { text, valid, invalid: parse(text) === undefined, onText, why: `A number ${range}.` }
}

/** The input of a number typed (see `useNumberText`). */
function NumberInput({
  typed: { text, invalid, onText, why },
  ...attributes
}: { typed: ReturnType<typeof useNumberText> } & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'disabled'
>) {
  return (
    <input
      type="text"
      inputMode="decimal"
      className={styles.numberInput}
      value={text}
      aria-invalid={invalid || undefined}
      title={invalid ? why : undefined}
      onChange={(event) => onText(event.target.value)}
      {...attributes}
    />
  )
}

/**
 * Calls `apply` once typing pauses, rather than at each keystroke, which would apply the values
 * typed on the way, such as 0 on the way to 0.05, unless `valid`, the value typed, is `value`, the
 * value in use, already, or `enabled` is false.
 */
function useApplyOnPause(valid: number, value: number | null, enabled: boolean, apply: () => void) {
  // The latest `apply`, which a render of the page passes anew without restarting the pause.
  const latest = useRef(apply)
  useEffect(() => {
    latest.current = apply
  })
  useEffect(() => {
    if (!enabled || valid === value) return
    const timer = setTimeout(() => latest.current(), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, valid, value])
}

/** The margin (CP1), a percentage of at least 0, typed in an input. */
function MarginInput({ value, onChange }: { value: number; onChange(value: number): void }) {
  const typed = useNumberText(value, 0, Infinity)
  useApplyOnPause(typed.valid, value, true, () => onChange(typed.valid))
  const labelId = useId()
  const helpId = useId()
  return (
    <div className={shared.root}>
      <HelpLabel id={labelId} help={MARGIN_HELP}>
        Margin
      </HelpLabel>
      <span className={styles.margin}>
        <NumberInput typed={typed} aria-labelledby={labelId} aria-describedby={helpId} />
        %
      </span>
      <VisuallyHidden elementType="span" id={helpId}>
        {MARGIN_HELP}
      </VisuallyHidden>
    </div>
  )
}

type KeptValues = Partial<Record<FilterKey, number>>

interface FilterProps {
  filter: Filter
  /** The filter's value, or null while it is disabled. */
  value: number | null
  /** Each filter's value as the panel last closed (see `ClassificationControls`). */
  kept: RefObject<KeptValues>
  onChange(key: FilterKey, value: number | null): void
}

/**
 * A filter: its checkbox, and its value, typed in an input, which is disabled while the filter is.
 * A valid value is applied once typing pauses, or as the panel closes, if that is sooner.
 */
function FilterInput({ filter, value, kept, onChange }: FilterProps) {
  const start = value ?? kept.current[filter.key] ?? filter.initial
  const typed = useNumberText(start, filter.min, filter.max)
  const { valid } = typed
  const enabled = value !== null
  const labelId = useId()
  const helpId = useId()
  useApplyOnPause(valid, value, enabled, () => onChange(filter.key, valid))
  // What closing the panel does: keep the filter's value, and apply it if it is the value typed,
  // while typing has not paused since.
  const close = useRef(() => {})
  useEffect(() => {
    close.current = () => {
      kept.current[filter.key] = valid
      if (enabled && valid !== value) onChange(filter.key, valid)
    }
  })
  useEffect(() => () => close.current(), [])

  return (
    <>
      <span className={styles.filterLabel}>
        <input
          type="checkbox"
          checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onChange={(event) => onChange(filter.key, event.target.checked ? valid : null)}
        />
        <HelpLabel id={labelId} help={filter.help}>
          {filter.label}
        </HelpLabel>
        <VisuallyHidden elementType="span" id={helpId}>
          {filter.help}
        </VisuallyHidden>
      </span>
      <NumberInput typed={typed} aria-label={`${filter.label} threshold`} disabled={!enabled} />
    </>
  )
}
