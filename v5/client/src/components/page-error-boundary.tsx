import { Component, type ReactNode } from 'react'
import { ErrorMessage } from './feedback'

interface Props {
  /** When this changes, a page that failed is rendered again: the location's key, typically. */
  resetKey: string
  children: ReactNode
}

interface State {
  error: unknown
  resetKey: string
}

/**
 * Shows the error a page threw while rendering instead of unmounting the whole app, and lets the
 * user navigate on. The usual case is a page's code failing to load, for instance because a deploy
 * replaced it since this copy of the app was loaded. That page keeps failing until the app is
 * reloaded, so the message says to.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }
  }

  render() {
    if (this.state.error === null) return this.props.children
    return (
      <>
        <ErrorMessage error={this.state.error} />
        <p>Reload the page to try again.</p>
      </>
    )
  }
}
