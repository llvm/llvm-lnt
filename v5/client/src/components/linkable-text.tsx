import { VisuallyHidden } from 'react-aria-components'
import { truncate } from '../format'

/** A web URL as AR6 defines one, once trimmed: `http://` or `https://`, then non-whitespace. */
const WEB_URL = /^https?:\/\/\S+$/i

interface Props {
  text: string
  /** Cut it to at most this many characters, whole on hover and to assistive technology. */
  max?: number
}

/**
 * A regression's bug, or a field's value (AR6): a link opening in a new tab when it is a web URL,
 * and plain text otherwise, since the API stores whatever string it is given, and a link must not
 * run a `javascript:` one.
 */
export function LinkableText({ text, max }: Props) {
  const shown = max === undefined ? text : truncate(text, max)
  // Assistive technology reads the whole text in place of the cut one.
  const content =
    shown === text ? (
      text
    ) : (
      <>
        <span title={text} aria-hidden="true">
          {shown}
        </span>
        <VisuallyHidden elementType="span">{text}</VisuallyHidden>
      </>
    )
  const trimmed = text.trim()
  if (!WEB_URL.test(trimmed)) return content
  return (
    <a href={trimmed} target="_blank" rel="noopener noreferrer">
      {content}
    </a>
  )
}
