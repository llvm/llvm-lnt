import { commitLinkText, commitUrl, NEW_TAB, type Repository } from '../repository'
import buttons from './button-link.module.css'
import styles from './repository-link.module.css'

interface CommitProps {
  repository: Repository
  /** The commit's commit string. */
  commit: string
  /** How it is set: in small type, or as a button, in a row of actions. */
  look?: 'small' | 'button'
}

const LOOKS = { small: styles.small, button: buttons.button }

/**
 * "View on {label}" (AR20): a link to the commit `commit` in the repository, opening in a new tab,
 * or nothing if the suite has no usable template of a commit's URL.
 */
export function CommitRepositoryLink({ repository, commit, look = 'small' }: CommitProps) {
  const url = commitUrl(repository, commit)
  if (url === null) return null
  return (
    <a href={url} {...NEW_TAB} className={LOOKS[look]}>
      {commitLinkText(repository)}
    </a>
  )
}
