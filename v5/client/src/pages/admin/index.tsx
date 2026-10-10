import { useEffect } from 'react'
import { Tabs } from '../../components/tabs'
import { useUrlState } from '../../url-state'
import { ApiKeysTab } from './api-keys-tab'
import { PARAMS, TABS, resetSettings, unusedSettings, type TabId } from './settings'
import { SuitesTab } from './suites-tab'

/** The Admin page: its API Keys (AD1) and Test Suites (AD2) tabs. */
export default function Admin() {
  const [settings, update] = useUrlState(PARAMS)
  const { tab, sort, suite } = settings

  // `settings` changes only with the URL.
  useEffect(() => {
    const unused = unusedSettings(settings)
    if (Object.keys(unused).length > 0) update(unused)
  }, [settings, update])

  const select = (id: TabId) => update({ tab: id, ...resetSettings() })

  return (
    <section>
      <h1>Admin</h1>
      <Tabs label="Admin tools" tabs={TABS} selected={tab} onSelect={select}>
        {tab === 'api-keys' ? (
          <ApiKeysTab sort={sort} onSort={(value) => update({ sort: value })} />
        ) : (
          <SuitesTab selected={suite} onSelect={(name) => update({ suite: name })} />
        )}
      </Tabs>
    </section>
  )
}
