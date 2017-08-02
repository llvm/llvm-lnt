# Version 0 is an empty database.
#
# Version 1 is the schema state at the time when we started doing DB
# versioning.

import sqlalchemy
from sqlalchemy import *
from sqlalchemy.schema import Index
from sqlalchemy.orm import relation

Base = sqlalchemy.ext.declarative.declarative_base()

###
# Core Schema


class SampleType(Base):
    __tablename__ = 'SampleType'
    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), unique=True)


class StatusKind(Base):
    __tablename__ = 'StatusKind'
    id = Column("ID", Integer, primary_key=True, autoincrement=False)
    name = Column("Name", String(256), unique=True)


class TestSuite(Base):
    __tablename__ = 'TestSuite'
    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), unique=True)
    db_key_name = Column("DBKeyName", String(256))
    version = Column("Version", String(16))
    machine_fields = relation('MachineField', backref='test_suite')
    order_fields = relation('OrderField', backref='test_suite')
    run_fields = relation('RunField', backref='test_suite')
    sample_fields = relation('SampleField', backref='test_suite')


class MachineField(Base):
    __tablename__ = 'TestSuiteMachineFields'
    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))
    info_key = Column("InfoKey", String(256))


class OrderField(Base):
    __tablename__ = 'TestSuiteOrderFields'
    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))
    info_key = Column("InfoKey", String(256))
    ordinal = Column("Ordinal", Integer)


class RunField(Base):
    __tablename__ = 'TestSuiteRunFields'
    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))
    info_key = Column("InfoKey", String(256))


class SampleField(Base):
    __tablename__ = 'TestSuiteSampleFields'
    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))
    type_id = Column("Type", Integer, ForeignKey('SampleType.ID'))
    type = relation(SampleType)
    info_key = Column("InfoKey", String(256))
    status_field_id = Column("status_field", Integer, ForeignKey(
            'TestSuiteSampleFields.ID'))
    status_field = relation('SampleField', remote_side=id)


def initialize_core(engine, session):
    # Create the tables.
    Base.metadata.create_all(engine)

    # Create the fixed sample kinds.
    #
    # NOTE: The IDs here are proscribed and should match those from
    # 'lnt.testing'.
    session.add(StatusKind(id=0, name="PASS"))
    session.add(StatusKind(id=1, name="FAIL"))
    session.add(StatusKind(id=2, name="XFAIL"))

    # Create the fixed status kinds.
    session.add(SampleType(name="Real"))
    session.add(SampleType(name="Status"))

    session.commit()

###
# NTS Testsuite Definition


def initialize_nts_definition(engine, session):
    # Fetch the sample types.
    real_sample_type = session.query(SampleType) \
        .filter_by(name="Real").first()
    status_sample_type = session.query(SampleType) \
        .filter_by(name="Status").first()

    # Create a test suite compile with "lnt runtest nt".
    ts = TestSuite(name="nts", db_key_name="NT")

    # Promote the natural information produced by 'runtest nt' to fields.
    ts.machine_fields.append(MachineField(name="hardware",
                                          info_key="hardware"))
    ts.machine_fields.append(MachineField(name="os", info_key="os"))

    # The only reliable order currently is the "run_order" field. We will want
    # to revise this over time.
    ts.order_fields.append(OrderField(name="llvm_project_revision",
                                      info_key="run_order", ordinal=0))

    # We are only interested in simple runs, so we expect exactly four fields
    # per test.
    compile_status = SampleField(name="compile_status",
                                 type=status_sample_type,
                                 info_key=".compile.status")
    compile_time = SampleField(name="compile_time", type=real_sample_type,
                               info_key=".compile",
                               status_field=compile_status)
    exec_status = SampleField(name="execution_status", type=status_sample_type,
                              info_key=".exec.status")
    exec_time = SampleField(name="execution_time", type=real_sample_type,
                            info_key=".exec", status_field=exec_status)
    ts.sample_fields.append(compile_time)
    ts.sample_fields.append(compile_status)
    ts.sample_fields.append(exec_time)
    ts.sample_fields.append(exec_status)

    session.add(ts)

###
# Compile Testsuite Definition


def initialize_compile_definition(engine, session):
    # Fetch the sample types.
    real_sample_type = session.query(SampleType) \
        .filter_by(name="Real").first()
    status_sample_type = session.query(SampleType) \
        .filter_by(name="Status").first()

    # Create a test suite compile with "lnt runtest compile".
    ts = TestSuite(name="compile", db_key_name="Compile")

    # Promote some natural information to fields.
    ts.machine_fields.append(MachineField(name="hardware",
                                          info_key="hw.model"))
    ts.machine_fields.append(MachineField(name="os_version",
                                          info_key="kern.version"))

    # The only reliable order currently is the "run_order" field. We will want
    # to revise this over time.
    ts.order_fields.append(OrderField(name="llvm_project_revision",
                                      info_key="run_order", ordinal=0))

    # We expect up to five fields per test, each with a status field.
    for name, type_name in (('user', 'time'),
                            ('sys', 'time'),
                            ('wall', 'time'),
                            ('size', 'bytes'),
                            ('mem', 'bytes')):
        status = SampleField(
            name="%s_status" % (name,), type=status_sample_type,
            info_key=".%s.status" % (name,))
        ts.sample_fields.append(status)
        value = SampleField(
            name="%s_%s" % (name, type_name), type=real_sample_type,
            info_key=".%s" % (name,), status_field=status)
        ts.sample_fields.append(value)

    session.add(ts)

###
# Per-Testsuite Table Schema


def get_base_for_testsuite(test_suite):
    Base = sqlalchemy.ext.declarative.declarative_base()
    db_key_name = test_suite.db_key_name

    class Machine(Base):
        __tablename__ = db_key_name + '_Machine'

        id = Column("ID", Integer, primary_key=True)
        name = Column("Name", String(256), index=True)

        parameters_data = Column("Parameters", Binary)

        class_dict = locals()
        for item in test_suite.machine_fields:
            if item.name in class_dict:
                raise ValueError("test suite defines reserved key %r" %
                                 (name,))

            class_dict[item.name] = item.column = Column(
                item.name, String(256))

    class Order(Base):
        __tablename__ = db_key_name + '_Order'

        id = Column("ID", Integer, primary_key=True)

        next_order_id = Column("NextOrder", Integer, ForeignKey(
                "%s.ID" % __tablename__))
        previous_order_id = Column("PreviousOrder", Integer, ForeignKey(
                "%s.ID" % __tablename__))

        class_dict = locals()
        for item in test_suite.order_fields:
            if item.name in class_dict:
                raise ValueError("test suite defines reserved key %r" %
                                 (name,))

            class_dict[item.name] = item.column = Column(
                item.name, String(256))

    class Run(Base):
        __tablename__ = db_key_name + '_Run'

        id = Column("ID", Integer, primary_key=True)
        machine_id = Column("MachineID", Integer, ForeignKey(Machine.id),
                            index=True)
        order_id = Column("OrderID", Integer, ForeignKey(Order.id),
                          index=True)
        imported_from = Column("ImportedFrom", String(512))
        start_time = Column("StartTime", DateTime)
        end_time = Column("EndTime", DateTime)
        simple_run_id = Column("SimpleRunID", Integer)

        parameters_data = Column("Parameters", Binary)

        machine = sqlalchemy.orm.relation(Machine)
        order = sqlalchemy.orm.relation(Order)

        class_dict = locals()
        for item in test_suite.run_fields:
            if item.name in class_dict:
                raise ValueError("test suite defines reserved key %r" %
                                 (name,))

            class_dict[item.name] = item.column = Column(
                item.name, String(256))

    class Test(Base):
        __tablename__ = db_key_name + '_Test'
        id = Column("ID", Integer, primary_key=True)
        name = Column("Name", String(256), unique=True, index=True)

    class Sample(Base):
        __tablename__ = db_key_name + '_Sample'

        id = Column("ID", Integer, primary_key=True)

        run_id = Column("RunID", Integer, ForeignKey(Run.id))
        test_id = Column("TestID", Integer, ForeignKey(Test.id), index=True)

        run = sqlalchemy.orm.relation(Run)
        test = sqlalchemy.orm.relation(Test)

        class_dict = locals()
        for item in test_suite.sample_fields:
            if item.name in class_dict:
                raise ValueError("test suite defines reserved key {}"
                                 .format(name))

            if item.type.name == 'Real':
                item.column = Column(item.name, Float)
            elif item.type.name == 'Status':
                item.column = Column(item.name, Integer, ForeignKey(
                        StatusKind.id))
            elif item.type.name == 'Hash':
                continue
            else:
                raise ValueError("test suite defines unknown sample type {}"
                                 .format(item.type.name))

            class_dict[item.name] = item.column

    sqlalchemy.schema.Index("ix_%s_Sample_RunID_TestID" % db_key_name,
                            Sample.run_id, Sample.test_id)

    return Base


def initialize_testsuite(engine, session, name):
    defn = session.query(TestSuite).filter_by(name=name).first()
    assert defn is not None

    # Create all the testsuite database tables. We don't need to worry about
    # checking if they already exist, SA will handle that for us.
    base = get_base_for_testsuite(defn).metadata.create_all(engine)


def upgrade(engine):
    # This upgrade script is special in that it needs to handle databases "in
    # the wild" which have contents but existed before versioning.

    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    # If the TestSuite table exists, assume the database is pre-versioning but
    # already has the core initalized.
    if not TestSuite.__table__.exists(engine):
        initialize_core(engine, session)

    # Initialize all the test suite definitions for NTS and Compile, if they do
    # not already exist.
    if session.query(TestSuite).filter_by(name="nts").first() is None:
        initialize_nts_definition(engine, session)
    if session.query(TestSuite).filter_by(name="compile").first() is None:
        initialize_compile_definition(engine, session)

    # Commit the results.
    session.commit()

    # Materialize the test suite tables.
    initialize_testsuite(engine, session, "nts")
    initialize_testsuite(engine, session, "compile")
    session.close()
