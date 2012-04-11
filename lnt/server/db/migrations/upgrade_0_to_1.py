# Version 0 is an empty database.
#
# Version 1 is the schema state at the time when we started doing DB versioning.

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
    id = Column("ID", Integer, primary_key=True)
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

def initialize_nts_testsuite(engine, session):
    # Fetch the sample types.
    real_sample_type = session.query(SampleType).\
        filter_by(name = "Real").first()
    status_sample_type = session.query(SampleType).\
        filter_by(name = "Status").first()

    ts = TestSuite(name="nts", db_key_name="NT")

    # Machine fields.
    ts.machine_fields.append(MachineField(name="hardware", info_key="hardware"))
    ts.machine_fields.append(MachineField(name="os", info_key="os"))

    # Order fields.
    ts.order_fields.append(OrderField(name="llvm_project_revision",
                                      info_key="run_order", ordinal=0))

    # Sample fields.
    compile_status = SampleField(name="compile_status", type=status_sample_type,
                                 info_key=".compile.status")
    compile_time = SampleField(name="compile_time", type=real_sample_type,
                               info_key=".compile", status_field=compile_status)
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

def initialize_compile_testsuite(engine, session):
    # Fetch the sample types.
    real_sample_type = session.query(SampleType).\
        filter_by(name = "Real").first()
    status_sample_type = session.query(SampleType).\
        filter_by(name = "Status").first()

    ts = TestSuite(name="compile", db_key_name="compile")

    # Machine fields.
    ts.machine_fields.append(MachineField(name="hardware", info_key="hw.model"))
    ts.machine_fields.append(MachineField(name="os_version",
                                          info_key="kern.version"))

    # Order fields.
    ts.order_fields.append(OrderField(name="llvm_project_revision",
                                      info_key="run_order", ordinal=0))

    # Sample fields.
    for name,type_name in (('user', 'time'),
                           ('sys', 'time'),
                           ('wall', 'time'),
                           ('size', 'bytes'),
                           ('mem', 'bytes')):
        status = SampleField(
            name="%s_status" % (name,), type=status_sample_type,
            info_key=".%s.status" % (name,))
        ts.sample_fields.append(status)
        value = SampleField(
            name="%s_%s" % (name,type_name), type=real_sample_type,
            info_key=".%s" % (name,), status_field=status)
        ts.sample_fields.append(value)

    session.add(ts)

###

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
        initialize_nts_testsuite(engine, session)
    if session.query(TestSuite).filter_by(name="compile").first() is None:
        initialize_compile_testsuite(engine, session)

    session.commit()
