# Version 8 of the database updates FieldChanges as well as adds tables
# for Regression Tracking features.

import sqlalchemy
from sqlalchemy import *
from sqlalchemy.orm import relation

# Import the original schema from upgrade_0_to_1 since upgrade_1_to_2 does not
# change the actual schema, but rather adds functionality vis-a-vis orders.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1

import lnt.server.db.migrations.upgrade_7_to_8 as upgrade_7_to_8


def add_baselines(test_suite):
    """Give test-suites a baseline order.
    """
    # Grab the Base for the previous schema so that we have all
    # the definitions we need.
    base = upgrade_7_to_8.add_regressions(test_suite)
    # Grab our db_key_name for our test suite so we can properly
    # prefix our fields/table names.

    db_key_name = test_suite.db_key_name

    class Baseline(base):
        """Baselines to compare runs to."""
        __tablename__ = db_key_name + '_Baseline'

        id = Column("ID", Integer, primary_key=True)
        name = Column("Name", String(32), unique=True)
        comment = Column("Comment", String(256))
        order_id = Column("OrderID", Integer,
                          ForeignKey("%s_Order.ID" % db_key_name), index=True)

    return base


def upgrade_testsuite(engine, session, name):
    # Grab Test Suite.
    test_suite = session.query(upgrade_0_to_1.TestSuite). \
        filter_by(name=name).first()
    assert (test_suite is not None)

    # Add FieldChange to the test suite.
    base = add_baselines(test_suite)

    # Create tables. We commit now since databases like Postgres run
    # into deadlocking issues due to previous queries that we have run
    # during the upgrade process. The commit closes all of the
    # relevant transactions allowing us to then perform our upgrade.
    session.commit()
    base.metadata.create_all(engine)
    # Commit changes (also closing all relevant transactions with
    # respect to Postgres like databases).
    session.commit()





def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    # Create our FieldChangeField table and commit.
    upgrade_testsuite(engine, session, 'nts')
    upgrade_testsuite(engine, session, 'compile')
