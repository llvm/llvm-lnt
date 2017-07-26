import sqlalchemy
from sqlalchemy import DDL
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.schema import DDLElement


class _AddColumn(DDLElement):
    def __init__(self, table, column):
        self.table = table
        self.column = column


@compiles(_AddColumn)
def _visit_add_column(element, compiler, **kw):
    return ("ALTER TABLE %s ADD COLUMN %s" %
        (compiler.preparer.format_table(element.table),
         compiler.get_column_specification(element.column)))


def add_column(engine, table, column):
    # type: (sqlalchemy.engine.Engine, sqlalchemy.Table, sqlalchemy.Column) -> None
    """Add this column to the table.

    This is a stopgap to a real migration system.  Inspect the Column pass
    and try to issue an ALTER command to make the column.

    :param engine: to execute on.
    :param table: the Table to add the column to.
    :param column: Column to add
    """
    add_column = _AddColumn(table, column)
    add_column.execute(bind=engine)


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
