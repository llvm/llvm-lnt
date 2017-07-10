# The "compile" suite is handled by the compile.yaml schema file now.
# This means we drop the entry in the TestSuite meta tables.
# The existing tables are either dropped if they are empty. We have to rename
# them if they are not empty, as previously the test-suite name was different
# from the prefix used in the tables. In yaml schemas the name and prefix is
# always the same so we have to rename from `Compile_XXXX` to `compile_XXX`.
import sqlalchemy


def _drop_table_if_empty(trans, name):
    num = trans.execute('SELECT COUNT(*) FROM "%s"' % name).first()
    if num[0] == 0:
        trans.execute('DROP TABLE "%s"' % name)
        return True
    return False


def upgrade(engine):
    # The following is expected to fail if the user never had an old
    # version of the database that create the Compile_XXX tables.
    try:
        renames = {
            'Compile_Machine': 'compile_Machine',
            'Compile_Order': 'compile_Order',
            'Compile_Run': 'compile_Run',
            'Compile_Sample': 'compile_Sample',
            'Compile_Profile': 'compile_Profile',
            'Compile_FieldChange': 'compile_FieldChange',
            'Compile_FieldChangeV2': 'compile_FieldChangeV2',
            'Compile_Regression': 'compile_Regression',
            'Compile_RegressionIndicator': 'compile_RegressionIndicator',
            'Compile_ChangeIgnore': 'compile_ChangeIgnore',
            'Compile_BaseLine': 'compile_Baseline',
        }
        with engine.begin() as trans:
            for old_name, new_name in renames.items():
                if _drop_table_if_empty(trans, old_name):
                    continue;
                env = {'old_name': old_name, 'new_name': new_name}
                trans.execute('''
ALTER TABLE "%(old_name)s" RENAME TO "%(new_name)s_x"
''' % env)
                trans.execute('''
ALTER TABLE "%(new_name)s_x" RENAME TO \"%(new_name)s\"
''' % env)
    except Exception as e:
        import traceback
        traceback.print_exc()

    # Drop Compile suite information from meta tables
    with engine.begin() as trans:
        trans.execute('''
DELETE FROM "TestSuiteOrderFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name"=\'compile\')
''')
        trans.execute('''
DELETE FROM "TestSuiteMachineFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name"=\'compile\')
''')
        trans.execute('''
DELETE FROM "TestSuiteRunFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name"=\'compile\')
''')
        trans.execute('''
DELETE FROM "TestSuiteSampleFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name"=\'compile\')
''')
        trans.execute('''
DELETE FROM "TestSuite" WHERE "Name"='compile'
''')
