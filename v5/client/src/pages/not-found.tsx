import { Link } from 'react-router'

export function NotFound() {
  return (
    <section>
      <h1>Page not found</h1>
      <p>
        No such page. <Link to="/">Back to the dashboard</Link>.
      </p>
    </section>
  )
}
