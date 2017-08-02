# Version 6 adds a "mem_bytes"" Sample type to "nts".

import sqlalchemy
from sqlalchemy import *
from lnt.server.db.migrations.util import add_column, introspect_table

###
# Upgrade TestSuite

# Import the original schema from upgrade_0_to_1 since upgrade_5_to_6 does not
# change the actual schema.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1


def upgrade(engine):
    # Create a session.
    session = sqlalchemy.orm.sessionmaker(engine)()

    real_sample_type = session.query(upgrade_0_to_1.SampleType).\
        filter_by(name="Real").first()

    ts = session.query(upgrade_0_to_1.TestSuite).filter_by(name='nts').first()
    mem_bytes = upgrade_0_to_1.SampleField(name="mem_bytes",
                                           type=real_sample_type,
                                           info_key=".mem",)
    ts.sample_fields.append(mem_bytes)
    session.add(ts)
    session.commit()
    session.close()

    test_suite_sample_fields = introspect_table(engine,
                                                'TestSuiteSampleFields')

    set_mem = update(test_suite_sample_fields) \
        .where(test_suite_sample_fields.c.Name == "mem_bytes") \
        .values(bigger_is_better=0)

    # upgrade_3_to_4.py added this column, so it is not in the ORM.
    with engine.begin() as trans:
        trans.execute(set_mem)

    nt_sample = introspect_table(engine, 'NT_Sample')
    mem_bytes = Column('mem_bytes', Float)
    add_column(engine, nt_sample, mem_bytes)
