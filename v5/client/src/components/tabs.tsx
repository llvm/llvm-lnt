import type { ReactNode } from 'react'
import { Tab, TabList, TabPanel, Tabs as AriaTabs } from 'react-aria-components'
import styles from './tabs.module.css'

interface Props<Id extends string> {
  /** The tab list's accessible name. */
  label: string
  tabs: readonly { id: Id; label: string }[]
  selected: Id
  onSelect(id: NoInfer<Id>): void
  /** The selected tab's content. */
  children: ReactNode
}

/**
 * A click selects a tab once the pointer is released on it, as on a link, rather than when it is
 * pressed, React Aria's default. A tab selected on press is selected again if the pointer leaves it
 * and comes back before it is released: when selecting it asks the user something first (AR19),
 * the release goes to the browser's dialog, and the pointer coming back onto the tab after it, or
 * the browser replaying its moves, asks again. React Aria's `Tab` passes this on to `useTab` without
 * declaring it.
 */
const SELECT_ON_RELEASE = { shouldSelectOnPressUp: true }

/**
 * A tab bar and the selected tab's panel, with manual activation: the arrow keys, Home and End move
 * the focus between the tabs, and Enter, Space or a click selects the focused one. Selecting a tab
 * can fetch data and change the URL, which moving through the tabs on the way to another should
 * not.
 */
export function Tabs<Id extends string>({ label, tabs, selected, onSelect, children }: Props<Id>) {
  return (
    <AriaTabs
      selectedKey={selected}
      // React Aria reports a click on the selected tab too, which selects nothing new.
      onSelectionChange={(key) => key !== selected && onSelect(key as Id)}
      keyboardActivation="manual"
    >
      <TabList aria-label={label} className={styles.bar}>
        {tabs.map((tab) => (
          <Tab key={tab.id} id={tab.id} className={styles.tab} {...SELECT_ON_RELEASE}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
      <TabPanel id={selected} className={styles.panel}>
        {children}
      </TabPanel>
    </AriaTabs>
  )
}
