"""Shared helpers for v5 API tests.

Provides:
- ``create_app`` -- Create a Flask app from an instance path
- ``create_client`` -- Return a Flask test client
- Auth helpers for creating API keys and headers
- Data creation helpers using V5TestSuiteDB methods
- API-based fixture helpers (submit_run, submit_regression, etc.)
"""

import datetime
import hashlib
import uuid

import lnt.server.ui.app
from lnt.server.db.v5.models import utcnow


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
        created_at=utcnow(),
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
        submitted_at = datetime.datetime(2024, 1, 1, 12, 0, 0,
                                         tzinfo=datetime.timezone.utc)
    return ts.create_run(session, machine, commit=commit,
                         submitted_at=submitted_at)


def create_test(session, ts, name='test.suite/benchmark'):
    """Create a Test via V5TestSuiteDB and return the ORM object."""
    ts.get_or_create_tests(session, [name])
    return session.query(ts.Test).filter(ts.Test.name == name).one()


def create_sample(session, ts, run, test, **field_values):
    """Create a Sample via V5TestSuiteDB and return the ORM object."""
    ts.create_samples(session, run, [{'test_id': test.id, **field_values}])
    return (
        session.query(ts.Sample)
        .filter(ts.Sample.run_id == run.id, ts.Sample.test_id == test.id)
        .order_by(ts.Sample.id.desc())
        .first()
    )


def create_regression(session, ts, title='Test Regression',
                      state=0, indicators=None, commit=None,
                      notes=None, bug=None):
    """Create a Regression (optionally with indicators) and return it.

    *indicators* is a list of dicts with keys machine_id, test_id, metric.
    """
    indicator_list = indicators or []
    return ts.create_regression(
        session, title, indicator_list,
        state=state, commit=commit, notes=notes, bug=bug)


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

def set_ordinal(client, commit, ordinal, testsuite='nts'):
    """Assign an ordinal to a commit via PATCH /commits/{value}."""
    resp = client.patch(
        f'/api/v5/{testsuite}/commits/{commit}',
        json={'ordinal': ordinal},
        headers=admin_headers(),
    )
    assert resp.status_code == 200, \
        "set_ordinal(%s, %d) failed: %s" % (commit, ordinal, resp.data)


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


def submit_regression(client, indicators=None, state='active',
                      title=None, commit=None, notes=None, bug=None,
                      testsuite='nts'):
    """Create a regression via POST and return response JSON.

    *indicators* is a list of {machine, test, metric} dicts.
    """
    body = {'state': state}
    if indicators:
        body['indicators'] = indicators
    if title:
        body['title'] = title
    if commit:
        body['commit'] = commit
    if notes:
        body['notes'] = notes
    if bug:
        body['bug'] = bug
    resp = client.post(f'/api/v5/{testsuite}/regressions',
                       json=body, headers=admin_headers())
    assert resp.status_code == 201, (
        f"Regression creation failed: {resp.get_json()}")
    return resp.get_json()


def submit_indicator_add(client, regression_uuid, indicators,
                         testsuite='nts'):
    """Add indicators to a regression via POST and return response JSON."""
    resp = client.post(
        f'/api/v5/{testsuite}/regressions/{regression_uuid}/indicators',
        json={'indicators': indicators},
        headers=admin_headers())
    assert resp.status_code == 200, (
        f"Indicator add failed: {resp.get_json()}")
    return resp.get_json()


def submit_indicator_remove(client, regression_uuid, indicator_uuids,
                            testsuite='nts'):
    """Remove indicators from a regression via DELETE and return response JSON."""
    resp = client.delete(
        f'/api/v5/{testsuite}/regressions/{regression_uuid}/indicators',
        json={'indicator_uuids': indicator_uuids},
        headers=admin_headers())
    assert resp.status_code == 200, (
        f"Indicator remove failed: {resp.get_json()}")
    return resp.get_json()


def make_profile_base64():
    """Create a base64-encoded profile blob for use in test submissions.

    Returns a base64 string containing a valid profile with two functions
    ('main' with 2 instructions, 'helper' with 1 instruction) and two
    counters ('cycles', 'branch-misses').
    """
    import base64
    from lnt.testing.profile.profilev1impl import ProfileV1
    from lnt.testing.profile.profilev2impl import ProfileV2

    v1_data = {
        'disassembly-format': 'raw',
        'counters': {'cycles': 1000, 'branch-misses': 50},
        'functions': {
            'main': {
                'counters': {'cycles': 80.0, 'branch-misses': 10.0},
                'data': [
                    [{'cycles': 50.0, 'branch-misses': 5.0}, 0x1000,
                     'push rbp'],
                    [{'cycles': 30.0, 'branch-misses': 5.0}, 0x1004,
                     'mov rsp, rbp'],
                ],
            },
            'helper': {
                'counters': {'cycles': 20.0, 'branch-misses': 3.0},
                'data': [
                    [{'cycles': 20.0, 'branch-misses': 3.0}, 0x2000, 'ret'],
                ],
            },
        },
    }
    v1 = ProfileV1(v1_data)
    v2 = ProfileV2.upgrade(v1)
    return base64.b64encode(v2.serialize()).decode('ascii')
