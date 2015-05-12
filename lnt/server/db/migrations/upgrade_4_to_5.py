# Version 5 adds a "score" Sample type.

import os
import sys

import sqlalchemy
from sqlalchemy import *

###
# Upgrade TestSuite

# Import the original schema from upgrade_0_to_1 since upgrade_4_to_5 does not
# change the actual schema.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1

def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    real_sample_type = session.query(upgrade_0_to_1.SampleType).\
        filter_by(name = "Real").first()

    ts = session.query(upgrade_0_to_1.TestSuite).filter_by(name='nts').first()
    score = upgrade_0_to_1.SampleField(name="score", type=real_sample_type,
                                       info_key=".score",)
    ts.sample_fields.append(score)
    session.add(ts)

    session.commit()
    # upgrade_3_to_4.py added this column, so it is not in the ORM.
    session.connection().execute("""
UPDATE "TestSuiteSampleFields"
SET bigger_is_better=1
WHERE "Name"='score'
                                 """)
    session.commit()

    # FIXME: This is obviously not the right way to do this, but I gave up
    # trying to find out how to do it properly in SQLAlchemy without
    # SQLAlchemy-migrate installed.
    session.connection().execute("""
ALTER TABLE "NT_Sample"
ADD COLUMN "score" FLOAT
""")
    session.commit()

    
