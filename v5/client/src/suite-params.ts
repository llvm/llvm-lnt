import { useParams } from 'react-router'
import { suiteRef, type SuiteRef } from './api/suites'

/**
 * The suite a page's path names, `/projects/{p}/suites/{s}/...` (AR3), the same object for as long
 * as the path names the same suite (see `suiteRef`).
 */
export function useSuiteParams(): SuiteRef {
  const { project = '', suite = '' } = useParams()
  return suiteRef(project, suite)
}
