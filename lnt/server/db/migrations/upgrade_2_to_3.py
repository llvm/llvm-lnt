# Version 3 of the database adds the FieldChange class to track flagged
# regressions in the database.

import os
import sys

import sqlalchemy
from sqlalchemy import *
from sqlalchemy.schema import Index
from sqlalchemy.orm import relation

# Import the original schema from upgrade_0_to_1 since upgrade_1_to_2 does not
# change the actual schema, but rather adds functionality vis-a-vis orders.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1

###
# Upgrade TestSuite


def get_base(test_suite):
    """Return the schema base with field changes added."""
    return add_fieldchange(test_suite)


def add_fieldchange(test_suite):
    # Grab the Base for the previous schema so that we have all
    # the definitions we need.
    Base = upgrade_0_to_1.get_base_for_testsuite(test_suite)
    # Grab our db_key_name for our test suite so we can properly
    # prefix our fields/table names.
    db_key_name = test_suite.db_key_name

    class FieldChange(Base):
        __tablename__ = db_key_name + '_FieldChange'
        id = Column("ID", Integer, primary_key=True)
        start_order_id = Column("StartOrderID", Integer,
                                ForeignKey("%s_Order.ID" % db_key_name))
        end_order_id = Column("EndOrderID", Integer,
                              ForeignKey("%s_Order.ID" % db_key_name))
        test_id = Column("TestID", Integer,
                         ForeignKey("%s_Test.ID" % db_key_name))
        machine_id = Column("MachineID", Integer,
                            ForeignKey("%s_Machine.ID" % db_key_name))
        field_id = Column("FieldID", Integer,
                          ForeignKey(upgrade_0_to_1.SampleField.id))

    return Base


def upgrade_testsuite(engine, session, name):
    # Grab Test Suite.
    test_suite = session.query(upgrade_0_to_1.TestSuite).\
                 filter_by(name=name).first()
    assert(test_suite is not None)

    # Add FieldChange to the test suite.
    Base = add_fieldchange(test_suite)

    # Create tables. We commit now since databases like Postgres run
    # into deadlocking issues due to previous queries that we have run
    # during the upgrade process. The commit closes all of the
    # relevant transactions allowing us to then perform our upgrade.
    session.commit()
    Base.metadata.create_all(engine)
    # Commit changes (also closing all relevant transactions with
    # respect to Postgres like databases).
    session.commit()


def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    # Create our FieldChangeField table and commit.
    upgrade_testsuite(engine, session, 'nts')
    upgrade_testsuite(engine, session, 'compile')
    session.close()
