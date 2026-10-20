/** A chart's tooltips, with their fields filled as Plotly fills them. */

import type { Data } from 'plotly.js'

/** What Plotly reads as a field of a template (see TEMPLATE_STRING_REGEX in plotly.js). */
const FIELD = /%{([^\s%{}:]*)([:|][^}]*)?}/g

/**
 * The `hovertemplate` of `trace`, still HTML, with its `%{customdata[i]}` fields filled from the
 * `index`th point's data in a single pass, as Plotly fills them, so that what they fill in is not
 * read again. Any other field, or a field with a format, fails the test: text written into the
 * template rather than passed as data would have Plotly read `%{` in it as a field.
 */
export function hoverText(trace: Data, index: number): string {
  const { hovertemplate, customdata } = trace as { hovertemplate?: string; customdata?: unknown[][] }
  if (typeof hovertemplate !== 'string') throw new Error('The trace has no hovertemplate')
  return hovertemplate.replace(FIELD, (field: string, key: string, format?: string) => {
    const item = format === undefined ? /^customdata\[(\d+)\]$/.exec(key) : null
    const value = item === null ? undefined : customdata?.[index]?.[Number(item[1])]
    if (value === undefined) throw new Error(`Unexpected field ${field} in the hovertemplate`)
    return String(value)
  })
}
