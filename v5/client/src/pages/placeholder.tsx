/**
 * Stand-in for a page that has not been built yet. Every route in the design's page hierarchy
 * renders one of these so the shell is navigable end to end; they get replaced a page at a time.
 */
export function Placeholder({ title, doc }: { title: string; doc: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <p>
        This page is not implemented yet. Its design lives in <code>{doc}</code>.
      </p>
    </section>
  )
}
