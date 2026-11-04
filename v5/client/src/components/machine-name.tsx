import { machineLabel, type MachineNames } from '../labels'
import { Note } from './note'

/**
 * Where the user finds a machine among others, in a picker or on the Machines tab: its label,
 * followed by its name in muted text when it has a display name (AR23).
 */
export function LabelWithName({ machine }: { machine: MachineNames }) {
  return (
    <>
      {machineLabel(machine)}
      <SecondaryName machine={machine} />
    </>
  )
}

/** The muted name that follows a machine's label when it has a display name (AR23), or nothing. */
export function SecondaryName({ machine }: { machine: MachineNames }) {
  return machine.display_name === null ? null : <Note>{machine.name}</Note>
}
