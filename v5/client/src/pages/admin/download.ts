/** How long a download's content is kept for the browser to read. */
export const REVOKE_AFTER_MS = 40_000

/**
 * Have the browser save `content` as a file called `name`, as if it had been downloaded: through a
 * link to it, clicked from script, which the browser saves under the link's `download` name.
 */
export function downloadFile(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  // Some browsers follow only a link that is in the document.
  document.body.append(link)
  link.click()
  link.remove()
  // Long after the click has started the download, which a URL revoked soon after can cut short in
  // some browsers. Keeping it costs only the content's memory meanwhile.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
}
