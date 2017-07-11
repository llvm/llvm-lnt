import contextlib
import click

import lnt.server.instance
from lnt.util import logger


@click.command("updatedb")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.option("--database", default="default", show_default=True,
              help="database to modify")
@click.option("--testsuite", required=True, help="testsuite to modify")
@click.option("--tmp-dir", default="lnt_tmp", show_default=True,
              help="name of the temp file directory")
@click.option("--commit", type=int,
              help="commit changes to the database")
@click.option("--show-sql", is_flag=True,
              help="show SQL statements")
@click.option("--delete-machine", "delete_machines", default=[],
              type=click.UNPROCESSED, show_default=True, multiple=True,
              help="machine names to delete")
@click.option("--delete-run", "delete_runs", default=[], show_default=True,
              multiple=True, help="run ids to delete", type=int)
@click.option("--delete-order", default=[], show_default=True,
              help="run ids to delete")
def action_updatedb(instance_path, database, testsuite, tmp_dir, commit,
                    show_sql, delete_machines, delete_runs, delete_order):
    """modify a database"""

    # Load the instance.
    instance = lnt.server.instance.Instance.frompath(instance_path)

    # Get the database and test suite.
    with contextlib.closing(instance.get_database(database,
                                                  echo=show_sql)) as db:
        ts = db.testsuite[testsuite]
        order = None
        # Compute a list of all the runs to delete.
        if delete_order:
            order = ts.query(ts.Order) \
                .filter(ts.Order.id == delete_order).one()
            runs_to_delete = ts.query(ts.Run.id) \
                .filter(ts.Run.order_id == order.id).all()
            runs_to_delete = [r[0] for r in runs_to_delete]
        else:
            runs_to_delete = list(delete_runs)

        if delete_machines:
            runs_to_delete.extend(
                id
                for id, in (ts.query(ts.Run.id)
                            .join(ts.Machine)
                            .filter(ts.Machine.name.in_(delete_machines))))

        # Delete all samples associated with those runs.
        ts.query(ts.Sample).\
            filter(ts.Sample.run_id.in_(runs_to_delete)).\
            delete(synchronize_session=False)

        # Delete all FieldChanges and RegressionIndicators
        for r in runs_to_delete:
            fcs = ts.query(ts.FieldChange). \
                filter(ts.FieldChange.run_id == r).all()
            for f in fcs:
                ris = ts.query(ts.RegressionIndicator) \
                    .filter(ts.RegressionIndicator.field_change_id == f.id) \
                    .all()
                for r in ris:
                    ts.delete(r)
                ts.delete(f)
        # Delete all those runs.
        ts.query(ts.Run).\
            filter(ts.Run.id.in_(runs_to_delete)).\
            delete(synchronize_session=False)

        # Delete the machines.
        for name in delete_machines:
            # Delete all FieldChanges associated with this machine.
            ids = ts.query(ts.FieldChange.id).\
                join(ts.Machine).filter(ts.Machine.name == name).all()
            for i in ids:
                ts.query(ts.FieldChange).filter(ts.FieldChange.id == i[0]).\
                    delete()

            num_deletes = ts.query(ts.Machine).filter_by(name=name).delete()
            if num_deletes == 0:
                logger.warning("unable to find machine named: %r" % name)
        if order:
            ts.delete(order)

        if commit:
            db.commit()
        else:
            db.rollback()
