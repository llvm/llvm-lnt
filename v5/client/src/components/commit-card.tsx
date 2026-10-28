import { useResolvedCommit } from '../api/commits'
import type { SuiteSchema } from '../api/suites'
import { commitDisplayValue, formatFieldValue, labelOf, type Commit } from '../schema'
import { CopyButton } from './copy-button'
import { ErrorMessage, Loading } from './feedback'
import { HoverCard } from './hover-card'
import { InfoRow } from './info-box'
import { LinkableText } from './linkable-text'
import { CommitRepositoryLink } from './repository-link'
import type { HoverCardState } from './use-hover-card'
import styles from './commit-card.module.css'

interface Props {
  /** From the link's `useHoverCard`. */
  card: HoverCardState
  schema: SuiteSchema
  /** The commit string. */
  value: string
  /** The commit, as the page loaded it for the link's text, if it has. */
  commit: Commit | undefined
}

/**
 * The card of a link to the commit `value` (AR21), while it is open: the commit as the page loaded
 * it, or else as fetched once the card is shown, since it is only rendered then.
 */
export function CommitCard({ card, schema, value, commit }: Props) {
  const headingId = `${card.id}-heading`
  return (
    <HoverCard
      card={card}
      labelledBy={headingId}
      popoverClassName={styles.popover}
      className={styles.card}
    >
      {commit ? (
        <CommitSummary schema={schema} commit={commit} headingId={headingId} />
      ) : (
        <FetchedCommit schema={schema} value={value} headingId={headingId} />
      )}
    </HoverCard>
  )
}

/**
 * The commit string, with a button copying it after its end: with its last character, so that it
 * goes onto the next line with it, rather than on its own, when the string does not fit on one.
 */
function CommitString({ value }: { value: string }) {
  const characters = Array.from(value)
  const last = characters.pop()
  return (
    <span className={styles.mono}>
      {characters.join('')}
      <span className={styles.end}>
        {last}
        <CopyButton text={value} icon>
          Copy commit
        </CopyButton>
      </span>
    </span>
  )
}

function Heading({ id, text }: { id: string; text: string }) {
  return (
    <div id={id} className={styles.heading}>
      {text}
    </div>
  )
}

interface ContentProps {
  schema: SuiteSchema
  headingId: string
}

function FetchedCommit({ schema, value, headingId }: ContentProps & { value: string }) {
  const resolved = useResolvedCommit(schema.name, value)
  if (resolved.data) {
    return <CommitSummary schema={schema} commit={resolved.data} headingId={headingId} />
  }
  return (
    <>
      <Heading id={headingId} text={value} />
      {resolved.isError ? (
        <ErrorMessage
          error={resolved.error}
          context="Could not load the commit"
          onRetry={() => void resolved.refetch()}
        />
      ) : resolved.isPending || resolved.isFetching ? (
        <Loading label="Loading the commit..." />
      ) : (
        <p className={styles.gone}>This commit no longer exists.</p>
      )}
    </>
  )
}

function CommitSummary({ schema, commit, headingId }: ContentProps & { commit: Commit }) {
  const fields = schema.commit_fields.flatMap((field) => {
    const value = commit.fields[field.name]
    return value === null || value === undefined ? [] : [{ field, value }]
  })
  return (
    <>
      <Heading id={headingId} text={commitDisplayValue(commit, schema)} />
      <dl className={styles.rows}>
        <InfoRow label="Commit">
          <CommitString value={commit.value} />
        </InfoRow>
        {commit.ordinal !== null && <InfoRow label="Ordinal">{commit.ordinal}</InfoRow>}
        {fields.map(({ field, value }) => (
          <InfoRow key={field.name} label={labelOf(field)}>
            {/* Cut to two lines, but whole to assistive technology, which ignores the cut. */}
            <div className={styles.clamped}>
              <LinkableText text={formatFieldValue(value, field.type)} />
            </div>
          </InfoRow>
        ))}
      </dl>
      <CommitRepositoryLink repository={schema.repository} commit={commit.value} />
    </>
  )
}
