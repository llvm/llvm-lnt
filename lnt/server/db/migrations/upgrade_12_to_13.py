# Adds new table to store jsonschema previously used to construct testsuite.
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy import Column, String, Binary

Base = declarative_base()


class TestSuiteJSONSchema(Base):
    __tablename__ = "TestSuiteJSONSchemas"
    testsuite_name = Column("TestSuiteName", String(256), primary_key=True)
    jsonschema = Column("JSONSchema", Binary)


def upgrade(engine):
    Base.metadata.create_all(engine)
