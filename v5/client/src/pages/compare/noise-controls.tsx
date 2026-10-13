import { useCallback, useEffect, useId, useState } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { HelpLabel } from '../../components/help-label'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { parseNumber } from '../../format'
import type { NoiseKnob } from './comparison'
import type { Settings } from './settings'
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

/** The URL parameter of each noise knob (CP7). */
const NOISE_PARAMS = {
  pct: 'noise_pct',
  pval: 'noise_pval',
  floor: 'noise_floor',
} as const satisfies Record<NoiseKnob, keyof Settings>

interface Props {
  settings: Settings
  update(changes: Partial<Settings>): void
}

/**
 * "Hide noise", and the noise knobs, in a section collapsed to begin with (CP1): each enabled with
 * its checkbox, and its value typed. The URL holds a knob's value while it is enabled (CP7).
 */
export function NoiseControls({ settings, update }: Props) {
  const [open, setOpen] = useState(false)
  const sectionId = useId()
  const onNoise = useCallback(
    (knob: NoiseKnob, value: number | null) => update({ [NOISE_PARAMS[knob]]: value }),
    [update],
  )
  return (
    <div className={styles.noise}>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={settings.hide_noise}
          onChange={(event) => update({ hide_noise: event.target.checked })}
        />
        Hide noise
      </label>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        aria-controls={sectionId}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Noise filtering
      </button>
      <div id={sectionId} className={styles.knobs} hidden={!open}>
        {KNOBS.map((knob) => (
          <KnobInput
            key={knob.key}
            knob={knob}
            value={settings[NOISE_PARAMS[knob.key]]}
            onChange={onNoise}
          />
        ))}
      </div>
    </div>
  )
}

interface KnobProps {
  knob: Knob
  /** The knob's value, or null while it is disabled. */
  value: number | null
  onChange(knob: NoiseKnob, value: number | null): void
}

/**
 * A noise knob: its checkbox, and its value, typed in an input. While the text is not a value the
 * knob accepts, the input shows the red halo (AR11), and the knob keeps its last valid value. A
 * valid value is applied once typing pauses, rather than at each keystroke, which would apply the
 * values typed on the way, such as 0 on the way to 0.05.
 */
function KnobInput({ knob, value, onChange }: KnobProps) {
  const [text, setText] = useState(String(value ?? knob.initial))
  const [valid, setValid] = useState(value ?? knob.initial)
  const invalid = parseNumber(text.trim(), knob.min, knob.max) === undefined
  const enabled = value !== null
  const labelId = useId()
  const helpId = useId()

  useEffect(() => {
    if (!enabled || valid === value) return
    const timer = setTimeout(() => onChange(knob.key, valid), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [enabled, valid, value, knob.key, onChange])

  const range =
    knob.max === Infinity ? `at least ${knob.min}` : `between ${knob.min} and ${knob.max}`
  return (
    <div className={styles.knob}>
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
      <VisuallyHidden id={helpId}>{knob.help}</VisuallyHidden>
      <input
        type="text"
        inputMode="decimal"
        className={styles.knobValue}
        aria-label={`${knob.label} threshold`}
        value={text}
        aria-invalid={invalid || undefined}
        title={invalid ? `A number ${range}.` : undefined}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = parseNumber(event.target.value.trim(), knob.min, knob.max)
          if (parsed !== undefined) setValid(parsed)
        }}
      />
    </div>
  )
}
