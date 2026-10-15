/** The heat scale of the Profiles page (PF6), which colors an instruction or a function by share. */

/** Where the scale starts and ends: a light yellow and a light red, under which text stays legible. */
const YELLOW = [253, 224, 71] as const
const RED = [248, 113, 113] as const

/** Shares below this percentage are not colored. */
const COLD = 1
/** Shares from this percentage up are red. */
const HOT = 10

/**
 * The color of `share`, a percentage (PF6): none below 1%, from yellow at 1% to red at 10%, and red
 * from there up. In between, each sRGB channel goes linearly from one to the other, as their
 * gamma-encoded values (as CSS's `color-mix(in srgb, ...)` does), not in linear light.
 */
export function heatColor(share: number): string | undefined {
  if (!(share >= COLD)) return undefined
  const t = Math.min((share - COLD) / (HOT - COLD), 1)
  const [r, g, b] = YELLOW.map((from, i) => Math.round(from + (RED[i] - from) * t))
  return `rgb(${r}, ${g}, ${b})`
}
