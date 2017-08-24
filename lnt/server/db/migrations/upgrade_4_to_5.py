# Version 5 adds a "score" Sample type.

# Import the original schema from upgrade_0_to_1 since upgrade_4_to_5 does not
# change the actual schema.
from sqlalchemy import update, Column, Float
from sqlalchemy.orm import sessionmaker

import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1
from lnt.server.db.migrations.util import introspect_table
from lnt.server.db.util import add_column


def upgrade(engine):
    # Create a session.
    session = sessionmaker(engine)()

    real_sample_type = session.query(upgrade_0_to_1.SampleType). \
        filter_by(name="Real").first()

    ts = session.query(upgrade_0_to_1.TestSuite).filter_by(name='nts').first()
    score = upgrade_0_to_1.SampleField(name="score", type=real_sample_type,
                                       info_key=".score")
    ts.sample_fields.append(score)
    session.add(ts)

    session.commit()
    session.close()

    test_suite_sample_fields = introspect_table(engine,
                                                'TestSuiteSampleFields')

    set_scores = update(test_suite_sample_fields) \
        .where(test_suite_sample_fields.c.Name == "score") \
        .values(bigger_is_better=1)

    with engine.begin() as trans:
        trans.execute(set_scores)
        # Give the NT table a score column.
        score = Column('score', Float)
        add_column(trans, 'NT_Sample', score)
