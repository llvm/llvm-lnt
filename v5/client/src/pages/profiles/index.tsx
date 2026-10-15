import { useEffect, useReducer, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { forgetProfiles } from '../../api/profiles'
import { useSuites } from '../../api/suites'
import { ErrorMessage } from '../../components/feedback'
import { useUrlState, useVisitKey } from '../../url-state'
import { PARAMS } from './settings'
import { ProfileColumn } from './profile-column'
import { NO_PICKS, sidePicks } from './selection'
import { SidePanel } from './side-panel'
import { useCounter } from './use-counter'
import { useFunctions } from './use-functions'
import { useProfileSide } from './use-side'
import { ViewControls } from './view-controls'
import styles from './profiles.module.css'

/**
 * The Profiles page (PF1-PF9). It starts afresh whenever the user navigates to it, for example
 * through a link to other profiles, so that it shows what the new URL names. It forgets the profile
 * data it fetched once the user leaves the page (PF8), but not when it starts afresh.
 */
export default function Profiles() {
  const queryClient = useQueryClient()
  useEffect(() => () => forgetProfiles(queryClient), [queryClient])
  return <ProfilesPage key={useVisitKey()} />
}

function ProfilesPage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  // The page changes these while it renders, which React only allows for its own state (see
  // `useProfileSide`).
  const picksA = useReducer(sidePicks, NO_PICKS)
  const picksB = useReducer(sidePicks, NO_PICKS)
  const a = useProfileSide('a', settings, update, suites, picksA)
  const b = useProfileSide('b', settings, update, suites, picksB)
  const counter = useCounter([a, b], settings.counter, update)
  const functions = useFunctions(a, b, counter, update)

  // A side keeps its column while its profile loads, and if it fails to load (PF7).
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
        <>
          <ViewControls
            counter={counter}
            values={settings.values}
            onValues={(values) => update({ values })}
          />
          <div className={styles.columns} style={{ '--columns': shown.length } as CSSProperties}>
            {shown.map((side) => (
              <ProfileColumn
                key={side.id}
                side={side}
                functions={functions[side.id]}
                counter={counter.shown}
                values={settings.values}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
