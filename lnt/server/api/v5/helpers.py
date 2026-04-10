"""Shared helper functions for v5 API endpoints."""

import datetime

from .errors import abort_with_error


def parse_datetime(value):
    """Parse an ISO datetime string. Returns a naive datetime or None.

    Two differences from ``datetime.fromisoformat``:

    1. Accepts ``Z`` as a timezone suffix (mapped to ``+00:00``).
    2. Always returns a **naive** datetime (tzinfo stripped) because
       the database stores naive UTC timestamps.
    """
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        # Strip timezone info for naive comparison (DB stores naive datetimes)
        if dt.tzinfo is not None:
            dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
        return dt
    except (ValueError, TypeError):
        return None


def escape_like(pattern):
    """Escape SQL LIKE wildcards in user-supplied patterns."""
    return pattern.replace('\\', '\\\\').replace('%', r'\%').replace('_', r'\_')


def validate_tag(tag):
    """Validate and normalize a tag value.

    Returns the normalized tag (None for empty strings) or aborts with
    400 if the value is invalid.
    """
    if tag is not None and (not isinstance(tag, str) or len(tag) > 64):
        abort_with_error(400, "'tag' must be a string of at most 64 characters")
    return tag or None


def resolve_metric(ts, field_name):
    """Resolve a metric name to its SampleField object.

    Searches the test suite's cached ``sample_fields`` list for a field
    whose name matches *field_name*. Returns the :class:`SampleField` on
    success, or aborts with a 400 error if no match is found.
    """
    for sf in ts.sample_fields:
        if sf.name == field_name:
            return sf
    abort_with_error(400, "Unknown metric name '%s'" % field_name)


# ---------------------------------------------------------------------------
# Entity lookup helpers (abort with 404 if not found)
# ---------------------------------------------------------------------------

def lookup_machine(session, ts, machine_name):
    """Look up a machine by name.

    Returns the machine, or aborts with 404 if not found, or 409 if
    multiple machines share the same name.
    """
    machines = session.query(ts.Machine).filter(
        ts.Machine.name == machine_name
    ).all()
    if len(machines) == 0:
        abort_with_error(404, "Machine '%s' not found" % machine_name)
    if len(machines) > 1:
        ids = ', '.join(str(m.id) for m in machines)
        abort_with_error(
            409,
            "Multiple machines named '%s' exist (IDs: %s). "
            "Use the v4 UI to merge or rename them." % (machine_name, ids))
    return machines[0]


def lookup_run_by_uuid(session, ts, run_uuid):
    """Look up a Run by UUID. Aborts with 404 if not found."""
    run = session.query(ts.Run).filter(
        ts.Run.uuid == run_uuid
    ).first()
    if run is None:
        abort_with_error(404, "Run '%s' not found" % run_uuid)
    return run


def lookup_fieldchange(session, ts, fc_uuid):
    """Look up a FieldChange by UUID. Aborts with 404 if not found."""
    fc = session.query(ts.FieldChange).filter(
        ts.FieldChange.uuid == fc_uuid
    ).first()
    if fc is None:
        abort_with_error(404, "Field change '%s' not found" % fc_uuid)
    return fc


def lookup_test(session, ts, test_name):
    """Look up a Test by name. Aborts with 404 if not found."""
    test = session.query(ts.Test).filter(
        ts.Test.name == test_name
    ).first()
    if test is None:
        abort_with_error(404, "Test '%s' not found" % test_name)
    return test


def lookup_regression(session, ts, regression_uuid):
    """Look up a Regression by UUID. Aborts with 404 if not found."""
    regression = session.query(ts.Regression).filter(
        ts.Regression.uuid == regression_uuid
    ).first()
    if regression is None:
        abort_with_error(404, "Regression '%s' not found" % regression_uuid)
    return regression


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def serialize_order(order):
    """Convert an Order model to a dict of field names to string values."""
    order_dict = {}
    if order:
        for field in order.fields:
            val = order.get_field(field)
            if val is not None:
                order_dict[field.name] = str(val)
    return order_dict


def serialize_run(run, ts):
    """Serialize a Run model instance for API responses.

    Returns a dict with uuid, machine, order, start_time, end_time,
    and parameters.  Used by both the runs and machines endpoints.
    """
    order_dict = serialize_order(run.order)

    start_time = None
    if run.start_time:
        start_time = run.start_time.isoformat()
    end_time = None
    if run.end_time:
        end_time = run.end_time.isoformat()

    # Machine name
    machine_name = None
    if run.machine:
        machine_name = run.machine.name

    # Run parameters
    parameters = {}
    try:
        params = run.parameters
        if params:
            for k, v in params.items():
                parameters[k] = str(v)
    except (TypeError, ValueError):
        pass

    return {
        'uuid': run.uuid,
        'machine': machine_name,
        'order': order_dict,
        'start_time': start_time,
        'end_time': end_time,
        'parameters': parameters,
    }


def serialize_fieldchange(fc):
    """Serialize the common fields of a FieldChange for API responses.

    Returns a dict with test, machine, metric, old_value, new_value,
    start_order, end_order, and run_uuid.  Callers should add an
    identifier key (``uuid`` or ``field_change_uuid``) to the result
    before returning it to the client.
    """
    # Get field name from the SampleField relation
    field_name = None
    if fc.field is not None:
        field_name = fc.field.name

    # Get order field values
    start_order_val = None
    if fc.start_order is not None:
        for field in fc.start_order.fields:
            val = fc.start_order.get_field(field)
            if val is not None:
                start_order_val = str(val)
                break

    end_order_val = None
    if fc.end_order is not None:
        for field in fc.end_order.fields:
            val = fc.end_order.get_field(field)
            if val is not None:
                end_order_val = str(val)
                break

    # Get run UUID
    run_uuid = None
    if fc.run is not None:
        run_uuid = fc.run.uuid

    return {
        'test': fc.test.name if fc.test else None,
        'machine': fc.machine.name if fc.machine else None,
        'metric': field_name,
        'old_value': fc.old_value,
        'new_value': fc.new_value,
        'start_order': start_order_val,
        'end_order': end_order_val,
        'run_uuid': run_uuid,
    }
