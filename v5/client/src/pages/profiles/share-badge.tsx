import { VisuallyHidden } from 'react-aria-components'
import { Badge } from '../../components/badge'
import { formatPercent } from '../../format'
import { shareText } from './functions'
import { heatColor } from './heat'

/**
 * A function's share of its profile's value for `counter`, colored by the heat scale (PF4), beside
 * the function in its selector. Nothing for a function without a share (see `functionShare`).
 * Assistive technology reads it with its counter, as "75% of cycles", which the badge itself only
 * shows on hover. The visible text is hidden from it, so that it reads the share once, in one piece.
 */
export function ShareBadge({
  share,
  counter,
}: {
  share: number | undefined
  counter: string | undefined
}) {
  if (share === undefined || counter === undefined) return null
  return (
    <Badge help={`Share of the profile's ${counter}`} color={heatColor(share)}>
      <span aria-hidden="true">{formatPercent(share)}</span>
      <VisuallyHidden elementType="span">{shareText(share, counter)}</VisuallyHidden>
    </Badge>
  )
}
