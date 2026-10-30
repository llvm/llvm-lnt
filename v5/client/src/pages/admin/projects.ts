import type { useProjects } from '../../api/suites'

/** The list of projects, as `useProjects` gives it. */
export type Projects = ReturnType<typeof useProjects>

/** Why no project can be picked yet, while the projects are not listed (TS7, AD2). */
export function projectsProblem(projects: Projects): string | undefined {
  if (projects.data !== undefined) return undefined
  return projects.isError ? 'The projects could not be loaded.' : 'Loading the projects...'
}
