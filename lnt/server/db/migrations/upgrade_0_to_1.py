# Version 0 is an empty database.
#
# Version 1 is the schema state at the time when we started doing DB versioning.

import sqlalchemy
from sqlalchemy import *
from sqlalchemy.schema import Index
from sqlalchemy.orm import relation

Base = sqlalchemy.ext.declarative.declarative_base()

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

def create_model_instance(class_, **kwargs):
    instance = class_()
    for key,value in kwargs.items():
        setattr(instance, key, value)
    return instance

def initialize_core(engine):
    # Create the tables.
    Base.metadata.create_all(engine)

    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    # Create the fixed sample kinds.
    #
    # NOTE: The IDs here are proscribed and should match those from
    # 'lnt.testing'.
    session.add(create_model_instance(StatusKind, id=0, name="PASS"))
    session.add(create_model_instance(StatusKind, id=1, name="FAIL"))
    session.add(create_model_instance(StatusKind, id=2, name="XFAIL"))

    # Create the fixed status kinds.
    session.add(create_model_instance(SampleType, name="Real"))
    session.add(create_model_instance(SampleType, name="Status"))

    session.commit()

def upgrade(engine):
    # This upgrade script is special in that it needs to handle databases "in
    # the wild" which have contents but existed before versioning.

    # If the TestSuite table exists, assume the database is pre-versioning but
    # already has the core initalized.
    if not TestSuite.__table__.exists(engine):
        initialize_core(engine)
