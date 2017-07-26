import sqlalchemy
from sqlalchemy import DDL


def add_column(engine, table_to_alter, column_to_add):
    # type: (sqlalchemy.engine.Engine, sqlalchemy.Table, sqlalchemy.Column) -> None
    """Add this column to the table.

    This is a stopgap to a real migration system.  Inspect the Column pass
    and try to issue an ALTER command to make the column.  Detect Column
    default, and add that.

    Be careful, this does not support corner cases like most Column keywords
    or any fancy Column settings.

    :param engine: to execute on.
    :param table_to_alter: the Table to add the column to.
    :param column_to_add: Column that does not have anything fancy like
    autoincrement.

    """
    column_name = column_to_add.name
    col_type = column_to_add.type
    if not column_to_add.default:
        default = ""
    else:
        default = "DEFAULT {}".format(column_to_add.default.arg)
    add_score = DDL("ALTER TABLE %(table)s ADD COLUMN %(column_name)s %(col_type)s %(default)s",
                    context=dict(column_name=column_name,
                                 col_type=col_type,
                                 default=default))
    add_score.execute(bind=engine, target=table_to_alter)


def introspect_table(engine, name):
    # type: (sqlalchemy.engine.Engine, str) -> sqlalchemy.Table
    """Create a SQLAlchemy Table from the table name in the current DB.

    Used to make a Table object from something already in the DB."""
    md = sqlalchemy.MetaData(engine)
    target_table = sqlalchemy.Table(name, md, autoload=True)
    return target_table


def rename_table(engine, old_table, new_name):
    # type: (sqlalchemy.engine.Engine, sqlalchemy.Table, str) -> None
    """Rename the old_table to new_table.

    Renames the table by Old_Table -> New_Table_x -> New_Table.

    :param engine: to execute on.
    :param old_table: the Table to rename.
    :param new_name: the string name to change the table to.

    """
    rename = DDL("ALTER TABLE %(table)s RENAME TO %(new_name)s_x",
                 context=dict(new_name=new_name))
    rename.execute(bind=engine, target=old_table)
    rename = DDL("ALTER TABLE %(new_name)s_x RENAME TO %(new_name)s",
                 context=dict(new_name=new_name))
    rename.execute(bind=engine)
