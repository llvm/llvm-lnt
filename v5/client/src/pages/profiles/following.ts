/** How side B shows a value it follows from side A (PF2, PF4). */

/**
 * The value `text` that side B follows from side A, as a combobox shows it (see `Combobox`'s
 * `inherited`), or undefined when side B follows none.
 */
export function followedFromA(text: string | null | undefined) {
  return text ? { text, description: followingA(text) } : undefined
}

/** What assistive technology reads of a value, `text`, that side B follows from side A. */
export function followingA(text: string): string {
  return `${text}, following side A`
}
