"""
Database models for the TestSuite databases themselves.

These are a bit magical because the models themselves are driven by the test
suite metadata, so we only create the classes at runtime.
"""

import datetime
import json
import os

import aniso8601
import sqlalchemy
import flask
from sqlalchemy import *
from sqlalchemy.orm import relation
from sqlalchemy.orm.exc import ObjectDeletedError
from typing import List
from lnt.util import logger

import testsuite
import lnt.testing.profile.profile as profile
import lnt
from lnt.server.ui.util import convert_revision


def _dict_update_abort_on_duplicates(base_dict, to_merge):
    '''This behaves like base_dict.update(to_merge) but asserts that none
    of the keys in to_merge is present in base_dict yet.'''
    for key, value in to_merge.items():
        assert base_dict.get(key, None) is None
        base_dict[key] = value


_sample_type_to_sql = {
    'Real': Float,
    'Hash': String,
    'Status': Integer,
}


def is_known_sample_type(name):
    return name in _sample_type_to_sql


def make_sample_column(name, type):
    sqltype = _sample_type_to_sql.get(type)
    if sqltype is None:
        raise ValueError("test suite defines unknown sample type %r" % type)
    options = []
    if type == 'Status':
        options.append(ForeignKey(testsuite.StatusKind.id))
    return Column(name, sqltype, *options)


def make_run_column(name):
    return Column(name, String(256))


def make_machine_column(name):
    return Column(name, String(256))


class MachineInfoChanged(ValueError):
    pass


class TestSuiteDB(object):
    """
    Wrapper object for an individual test suites database tables.

    This wrapper is somewhat special in that it handles specializing the
    metatable instances for the given test suite.

    Clients are expected to only access the test suite database tables by going
    through the model classes constructed by this wrapper object.
    """

    def __init__(self, v4db, name, test_suite):
        testsuitedb = self
        self.v4db = v4db
        self.name = name
        self.test_suite = test_suite

        # Save caches of the various fields.
        self.machine_fields = list(self.test_suite.machine_fields)
        self.order_fields = list(self.test_suite.order_fields)
        self.run_fields = list(self.test_suite.run_fields)
        self.sample_fields = list(sorted(self.test_suite.sample_fields,
            key = lambda s: s.schema_index))
        self.machine_to_latest_order_cache = {}
        sample_field_indexes = dict()

        for i, field in enumerate(self.sample_fields):
            sample_field_indexes[field.name] = i
        self.sample_field_indexes = sample_field_indexes

        self.base = sqlalchemy.ext.declarative.declarative_base()

        # Create parameterized model classes for this test suite.
        class ParameterizedMixin(object):
            # Class variable to allow finding the associated test suite from
            # model instances.
            testsuite = self

            # Class variable (expected to be defined by subclasses) to allow
            # easy access to the field list for parameterized model classes.
            fields = None

            def get_field(self, field):
                return getattr(self, field.name)

            def set_field(self, field, value):
                return setattr(self, field.name, value)

            def get_fields(self):
                result = dict()
                for field in self.fields:
                    value = self.get_field(field)
                    if value is None:
                        continue
                    result[field.name] = value
                return result

            def set_fields_pop(self, data_dict):
                for field in self.fields:
                    value = data_dict.pop(field.name, None)
                    self.set_field(field, value)

        db_key_name = self.test_suite.db_key_name

        class Machine(self.base, ParameterizedMixin):
            __tablename__ = db_key_name + '_Machine'
            __table_args__ = {'mysql_collate': 'utf8_bin'}
            DEFAULT_BASELINE_REVISION = v4db.baseline_revision

            fields = self.machine_fields
            id = Column("ID", Integer, primary_key=True)
            name = Column("Name", String(256), index=True)

            # The parameters blob is used to store any additional information
            # reported by the run but not promoted into the machine record.
            # Such data is stored as a JSON encoded blob.
            parameters_data = Column("Parameters", Binary)

            # Dynamically create fields for all of the test suite defined
            # machine fields.
            class_dict = locals()
            for item in fields:
                iname = item.name
                if iname in class_dict:
                    raise ValueError("test suite defines reserved key %r" % (
                        iname))

                class_dict[iname] = item.column = make_machine_column(iname)

            def __init__(self, name_value):
                self.id = None
                self.name = name_value

            def __repr__(self):
                return '%s_%s%r' % (db_key_name, self.__class__.__name__,
                                    (self.id, self.name))

            @property
            def parameters(self):
                """dictionary access to the BLOB encoded parameters data"""
                return dict(json.loads(self.parameters_data))

            @parameters.setter
            def parameters(self, data):
                self.parameters_data = json.dumps(sorted(data.items()))

            def get_baseline_run(self, session):
                ts = Machine.testsuite
                user_baseline = ts.get_users_baseline(session)
                if user_baseline:
                    return self.get_closest_previously_reported_run(
                        session, user_baseline.order)
                else:
                    mach_base = Machine.DEFAULT_BASELINE_REVISION
                    # If we have an int, convert it to a proper string.
                    if isinstance(mach_base, int):
                        mach_base = '% 7d' % mach_base
                    return self.get_closest_previously_reported_run(
                        session, ts.Order(llvm_project_revision=mach_base))

            def get_closest_previously_reported_run(self, session,
                                                    order_to_find):
                """
                Find the closest previous run to the requested order, for which
                this machine also reported.
                """

                # FIXME: Scalability! Pretty fast in practice, but still.
                ts = Machine.testsuite
                # Search for best order.
                best_order = None
                for order in session.query(ts.Order).\
                        join(ts.Run).\
                        filter(ts.Run.machine_id == self.id).distinct():
                    if order >= order_to_find and \
                          (best_order is None or order < best_order):
                        best_order = order

                # Find the most recent run on this machine that used
                # that order.
                closest_run = None
                if best_order:
                    closest_run = session.query(ts.Run)\
                        .filter(ts.Run.machine_id == self.id)\
                        .filter(ts.Run.order_id == best_order.id)\
                        .order_by(ts.Run.start_time.desc()).first()

                return closest_run

            def set_from_dict(self, data):
                data_name = data.pop('name', None)
                # This function is not meant for renaming. Abort on mismatch.
                if data_name is not None and data_name != self.name:
                    raise ValueError("Mismatching machine name")
                data.pop('id', None)
                self.set_fields_pop(data)
                self.parameters = data

            def __json__(self):
                result = dict()
                result['name'] = self.name
                result['id'] = self.id
                _dict_update_abort_on_duplicates(result, self.get_fields())
                _dict_update_abort_on_duplicates(result, self.parameters)
                return result

        class Order(self.base, ParameterizedMixin):
            __tablename__ = db_key_name + '_Order'

            # We guarantee that our fields are stored in the order they are
            # supposed to be lexicographically compared, the __cmp__ method
            # relies on this.
            fields = sorted(self.order_fields,
                            key=lambda of: of.ordinal)

            id = Column("ID", Integer, primary_key=True)

            # Define two common columns which are used to store the previous
            # and next links for the total ordering amongst run orders.
            next_order_id = Column("NextOrder", Integer, ForeignKey(id))
            previous_order_id = Column("PreviousOrder", Integer,
                                       ForeignKey(id))

            # This will implicitly create the previous_order relation.
            backref = sqlalchemy.orm.backref('previous_order', uselist=False,
                                             remote_side=id)
            join = 'Order.previous_order_id==Order.id'
            next_order = relation("Order", backref=backref, primaryjoin=join,
                                  uselist=False)
            order_name_cache = {}

            # Dynamically create fields for all of the test suite defined order
            # fields.
            class_dict = locals()
            for item in self.order_fields:
                if item.name in class_dict:
                    raise ValueError("test suite defines reserved key %r" % (
                        name,))

                class_dict[item.name] = item.column = Column(
                    item.name, String(256))

            def __init__(self, previous_order_id=None, next_order_id=None,
                         **kwargs):
                self.previous_order_id = previous_order_id
                self.next_order_id = next_order_id

                # Initialize fields (defaulting to None, for now).
                for item in self.fields:
                    self.set_field(item, kwargs.get(item.name))

            def __repr__(self):
                fields = dict((item.name, self.get_field(item))
                              for item in self.fields)

                return '%s_%s(%r, %r, **%r)' % (
                    db_key_name, self.__class__.__name__,
                    self.previous_order_id, self.next_order_id, fields)

            def as_ordered_string(self):
                """Return a readable value of the order object by printing the
                fields in lexicographic order."""

                # If there is only a single field, return it.
                if len(self.fields) == 1:
                    return self.get_field(self.fields[0])

                # Otherwise, print as a tuple of string.
                return '(%s)' % (
                    ', '.join(self.get_field(field)
                              for field in self.fields),)

            @property
            def name(self):
                return self.as_ordered_string()

            def __cmp__(self, b):
                # SA occasionally uses comparison to check model instances
                # verse some sentinels, so we ensure we support comparison
                # against non-instances.
                if self.__class__ is not b.__class__:
                    return -1
                # Compare every field in lexicographic order.
                return cmp([convert_revision(self.get_field(item), cache=Order.order_name_cache)
                            for item in self.fields],
                           [convert_revision(b.get_field(item),  cache=Order.order_name_cache)
                            for item in self.fields])

            def __json__(self, include_id=True):
                result = {}
                if include_id:
                    result['id'] = self.id
                _dict_update_abort_on_duplicates(result, self.get_fields())
                return result

        class Run(self.base, ParameterizedMixin):
            __tablename__ = db_key_name + '_Run'

            fields = self.run_fields
            id = Column("ID", Integer, primary_key=True)
            machine_id = Column("MachineID", Integer, ForeignKey(Machine.id),
                                index=True)
            order_id = Column("OrderID", Integer, ForeignKey(Order.id),
                              index=True)
            imported_from = Column("ImportedFrom", String(512))
            start_time = Column("StartTime", DateTime)
            end_time = Column("EndTime", DateTime)
            simple_run_id = Column("SimpleRunID", Integer)

            # The parameters blob is used to store any additional information
            # reported by the run but not promoted into the machine record.
            # Such data is stored as a JSON encoded blob.
            parameters_data = Column("Parameters", Binary, index=False,
                                     unique=False)

            machine = relation(Machine)
            order = relation(Order)

            # Dynamically create fields for all of the test suite defined run
            # fields.
            #
            # FIXME: We are probably going to want to index on some of these,
            # but need a bit for that in the test suite definition.
            class_dict = locals()
            for item in fields:
                iname = item.name
                if iname in class_dict:
                    raise ValueError("test suite defines reserved key %r" %
                                     (iname,))

                class_dict[iname] = item.column = make_run_column(iname)

            def __init__(self, new_id, machine, order, start_time, end_time):
                self.id = new_id
                self.machine = machine
                self.order = order
                self.start_time = start_time
                self.end_time = end_time
                self.imported_from = None

            def __repr__(self):
                return '%s_%s%r' % (db_key_name, self.__class__.__name__,
                                    (self.id, self.machine, self.order,
                                     self.start_time, self.end_time))

            @property
            def parameters(self):
                """dictionary access to the BLOB encoded parameters data"""
                return dict(json.loads(self.parameters_data))

            @parameters.setter
            def parameters(self, data):
                self.parameters_data = json.dumps(sorted(data.items()))

            def __json__(self, flatten_order=True):
                result = {
                    'id': self.id,
                    'start_time': self.start_time,
                    'end_time': self.end_time,
                }
                # Leave out: machine_id, simple_run_id, imported_from
                if flatten_order:
                    _dict_update_abort_on_duplicates(
                        result, self.order.__json__(include_id=False))
                    result['order_by'] = \
                        ','.join([f.name for f in self.order.fields])
                    result['order_id'] = self.order_id
                else:
                    result['order_id'] = self.order_id
                _dict_update_abort_on_duplicates(result, self.get_fields())
                _dict_update_abort_on_duplicates(result, self.parameters)
                return result

        Machine.runs = relation(Run, back_populates='machine',
                                cascade="all, delete-orphan")
        Order.runs = relation(Run, back_populates='order',
                              cascade="all, delete-orphan")

        class Test(self.base, ParameterizedMixin):
            __tablename__ = db_key_name + '_Test'
            # utf8_bin for case sensitive compare
            __table_args__ = {'mysql_collate': 'utf8_bin'}
            id = Column("ID", Integer, primary_key=True)
            name = Column("Name", String(256), unique=True, index=True)

            def __init__(self, name):
                self.id = None
                self.name = name

            def __repr__(self):
                return '%s_%s%r' % (db_key_name, self.__class__.__name__,
                                    (self.id, self.name))

            def __json__(self, include_id=True):
                result = {'name': self.name}
                if include_id:
                    result['id'] = self.id
                return result

        class Profile(self.base):
            __tablename__ = db_key_name + '_Profile'

            id = Column("ID", Integer, primary_key=True)
            created_time = Column("CreatedTime", DateTime)
            accessed_time = Column("AccessedTime", DateTime)
            filename = Column("Filename", String(256))
            counters = Column("Counters", String(512))

            def __init__(self, encoded, config, testid):
                self.created_time = datetime.datetime.now()
                self.accessed_time = datetime.datetime.now()

                if config is not None:
                    profileDir = config.config.profileDir
                    prefix = 't-%s-s-' % os.path.basename(testid)
                    self.filename = \
                        profile.Profile.saveFromRendered(encoded,
                                                         profileDir=profileDir,
                                                         prefix=prefix)

                p = profile.Profile.fromRendered(encoded)
                s = ','.join('%s=%s' % (k, v)
                             for k, v in p.getTopLevelCounters().items())
                self.counters = s[:512]

            def getTopLevelCounters(self):
                d = dict()
                for i in self.counters.split('='):
                    k, v = i.split(',')
                    d[k] = v
                return d

            def load(self, profileDir):
                return profile.Profile.fromFile(os.path.join(profileDir,
                                                             self.filename))

        class Sample(self.base, ParameterizedMixin):
            __tablename__ = db_key_name + '_Sample'

            fields = list(sorted(self.sample_fields, key = lambda x: self.sample_field_indexes[x.name]))
            id = Column("ID", Integer, primary_key=True)
            # We do not need an index on run_id, this is covered by the
            # compound (Run(ID),Test(ID)) index we create below.
            run_id = Column("RunID", Integer, ForeignKey(Run.id), index=True)
            test_id = Column("TestID", Integer, ForeignKey(Test.id),
                             index=True)
            profile_id = Column("ProfileID", Integer, ForeignKey(Profile.id))

            run = relation(Run)
            test = relation(Test)
            profile = relation(Profile)

            @staticmethod
            def get_primary_fields():
                """
                get_primary_fields() -> [SampleField*]

                Get the primary sample fields (those which are not associated
                with some other sample field).
                """
                status_fields = set(s.status_field
                                    for s in self.Sample.fields
                                    if s.status_field is not None)
                for field in self.Sample.fields:
                    if field not in status_fields:
                        yield field

            @staticmethod
            def get_metric_fields():
                """
                get_metric_fields() -> [SampleField*]

                Get the sample fields which represent some kind of metric, i.e.
                those which have a value that can be interpreted as better or
                worse than other potential values for this field.
                """
                for field in Sample.fields:
                    if field.type.name in ['Real', 'Integer']:
                        yield field

            @staticmethod
            def get_hash_of_binary_field():
                """
                get_hash_of_binary_field() -> SampleField

                Get the sample field which represents a hash of the binary
                being tested. This field will compare equal iff two binaries
                are considered to be identical, e.g. two different compilers
                producing identical code output.

                Returns None if such a field isn't available.
                """
                for field in self.Sample.fields:
                    if field.name == 'hash':
                        return field
                return None

            # Dynamically create fields for all of the test suite defined
            # sample fields.
            #
            # FIXME: We might want to index some of these, but for a different
            # reason than above. It is possible worth it to turn the compound
            # index below into a covering index. We should evaluate this once
            # the new UI is up.
            class_dict = locals()
            for item in self.sample_fields:
                iname = item.name
                if iname in class_dict:
                    raise ValueError("test suite defines reserved key %r" %
                                     (iname,))

                item.column = make_sample_column(iname, item.type.name)
                class_dict[iname] = item.column

            def __init__(self, run, test, **kwargs):
                self.id = None
                self.run = run
                self.test = test

                # Initialize sample fields (defaulting to 0, for now).
                for item in self.fields:
                    self.set_field(item, kwargs.get(item.name, None))

            def __repr__(self):
                fields = dict((item.name, self.get_field(item))
                              for item in self.fields)

                return '%s_%s(%r, %r, %r, **%r)' % (
                    db_key_name, self.__class__.__name__,
                    self.id, self.run, self.test, fields)

            def __json__(self, flatten_test=False, include_id=True):
                result = {}
                if include_id:
                    result['id'] = self.id
                # Leave out: run_id
                # TODO: What about profile/profile_id?
                if flatten_test:
                    _dict_update_abort_on_duplicates(
                        result, self.test.__json__(include_id=False))
                else:
                    result['test_id'] = self.test_id
                _dict_update_abort_on_duplicates(result, self.get_fields())
                return result

        Run.samples = relation(Sample, back_populates='run',
                               cascade="all, delete-orphan")

        class FieldChange(self.base, ParameterizedMixin):
            """FieldChange represents a change in between the values
            of the same field belonging to two samples from consecutive runs.
            """

            __tablename__ = db_key_name + '_FieldChangeV2'
            id = Column("ID", Integer, primary_key=True)
            old_value = Column("OldValue", Float)
            new_value = Column("NewValue", Float)
            start_order_id = Column("StartOrderID", Integer,
                                    ForeignKey(Order.id), index=True)
            end_order_id = Column("EndOrderID", Integer, ForeignKey(Order.id))
            test_id = Column("TestID", Integer, ForeignKey(Test.id))
            machine_id = Column("MachineID", Integer, ForeignKey(Machine.id))
            field_id = Column("FieldID", Integer,
                              ForeignKey(testsuite.SampleField.id))
            # Could be from many runs, but most recent one is interesting.
            run_id = Column("RunID", Integer, ForeignKey(Run.id))

            start_order = relation(Order, primaryjoin='FieldChange.'
                                   'start_order_id==Order.id')
            end_order = relation(Order, primaryjoin='FieldChange.'
                                 'end_order_id==Order.id')
            test = relation(Test)
            machine = relation(Machine)
            field = relation(testsuite.SampleField)
            run = relation(Run)

            def __init__(self, start_order, end_order, machine,
                         test, field_id):
                self.start_order = start_order
                self.end_order = end_order
                self.machine = machine
                self.test = test
                self.field_id = field_id

            def __repr__(self):
                return '%s_%s%r' % (db_key_name, self.__class__.__name__,
                                    (self.start_order, self.end_order,
                                     self.test, self.machine, self.field))

            def __json__(self):
                return {
                    'id': self.id,
                    'old_value': self.old_value,
                    'new_value': self.new_value,
                    'start_order_id': self.start_order_id,
                    'end_order_id': self.end_order_id,
                    'test_id': self.test_id,
                    'machine_id': self.machine_id,
                    'field_id': self.field_id,
                    'run_id': self.run_id,
                }

        Machine.fieldchanges = relation(FieldChange, back_populates='machine',
                                        cascade="all, delete-orphan")
        Run.fieldchanges = relation(FieldChange, back_populates='run',
                                    cascade="all, delete-orphan")

        class Regression(self.base, ParameterizedMixin):
            """Regressions hold data about a set of RegressionIndices."""

            __tablename__ = db_key_name + '_Regression'
            id = Column("ID", Integer, primary_key=True)
            title = Column("Title", String(256), unique=False, index=False)
            bug = Column("BugLink", String(256), unique=False, index=False)
            state = Column("State", Integer)

            def __init__(self, title, bug, state):
                self.title = title
                self.bug = bug
                self.state = state

            def __repr__(self):
                """String representation of the Regression for debugging.

                Sometimes we try to print deleted regressions: in this case
                don't die, and return a deleted """
                try:
                    return '{}_{}:"{}"'.format(db_key_name,
                                               self.__class__.__name__,
                                               self.title)
                except ObjectDeletedError:
                    return '{}_{}:"{}"'.format(db_key_name,
                                               self.__class__.__name__,
                                               "<Deleted>")

            def __json__(self):
                return {
                    'id': self.id,
                    'title': self.title,
                    'bug': self.bug,
                    'state': self.state,
                }

        class RegressionIndicator(self.base, ParameterizedMixin):
            """Relates a regression to a fieldchange."""

            __tablename__ = db_key_name + '_RegressionIndicator'
            id = Column("ID", Integer, primary_key=True)
            regression_id = Column("RegressionID", Integer,
                                   ForeignKey(Regression.id), index=True)
            field_change_id = Column("FieldChangeID", Integer,
                                     ForeignKey(FieldChange.id))

            regression = relation(Regression)
            field_change = relation(FieldChange)

            def __init__(self, regression, field_change):
                self.regression = regression
                self.field_change = field_change

            def __repr__(self):
                return '%s_%s%r' % (db_key_name, self.__class__.__name__,
                                    (self.id, self.regression,
                                     self.field_change))

            def __json__(self):
                return {
                    'RegressionIndicatorID': self.id,
                    'Regression': self.regression,
                    'FieldChange': self.field_change
                }

        FieldChange.regression_indicators = \
            relation(RegressionIndicator, back_populates='field_change',
                     cascade="all, delete-orphan")

        class ChangeIgnore(self.base, ParameterizedMixin):
            """Changes to ignore in the web interface."""

            __tablename__ = db_key_name + '_ChangeIgnore'
            id = Column("ID", Integer, primary_key=True)

            field_change_id = Column("ChangeIgnoreID", Integer,
                                     ForeignKey(FieldChange.id))

            field_change = relation(FieldChange)

            def __init__(self, field_change):
                self.field_change = field_change

            def __repr__(self):
                return '%s_%s%r' % (db_key_name, self.__class__.__name__,
                                    (self.id, self.field_change))

        class Baseline(self.base, ParameterizedMixin):
            """Baselines to compare runs to."""
            __tablename__ = db_key_name + '_Baseline'
            __table_args__ = {'mysql_collate': 'utf8_bin'}

            id = Column("ID", Integer, primary_key=True)
            name = Column("Name", String(32), unique=True)
            comment = Column("Comment", String(256))
            order_id = Column("OrderID", Integer, ForeignKey(Order.id),
                              index=True)
            order = relation(Order)

            def __str__(self):
                return "Baseline({})".format(self.name)

        self.Machine = Machine
        self.Run = Run
        self.Test = Test
        self.Profile = Profile
        self.Sample = Sample
        self.Order = Order
        self.FieldChange = FieldChange
        self.Regression = Regression
        self.RegressionIndicator = RegressionIndicator
        self.ChangeIgnore = ChangeIgnore
        self.Baseline = Baseline

        # Create the compound index we cannot declare inline.
        sqlalchemy.schema.Index("ix_%s_Sample_RunID_TestID" % db_key_name,
                                Sample.run_id, Sample.test_id)

    def create_tables(self, engine):
        self.base.metadata.create_all(engine)

    def get_baselines(self, session):
        return session.query(self.Baseline).all()

    def get_users_baseline(self, session):
        try:
            baseline_key = lnt.server.ui.util.baseline_key(self.name)
            session_baseline = flask.session.get(baseline_key)
        except RuntimeError:
            # Sometimes this is called from outside the app context.
            # In that case, don't get the user's session baseline.
            return None
        if session_baseline:
            return session.query(self.Baseline).get(session_baseline)

        return None

    def _getIncompatibleFields(self, existing_machine, new_machine):
        incompatible_fields = set()
        for field in self.machine_fields:
            existing_value = existing_machine.get_field(field)
            new_value = new_machine.get_field(field)
            if new_value is None or existing_value == new_value:
                continue
            if existing_value is not None:
                incompatible_fields.add(field.name)
        existing_parameters = existing_machine.parameters
        for key, new_value in new_machine.parameters.items():
            existing_value = existing_parameters.get(key, None)
            if new_value is None or existing_value == new_value:
                continue
            if existing_value is not None:
                incompatible_fields.add(key)
        return incompatible_fields

    def _updateMachine(self, existing_machine, new_machine):
        for field in self.machine_fields:
            new_value = new_machine.get_field(field)
            if new_value is None:
                continue
            existing_machine.set_field(field, new_value)
        parameters = existing_machine.parameters
        for key, new_value in new_machine.parameters.items():
            if new_value is None and parameters.get(key, None) is not None:
                continue
            parameters[key] = new_value
        existing_machine.parameters = parameters

    def _getOrCreateMachine(self, session, machine_data, select_machine):
        """
        _getOrCreateMachine(data, select_machine) -> Machine

        Add or create (and insert) a Machine record from the given machine data
        (as recorded by the test interchange format).

        select_machine strategies:
        'match': Abort if the existing machine doesn't match the new machine
                 data.
        'update': Update the existing machine in cases where the new machine
                  data doesn't match the existing data.
        'split': On parameter mismatch create a new machine with a `$NN` suffix
                 added, or choose an existing compatible machine with such a
                 suffix.
        """
        assert select_machine == 'match' or select_machine == 'update' \
            or select_machine == 'split'

        # Convert the machine data into a machine record.
        machine_parameters = machine_data.copy()
        name = machine_parameters.pop('name')
        machine = self.Machine(name)
        machine_parameters.pop('id', None)
        for item in self.machine_fields:
            value = machine_parameters.pop(item.name, None)
            machine.set_field(item, value)
        machine.parameters = machine_parameters

        # Look for an existing machine.
        existing_machines = session.query(self.Machine) \
            .filter(self.Machine.name == name) \
            .order_by(self.Machine.id.desc()) \
            .all()
        # No existing machine? Add one.
        if len(existing_machines) == 0:
            session.add(machine)
            return machine
        # Search for a compatible machine.
        existing_machine = None
        incompatible_fields_0 = []
        for m in existing_machines:
            incompatible_fields = self._getIncompatibleFields(m, machine)
            if len(incompatible_fields) == 0:
                existing_machine = m
                break
            if len(incompatible_fields_0) == 0:
                incompatible_fields_0 = incompatible_fields
        # All existing machines are incompatible?
        if existing_machine is None:
            if select_machine == 'split':
                # Add a new machine.
                session.add(machine)
                return machine
            if select_machine == 'match':
                raise MachineInfoChanged("'%s' on machine '%s' changed." %
                                         (', '.join(incompatible_fields_0),
                                          name))
            else:
                assert select_machine == 'update'
                # Just pick the first and update it below.
                existing_machine = existing_machines[0]

        self._updateMachine(existing_machine, machine)
        return existing_machine

    def _getOrCreateOrder(self, session, run_parameters):
        """
        _getOrCreateOrder(data) -> Order

        Add or create (and insert) an Order record based on the given run
        parameters (as recorded by the test interchange format).

        The run parameters that define the order will be removed from the
        provided ddata argument.
        """

        query = session.query(self.Order)
        order = self.Order()

        # First, extract all of the specified order fields.
        for item in self.order_fields:
            value = run_parameters.pop(item.name, None)
            if value is None:
                # We require that all of the order fields be present.
                raise ValueError("Supplied run is missing parameter: %r" %
                                 (item.name))

            query = query.filter(item.column == value)
            order.set_field(item, value)

        # Execute the query to see if we already have this order.
        existing = query.first()
        if existing is not None:
            return existing

        # If not, then we need to insert this order into the total ordering
        # linked list.

        # Add the new order and commit, to assign an ID.
        session.add(order)
        session.commit()

        # Load all the orders.
        orders = list(session.query(self.Order))

        # Sort the objects to form the total ordering.
        orders.sort()

        # Find the order we just added.
        index = orders.index(order)

        # Insert this order into the linked list which forms the total
        # ordering.
        if index > 0:
            previous_order = orders[index - 1]
            previous_order.next_order_id = order.id
            order.previous_order_id = previous_order.id
        if index + 1 < len(orders):
            next_order = orders[index + 1]
            next_order.previous_order_id = order.id
            order.next_order_id = next_order.id

        return order

    def _getOrCreateRun(self, session, run_data, machine, merge):
        """
        _getOrCreateRun(session, run_data, machine, merge) -> Run, bool

        Add a new Run record from the given data (as recorded by the test
        interchange format).

        merge comes into play when there is already a run with the same order
        fields:
        - 'reject': Reject submission (raise ValueError).
        - 'replace': Remove the existing submission(s), then add the new one.
        - 'append': Add new submission.

        The boolean result indicates whether the returned record was
        constructed or not.
        """

        # Extra the run parameters that define the order.
        run_parameters = run_data.copy()
        # Ignore incoming ids; we will create our own
        run_parameters.pop('id', None)

        # Added by REST API, we will replace as well.
        run_parameters.pop('order_by', None)
        run_parameters.pop('order_id', None)
        run_parameters.pop('machine_id', None)
        run_parameters.pop('imported_from', None)
        run_parameters.pop('simple_run_id', None)

        # Find the order record.
        order = self._getOrCreateOrder(session, run_parameters)
        new_id = None

        if merge != 'append':
            existing_runs = session.query(self.Run) \
                .filter(self.Run.machine_id == machine.id) \
                .filter(self.Run.order_id == order.id) \
                .all()
            if len(existing_runs) > 0:
                if merge == 'reject':
                    raise ValueError("Duplicate submission for '%s'" %
                                     order.name)
                elif merge == 'replace':
                    for previous_run in existing_runs:
                        logger.info("Duplicate submission for order %r: "
                                    "deleting previous run %r" %
                                    (order, previous_run))

                        # Keep the latest ID so the URL is still valid on replace
                        new_id = previous_run.id

                        session.delete(previous_run)
                else:
                    raise ValueError('Invalid Run mergeStrategy %r' % merge)

        # We'd like ISO8061 timestamps, but will also accept the old format.
        try:
            start_time = aniso8601.parse_datetime(run_data['start_time'])
        except ValueError:
            start_time = datetime.datetime.strptime(run_data['start_time'],
                                                    "%Y-%m-%d %H:%M:%S")
        run_parameters.pop('start_time')

        try:
            end_time = aniso8601.parse_datetime(run_data['end_time'])
        except ValueError:
            end_time = datetime.datetime.strptime(run_data['end_time'],
                                                  "%Y-%m-%d %H:%M:%S")
        run_parameters.pop('end_time')

        run = self.Run(new_id, machine, order, start_time, end_time)

        # First, extract all of the specified run fields.
        for item in self.run_fields:
            value = run_parameters.pop(item.name, None)
            run.set_field(item, value)

        # Any remaining parameters are saved as a JSON encoded array.
        run.parameters = run_parameters
        session.add(run)
        return run

    def _importSampleValues(self, session, tests_data, run, config):
        # Load a map of all the tests, which we will extend when we find tests
        # that need to be added.
        # Downcast to str, so we match on MySQL.
        test_cache = dict((test.name, test)
                          for test in session.query(self.Test))

        profiles = dict()
        field_dict = dict([(f.name, f) for f in self.sample_fields])
        all_samples_to_add = []
        for test_data in tests_data:
            name = test_data['name']
            test = test_cache.get(name)
            if test is None:
                test = self.Test(test_data['name'])
                test_cache[name] = test
                session.add(test)

            samples = []
            for key, values in test_data.items():
                if key == 'name' or key == "id" or key.endswith("_id"):
                    continue
                field = field_dict.get(key)
                if field is None and key != 'profile':
                    raise ValueError("test %r: Metric %r unknown in suite " %
                                     (name, key))

                if not isinstance(values, list):
                    values = [values]
                while len(samples) < len(values):
                    sample = self.Sample(run, test)
                    samples.append(sample)
                    all_samples_to_add.append(sample)
                for sample, value in zip(samples, values):
                    if key == 'profile':
                        profile = self.Profile(value, config, name)
                        sample.profile = profiles.get(hash(value), profile)
                    else:
                        sample.set_field(field, value)
        session.add_all(all_samples_to_add)

    def importDataFromDict(self, session, data, config, select_machine,
                           merge_run):
        """
        importDataFromDict(session, data, config, select_machine, merge_run)
            -> Run  (or throws ValueError exception)

        Import a new run from the provided test interchange data, and return
        the constructed Run record. May throw ValueError exceptions in cases
        like mismatching machine data or duplicate run submission with
        merge_run == 'reject'.
        """
        machine = self._getOrCreateMachine(session, data['machine'],
                                           select_machine)
        run = self._getOrCreateRun(session, data['run'], machine, merge_run)
        self._importSampleValues(session, data['tests'], run, config)
        return run

    # Simple query support (mostly used by templates)

    def machines(self, session, name=None):
        q = session.query(self.Machine)
        if name:
            q = q.filter_by(name=name)
        return q

    def getMachine(self, session, id):
        return session.query(self.Machine).filter_by(id=id).one()

    def getRun(self, session, id):
        return session.query(self.Run).filter_by(id=id).one()

    def get_adjacent_runs_on_machine(self, session, run, N, direction=-1):
        """
        get_adjacent_runs_on_machine(run, N, direction=-1) -> [Run*]

        Return the N runs which have been submitted to the same machine and are
        adjacent to the given run.

        The actual number of runs returned may be greater than N in situations
        where multiple reports were received for the same order.

        The runs will be reported starting with the runs closest to the given
        run's order.

        The direction must be -1 or 1 and specified whether or not the
        preceeding or following runs should be returned.
        """
        assert N >= 0, "invalid count"
        assert direction in (-1, 1), "invalid direction"

        if N == 0:
            return []

        # The obvious algorithm here is to step through the run orders in the
        # appropriate direction and yield any runs on the same machine which
        # were reported at that order.
        #
        # However, this has one large problem. In some cases, the gap between
        # orders reported on that machine may be quite high. This will be
        # particularly true when a machine has stopped reporting for a while,
        # for example, as there may be large gap between the largest reported
        # order and the last order the machine reported at.
        #
        # In such cases, we could end up executing a large number of individual
        # SA object materializations in traversing the order list, which is
        # very bad.
        #
        # We currently solve this by instead finding all the orders reported on
        # this machine, ordering those programatically, and then iterating over
        # that. This performs worse (O(N) instead of O(1)) than the obvious
        # algorithm in the common case but more uniform and significantly
        # better in the worst cast, and I prefer that response times be
        # uniform. In practice, this appears to perform fine even for quite
        # large (~1GB, ~20k runs) databases.

        # Find all the orders on this machine, then sort them.
        #
        # FIXME: Scalability! However, pretty fast in practice, see elaborate
        # explanation above.
        all_machine_orders = session.query(self.Order).\
            join(self.Run).\
            filter(self.Run.machine == run.machine).distinct().all()
        all_machine_orders.sort()

        # Find the index of the current run.
        index = all_machine_orders.index(run.order)

        # Gather the next N orders.
        if direction == -1:
            orders_to_return = all_machine_orders[max(0, index - N):index]
        else:
            orders_to_return = all_machine_orders[index+1:index+N]

        # Get all the runs for those orders on this machine in a single query.
        ids_to_fetch = [o.id
                        for o in orders_to_return]
        if not ids_to_fetch:
            return []

        runs = session.query(self.Run).\
            filter(self.Run.machine == run.machine).\
            filter(self.Run.order_id.in_(ids_to_fetch)).all()

        # Sort the result by order, accounting for direction to satisfy our
        # requirement of returning the runs in adjacency order.
        #
        # Even though we already know the right order, this is faster than
        # issueing separate queries.
        runs.sort(key=lambda r: r.order, reverse=(direction == -1))

        return runs

    def get_previous_runs_on_machine(self, session, run, N):
        return self.get_adjacent_runs_on_machine(session, run, N, direction=-1)

    def get_next_runs_on_machine(self, session, run, N):
        return self.get_adjacent_runs_on_machine(session, run, N, direction=1)

    def __repr__(self):
        return "TestSuiteDB('%s')" % self.name

    def getNumMachines(self, session):
        return session.query(sqlalchemy.func.count(self.Machine.id)).scalar()

    def getNumRuns(self, session):
        return session.query(sqlalchemy.func.count(self.Run.id)).scalar()

    def getNumSamples(self, session):
        return session.query(sqlalchemy.func.count(self.Sample.id)).scalar()

    def getNumTests(self, session):
        return session.query(sqlalchemy.func.count(self.Test.id)).scalar()

    def get_field_index(self, sample_field):
        return self.sample_field_indexes[sample_field.name]
