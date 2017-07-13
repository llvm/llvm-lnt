# The "compile" suite is handled by the compile.yaml schema file now.
# This means we drop the entry in the TestSuite meta tables.
# The existing tables are either dropped if they are empty. We have to rename
# them if they are not empty, as previously the test-suite name was different
# from the prefix used in the tables. In yaml schemas the name and prefix is
# always the same so we have to rename from `Compile_XXXX` to `compile_XXX`.
import sqlalchemy


def _drop_suite(trans, name):
    trans.execute('''
DELETE FROM "TestSuiteOrderFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name" = \'compile\')
''')
    trans.execute('''
DELETE FROM "TestSuiteMachineFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name" = \'compile\')
''')
    trans.execute('''
DELETE FROM "TestSuiteRunFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name" = \'compile\')
''')
    trans.execute('''
DELETE FROM "TestSuiteSampleFields"
    WHERE "TestSuiteID" IN
        (SELECT "ID" FROM "TestSuite" WHERE "Name" = \'compile\')
''')
    trans.execute('DELETE FROM "TestSuite" WHERE "Name" = \'compile\'')


def upgrade(engine):
    tablenames = [
        ('Compile_Baseline', 'compile_Baseline'),
        ('Compile_ChangeIgnore', 'compile_ChangeIgnore'),
        ('Compile_RegressionIndicator', 'compile_RegressionIndicator'),
        ('Compile_FieldChange', 'compile_FieldChange'),
        ('Compile_FieldChangeV2', 'compile_FieldChangeV2'),
        ('Compile_Profile', 'compile_Profile'),
        ('Compile_Regression', 'compile_Regression'),
        ('Compile_Sample', 'compile_Sample'),
        ('Compile_Run', 'compile_Run'),
        ('Compile_Order', 'compile_Order'),
        ('Compile_Test', 'compile_Test'),
        ('Compile_Machine', 'compile_Machine'),
    ]
    all_empty = True
    for name, _ in tablenames:
        num = engine.execute('SELECT COUNT(*) FROM "%s"' % name).first()
        if num[0] > 0:
            all_empty = False
            break

    with engine.begin() as trans:
        # If nobody ever put data into the compile suite drop it
        if all_empty:
            for name, _ in tablenames:
                trans.execute('DROP TABLE "%s"' % name)
            _drop_suite(trans, 'compile')
        else:
            for old_name, new_name in tablenames:
                env = {'old_name': old_name, 'new_name': new_name}
                trans.execute('''
ALTER TABLE "%(old_name)s" RENAME TO "%(new_name)s_x"
''' % env)
                trans.execute('''
ALTER TABLE "%(new_name)s_x" RENAME TO \"%(new_name)s\"
''' % env)
            # Just change the DB_Key to match the name
            trans.execute('''
UPDATE "TestSuite" SET "DBKeyName" = \'compile\' WHERE "Name" = \'compile\'
''')
