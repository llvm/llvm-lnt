"""This upgrade adds a index on the fieldchange start order, to optimize the deduplication query that is
pretty slow.
"""

import sqlalchemy
from sqlalchemy import Index, select, all_
from lnt.server.db.migrations.util import introspect_table
from logging import getLogger

log = getLogger(__name__)


def _mk_index_on(engine, ts_name):
    fc_table = introspect_table(engine, "{}_FieldChangeV2".format(ts_name))

    fast_fc_lookup = Index('idx_fast_fieldchange_lookup', fc_table.c.StartOrderID)
    try:
        fast_fc_lookup.create(engine)
    except (sqlalchemy.exc.OperationalError, sqlalchemy.exc.ProgrammingError) as e:
        log.warning("Skipping index creation on {}, because of {}".format(fc_table.name, e.message))


def upgrade(engine):
    """Add an index to FieldChangeV2 for each fo the test-suites.
    """
    with engine.begin() as trans:
        test_suite = introspect_table(engine, 'TestSuite')

        db_keys = trans.execute(select([test_suite]))
        for suite in db_keys:
            _mk_index_on(trans, suite[2])
