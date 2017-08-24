import sqlalchemy
import sqlalchemy.ext.compiler
import re
from sqlalchemy.schema import DDLElement
from sqlalchemy.ext.compiler import compiles


def path_has_no_database_type(path):
    return '://' not in path


class _AddColumn(DDLElement):
    def __init__(self, table_name, column):
        self.table_name = table_name
        self.column = column


@compiles(_AddColumn)
def _visit_add_column(element, compiler, **kw):
    return ("ALTER TABLE %s ADD COLUMN %s" %
            (compiler.preparer.quote(element.table_name),
             compiler.get_column_specification(element.column)))


def add_column(connectable, table_name, column):
    # type: (sqlalchemy.Connectable, sqlalchemy.Table, sqlalchemy.Column)
    # -> None
    """Add this column to the table named `table_name`.

    This is a stopgap to a real migration system.  Inspect the Column pass
    and try to issue an ALTER command to make the column.

    :param connectable: to execute on.
    :param table_name: name of table to add the column to.
    :param column: Column to add
    """
    statement = _AddColumn(table_name, column)
    statement.execute(bind=connectable)
