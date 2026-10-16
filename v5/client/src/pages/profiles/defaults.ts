/** How side B shows the test or function it takes by default from side A (PF2, PF4). */

/**
 * The value `text` that side B takes by default from side A, as a combobox shows it (see
 * `Combobox`'s `inherited`), or undefined when side B has no default value.
 */
export function defaultFromA(text: string | null | undefined) {
  return text ? { text, description: defaultDescription(text) } : undefined
}

/** What assistive technology reads of a value, `text`, that side B takes by default from side A. */
export function defaultDescription(text: string): string {
  return `${text}, default from side A`
}
