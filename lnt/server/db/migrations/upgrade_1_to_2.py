# Version 2 didn't actually change the database schema per-se, but we changed
# to better support versions as run orders.
#
# As part of this, we changed the compiler sniffing code to extract the full
# build information from production compilers, and it was convenient to
# propagate this change to older databases.
#
# So, for this upgrade, we go look for runs that used the older run_order
# extraction, and we recompute the run order for them.

import json
import re

from lnt.util import logger
import sqlalchemy
from sqlalchemy import Table, MetaData


def update_testsuite(engine, session, db_key_name):
    class Run(object):
        pass

    class Order(object):
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    meta = MetaData(bind=engine)

    # Autoload the Run and Order tables.
    order_table = Table('%s_Order' % db_key_name, meta, autoload=True)
    run_table = Table('%s_Run' % db_key_name, meta, autoload=True)

    sqlalchemy.orm.mapper(Order, order_table)
    sqlalchemy.orm.mapper(Run, run_table)

    # Scan each run that has no report version and possibly recompute the
    # run order.
    logger.info("updating runs")
    all_runs = session.query(Run).\
        filter(sqlalchemy.not_(Run.Parameters.like(
                '%["__report_version__"%'))).all()
    for i, run in enumerate(all_runs):
        if i % 1000 == 999:
            logger.info("update run %d of %d" % (i + 1, len(all_runs)))

        # Extract the parameters.
        run_info = dict(json.loads(run.Parameters))

        # Sanity check this was an inferred run order.
        orig_order, = session.query(Order.llvm_project_revision).\
            filter(Order.ID == run.OrderID).first()
        inferred_run_order = run_info.get('inferred_run_order')

        if orig_order is None or (orig_order != inferred_run_order and
                                  inferred_run_order is not None):
            continue

        # Trim the whitespace on the run order.
        run_order = orig_order.strip()

        # If this was a production Clang build, try to recompute the src tag.
        if 'clang' in run_info.get('cc_name', '') and \
                run_info.get('cc_build') == 'PROD' and \
                run_info.get('cc_src_tag') and \
                run_order == run_info['cc_src_tag'].strip():
            # Extract the version line.
            version_ln = None
            for ln in run_info.get('cc_version', '').split('\n'):
                if ' version ' in ln:
                    version_ln = ln
                    break

            # Extract the build string.
            if version_ln:
                m = re.match(r'(.*) version ([^ ]*) (\([^(]*\))(.*)',
                             version_ln)
                if m:
                    cc_name, cc_version_num, cc_build_string, cc_extra = \
                        m.groups()
                    m = re.search('clang-([0-9.]*)', cc_build_string)
                    if m:
                        run_order = m.group(1)

        # Update the run info.
        run_info['inferred_run_order'] = run_order
        run_info['__report_version__'] = '1'
        run.Parameters = json.dumps(sorted(run_info.items()))

        if run_order != orig_order:
            # Lookup the new run order.
            result = session.query(Order.ID).\
                filter(Order.llvm_project_revision == run_order).first()

            # If the result exists...
            if result is not None:
                order_id, = result
            else:
                # It doesn't, we need to create a new run order. We will
                # rebuild all the links at the end.
                order = Order(llvm_project_revision=run_order)
                session.add(order)
                session.flush()
                order_id = order.ID

            run.OrderID = order_id

    # Drop any now-unused orders.
    logger.info("deleting unused orders")
    session.query(Order) \
        .filter(sqlalchemy.not_(sqlalchemy.sql.exists()
                .where(Run.OrderID == Order.ID))) \
        .delete(synchronize_session=False)

    # Rebuilt all the previous/next links for the run orders.
    logger.info("rebuilding run order links")

    def parse_run_order(order):
        version = order.llvm_project_revision.strip()
        items = version.split('.')
        for i, item in enumerate(items):
            if item.isdigit():
                items[i] = int(item)
        return tuple(items)

    orders = session.query(Order).all()
    orders.sort(key=parse_run_order)
    for i, order in enumerate(orders):
        if i == 0:
            order.PreviousOrder = None
        else:
            order.PreviousOrder = orders[i-1].ID
        if i + 1 == len(orders):
            order.NextOrder = None
        else:
            order.NextOrder = orders[i+1].ID

    session.flush()


def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    # For each test suite...
    update_testsuite(engine, session, 'NT')
    update_testsuite(engine, session, 'Compile')

    # Commit the results.
    session.commit()
    session.close()
