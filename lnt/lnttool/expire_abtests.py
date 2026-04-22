import contextlib
import datetime
import re

import click


def _parse_age(value):
    """Parse an age string like '90d', '4w', '6m', '1y' into a cutoff datetime."""
    m = re.fullmatch(r'(\d+)([dwmy])', value)
    if not m:
        raise click.BadParameter(
            "expected a positive integer followed by d/w/m/y "
            "(e.g. 90d, 4w, 6m, 1y)",
            param_hint="'--older-than'")
    n, unit = int(m.group(1)), m.group(2)
    days = {'d': n, 'w': n * 7, 'm': n * 30, 'y': n * 365}[unit]
    return datetime.datetime.utcnow() - datetime.timedelta(days=days)


@click.command("expire-abtests")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.option("--database", default="default", show_default=True,
              help="database to expire experiments from")
@click.option("--testsuite", "-s", default="nts", show_default=True,
              help="testsuite to expire experiments from")
@click.option("--older-than", "older_than", required=True,
              help="delete experiments older than this age (e.g. 90d, 4w, 6m, 1y)")
@click.option("--dry-run", is_flag=True,
              help="print what would be deleted without making any changes")
def action_expire_abtests(instance_path, database, testsuite,
                          older_than, dry_run):
    """Delete unpinned A/B experiments older than a given age.

\b
Removes unpinned ABExperiment records (and their associated ABRun and
ABSample rows) whose creation time predates the specified age threshold.
Pinned ('Keep Forever') experiments are never deleted.

\b
Age format: a positive integer followed by a unit:
  d  days       (e.g. 90d)
  w  weeks      (e.g. 4w)
  m  months     (approx 30 days each, e.g. 6m)
  y  years      (approx 365 days each, e.g. 1y)
    """
    import lnt.server.instance

    cutoff = _parse_age(older_than)

    instance = lnt.server.instance.Instance.frompath(instance_path)
    with contextlib.closing(instance.get_database(database)) as db:
        session = db.make_session()
        ts = db.testsuite[testsuite]

        to_delete = (
            session.query(ts.ABExperiment)
            .filter(ts.ABExperiment.created_time < cutoff,
                    ts.ABExperiment.pinned == False)  # noqa: E712
            .all())

        if not to_delete:
            click.echo("No experiments to delete.")
            return

        for exp in to_delete:
            click.echo("%s experiment #%d: %s" % (
                "Would delete" if dry_run else "Deleting",
                exp.id, exp.name or "(unnamed)"))

        if dry_run:
            return

        # Delete ABSample and ABRun children before the ABExperiment rows to
        # respect foreign-key constraints.
        run_ids = [rid for exp in to_delete
                   for rid in (exp.control_run_id, exp.variant_run_id)
                   if rid is not None]

        session.query(ts.ABSample) \
            .filter(ts.ABSample.run_id.in_(run_ids)) \
            .delete(synchronize_session=False)

        session.query(ts.ABRun) \
            .filter(ts.ABRun.id.in_(run_ids)) \
            .delete(synchronize_session=False)

        for exp in to_delete:
            session.delete(exp)

        session.commit()
        click.echo("Deleted %d experiment%s." %
                   (len(to_delete), "s" if len(to_delete) != 1 else ""))
