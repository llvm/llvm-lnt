import { Badge } from '../../components/badge'
import { formatPercent } from '../../format'
import { heatColor } from './heat'

/**
 * A function's share of its profile's value for `counter`, colored by the heat scale (PF4), beside
 * the function in its selector. Nothing for a function without a share (see `functionShare`).
 */
export function ShareBadge({ share, counter }: { share: number | undefined; counter: string }) {
  if (share === undefined) return null
  return (
    <Badge help={`Share of the profile's ${counter}`} color={heatColor(share)}>
      {formatPercent(share)}
    </Badge>
  )
}
