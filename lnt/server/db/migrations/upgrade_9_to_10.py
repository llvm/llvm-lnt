# Version 10 adds a code_size Sample type to the nightly test suite.


import sqlalchemy

###
# Import the original schema from upgrade_0_to_1 since upgrade_5_to_6 does not
# change the actual schema.
from sqlalchemy import update, Column, Float

import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1

from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column


def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    real_sample_type = session.query(upgrade_0_to_1.SampleType).\
        filter_by(name="Real").first()

    ts = session.query(upgrade_0_to_1.TestSuite).filter_by(name='nts').first()
    code_size = upgrade_0_to_1.SampleField(name="code_size",
                                           type=real_sample_type,
                                           info_key=".code_size",)
    ts.sample_fields.append(code_size)
    session.add(ts)
    session.commit()
    session.close()

    test_suite_sample_fields = introspect_table(engine,
                                                'TestSuiteSampleFields')
    update_code_size = update(test_suite_sample_fields) \
        .where(test_suite_sample_fields.c.Name == "code_size") \
        .values(bigger_is_better=0)
    # upgrade_3_to_4.py added this column, so it is not in the ORM.

    with engine.begin() as trans:
        trans.execute(update_code_size)
        code_size = Column('code_size', Float)
        add_column(trans, 'NT_Sample', code_size)
