# Version 10 adds a code_size Sample type to the nightly test suite.


import sqlalchemy

###
# Import the original schema from upgrade_0_to_1 since upgrade_5_to_6 does not
# change the actual schema.
import lnt.server.db.migrations.upgrade_0_to_1 as upgrade_0_to_1


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
    # upgrade_3_to_4.py added this column, so it is not in the ORM.
    session.connection().execute("""
UPDATE "TestSuiteSampleFields"
SET bigger_is_better=0
WHERE "Name"='code_size'
                                 """)
    session.commit()

    session.connection().execute("""
ALTER TABLE "NT_Sample"
ADD COLUMN "code_size" FLOAT
""")
    session.commit()
