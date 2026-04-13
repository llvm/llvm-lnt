"""Shared helpers for v5 API tests.

Provides:
- ``create_app`` -- Create a Flask app from an instance path
- ``create_client`` -- Return a Flask test client
- Auth helpers for creating API keys and headers
- API-based fixture helpers (submit_run, submit_fieldchange, etc.)
- Legacy DB helpers (create_machine, etc.) for tests that need direct
  DB access (e.g. profile tests, duplicate-name edge cases)
"""

import datetime
import uuid

import lnt.server.ui.app


# ---------------------------------------------------------------------------
# Application & client helpers
# ---------------------------------------------------------------------------

def create_app(instance_path):
    """Create a Flask app backed by the given LNT instance."""
    app = lnt.server.ui.app.App.create_standalone(instance_path)
    app.testing = True
    return app


def create_client(app):
    """Return a Flask test client for *app*."""
    return app.test_client()


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def admin_headers():
    """Auth headers using the bootstrap api_auth_token (admin scope)."""
    return {'Authorization': 'Bearer test_token'}


def make_scoped_headers(app, scope_name):
    """Create an API key via the admin endpoint and return Bearer headers."""
    client = app.test_client()
    resp = client.post(
        '/api/v5/admin/api-keys',
        json={'name': f'test-{scope_name}', 'scope': scope_name},
        headers=admin_headers(),
    )
    assert resp.status_code == 201, (
        f"API key creation failed: {resp.get_json()}")
    data = resp.get_json()
    return {'Authorization': f'Bearer {data["key"]}'}


# ---------------------------------------------------------------------------
# Legacy DB helpers (kept for test_samples.py, test_profiles.py, and
# TestDuplicateMachineNames which require direct DB access)
# ---------------------------------------------------------------------------

def create_machine(session, ts, name='test-machine', **info_fields):
    """Create a Machine and return it."""
    machine = ts.Machine(name)
    declared = {f.name for f in ts.machine_fields}
    params = {}
    for key, value in info_fields.items():
        if key in declared:
            setattr(machine, key, value)
        else:
            params[key] = value
    if params:
        machine.parameters = params
    session.add(machine)
    session.flush()
    return machine


def create_order(session, ts, revision='1'):
    """Create an Order and return it."""
    order = ts.Order()
    order.set_field(ts.order_fields[0], revision)
    session.add(order)
    session.flush()
    return order


def create_run(session, ts, machine, order,
               start_time=None, end_time=None):
    """Create a Run and return it."""
    if start_time is None:
        start_time = datetime.datetime(2024, 1, 1, 12, 0, 0)
    if end_time is None:
        end_time = datetime.datetime(2024, 1, 1, 12, 30, 0)
    run = ts.Run(None, machine, order, start_time, end_time)
    run.uuid = str(uuid.uuid4())
    run.parameters = {}
    session.add(run)
    session.flush()
    return run


def create_test(session, ts, name='test.suite/benchmark'):
    """Create a Test and return it."""
    test = ts.Test(name)
    session.add(test)
    session.flush()
    return test


def create_sample(session, ts, run, test, **field_values):
    """Create a Sample and return it."""
    sample = ts.Sample(run, test, **field_values)
    session.add(sample)
    session.flush()
    return sample


def create_fieldchange(session, ts, start_order, end_order, machine, test,
                       field, old_value=1.0, new_value=2.0, run=None):
    """Create a FieldChange and return it."""
    fc = ts.FieldChange(start_order=start_order, end_order=end_order,
                        machine=machine, test=test, field_id=field.id)
    fc.uuid = str(uuid.uuid4())
    fc.old_value = old_value
    fc.new_value = new_value
    if run:
        fc.run = run
    session.add(fc)
    session.flush()
    return fc


def create_regression(session, ts, title='Test Regression',
                      state=0, field_changes=None):
    """Create a Regression (optionally with indicators) and return it."""
    regression = ts.Regression(title, '', state)
    regression.uuid = str(uuid.uuid4())
    session.add(regression)
    session.flush()

    if field_changes:
        for fc in field_changes:
            ri = ts.RegressionIndicator(regression, fc)
            session.add(ri)
        session.flush()

    return regression


# ---------------------------------------------------------------------------
# Pagination helpers
# ---------------------------------------------------------------------------

def collect_all_pages(test_case, client, url, page_limit=20):
    """Traverse all pages of a cursor-paginated endpoint.

    Returns a list of all items collected across every page. Fails the
    *test_case* if more than *page_limit* pages are fetched (infinite-loop
    guard).
    """
    all_items = []
    resp = client.get(url)
    test_case.assertEqual(resp.status_code, 200)
    data = resp.get_json()
    all_items.extend(data['items'])
    cursor = data['cursor']['next']
    pages = 1
    while cursor:
        resp = client.get(url + f'&cursor={cursor}')
        test_case.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        all_items.extend(data['items'])
        cursor = data['cursor']['next']
        pages += 1
        if pages > page_limit:
            test_case.fail("Too many pages; possible infinite loop")
    return all_items


# ---------------------------------------------------------------------------
# API-based fixture helpers
# ---------------------------------------------------------------------------

def submit_run(client, machine_name, revision, tests,
               start_time='2024-06-15T10:00:00',
               end_time='2024-06-15T10:30:00',
               machine_info=None, testsuite='nts'):
    """Submit a run via POST and return response JSON (includes run_uuid)."""
    machine = {'name': machine_name}
    if machine_info:
        machine.update(machine_info)
    payload = {
        'format_version': '2',
        'machine': machine,
        'run': {
            'start_time': start_time,
            'end_time': end_time,
            'llvm_project_revision': revision,
        },
        'tests': tests,
    }
    resp = client.post(f'/api/v5/{testsuite}/runs', json=payload,
                       headers=admin_headers())
    assert resp.status_code == 201, (
        f"Run submission failed: {resp.get_json()}")
    return resp.get_json()


def submit_fieldchange(client, app, machine, test, metric,
                       start_rev, end_rev,
                       old_value=10.0, new_value=20.0,
                       testsuite='nts'):
    """Create a field change via POST and return response JSON."""
    body = {
        'machine': machine, 'test': test, 'metric': metric,
        'old_value': old_value, 'new_value': new_value,
        'start_order': start_rev, 'end_order': end_rev,
    }
    resp = client.post(f'/api/v5/{testsuite}/field-changes',
                       json=body, headers=admin_headers())
    assert resp.status_code == 201, (
        f"FC creation failed: {resp.get_json()}")
    return resp.get_json()


def submit_regression(client, app, fc_uuids, state='active',
                      testsuite='nts'):
    """Create a regression via POST and return response JSON."""
    body = {'field_change_uuids': fc_uuids, 'state': state}
    resp = client.post(f'/api/v5/{testsuite}/regressions',
                       json=body, headers=admin_headers())
    assert resp.status_code == 201, (
        f"Regression creation failed: {resp.get_json()}")
    return resp.get_json()
