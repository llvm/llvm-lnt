import styles from './note.module.css'

/**
 * Muted text said of what it follows, after a space, such as what a dropdown says of an option, or
 * a machine's name after its label (AR23).
 */
export function Note({ children }: { children: string }) {
  return (
    <>
      {' '}
      <span className={styles.note}>{children}</span>
    </>
  )
}
