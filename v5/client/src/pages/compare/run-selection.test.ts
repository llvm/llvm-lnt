import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRunSelection } from './run-selection'

interface Props {
  uuids: readonly string[] | undefined
  list: string
  fromUrl: readonly string[]
}

const sorted = (runs: ReadonlySet<string> | undefined) => runs && [...runs].sort()

/** The run selection, from `initial`, and what each render read of the runs selected. */
function renderSelection(initial: Props) {
  const reads: (string[] | undefined)[] = []
  const hook = renderHook(
    ({ uuids, list, fromUrl }: Props) => {
      const selection = useRunSelection(uuids, list, fromUrl)
      reads.push(sorted(selection.selected))
      return selection
    },
    { initialProps: initial },
  )
  const selected = () => sorted(hook.result.current.selected)
  return { ...hook, reads, selected }
}

const RUNS = ['1', '2', '3']

describe('useRunSelection', () => {
  it('is unknown until the runs are listed, then selects every run', () => {
    const { rerender, selected, result } = renderSelection({
      uuids: undefined,
      list: 'c1',
      fromUrl: [],
    })
    expect(selected()).toBeUndefined()
    expect(result.current.chosen).toBeUndefined()

    rerender({ uuids: RUNS, list: 'c1', fromUrl: [] })
    expect(selected()).toEqual(RUNS)
    expect(result.current.chosen).toEqual(RUNS)
  })

  it('says nothing of the runs selected until it has filled the selection', () => {
    const { rerender, reads } = renderSelection({ uuids: undefined, list: 'c1', fromUrl: ['2'] })
    rerender({ uuids: RUNS, list: 'c1', fromUrl: ['2'] })
    expect(reads.every((read) => read === undefined || read.join() === '2')).toBe(true)
    expect(reads.at(-1)).toEqual(['2'])
  })

  it('selects the runs the URL names that are listed, or else every run', () => {
    expect(renderSelection({ uuids: RUNS, list: 'c1', fromUrl: ['3', '9'] }).selected()).toEqual([
      '3',
    ])
    expect(renderSelection({ uuids: RUNS, list: 'c1', fromUrl: ['9'] }).selected()).toEqual(RUNS)
  })

  it('keeps what the user selects, whatever the URL names afterwards', () => {
    const { rerender, selected, result } = renderSelection({
      uuids: RUNS,
      list: 'c1',
      fromUrl: [],
    })
    act(() => result.current.rows.click('1', false))
    expect(selected()).toEqual(['2', '3'])
    expect(result.current.chosen).toEqual(['2', '3'])

    // As the page writes the selection to the URL, and back to every run.
    rerender({ uuids: RUNS, list: 'c1', fromUrl: ['2', '3'] })
    rerender({ uuids: RUNS, list: 'c1', fromUrl: [] })
    expect(selected()).toEqual(['2', '3'])
  })

  it('fills the selection again for another list', () => {
    const { rerender, selected, result } = renderSelection({
      uuids: RUNS,
      list: 'c1',
      fromUrl: [],
    })
    act(() => result.current.rows.click('1', false))

    rerender({ uuids: ['4', '5'], list: 'c2', fromUrl: ['2', '3'] })
    expect(selected()).toEqual(['4', '5'])
  })

  it('fills the selection again for the same list once its runs have stopped being listed', () => {
    const { rerender, selected, result } = renderSelection({
      uuids: RUNS,
      list: 'c1',
      fromUrl: [],
    })
    act(() => result.current.rows.click('1', false))

    rerender({ uuids: undefined, list: 'c1', fromUrl: [] })
    expect(selected()).toBeUndefined()
    rerender({ uuids: RUNS, list: 'c1', fromUrl: [] })
    expect(selected()).toEqual(RUNS)
  })
})
