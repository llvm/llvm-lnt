/** A cell of a CSV document: a number written at full precision, or nothing for null. */
export type CsvCell = string | number | null

/** A cell as CSV writes it (RFC 4180): quoted when it holds a comma, a quote or a line break. */
function csvCell(cell: CsvCell): string {
  if (cell === null) return ''
  const text = String(cell)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** `rows` as a CSV document (RFC 4180), a line per row, for Copy as CSV (CP2). */
export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}
