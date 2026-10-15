import { useEffect, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { forgetProfiles } from '../../api/profiles'
import { useSuites } from '../../api/suites'
import { ErrorMessage, Loading } from '../../components/feedback'
import { useUrlState, useVisitKey } from '../../url-state'
import { PARAMS } from './settings'
import { SidePanel } from './side-panel'
import { useProfileSide, type ProfileSide } from './use-side'
import styles from './profiles.module.css'

/**
 * The Profiles page (PF1-PF9), started afresh whenever the user navigates to it -- a link to other
 * profiles while on it, say -- so that it shows what the new URL names. What it fetched of the
 * profiles is forgotten once it has been left (PF8), but not when it starts afresh.
 */
export default function Profiles() {
  const queryClient = useQueryClient()
  useEffect(() => () => forgetProfiles(queryClient), [queryClient])
  return <ProfilesPage key={useVisitKey()} />
}

function ProfilesPage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  const a = useProfileSide('a', settings, update, suites)
  const b = useProfileSide('b', settings, update, suites)

  // A side whose profile is still on its way, or could not be fetched, keeps its column (PF7).
  const shown = [a, b].filter((side) => side.status.kind !== 'none')
  return (
    <section>
      <h1>Profiles</h1>
      {suites.isError && (
        <ErrorMessage
          context="The test suites could not be listed"
          error={suites.error}
          onRetry={() => void suites.refetch()}
        />
      )}
      <div className={styles.sides}>
        <SidePanel side={a} title="Side A" suites={suites.data ?? []} />
        <SidePanel side={b} title="Side B" suites={suites.data ?? []} />
      </div>
      {shown.length === 0 ? (
        <p className={styles.note}>Select a test on either side to see its profile.</p>
      ) : (
        <div className={styles.columns} style={{ '--columns': shown.length } as CSSProperties}>
          {shown.map((side) => (
            <ProfileColumn key={side.id} side={side} />
          ))}
        </div>
      )}
    </section>
  )
}

/** What a side shows of its profile (PF4, PF5), in its column. */
function ProfileColumn({ side }: { side: ProfileSide }) {
  const { status, metadata } = side
  return (
    <section className={styles.column} aria-label={`Profile ${side.id.toUpperCase()}`}>
      {status.kind === 'pending' && <Loading label="Loading the profile..." />}
      {/* Whatever came before the profile and failed says so in the side's controls. */}
      {status.kind === 'failed' && metadata.isError && (
        <ErrorMessage
          context="The profile could not be loaded"
          error={metadata.error}
          onRetry={() => void metadata.refetch()}
        />
      )}
    </section>
  )
}
