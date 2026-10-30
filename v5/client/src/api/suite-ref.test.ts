import { describe, expect, it } from 'vitest'
import { fullName, NO_SUITE, suiteOfFullName, suiteRef } from './suite-ref'

describe('suiteRef', () => {
  it('gives the same object for the same names, and another for others', () => {
    expect(suiteRef('llvm', 'nts')).toBe(suiteRef('llvm', 'nts'))
    expect(suiteRef('llvm', 'nts')).not.toBe(suiteRef('nts', 'llvm'))
    expect(suiteRef('', '')).toBe(NO_SUITE)
  })

  it("reads back a suite's full name", () => {
    expect(fullName(suiteRef('llvm', 'nts'))).toBe('llvm/nts')
    expect(suiteOfFullName('llvm/nts')).toBe(suiteRef('llvm', 'nts'))
  })

  it('reads anything but a full name as no suite', () => {
    for (const name of ['nts', 'llvm/nts/x', '']) expect(suiteOfFullName(name)).toBe(NO_SUITE)
  })
})
