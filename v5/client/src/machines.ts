/** How machines are presented. */

/** What `tracked: false` means, wherever a machine shows it (D5). */
export const UNTRACKED_HELP =
  "Untracked machines are left out of the Dashboard's trend overview, and listed after the " +
  'tracked ones wherever a machine is picked, but are usable everywhere.'

/**
 * Why a machine cannot be named `text`, or undefined if it can: the URLs addressing the machine
 * must carry its name intact (I1).
 */
export function invalidMachineName(text: string): string | undefined {
  return text.includes('/') || text.includes('%') || text === '.' || text === '..'
    ? "A machine name cannot contain '/' or '%', or be '.' or '..'."
    : undefined
}
