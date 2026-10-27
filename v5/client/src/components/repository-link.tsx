import { VisuallyHidden } from 'react-aria-components'
import {
  commitLinkText,
  commitUrl,
  fillTemplate,
  NEW_TAB,
  rangeLinkText,
  usableTemplate,
  type Repository,
} from '../repository'
import { DisabledLink } from './button-link'
import buttons from './button-link.module.css'
import styles from './repository-link.module.css'

interface CommitProps {
  repository: Repository
  /** The commit's commit string. */
  commit: string
  /**
   * What names the commit to assistive technology, after the link's text, where the page shows
   * several such links side by side.
   */
  name?: string
}

/**
 * "View on {label}" (AR20): a link to the commit `commit` in the repository, opening in a new tab,
 * or nothing if the suite has no usable template of a commit's URL. It goes after the commit, or
 * whatever names it.
 */
export function CommitRepositoryLink({ repository, commit, name }: CommitProps) {
  const url = commitUrl(repository, commit)
  if (url === null) return null
  return (
    <a href={url} {...NEW_TAB} className={styles.commit}>
      {commitLinkText(repository)}
      {name !== undefined && <VisuallyHidden elementType="span">: {name}</VisuallyHidden>}
    </a>
  )
}

interface RangeProps {
  repository: Repository
  /** The commit strings filling in `{from}` and `{to}` (D4), or no `from` while there is none. */
  from: string | null
  to: string
  /** Why there is no `from` (AR8). */
  reason: string
}

/**
 * "View changes on {label}" (AR20), in a row of actions: a link to the changes from `from` to `to`
 * in the repository, opening in a new tab, or nothing if the suite has no usable template of a
 * range's URL. While there is no `from`, it is shown disabled, saying why (AR8).
 */
export function RangeRepositoryLink({ repository, from, to, reason }: RangeProps) {
  const template = usableTemplate(repository, 'range_url')
  if (template === null) return null
  const text = rangeLinkText(repository)
  if (from === null) {
    return (
      <DisabledLink title={reason} className={buttons.button}>
        {text}
      </DisabledLink>
    )
  }
  return (
    <a href={fillTemplate(template, { from, to })} {...NEW_TAB} className={buttons.button}>
      {text}
    </a>
  )
}
