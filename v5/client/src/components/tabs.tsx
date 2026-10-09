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
          <Tab key={tab.id} id={tab.id} className={styles.tab}>
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
