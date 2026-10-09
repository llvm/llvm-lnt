import { Popover as AriaPopover, composeRenderProps, type PopoverProps } from 'react-aria-components'
import clsx from 'clsx'
import styles from './popover.module.css'

/**
 * React Aria's `Popover`, with the look every box floating over the page shares: a combobox's list,
 * the Settings panel. `className` adds the caller's own layout to it.
 */
export function Popover({ className, ...props }: PopoverProps) {
  return (
    <AriaPopover
      {...props}
      className={composeRenderProps(className, (own) => clsx(styles.root, own))}
    />
  )
}
