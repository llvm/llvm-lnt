// The partial Plotly distribution the client bundles (scatter, bar and pie traces) has the API of
// the full one, which `@types/plotly.js` describes.
//
// Those types describe Plotly 3, whereas the client runs Plotly 4: there are no types for Plotly 4
// yet. The parts of the API the client uses are the same in both, except where corrected below,
// but check against Plotly 4's documentation before relying on a new one, and switch to types for 4
// once they exist.
declare module 'plotly.js-basic-dist-min' {
  import type * as Plotly from 'plotly.js'

  const plotly: Omit<typeof Plotly, 'Plots'> & {
    Plots: {
      /** Rejected when `root` is not displayed, unlike what the types for Plotly 3 say. */
      resize(root: Plotly.Root): Promise<void>
    }
  }
  export default plotly
}
