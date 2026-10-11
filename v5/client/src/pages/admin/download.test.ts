import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFile, REVOKE_AFTER_MS } from './download'

describe('downloadFile', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('clicks a link to the content, named after the file, and lets the content go after', async () => {
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return 'blob:content'
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this)
    })

    vi.useFakeTimers()
    downloadFile('nts.json', '{}\n', 'application/json')

    expect(clicked.map((link) => [link.download, link.getAttribute('href')])).toEqual([
      ['nts.json', 'blob:content'],
    ])
    expect(clicked[0].isConnected).toBe(false)
    expect(blobs[0].type).toBe('application/json')
    expect(await blobs[0].text()).toBe('{}\n')
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledWith('blob:content')
  })
})
