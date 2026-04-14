"""Shared helpers for v5 API tests.

Provides:
- ``create_app`` -- Create a Flask app from an instance path
- ``create_client`` -- Return a Flask test client
- Auth helpers for creating API keys and headers
- Data creation helpers using V5TestSuiteDB methods
- API-based fixture helpers (submit_run, submit_fieldchange, etc.)
"""

import datetime
import hashlib
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

def make_api_key(session, name, scope, raw_token):
    """Insert an APIKey row and return the Bearer header dict."""
    from lnt.server.api.v5.auth import APIKey
    key_hash = hashlib.sha256(raw_token.encode('utf-8')).hexdigest()
    api_key = APIKey(
        name=name,
        key_prefix=raw_token[:8],
        key_hash=key_hash,
        scope=scope,
        created_at=datetime.datetime.utcnow(),
        is_active=True,
    )
    session.add(api_key)
    session.commit()
    return {'Authorization': f'Bearer {raw_token}'}


def admin_headers():
    """Auth headers using the bootstrap api_auth_token (admin scope)."""
    return {'Authorization': 'Bearer test_token'}


def make_scoped_headers(app, scope_name):
    """Create an API key with the given scope and return Bearer headers."""
    db = app.instance.get_database("default")
    session = db.make_session()
    token = f'{scope_name}token_{uuid.uuid4().hex[:20]}'
    headers = make_api_key(session, f'test-{scope_name}', scope_name, token)
    session.close()
    return headers


# ---------------------------------------------------------------------------
# Data creation helpers -- use V5TestSuiteDB methods
# ---------------------------------------------------------------------------

def create_machine(session, ts, name='test-machine', **info_fields):
    """Create a Machine via V5TestSuiteDB and return it."""
    schema_fields = {k: v for k, v in info_fields.items()
                     if k in ts._machine_field_names}
    params = {k: v for k, v in info_fields.items()
              if k not in ts._machine_field_names}
    return ts.get_or_create_machine(
        session, name, parameters=params or None, **schema_fields)


def create_commit(session, ts, commit='rev-1', **metadata):
    """Create a Commit via V5TestSuiteDB and return it."""
    return ts.get_or_create_commit(session, commit, **metadata)


def create_run(session, ts, machine, commit,
               submitted_at=None):
    """Create a Run via V5TestSuiteDB and return it."""
    if submitted_at is None:
        submitted_at = datetime.datetime(2024, 1, 1, 12, 0, 0)
    return ts.create_run(session, machine, commit=commit,
                         submitted_at=submitted_at)


def create_test(session, ts, name='test.suite/benchmark'):
    """Create a Test via V5TestSuiteDB and return it."""
    return ts.get_or_create_test(session, name)


def create_sample(session, ts, run, test, **field_values):
    """Create a Sample via V5TestSuiteDB and return it."""
    samples = ts.create_samples(
        session, run, [{'test_id': test.id, **field_values}])
    return samples[0]


def create_fieldchange(session, ts, start_commit, end_commit, machine, test,
                       field_name, old_value=1.0, new_value=2.0):
    """Create a FieldChange via V5TestSuiteDB and return it."""
    return ts.create_field_change(
        session, machine, test, field_name,
        start_commit, end_commit, old_value, new_value)


def create_regression(session, ts, title='Test Regression',
                      state=0, field_changes=None):
    """Create a Regression (optionally with indicators) and return it."""
    fc_ids = [fc.id for fc in field_changes] if field_changes else []
    return ts.create_regression(session, title, fc_ids, state=state)


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

def submit_run(client, machine_name, commit, tests,
               machine_info=None, testsuite='nts'):
    """Submit a run via POST and return response JSON (includes run_uuid)."""
    machine = {'name': machine_name}
    if machine_info:
        machine.update(machine_info)
    payload = {
        'format_version': '5',
        'machine': machine,
        'commit': commit,
        'tests': tests,
    }
    resp = client.post(f'/api/v5/{testsuite}/runs', json=payload,
                       headers=admin_headers())
    assert resp.status_code == 201, (
        f"Run submission failed: {resp.get_json()}")
    return resp.get_json()


def submit_fieldchange(client, app, machine, test, metric,
                       start_commit, end_commit,
                       old_value=10.0, new_value=20.0,
                       testsuite='nts'):
    """Create a field change via POST and return response JSON."""
    body = {
        'machine': machine, 'test': test, 'metric': metric,
        'old_value': old_value, 'new_value': new_value,
        'start_commit': start_commit, 'end_commit': end_commit,
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
