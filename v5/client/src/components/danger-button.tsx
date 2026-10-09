import type { ComponentProps } from 'react'
import clsx from 'clsx'
import styles from './danger-button.module.css'

/** A button whose action destroys something, in red. */
export function DangerButton({ className, ...props }: ComponentProps<'button'>) {
  return <button {...props} className={clsx(styles.danger, className)} />
}
