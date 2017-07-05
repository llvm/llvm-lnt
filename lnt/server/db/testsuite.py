"""
Database models for the TestSuites abstraction.
"""

import lnt

import sqlalchemy
import sqlalchemy.ext.declarative
import sqlalchemy.orm
from sqlalchemy import *
from sqlalchemy.schema import Index
from sqlalchemy.orm import relation

Base = sqlalchemy.ext.declarative.declarative_base()


class SampleType(Base):
    """
    The SampleType table describes an enumeration for the possible types
    clients can configure for different sample fields.
    """
    __tablename__ = 'SampleType'

    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), unique=True)

    # FIXME: We expect the database to have a limited number of instances of
    # this class, we should just provide static class variables for the various
    # types once bound.

    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name,))


class StatusKind(Base):
    """
    The StatusKind table describes an enumeration for the possible values
    clients can use for "Status" typed samples. This is designed to match the
    values which are in use by test produces and are defined in the lnt.testing
    module.
    """

    __tablename__ = 'StatusKind'

    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), unique=True)

    def __init__(self, id, name):
        self.id = id
        self.name = name

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name,))


class TestSuite(Base):
    __tablename__ = 'TestSuite'

    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), unique=True)

    # The name we use to prefix the per-testsuite databases.
    db_key_name = Column("DBKeyName", String(256))

    # The version of the schema used for the per-testsuite databases (encoded
    # as the LNT version).
    version = Column("Version", String(16))

    machine_fields = relation('MachineField', backref='test_suite')
    order_fields = relation('OrderField', backref='test_suite')
    run_fields = relation('RunField', backref='test_suite')
    sample_fields = relation('SampleField', backref='test_suite')

    def __init__(self, name, db_key_name):
        self.name = name
        self.db_key_name = db_key_name
        self.version = "%d.%d" % (lnt.__versioninfo__[0],
                                  lnt.__versioninfo__[1])

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.db_key_name,
                                                   self.version))

    @staticmethod
    def from_json(data):
        if data.get('format_version') != '2':
            raise ValueError("Expected \"format_version\": \"2\" in schema")
        name = data['name']
        ts = TestSuite(data['name'], data['name'])

        machine_fields = []
        for field_desc in data.get('machine_fields', []):
            name = field_desc['name']
            field = MachineField(name, info_key=None)
            machine_fields.append(field)
        ts.machine_fields = machine_fields

        run_fields = []
        order_fields = []
        for field_desc in data.get('run_fields', []):
            name = field_desc['name']
            is_order = field_desc.get('order', False)
            if is_order:
                field = OrderField(name, info_key=None, ordinal=0)
                order_fields.append(field)
            else:
                field = RunField(name, info_key=None)
                run_fields.append(field)
        ts.run_fields = run_fields
        ts.order_fields = order_fields
        assert(len(order_fields) > 0)

        # Hardcode some sample types. I wonder whether we should rather query
        # them from the core database?
        # This needs to be kept in sync with testsuitedb.py
        metric_types = {
            'Real': SampleType('Real'),
            'Integer': SampleType('Integer'),
            'Status': SampleType('Status'),
            'Hash': SampleType('Hash')
        }

        sample_fields = []
        for metric_desc in data['metrics']:
            name = metric_desc['name']
            bigger_is_better = metric_desc.get('bigger_is_better', False)
            metric_type_name = metric_desc.get('type', 'Real')
            metric_type = metric_types.get(metric_type_name)
            if metric_type is None:
                raise ValueError("Unknown metric type '%s' (not in %s)" %
                                 (metric_type_name,
                                  metric_types.keys().join(",")))

            bigger_is_better_int = 1 if bigger_is_better else 0
            field = SampleField(name, metric_type, info_key=None,
                                status_field = None,
                                bigger_is_better=bigger_is_better_int)
            sample_fields.append(field)
        ts.sample_fields = sample_fields
        return ts


class FieldMixin(object):
    @property
    def title(self):
        """ Return a title for the given field by replacing all _ with
            spaces and that has every word capitalized.
        """
        return self.name.replace("_", " ").title()


class MachineField(FieldMixin, Base):
    __tablename__ = 'TestSuiteMachineFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    # The info key describes the key to expect this field to be present as in
    # the reported machine information. Missing keys result in NULL values in
    # the database.
    info_key = Column("InfoKey", String(256))

    def __init__(self, name, info_key):
        self.name = name
        self.info_key = info_key

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.info_key))


class OrderField(FieldMixin, Base):
    __tablename__ = 'TestSuiteOrderFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    # The info key describes the key to expect this field to be present as in
    # the reported machine information. Missing keys result in NULL values in
    # the database.
    info_key = Column("InfoKey", String(256))

    # The ordinal index this field should be used at for creating a
    # lexicographic ordering amongst runs.
    ordinal = Column("Ordinal", Integer)

    def __init__(self, name, info_key, ordinal):
        assert isinstance(ordinal, int) and ordinal >= 0

        self.name = name
        self.info_key = info_key
        self.ordinal = ordinal

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.info_key,
                                                   self.ordinal))


class RunField(FieldMixin, Base):
    __tablename__ = 'TestSuiteRunFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    # The info key describes the key to expect this field to be present as in
    # the reported machine information. Missing keys result in NULL values in
    # the database.
    info_key = Column("InfoKey", String(256))

    def __init__(self, name, info_key):
        self.name = name
        self.info_key = info_key

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.info_key))


class SampleField(FieldMixin, Base):
    __tablename__ = 'TestSuiteSampleFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    # The type of sample this is.
    type_id = Column("Type", Integer, ForeignKey('SampleType.ID'))
    type = relation(SampleType)

    # The info key describes the key to expect this field to be present as in
    # the reported machine information. Missing keys result in NULL values in
    # the database.
    info_key = Column("InfoKey", String(256))

    # The status field is used to create a relation to the sample field that
    # reports the status (pass/fail/etc.) code related to this value. This
    # association is used by UI code to present the two status fields together.
    status_field_id = Column("status_field", Integer, ForeignKey(
            'TestSuiteSampleFields.ID'))
    status_field = relation('SampleField', remote_side=id)

    # Most real type samples assume lower values are better than higher values.
    # This assumption can be inverted by setting this column to nonzero.
    bigger_is_better = Column("bigger_is_better", Integer)

    def __init__(self, name, type, info_key, status_field=None,
                 bigger_is_better=0):
        self.name = name
        self.type = type
        self.info_key = info_key
        self.status_field = status_field
        self.bigger_is_better = bigger_is_better

        # Index of this column.
        self.index = None

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.type,
                                                   self.info_key))
