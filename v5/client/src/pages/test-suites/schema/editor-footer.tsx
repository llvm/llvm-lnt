import type { ReactNode } from 'react'
import styles from './schema.module.css'

/**
 * The schema editor's footer, below its tables (TS7): its heading, if it has one, then its buttons,
 * at the far end.
 */
export function EditorFooter({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.editorFooter}>
      {title}
      <span className={styles.editorButtons}>{children}</span>
    </div>
  )
}
