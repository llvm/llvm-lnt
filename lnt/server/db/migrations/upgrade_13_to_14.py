# The "compile" suite is handled by the compile.yaml schema file now.
# This means we drop the entry in the TestSuite meta tables.
# The existing tables are either dropped if they are empty. We have to rename
# them if they are not empty, as previously the test-suite name was different
# from the prefix used in the tables. In yaml schemas the name and prefix is
# always the same so we have to rename from `Compile_XXXX` to `compile_XXX`.
import collections

from sqlalchemy import delete, select, update, func, and_

from lnt.server.db.migrations.util import introspect_table, rename_table


def _drop_suite(trans, name, engine):
    """Drop the suite name.

    This patches up the suite description tables for Order Fields,
    Machine Fields, Run Fields and Sample Fields.

    After than remove the suite directly from the TestSuite table.
    """

    test_suite = introspect_table(engine, 'TestSuite')

    test_suite_id = trans.execute(
        select([test_suite.c.ID]).where(test_suite.c.Name == name)) \
        .scalar()

    drop_fields(engine, test_suite_id, 'TestSuiteOrderFields', trans)
    drop_fields(engine, test_suite_id, 'TestSuiteMachineFields', trans)
    drop_fields(engine, test_suite_id, 'TestSuiteRunFields', trans)

    drop_samples_fields(engine, test_suite_id, trans)

    trans.execute(delete(test_suite).where(test_suite.c.Name == name))


def drop_fields(engine, test_suite_id, name, trans):
    """In the *Fields Tables, drop entries related to the test_suite_id.
    """
    fields_table = introspect_table(engine, name)
    order_files = delete(fields_table,
                         fields_table.c.TestSuiteID == test_suite_id)
    trans.execute(order_files)
    return fields_table


def drop_samples_fields(engine, test_suite_id, trans):
    """In the TestSuiteSampleFields, drop entries related to the test_suite_id.

    This extra function is needed because in MySQL it can't sort out the forign
    keys in the same table.
    """
    samples_table = introspect_table(engine, 'TestSuiteSampleFields')
    order_files = delete(samples_table,
                         and_(samples_table.c.TestSuiteID == test_suite_id,
                              samples_table.c.status_field.isnot(None)))
    trans.execute(order_files)
    order_files = delete(samples_table,
                         samples_table.c.TestSuiteID == test_suite_id)
    trans.execute(order_files)
    return samples_table


TableRename = collections.namedtuple('TableRename', 'old_name new_name')


def upgrade(engine):
    table_renames = [
        TableRename('Compile_Baseline', 'compile_Baseline'),
        TableRename('Compile_ChangeIgnore', 'compile_ChangeIgnore'),
        TableRename('Compile_RegressionIndicator',
                    'compile_RegressionIndicator'),
        TableRename('Compile_FieldChange', 'compile_FieldChange'),
        TableRename('Compile_FieldChangeV2', 'compile_FieldChangeV2'),
        TableRename('Compile_Profile', 'compile_Profile'),
        TableRename('Compile_Regression', 'compile_Regression'),
        TableRename('Compile_Sample', 'compile_Sample'),
        TableRename('Compile_Run', 'compile_Run'),
        TableRename('Compile_Order', 'compile_Order'),
        TableRename('Compile_Test', 'compile_Test'),
        TableRename('Compile_Machine', 'compile_Machine'),
    ]
    all_empty = True
    for rename in table_renames:
        tab = introspect_table(engine, rename.old_name)
        size = select([func.count(tab.c.ID)])
        num = engine.execute(size).scalar()

        if num > 0:
            all_empty = False
            break
    test_suite = introspect_table(engine, 'TestSuite')
    with engine.begin() as trans:
        # If nobody ever put data into the compile suite drop it.
        if all_empty:
            for name, _ in table_renames:
                tab = introspect_table(engine, name)
                tab.drop()
            _drop_suite(trans, 'compile', engine)
        else:
            for rename in table_renames:
                rename_table(engine, rename.old_name, rename.new_name)
            # Just change the DB_Key to match the name
            trans.execute(update(test_suite)
                          .where(test_suite.c.Name == 'compile')
                          .values(DBKeyName='compile'))
