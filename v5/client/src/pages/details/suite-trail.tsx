import { Link } from 'react-router'
import { suitePath } from '../../paths'
import { TABS, suiteTabPath, type TabId } from '../test-suites/settings'
import styles from './details.module.css'

interface Props {
  /** The suite named by the page's URL, whether or not it exists. */
  suite: string
  /** The tab of the Test Suites page listing the kind of entity the page is about. */
  tab: TabId
}

/**
 * The breadcrumb trail above a detail page's header, leading back to the suite and to the tab
 * listing the page's kind of entity, in its default state. It needs nothing but the page's path,
 * so it is shown whatever the state of the page's data.
 */
export function SuiteTrail({ suite, tab }: Props) {
  const label = TABS.find((entry) => entry.id === tab)?.label
  return (
    <nav aria-label="Breadcrumb" className={styles.trail}>
      <ol>
        <li>
          <Link to={suitePath(suite)}>{suite}</Link>
        </li>
        <li>
          <Link to={suiteTabPath(suite, tab)}>{label}</Link>
        </li>
      </ol>
    </nav>
  )
}
