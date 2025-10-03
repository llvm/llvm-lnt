# Version 8 of the database updates FieldChanges as well as adds tables
# for Regression Tracking features.

import sqlalchemy
from sqlalchemy import Float, String, Integer, Column, ForeignKey

# Import the original schema from upgrade_0_to_1 since upgrade_1_to_2 does not
# change the actual schema, but rather adds functionality vis-a-vis orders.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1
import lnt.server.db.migrations.upgrade_2_to_3 as upgrade_2_to_3


###
# Upgrade TestSuite
def add_regressions(test_suite):
    """Given a test suite with a database connection and a test-suite
    name, make the regression sqalchmey database objects for that test-suite.
    """
    # Grab the Base for the previous schema so that we have all
    # the definitions we need.
    Base = upgrade_2_to_3.get_base(test_suite)
    # Grab our db_key_name for our test suite so we can properly
    # prefix our fields/table names.

    db_key_name = test_suite.db_key_name
    # Replace the field change definition with a new one, the old table
    # is full of bad data.
    table_name = "{}_FieldChange".format(db_key_name)
    Base.metadata.remove(Base.metadata.tables[table_name])

    class FieldChange(Base):
        """FieldChange represents a change in between the values
        of the same field belonging to two samples from consecutive runs."""

        __tablename__ = db_key_name + '_FieldChangeV2'
        id = Column("ID", Integer, primary_key=True)
        old_value = Column("OldValue", Float)
        new_value = Column("NewValue", Float)
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
        # Could be from many runs, but most recent one is interesting.
        run_id = Column("RunID", Integer,
                        ForeignKey("%s_Run.ID" % db_key_name))

    class Regression(Base):
        """Regession hold data about a set of RegressionIndicies."""

        __tablename__ = db_key_name + '_Regression'
        id = Column("ID", Integer, primary_key=True)
        title = Column("Title", String(256), unique=False, index=False)
        bug = Column("BugLink", String(256), unique=False, index=False)
        state = Column("State", Integer)

    class RegressionIndicator(Base):
        """"""
        __tablename__ = db_key_name + '_RegressionIndicator'
        id = Column("ID", Integer, primary_key=True)
        regression_id = Column("RegressionID", Integer,
                               ForeignKey("%s_Regression.ID" % db_key_name))

        field_change_id = Column(
            "FieldChangeID", Integer,
            ForeignKey("%s_FieldChangeV2.ID" % db_key_name))

    class ChangeIgnore(Base):
        """Changes to ignore in the web interface."""

        __tablename__ = db_key_name + '_ChangeIgnore'
        id = Column("ID", Integer, primary_key=True)

        field_change_id = Column(
            "ChangeIgnoreID", Integer,
            ForeignKey("%s_FieldChangeV2.ID" % db_key_name))

    return Base


def upgrade_testsuite(engine, session, name):
    # Grab Test Suite.
    test_suite = session.query(upgrade_0_to_1.TestSuite).\
                 filter_by(name=name).first()
    assert test_suite is not None

    # Add FieldChange to the test suite.
    Base = add_regressions(test_suite)

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
