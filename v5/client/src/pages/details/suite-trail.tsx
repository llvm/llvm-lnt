import { Link } from 'react-router'
import { useKnownProjects, type SuiteRef } from '../../api/suites'
import { projectLabel, projectNamed, suiteLabel, suiteNamed } from '../../labels'
import { projectPath, suitePath } from '../../paths'
import { TABS, suiteTabPath, type TabId } from '../test-suites/settings'
import styles from './details.module.css'

interface Props {
  /** The suite named by the page's URL, whether or not it exists. */
  suite: SuiteRef
  /** The tab of the Test Suites page listing the kind of entity the page is about. */
  tab: TabId
}

/**
 * The breadcrumb trail above a detail page's header, leading back to the suite's project, to the
 * suite, and to the tab listing the page's kind of entity, in its default state. It needs nothing
 * but the page's path, so it is shown whatever the state of the page's data, naming the project and
 * the suite by their names until the projects are listed (AR22). It does not fetch them.
 */
export function SuiteTrail({ suite, tab }: Props) {
  const projects = useKnownProjects()
  const project = projectNamed(projects, suite.project)
  const named = suiteNamed(
    projects?.find((entry) => entry.name === suite.project)?.suites,
    suite,
  )
  const label = TABS.find((entry) => entry.id === tab)?.label
  return (
    <nav aria-label="Breadcrumb" className={styles.trail}>
      <ol>
        <li>
          <Link to={projectPath(suite.project)}>{projectLabel(project)}</Link>
        </li>
        <li>
          <Link to={suitePath(suite)}>{suiteLabel(named)}</Link>
        </li>
        <li>
          <Link to={suiteTabPath(suite, tab)}>{label}</Link>
        </li>
      </ol>
    </nav>
  )
}
