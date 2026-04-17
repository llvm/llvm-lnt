"""Shared helper functions for v5 API endpoints."""

import datetime

from .errors import abort_with_error


def parse_datetime(value):
    """Parse an ISO datetime string. Returns a timezone-aware UTC datetime
    or None.

    Two differences from ``datetime.fromisoformat``:

    1. Accepts ``Z`` as a timezone suffix (mapped to ``+00:00``).
    2. Always returns a **timezone-aware UTC** datetime.  Bare datetime
       strings (no timezone suffix) are assumed to be UTC.
    """
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is not None:
            dt = dt.astimezone(datetime.timezone.utc)
        else:
            # Bare datetime assumed UTC
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def escape_like(pattern):
    """Escape SQL LIKE wildcards in user-supplied patterns."""
    return pattern.replace('\\', '\\\\').replace('%', r'\%').replace('_', r'\_')


def validate_metric_name(ts, field_name):
    """Validate that *field_name* is a known metric for this test suite.

    Aborts with 400 if the metric is not found.  Returns *field_name*
    unchanged on success.
    """
    if field_name not in ts._metric_names:
        abort_with_error(400, "Unknown metric name '%s'" % field_name)
    return field_name


def get_metric_def(ts, metric_name):
    """Validate *metric_name* and return its schema Metric definition.

    Aborts with 400 if the metric is not found.
    """
    validate_metric_name(ts, metric_name)
    for m in ts.schema.metrics:
        if m.name == metric_name:
            return m
    # Unreachable if validate_metric_name passed
    abort_with_error(400, "Unknown metric name '%s'" % metric_name)


# ---------------------------------------------------------------------------
# Entity lookup helpers (abort with 404 if not found)
# ---------------------------------------------------------------------------

def lookup_machine(session, ts, machine_name):
    """Look up a machine by name.  Aborts with 404 if not found."""
    machine = ts.get_machine(session, name=machine_name)
    if machine is None:
        abort_with_error(404, "Machine '%s' not found" % machine_name)
    return machine


def lookup_run_by_uuid(session, ts, run_uuid):
    """Look up a Run by UUID. Aborts with 404 if not found."""
    run = ts.get_run(session, uuid=run_uuid)
    if run is None:
        abort_with_error(404, "Run '%s' not found" % run_uuid)
    return run


def lookup_commit(session, ts, commit_id):
    """Look up a Commit by its identity string (e.g. git SHA).

    Aborts with 404 if not found.
    """
    commit_obj = ts.get_commit(session, commit=commit_id)
    if commit_obj is None:
        abort_with_error(404, "Commit '%s' not found" % commit_id)
    return commit_obj


def lookup_test(session, ts, test_name):
    """Look up a Test by name. Aborts with 404 if not found."""
    test = ts.get_test(session, name=test_name)
    if test is None:
        abort_with_error(404, "Test '%s' not found" % test_name)
    return test


def lookup_regression(session, ts, regression_uuid):
    """Look up a Regression by UUID. Aborts with 404 if not found."""
    regression = ts.get_regression(session, uuid=regression_uuid)
    if regression is None:
        abort_with_error(404, "Regression '%s' not found" % regression_uuid)
    return regression


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def format_utc(dt):
    """Format a UTC datetime as an ISO 8601 string with Z suffix.

    Returns None if *dt* is None.  Naive datetimes are assumed to be
    UTC and tagged accordingly.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def serialize_run(run, ts):
    """Serialize a Run model instance for API responses.

    Returns a dict with uuid, machine, commit, submitted_at,
    and run_parameters.
    """
    machine_name = run.machine.name if run.machine else None

    return {
        'uuid': run.uuid,
        'machine': machine_name,
        'commit': run.commit_obj.commit if run.commit_obj else None,
        'submitted_at': format_utc(run.submitted_at),
        'run_parameters': dict(run.run_parameters) if run.run_parameters else {},
    }
