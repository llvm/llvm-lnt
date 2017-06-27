# Version 9 of the database updates Sample to add the profile field, and
# adds Profiles.

import os
import sys

import sqlalchemy
from sqlalchemy import *
from sqlalchemy.schema import Index
from sqlalchemy.orm import relation

# Import the original schema from upgrade_0_to_1 since upgrade_1_to_2 does not
# change the actual schema, but rather adds functionality vis-a-vis orders.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1
import lnt.server.db.migrations.upgrade_2_to_3 as upgrade_2_to_3


###
# Upgrade TestSuite
def add_profiles(test_suite):
    """Given a test suite with a database connection and a test-suite
    name, make the profile sqlalchemy database objects for that test-suite.
    """
    # Grab the Base for the previous schema so that we have all
    # the definitions we need.
    Base = upgrade_2_to_3.get_base(test_suite)
    # Grab our db_key_name for our test suite so we can properly
    # prefix our fields/table names.
    db_key_name = test_suite.db_key_name

    class Profile(Base):
        __tablename__ = db_key_name + '_Profile'
        
        id = Column("ID", Integer, primary_key=True)
        created_time = Column("CreatedTime", DateTime)
        accessed_time = Column("AccessedTime", DateTime)
        filename = Column("Filename", String(256))
        counters = Column("Counters", String(512))
    
    return Base

def upgrade_testsuite(engine, name):
    # Grab Test Suite.
    session = sqlalchemy.orm.sessionmaker(engine)()
    test_suite = session.query(upgrade_0_to_1.TestSuite).\
                 filter_by(name=name).first()
    assert(test_suite is not None)
    db_key_name = test_suite.db_key_name
    
    # Add FieldChange to the test suite.
    Base = add_profiles(test_suite)
    Base.metadata.create_all(engine)
    # Commit changes (also closing all relevant transactions with
    # respect to Postgres like databases).
    session.commit()
    session.close()

    with engine.begin() as trans:
        trans.execute("""
ALTER TABLE "%s_Sample"
ADD COLUMN "ProfileID" INTEGER
""" % (db_key_name,))

def upgrade(engine):
    # Create our FieldChangeField table and commit.
    upgrade_testsuite(engine, 'nts')
    upgrade_testsuite(engine, 'compile')
