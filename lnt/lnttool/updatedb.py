import click


@click.command("updatedb")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.option("--database", default="default", show_default=True,
              help="database to modify")
@click.option("--testsuite", required=True, help="testsuite to modify")
@click.option("--tmp-dir", default="lnt_tmp", show_default=True,
              help="name of the temp file directory")
@click.option("--commit", is_flag=True, help="commit changes to the database")
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
    from lnt.util import logger
    import contextlib
    import lnt.server.instance

    # Load the instance.
    instance = lnt.server.instance.Instance.frompath(instance_path)

    # Get the database and test suite.
    with contextlib.closing(instance.get_database(database,
                                                  echo=show_sql)) as db:
        ts = db.testsuite[testsuite]
        order = None
        # Compute a list of all the runs to delete.
        if delete_order:
            runs = ts.query(ts.Run).join(ts.Order) \
                .filter(ts.Order.id == delete_order).all()
        else:
            runs = ts.query(ts.Run).filter(ts.Run.id.in_(delete_runs)).all()
        for run in runs:
            ts.delete(run)

        if delete_machines:
            machines = ts.query(ts.Machine) \
                .filter(ts.Machine.name.in_(delete_machines)).all()
            for machine in machines:
                ts.delete(machine)

        if commit:
            db.commit()
        else:
            db.rollback()
