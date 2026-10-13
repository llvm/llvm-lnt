import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import type { Measurement } from '../../api/series'
import type { PlotGeometry } from '../../components/chart'
import { formatTimestamp, shortUuid } from '../../format'
import { formatMetricValue, type Metric } from '../../schema'
import styles from './graph.module.css'

/** What the markers of the samples of a point whose details are open need (GR10). */
export interface Pinned {
  metric: Metric
  /** Which side of the point the details are on. */
  details: 'left' | 'right'
  /** Where the markers are drawn, for a press on them not to close the details. */
  ref: RefObject<SVGSVGElement | null>
}

interface Props {
  samples: readonly Measurement[]
  geometry: PlotGeometry
  /** The point's position on the x-axis. */
  position: number
  color: string
  /** Set while the point's details are open. */
  pinned?: Pinned
}

/**
 * The samples of a point (GR10), drawn over the chart at its position, faded, and clipped to the
 * plot, so that they never rescale it. The pointer goes through the markers of a point merely
 * hovered: were they hovered, Plotly would unhover the point, and they would vanish. Those of a
 * point whose details are open stay, and show each sample's tooltip on hover. They are therefore
 * where a drag, a double-click or a click on the chart cannot start, and pressing one, the open
 * point included, does nothing. They are hidden from assistive technology and cannot be focused,
 * since the details list the same samples (GR11).
 */
export function SampleCloud({ samples, geometry, position, color, pinned }: Props) {
  const [tip, setTip] = useState<number | null>(null)
  // A sample's tooltip goes away from the details, unless it would leave the chart there, as at
  // the first commits: then the tooltips of the cloud, whose markers share their x, go over them.
  const [flipped, setFlipped] = useState(false)
  const tipBox = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = tipBox.current?.getBoundingClientRect()
    const chart = tipBox.current?.offsetParent?.getBoundingClientRect()
    if (flipped || box === undefined || chart === undefined) return
    if (box.left < chart.left || box.right > chart.right) setFlipped(true)
  }, [tip, flipped])
  const { area } = geometry
  const x = geometry.x(position) - area.left
  // Out of range once the samples change under the pointer, as data arrives.
  const shown = tip === null ? undefined : samples.at(tip)
  const onRight = flipped === (pinned?.details === 'right')
  return (
    <>
      <svg
        ref={pinned?.ref}
        className={styles.scatter}
        style={{ left: area.left, top: area.top, width: area.width, height: area.height }}
        aria-hidden="true"
      >
        {samples.map((sample, i) => (
          <circle
            key={i}
            className={pinned && styles.pinnedSample}
            cx={x}
            cy={geometry.y(sample.value) - area.top}
            r={4}
            fill={color}
            fillOpacity={0.3}
            {...(pinned && {
              onPointerEnter: () => setTip(i),
              onPointerLeave: () => setTip(null),
              // Pressing a marker leaves the focus in the details, for Escape to close them.
              onMouseDown: (event: MouseEvent) => event.preventDefault(),
            })}
          />
        ))}
      </svg>
      {pinned && shown && (
        <div
          ref={tipBox}
          role="tooltip"
          className={styles.sampleTip}
          style={{
            left: area.left + x,
            top: geometry.y(shown.value),
            background: color,
            transform: `translate(${onRight ? '8px' : 'calc(-100% - 8px)'}, -50%)`,
          }}
        >
          <span>{formatTimestamp(shown.submitted)}</span>
          <span>{shortUuid(shown.run)}</span>
          <span>Value: {formatMetricValue(shown.value, pinned.metric)}</span>
        </div>
      )}
    </>
  )
}
