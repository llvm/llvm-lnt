# Drop the "FieldChange" tables; they have been deprecated and replaced by
# "FieldChangeV2" for a long while now (but can still cause trouble when trying
# to delete old runs that are referenced from a FieldChange entry).
from lnt.server.db.migrations.util import introspect_table, rename_table


def update_testsuite(engine, db_key_name):
    table_name = '%s_FieldChange' % db_key_name
    with engine.begin() as trans:
        table = introspect_table(engine, table_name, autoload=False)
        table.drop(checkfirst=True)


def upgrade(engine):
    update_testsuite(engine, 'NT')
    update_testsuite(engine, 'compile')
