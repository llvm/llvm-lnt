import sqlalchemy
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.schema import DDLElement


class _RenameTable(DDLElement):
    def __init__(self, old_name, new_name):
        self.old_name = old_name
        self.new_name = new_name


@compiles(_RenameTable)
def _visite_rename_table(element, compiler, **kw):
    return ("ALTER TABLE %s RENAME TO %s" %
            (compiler.preparer.quote(element.old_name),
             compiler.preparer.quote(element.new_name)))


def introspect_table(engine, name, autoload=True):
    # type: (sqlalchemy.engine.Engine, str) -> sqlalchemy.Table
    """Create a SQLAlchemy Table from the table name in the current DB.

    Used to make a Table object from something already in the DB."""
    md = sqlalchemy.MetaData(engine)
    target_table = sqlalchemy.Table(name, md, autoload=autoload)
    return target_table


def rename_table(engine, old_name, new_name):
    """Rename table with name `old_name` to `new_name`."""
    # sqlite refuses to rename "BAR" to "bar" so we go
    # "BAR" -> "BAR_x" -> "bar"
    rename = _RenameTable(old_name, old_name+"_x")
    rename.execute(bind=engine)
    rename = _RenameTable(old_name+"_x", new_name)
    rename.execute(bind=engine)
