/** Small icons, drawn inline rather than from a library: the UI needs only a few. */

import type { ReactNode } from 'react'

/** A small icon, in the color of the text around it, which what holds it names. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Two sheets, one over the other. */
export function CopyIcon() {
  return (
    <Icon>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 10h.5" />
    </Icon>
  )
}

/** A tick. */
export function CopiedIcon() {
  return (
    <Icon>
      <path d="M3 8.5l3 3 7-7" />
    </Icon>
  )
}

/** A cross. */
export function FailedIcon() {
  return (
    <Icon>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  )
}

/** An "i" in a circle: more about something. */
export function InfoIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.25v4M8 4.75v.01" />
    </Icon>
  )
}
