"""Add ABRun, ABSample, and ABExperiment tables for A/B performance testing.

ABRun intentionally omits order_id so that A/B test runs never participate
in trend analysis or FieldChange/Regression detection.

This migration creates the AB tables with their dynamic run/sample field
columns following the same column-type rules as upgrade_0_to_1.
"""

from sqlalchemy import (Boolean, Column, DateTime, Float, ForeignKey, Integer,
                        LargeBinary, String, select)
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base

import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1
from lnt.server.db.migrations.util import introspect_table


def _add_ab_tables(test_suite):
    """Return a Base with ABRun, ABSample, and ABExperiment for test_suite.

    Machine and Test stubs are included in the same Base so that FK
    references resolve during create_all."""
    db_key_name = test_suite.db_key_name
    Base = declarative_base()

    class Machine(Base):
        __tablename__ = db_key_name + '_Machine'
        __table_args__ = {'extend_existing': True}
        id = Column("ID", Integer, primary_key=True)

    class Test(Base):
        __tablename__ = db_key_name + '_Test'
        __table_args__ = {'extend_existing': True}
        id = Column("ID", Integer, primary_key=True)

    class ABRun(Base):
        __tablename__ = db_key_name + '_ABRun'
        id = Column("ID", Integer, primary_key=True)
        machine_id = Column("MachineID", Integer, ForeignKey(Machine.id),
                            index=True)
        start_time = Column("StartTime", DateTime)
        end_time = Column("EndTime", DateTime)
        parameters_data = Column("Parameters", LargeBinary)

        class_dict = locals()
        for item in test_suite.run_fields:
            class_dict[item.name] = Column(item.name, String(256))

    class ABSample(Base):
        __tablename__ = db_key_name + '_ABSample'
        id = Column("ID", Integer, primary_key=True)
        run_id = Column("RunID", Integer, ForeignKey(ABRun.id), index=True)
        test_id = Column("TestID", Integer, ForeignKey(Test.id), index=True)

        class_dict = locals()
        for item in test_suite.sample_fields:
            if item.type.name == 'Real':
                class_dict[item.name] = Column(item.name, Float)
            elif item.type.name == 'Status':
                class_dict[item.name] = Column(
                    item.name, Integer,
                    ForeignKey(upgrade_0_to_1.StatusKind.id))
            elif item.type.name == 'Hash':
                class_dict[item.name] = Column(item.name, String)

    class ABExperiment(Base):
        __tablename__ = db_key_name + '_ABExperiment'
        id = Column("ID", Integer, primary_key=True)
        name = Column("Name", String(256))
        created_time = Column("CreatedTime", DateTime)
        extra = Column("Extra", String)
        pinned = Column("Pinned", Boolean, default=False)
        control_run_id = Column("ControlRunID", Integer,
                                ForeignKey(ABRun.id))
        variant_run_id = Column("VariantRunID", Integer,
                                ForeignKey(ABRun.id))

    return Base


def upgrade_testsuite(engine, db_key_name):
    """Create the AB tables for a single test suite identified by db_key_name."""
    session = sessionmaker(engine)()
    try:
        test_suite = session.query(upgrade_0_to_1.TestSuite).filter_by(
            db_key_name=db_key_name).first()
        if test_suite is None:
            return
        Base = _add_ab_tables(test_suite)
        # Only create new tables; use checkfirst=True (the default) so
        # existing tables are left untouched.
        Base.metadata.create_all(engine, checkfirst=True)
    finally:
        session.close()


def upgrade(engine):
    """Create AB tables for every existing test suite."""
    test_suite_table = introspect_table(engine, 'TestSuite')

    with engine.begin() as trans:
        suites = list(trans.execute(select([test_suite_table.c.DBKeyName])))

    for (db_key_name,) in suites:
        upgrade_testsuite(engine, db_key_name)
