import click


@click.command("updatedb")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.option("--database", default="default", show_default=True,
              help="database to modify")
@click.option("--testsuite", required=True, help="testsuite to modify")
@click.option("--show-sql", is_flag=True,
              help="show SQL statements")
@click.option("--delete-machine", "delete_machines", default=[], multiple=True, type=click.UNPROCESSED,
              help="Delete the given machine, all runs associated to this machine and their samples. "
                   "Machines are identified by their name.")
@click.option("--delete-run", "delete_runs", default=[], multiple=True, type=int,
              help="Delete the specified run(s) and their samples. "
                   "Runs are identified by their ID.")
@click.option("--delete-order", "delete_orders", default=[], multiple=True, type=int,
              help="Delete all runs associated to the given order(s) and their samples. "
                   "Orders are identified by their ID.")
def action_updatedb(instance_path, database, testsuite, show_sql,
                    delete_machines, delete_runs, delete_orders):
    """modify a database"""
    from .common import init_logger

    import contextlib
    import lnt.server.instance
    import logging

    init_logger(logging.INFO if show_sql else logging.WARNING,
                show_sql=show_sql)

    # Load the instance.
    instance = lnt.server.instance.Instance.frompath(instance_path)

    # Get the database and test suite.
    with contextlib.closing(instance.get_database(database)) as db:
        session = db.make_session()
        ts = db.testsuite[testsuite]
        # Compute a list of all the runs to delete.
        if delete_orders:
            runs = session.query(ts.Run).join(ts.Order) \
                .filter(ts.Order.id.in_(delete_orders)).all()
        else:
            runs = session.query(ts.Run) \
                .filter(ts.Run.id.in_(delete_runs)).all()
        for run in runs:
            session.delete(run)

        if delete_machines:
            machines = session.query(ts.Machine) \
                .filter(ts.Machine.name.in_(delete_machines)).all()
            for machine in machines:
                session.delete(machine)

        session.commit()
