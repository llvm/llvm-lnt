"""
Database models for the TestSuites abstraction.
"""

from __future__ import absolute_import
import json
import lnt
from . import util

import sqlalchemy
import sqlalchemy.ext.declarative
import sqlalchemy.orm
from sqlalchemy import Column, Integer, ForeignKey, String, Binary
from sqlalchemy.orm import relation
from lnt.util import logger

Base = sqlalchemy.ext.declarative.declarative_base()  # type: sqlalchemy.ext.declarative.api.DeclarativeMeta


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

    id = Column("ID", Integer, primary_key=True, autoincrement=False)
    name = Column("Name", String(256), unique=True)

    def __init__(self, id, name):
        self.id = id
        self.name = name

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name,))


class _MigrationError(Exception):
    def __init__(self, message):
        full_message = \
            "Cannot automatically migrate database: %s" % message
        super(_MigrationError, self).__init__(full_message)


class TestSuiteJSONSchema(Base):
    """
    Saves the json schema used when creating a testsuite. Only used for suites
    created with a json schema description.
    """
    __tablename__ = 'TestSuiteJSONSchemas'
    testsuite_name = Column("TestSuiteName", String(256), primary_key=True)
    jsonschema = Column("JSONSchema", Binary)

    def __init__(self, testsuite_name, data):
        self.testsuite_name = testsuite_name
        self.jsonschema = json.dumps(data, encoding='utf-8', sort_keys=True)


class TestSuite(Base):
    __tablename__ = 'TestSuite'

    id = Column("ID", Integer, primary_key=True)
    name = Column("Name", String(256), unique=True)

    # The name we use to prefix the per-testsuite databases.
    db_key_name = Column("DBKeyName", String(256))

    # The version of the schema used for the per-testsuite databases (encoded
    # as the LNT version).
    version = Column("Version", String(16))

    machine_fields = relation('MachineField', backref='test_suite',
                              lazy='immediate')
    order_fields = relation('OrderField', backref='test_suite',
                            lazy='immediate')
    run_fields = relation('RunField', backref='test_suite',
                          lazy='immediate')
    sample_fields = relation('SampleField', backref='test_suite',
                             lazy='immediate')

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
        from . import testsuitedb
        if data.get('format_version') != '2':
            raise ValueError("Expected \"format_version\": \"2\" in schema")
        name = data['name']
        ts = TestSuite(name=data['name'], db_key_name=data['name'])

        machine_fields = []
        for field_desc in data.get('machine_fields', []):
            name = field_desc['name']
            field = MachineField(name)
            machine_fields.append(field)
        ts.machine_fields = machine_fields

        run_fields = []
        order_fields = []
        for field_desc in data.get('run_fields', []):
            name = field_desc['name']
            is_order = field_desc.get('order', False)
            if is_order:
                field = OrderField(name, ordinal=0)
                order_fields.append(field)
            else:
                field = RunField(name)
                run_fields.append(field)
        ts.run_fields = run_fields
        ts.order_fields = order_fields
        assert(len(order_fields) > 0)

        sample_fields = []
        for index, metric_desc in enumerate(data['metrics']):
            name = metric_desc['name']
            bigger_is_better = metric_desc.get('bigger_is_better', False)
            metric_type_name = metric_desc.get('type', 'Real')
            display_name = metric_desc.get('display_name')
            unit = metric_desc.get('unit')
            unit_abbrev = metric_desc.get('unit_abbrev')
            if not testsuitedb.is_known_sample_type(metric_type_name):
                raise ValueError("Unknown metric type '%s'" %
                                 metric_type_name)
            metric_type = SampleType(metric_type_name)
            bigger_is_better_int = 1 if bigger_is_better else 0
            field = SampleField(name, metric_type, index, status_field=None,
                                bigger_is_better=bigger_is_better_int,
                                display_name=display_name, unit=unit,
                                unit_abbrev=unit_abbrev)
            sample_fields.append(field)
        ts.sample_fields = sample_fields
        ts.jsonschema = data
        return ts

    def __json__(self):
        metrics = []
        for sample_field in self.sample_fields:
            metric = {
                'bigger_is_better': (sample_field.bigger_is_better != 0),
                'display_name': sample_field.display_name,
                'name': sample_field.name,
                'type': sample_field.type.name,
                'unit': sample_field.unit,
                'unit_abbrev': sample_field.unit_abbrev,
            }
            metrics.append(metric)
        machine_fields = []
        for machine_field in self.machine_fields:
            field = {
                'name': machine_field.name
            }
            machine_fields.append(field)
        run_fields = []
        for run_field in self.run_fields:
            field = {
                'name': run_field.name
            }
            run_fields.append(field)
        for order_field in self.order_fields:
            field = {
                'name': order_field.name,
                'order': True,
            }
            run_fields.append(field)
        metrics.sort(key=lambda x: x['name'])
        machine_fields.sort(key=lambda x: x['name'])
        run_fields.sort(key=lambda x: x['name'])

        return {
            'format_version': '2',
            'machine_fields': machine_fields,
            'metrics': metrics,
            'name': self.name,
            'run_fields': run_fields,
        }


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

    def __init__(self, name):
        self.name = name

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, ))

    def __copy__(self):
        return MachineField(self.name)


class OrderField(FieldMixin, Base):
    __tablename__ = 'TestSuiteOrderFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    # The ordinal index this field should be used at for creating a
    # lexicographic ordering amongst runs.
    ordinal = Column("Ordinal", Integer)

    def __init__(self, name, ordinal):
        assert isinstance(ordinal, int) and ordinal >= 0

        self.name = name
        self.ordinal = ordinal

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.ordinal))

    def __copy__(self):
        return Ordinal(self.name, self.ordinal)


class RunField(FieldMixin, Base):
    __tablename__ = 'TestSuiteRunFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    def __init__(self, name):
        self.name = name

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, ))

    def __copy__(self):
        return RunField(self.name)


class SampleField(FieldMixin, Base):
    __tablename__ = 'TestSuiteSampleFields'

    id = Column("ID", Integer, primary_key=True)
    test_suite_id = Column("TestSuiteID", Integer, ForeignKey('TestSuite.ID'),
                           index=True)
    name = Column("Name", String(256))

    # The type of sample this is.
    type_id = Column("Type", Integer, ForeignKey('SampleType.ID'))
    type = relation(SampleType, lazy='immediate')

    # The status field is used to create a relation to the sample field that
    # reports the status (pass/fail/etc.) code related to this value. This
    # association is used by UI code to present the two status fields together.
    status_field_id = Column("status_field", Integer, ForeignKey(
            'TestSuiteSampleFields.ID'))
    status_field = relation('SampleField', remote_side=id, lazy='immediate')

    # Most real type samples assume lower values are better than higher values.
    # This assumption can be inverted by setting this column to nonzero.
    bigger_is_better = Column("bigger_is_better", Integer)

    def __init__(self, name, type, schema_index, status_field=None, bigger_is_better=0,
                 display_name=None, unit=None, unit_abbrev=None):
        self.name = name
        self.type = type
        self.status_field = status_field
        self.bigger_is_better = bigger_is_better
        self.display_name = name if display_name is None else display_name
        self.unit = unit
        self.unit_abbrev = unit_abbrev
        self.schema_index = schema_index

        # Column instance for fields which have been bound (non-DB
        # parameter). This is provided for convenience in querying.
        self.column = None

    @sqlalchemy.orm.reconstructor
    def init_on_load(self):
        self.display_name = self.name
        self.unit = None
        self.unit_abbrev = None
        self.schema_index = -1

    def __repr__(self):
        return '%s%r' % (self.__class__.__name__, (self.name, self.type, ))

    def __copy__(self):
        return SampleField(self.name, self.type, self.schema_index, self.status_field,
                           self.bigger_is_better, self.display_name, self.unit,
                           self.unit_abbrev)

    def copy_info(self, other):
        self.display_name = other.display_name
        self.unit = other.unit
        self.unit_abbrev = other.unit_abbrev
        self.schema_index = other.schema_index


def _upgrade_to(connectable, tsschema, new_schema, dry_run=False):
    from . import testsuitedb
    new = json.loads(new_schema.jsonschema)
    old = json.loads(tsschema.jsonschema)
    ts_name = new['name']
    if old['name'] != ts_name:
        raise _MigrationError("Schema names differ?!?")

    old_metrics = {}
    for metric_desc in old.get('metrics', []):
        old_metrics[metric_desc['name']] = metric_desc

    for metric_desc in new.get('metrics', []):
        name = metric_desc['name']
        old_metric = old_metrics.pop(name, None)
        type = metric_desc['type']
        if old_metric is not None:
            if old_metric['type'] != type:
                raise _MigrationError("Type mismatch in metric '%s'" %
                                      name)
        elif not dry_run:
            # Add missing columns
            column = testsuitedb.make_sample_column(name, type)
            util.add_column(connectable, '%s_Sample' % ts_name, column)

    if len(old_metrics) != 0:
        raise _MigrationError("Metrics removed: %s" %
                              ", ".join(old_metrics.keys()))

    old_run_fields = {}
    old_order_fields = {}
    for field_desc in old.get('run_fields', []):
        if field_desc.get('order', False):
            old_order_fields[field_desc['name']] = field_desc
            continue
        old_run_fields[field_desc['name']] = field_desc

    for field_desc in new.get('run_fields', []):
        name = field_desc['name']
        if field_desc.get('order', False):
            old_order_field = old_order_fields.pop(name, None)
            if old_order_field is None:
                raise _MigrationError("Cannot add order field '%s'" %
                                      name)
            continue

        old_field = old_run_fields.pop(name, None)
        # Add missing columns
        if old_field is None and not dry_run:
            column = testsuitedb.make_run_column(name)
            util.add_column(connectable, '%s_Run' % ts_name, column)

    if len(old_run_fields) > 0:
        raise _MigrationError("Run fields removed: %s" %
                              ", ".join(old_run_fields.keys()))
    if len(old_order_fields) > 0:
        raise _MigrationError("Order fields removed: %s" %
                              ", ".join(old_order_fields.keys()))

    old_machine_fields = {}
    for field_desc in old.get('machine_fields', []):
        name = field_desc['name']
        old_machine_fields[name] = field_desc

    for field_desc in new.get('machine_fields', []):
        name = field_desc['name']
        old_field = old_machine_fields.pop(name, None)
        # Add missing columns
        if old_field is None and not dry_run:
            column = testsuitedb.make_machine_column(name)
            util.add_column(connectable, '%s_Machine' % ts_name, column)

    if len(old_machine_fields) > 0:
        raise _MigrationError("Machine fields removed: %s" %
                              ", ".join(old_machine_fields.keys()))
    # The rest should just be metadata that we can upgrade
    return True


def check_testsuite_schema_changes(session, testsuite):
    """Check whether the given testsuite that was loaded from a json/yaml
    file changed compared to the previous schema stored in the database.
    The database is automatically migrated for trivial changes or we throw
    and exception if automatic migration is not possible."""
    name = testsuite.name
    schema = TestSuiteJSONSchema(name, testsuite.jsonschema)
    prev_schema = session.query(TestSuiteJSONSchema) \
        .filter(TestSuiteJSONSchema.testsuite_name == name).first()
    if prev_schema is not None:
        if prev_schema.jsonschema != schema.jsonschema:
            logger.info("Previous Schema:")
            logger.info(json.dumps(json.loads(prev_schema.jsonschema),
                                   indent=2))
            # First do a dry run to check whether the upgrade will succeed.
            _upgrade_to(session, prev_schema, schema, dry_run=True)
            # Not perform the actual upgrade. This shouldn't fail as the dry
            # run already worked fine.
            _upgrade_to(session, prev_schema, schema)

            prev_schema.jsonschema = schema.jsonschema
            session.add(prev_schema)
            session.commit()
    else:
        session.add(schema)
        session.commit()


def _sync_fields(session, existing_fields, new_fields):
    for new_field in new_fields:
        existing = None
        for existing_field in existing_fields:
            if existing_field.name == new_field.name:
                existing = existing_field
                break
        if existing is None:
            existing_fields.append(new_field.__copy__())
        elif hasattr(existing, 'copy_info'):
            existing.copy_info(new_field)


def sync_testsuite_with_metatables(session, testsuite):
    """Update the metatables according a TestSuite object that was loaded
    from a yaml description."""
    name = testsuite.name

    # Replace metric_type fields with objects queried from database.
    sampletypes = session.query(SampleType).all()
    sampletypes = dict([(st.name, st) for st in sampletypes])
    for sample_field in testsuite.sample_fields:
        metric_type_name = sample_field.type.name
        sample_field.type = sampletypes[metric_type_name]

    # Update or create the TestSuite entry.
    existing_ts = session.query(TestSuite) \
        .filter(TestSuite.name == name).first()
    if existing_ts is None:
        session.add(testsuite)
    else:
        # Add missing fields (Note that we only need to check for newly created
        # fields, removed ones should be catched by check_schema_changes()).
        _sync_fields(session, existing_ts.machine_fields,
                     testsuite.machine_fields)
        _sync_fields(session, existing_ts.run_fields, testsuite.run_fields)
        _sync_fields(session, existing_ts.order_fields, testsuite.order_fields)
        _sync_fields(session, existing_ts.sample_fields,
                     testsuite.sample_fields)
        testsuite = existing_ts
    return testsuite
