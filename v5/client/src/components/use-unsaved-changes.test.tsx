import { act, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router'
import { describe, expect, it } from 'vitest'
import { answerLeaving } from '../test/leave'
import { settle } from '../test/page'
import { renderWithProviders } from '../test/render'
import { useUnsavedChanges } from './use-unsaved-changes'

/** What the form rendered last uses. */
const handle: { allowLeaving?: () => void; navigate?: NavigateFunction } = {}

/** A form with unsaved changes at every URL, which it shows, and what it uses in `handle`. */
function Form() {
  const allowLeaving = useUnsavedChanges(true)
  const navigate = useNavigate()
  useEffect(() => {
    handle.allowLeaving = allowLeaving
    handle.navigate = navigate
  })
  return <output>{useLocation().pathname}</output>
}

describe('useUnsavedChanges', () => {
  it('goes ahead with a navigation once confirmed', async () => {
    renderWithProviders(<Form />, { url: '/form' })
    const confirm = answerLeaving(true)

    act(() => void handle.navigate!('/elsewhere'))
    await settle()

    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('/elsewhere')
  })

  it('drops a navigation confirmed once the form has left on its own meanwhile', async () => {
    renderWithProviders(<Form />, { url: '/form' })
    // A save completing while the user is asked, which leaves for where it goes once done.
    answerLeaving(true).mockImplementation(() => {
      handle.allowLeaving!()
      void handle.navigate!('/saved')
      return true
    })

    act(() => void handle.navigate!('/elsewhere'))
    await settle()

    expect(screen.getByRole('status')).toHaveTextContent('/saved')
  })
})
