# Version 4 of the database adds the bigger_is_better column to StatusField.

from sqlalchemy import Column, Integer

from lnt.server.db.util import add_column


def upgrade(engine):
    bigger_is_better = Column('bigger_is_better', Integer, default=0)
    add_column(engine, 'TestSuiteSampleFields', bigger_is_better)
