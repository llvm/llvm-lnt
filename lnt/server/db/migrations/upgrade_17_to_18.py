"""Adds a ignore_same_hash column to the sample fields table and sets it to
true for execution_time.

"""

from sqlalchemy import Column, Integer, update

from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column


def upgrade(engine):
    ignore_same_hash = Column("ignore_same_hash", Integer, default=0)
    add_column(engine, "TestSuiteSampleFields", ignore_same_hash)

    test_suite_sample_fields = introspect_table(engine, "TestSuiteSampleFields")
    set_init_value = update(test_suite_sample_fields).values(ignore_same_hash=0)
    set_exec_time = (
        update(test_suite_sample_fields)
        .where(
            (test_suite_sample_fields.c.Name == "execution_time")
            | (test_suite_sample_fields.c.Name == "score")
        )
        .values(ignore_same_hash=1)
    )

    with engine.begin() as trans:
        trans.execute(set_init_value)
        trans.execute(set_exec_time)
