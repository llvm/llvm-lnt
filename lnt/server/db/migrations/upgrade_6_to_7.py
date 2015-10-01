# Version 7 adds a "hash" Sample type & adds a sample field of
# this type for the NTS test suite.

import os
import sys

import sqlalchemy

###
# Upgrade TestSuite

# Import the original schema from upgrade_0_to_1 since upgrade_6_to_7 does not
# change the actual schema.
from lnt.server.db.migrations.upgrade_0_to_1 \
  import SampleType, TestSuite, SampleField


def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    session.add(SampleType(name="Hash"))
    session.commit()

    status_sample_type = session.query(SampleType).\
        filter_by(name="Status").first()
    hash_sample_type = session.query(SampleType).\
        filter_by(name="Hash").first()

    ts = session.query(TestSuite).filter_by(name='nts').first()
    hash_status_field = SampleField(name="hash_status",
                                    type=status_sample_type,
                                    info_key=".hash.status",)
    hash_field = SampleField(name="hash",
                             type=hash_sample_type,
                             info_key=".hash",
                             status_field=hash_status_field)
    ts.sample_fields.append(hash_status_field)
    ts.sample_fields.append(hash_field)
    session.add(ts)
    session.commit()

    session.connection().execute("""
ALTER TABLE "NT_Sample"
ADD COLUMN "hash_status" INTEGER
""")
    # For MD5 hashes, 32 characters is enough to store the full has.
    # Assume that for hashing schemes producing longer hashes, storing
    # just the first 32 characters is good enough for our use case.
    session.connection().execute("""
ALTER TABLE "NT_Sample"
ADD COLUMN "hash" VARCHAR(32)
""")
    session.commit()
