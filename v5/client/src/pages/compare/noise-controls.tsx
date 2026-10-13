import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { Button, Dialog, DialogTrigger, VisuallyHidden } from 'react-aria-components'
import { HelpLabel } from '../../components/help-label'
import { Popover } from '../../components/popover'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { parseNumber } from '../../format'
import type { NoiseKnob, NoiseSettings } from './comparison'
import styles from './compare.module.css'

interface Knob {
  key: NoiseKnob
  label: string
  /** What the knob does, said on hover. */
  help: string
  /** The values the knob accepts, both included, and its value until the user gives another. */
  min: number
  max: number
  initial: number
}

/** The noise knobs (CP1). */
const KNOBS: Knob[] = [
  {
    key: 'pct',
    label: 'Delta % below',
    help: 'Tests whose absolute Delta % is below this threshold are noise.',
    min: 0,
    max: Infinity,
    initial: 1,
  },
  {
    key: 'pval',
    label: 'P-value above',
    help:
      "Welch's t-test on the samples of both sides: tests whose p-value is above this threshold " +
      'are noise, their difference not being statistically significant. It needs at least 2 ' +
      'samples on each side.',
    min: 0,
    max: 1,
    initial: 0.05,
  },
  {
    key: 'floor',
    label: 'Absolute below',
    help:
      "Tests whose values are both below this floor, in the metric's unit, are noise: too small " +
      'to be meaningful.',
    min: 0,
    max: Infinity,
    initial: 0,
  },
]

type KeptValues = Partial<Record<NoiseKnob, number>>

interface Props {
  noise: NoiseSettings
  /** Called with a knob's threshold once it changes, or null once it is disabled. Memoize it. */
  onNoise(knob: NoiseKnob, value: number | null): void
  hideNoise: boolean
  onHideNoise(hide: boolean): void
}

/**
 * "Hide noise", and the "Noise filtering" button, which opens the noise knobs in a panel below it
 * (CP1): each enabled with its checkbox, and its value typed.
 */
export function NoiseControls({ noise, onNoise, hideNoise, onHideNoise }: Props) {
  // The value of each knob as the panel last closed, which a disabled knob opens on again: the URL
  // holds only those of the enabled knobs.
  const kept = useRef<KeptValues>({})
  return (
    <div className={styles.noiseControls}>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={hideNoise}
          onChange={(event) => onHideNoise(event.target.checked)}
        />
        Hide noise
      </label>
      <DialogTrigger>
        <Button>
          Noise filtering <span aria-hidden="true">▾</span>
        </Button>
        <Popover placement="bottom start">
          <Dialog className={styles.knobs} aria-label="Noise filtering">
            {KNOBS.map((knob) => (
              <KnobInput
                key={knob.key}
                knob={knob}
                value={noise[knob.key]}
                kept={kept}
                onChange={onNoise}
              />
            ))}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  )
}

interface KnobProps {
  knob: Knob
  /** The knob's value, or null while it is disabled. */
  value: number | null
  /** Each knob's value as the panel last closed (see `NoiseControls`). */
  kept: RefObject<KeptValues>
  onChange(knob: NoiseKnob, value: number | null): void
}

/**
 * A noise knob: its checkbox, and its value, typed in an input, which is disabled while the knob is.
 * While the text is not a value the knob accepts, the input shows the red halo (AR11), and the knob
 * keeps its last valid value. A valid value is applied once typing pauses, rather than at each
 * keystroke, which would apply the values typed on the way, such as 0 on the way to 0.05, or as the
 * panel closes, if that is sooner.
 */
function KnobInput({ knob, value, kept, onChange }: KnobProps) {
  const start = value ?? kept.current[knob.key] ?? knob.initial
  const [text, setText] = useState(String(start))
  const [valid, setValid] = useState(start)
  const invalid = parseNumber(text.trim(), knob.min, knob.max) === undefined
  const enabled = value !== null
  const labelId = useId()
  const helpId = useId()

  useEffect(() => {
    if (!enabled || valid === value) return
    const timer = setTimeout(() => onChange(knob.key, valid), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, valid, value, knob.key, onChange])
  // What closing the panel does: keep the knob's value, and apply it if it is the value typed,
  // while typing has not paused since.
  const close = useRef(() => {})
  useEffect(() => {
    close.current = () => {
      kept.current[knob.key] = valid
      if (enabled && valid !== value) onChange(knob.key, valid)
    }
  })
  useEffect(() => () => close.current(), [])

  const range =
    knob.max === Infinity ? `at least ${knob.min}` : `between ${knob.min} and ${knob.max}`
  return (
    <>
      <span className={styles.knobLabel}>
        <input
          type="checkbox"
          checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onChange={(event) => onChange(knob.key, event.target.checked ? valid : null)}
        />
        <HelpLabel id={labelId} help={knob.help}>
          {knob.label}
        </HelpLabel>
        <VisuallyHidden elementType="span" id={helpId}>
          {knob.help}
        </VisuallyHidden>
      </span>
      <input
        type="text"
        inputMode="decimal"
        className={styles.knobValue}
        aria-label={`${knob.label} threshold`}
        value={text}
        disabled={!enabled}
        aria-invalid={invalid || undefined}
        title={invalid ? `A number ${range}.` : undefined}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = parseNumber(event.target.value.trim(), knob.min, knob.max)
          if (parsed !== undefined) setValid(parsed)
        }}
      />
    </>
  )
}
