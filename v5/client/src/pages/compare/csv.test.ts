import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'

describe('toCsv', () => {
  it('writes a line per row, numbers at full precision and null as an empty cell', () => {
    expect(
      toCsv([
        ['Test', 'Value A'],
        ['a', 1.2345678901234],
        ['b', null],
      ]),
    ).toBe('Test,Value A\r\na,1.2345678901234\r\nb,')
  })

  it('quotes a cell holding a comma, a quote or a line break, doubling its quotes', () => {
    expect(toCsv([['a,b', 'say "hi"', 'two\nlines', 'plain']])).toBe(
      '"a,b","say ""hi""","two\nlines",plain',
    )
  })
})
