import sqlalchemy
import sqlalchemy.ext.compiler
import re

PATH_DATABASE_TYPE_RE = re.compile('\w+\:\/\/')

def path_has_no_database_type(path):
    return PATH_DATABASE_TYPE_RE.match(path) is None


def _alter_table_statement(dialect, table_name, column):
    """Given an SQLAlchemy Column object, create an `ALTER TABLE` statement
    that adds the column to the existing table."""
    # Code inspired by sqlalchemy.schema.CreateColumn documentation.
    compiler = dialect.ddl_compiler(dialect, None)
    text = "ALTER TABLE \"%s\" ADD COLUMN " % table_name
    text += compiler.get_column_specification(column)
    return text


def add_sqlalchemy_column(engine, table_name, column):
    statement = _alter_table_statement(engine.dialect, table_name, column)
    with engine.begin() as trans:
        trans.execute(statement)
