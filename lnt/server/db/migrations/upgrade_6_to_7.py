# Version 7 adds a "hash" Sample type & adds a sample field of
# this type for the NTS test suite.

import sqlalchemy

###
# Upgrade TestSuite
#
# Import the original schema from upgrade_0_to_1 since upgrade_6_to_7 does not
# change the actual schema.
from lnt.server.db.migrations.upgrade_0_to_1 import SampleType, TestSuite, SampleField

from lnt.server.db.util import add_column


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
                                    type=status_sample_type)
    hash_field = SampleField(name="hash",
                             type=hash_sample_type,
                             status_field=hash_status_field)
    ts.sample_fields.append(hash_status_field)
    ts.sample_fields.append(hash_field)
    session.add(ts)

    hash_status = sqlalchemy.Column('hash_status', sqlalchemy.Integer)
    hash_string = sqlalchemy.Column('hash', sqlalchemy.String(32))
    add_column(session, 'NT_Sample', hash_status)
    add_column(session, 'NT_Sample', hash_string)
    session.commit()
    session.close()
