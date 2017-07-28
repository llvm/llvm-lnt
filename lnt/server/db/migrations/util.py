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


class _RenameTable(DDLElement):
    def __init__(self, old_name, new_name):
        self.old_name = old_name
        self.new_name = new_name


@compiles(_RenameTable)
def _visite_rename_table(element, compiler, **kw):
    return ("ALTER TABLE %s RENAME TO %s" %
        (compiler.preparer.quote(element.old_name),
         compiler.preparer.quote(element.new_name)))


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


def rename_table(engine, old_name, new_name):
    """Rename table wiht name \p old_name to \p new_name."""
    # sqlite refuses to rename "BAR" to "bar" so we go
    # "BAR" -> "BAR_x" -> "bar"
    rename = _RenameTable(old_name, old_name+"_x")
    rename.execute(bind=engine)
    rename = _RenameTable(old_name+"_x", new_name)
    rename.execute(bind=engine)
