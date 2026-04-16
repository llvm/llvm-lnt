# Tests for the v5 profile endpoints.
#
# TODO: Profiles are not tested right now because we haven't implemented them in v5 yet.
# RUN: true
# END.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import base64
import os
import pickle
import sys
import unittest
import uuid
import zlib

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, make_scoped_headers,
    create_machine, create_order, create_run, create_test, create_sample,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'

# Sample profile data in the ProfileV1 format
SAMPLE_PROFILE_DATA = {
    'counters': {'cycles': 12345.0, 'branch-misses': 200.0},
    'disassembly-format': 'raw',
    'functions': {
        'main': {
            'counters': {'cycles': 80.0, 'branch-misses': 10.0},
            'data': [
                [0x1000, {'cycles': 50.0}, '\tadd r0, r0, r1'],
                [0x1004, {'cycles': 30.0}, '\tmov r2, r3'],
            ],
        },
        'helper_func': {
            'counters': {'cycles': 20.0, 'branch-misses': 5.0},
            'data': [
                [0x2000, {'cycles': 20.0}, '\tret'],
            ],
        },
    },
}


def _make_encoded_profile(profile_data=None):
    """Create a base64-encoded profile string suitable for the Profile
    constructor.

    Returns a base64-encoded string of zlib-compressed pickled profile data.
    """
    if profile_data is None:
        profile_data = SAMPLE_PROFILE_DATA
    compressed = zlib.compress(pickle.dumps(profile_data))
    return base64.b64encode(compressed).decode('ascii')


class _MockConfig(object):
    """Mock config object for Profile.__init__.

    Profile.__init__ accesses config.config.profileDir.
    """
    def __init__(self, profile_dir):
        self.config = self
        self.profileDir = profile_dir


def _create_sample_with_profile(session, ts, run, test, profile_dir):
    """Create a sample with an associated profile record on disk.

    Returns the created sample.
    """
    encoded = _make_encoded_profile()
    config = _MockConfig(profile_dir)
    profile_obj = ts.Profile(encoded, config, test.name)
    session.add(profile_obj)
    session.flush()

    # Create Sample linked to this profile
    sample = ts.Sample(run, test)
    sample.profile_id = profile_obj.id
    session.add(sample)
    session.flush()
    return sample


def _setup_run_with_profile(app):
    """Create a run with a profiled sample. Returns (run_uuid, test_name)."""
    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite['nts']

    machine = create_machine(
        session, ts, f'profile-machine-{uuid.uuid4().hex[:8]}')
    order = create_order(
        session, ts, revision=f'prof-rev-{uuid.uuid4().hex[:8]}')
    run = create_run(session, ts, machine, order)
    test = create_test(
        session, ts, f'test.suite/profiled-{uuid.uuid4().hex[:8]}')

    profile_dir = app.old_config.profileDir
    _create_sample_with_profile(session, ts, run, test, profile_dir)

    session.commit()
    run_uuid = run.uuid
    test_name = test.name
    session.close()
    return run_uuid, test_name


class TestProfileMetadata(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs/{uuid}/tests/{test_name}/profile."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_profile_metadata(self):
        """Get profile metadata with top-level counters."""
        run_uuid, test_name = _setup_run_with_profile(self.app)

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['test'], test_name)
        self.assertIn('counters', data)
        self.assertIn('cycles', data['counters'])
        self.assertEqual(data['counters']['cycles'], 12345.0)

    def test_profile_nonexistent_run(self):
        """404 for a nonexistent run UUID."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.get(
            PREFIX + f'/runs/{fake_uuid}/tests/some.test/profile')
        self.assertEqual(resp.status_code, 404)

    def test_profile_nonexistent_test(self):
        """404 for a nonexistent test name."""
        # Create a real run
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'pne-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'pne-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        session.commit()
        run_uuid = run.uuid
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/no.such.test/profile')
        self.assertEqual(resp.status_code, 404)

    def test_profile_no_profile_data(self):
        """404 when the sample exists but has no profile."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'noprof-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'noprof-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        test = create_test(
            session, ts, f'test.suite/noprofile-{uuid.uuid4().hex[:8]}')
        create_sample(session, ts, run, test)
        session.commit()
        run_uuid = run.uuid
        test_name = test.name
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile')
        self.assertEqual(resp.status_code, 404)


class TestProfileFunctions(unittest.TestCase):
    """Tests for GET /runs/{uuid}/tests/{test_name}/profile/functions."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_function_list(self):
        """Get list of functions with counters."""
        run_uuid, test_name = _setup_run_with_profile(self.app)

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile/functions')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('functions', data)
        self.assertIsInstance(data['functions'], list)
        self.assertEqual(len(data['functions']), 2)

        fn_names = {f['name'] for f in data['functions']}
        self.assertIn('main', fn_names)
        self.assertIn('helper_func', fn_names)

        for fn in data['functions']:
            self.assertIn('counters', fn)
            self.assertIn('length', fn)
            self.assertIsInstance(fn['counters'], dict)

    def test_function_list_nonexistent_run(self):
        """404 for a nonexistent run UUID."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.get(
            PREFIX + f'/runs/{fake_uuid}/tests/some.test/profile/functions')
        self.assertEqual(resp.status_code, 404)

    def test_function_list_no_profile(self):
        """404 when sample has no profile."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'fnlist-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'fnlist-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        test = create_test(
            session, ts,
            f'test.suite/fnlist-noprof-{uuid.uuid4().hex[:8]}')
        create_sample(session, ts, run, test)
        session.commit()
        run_uuid = run.uuid
        test_name = test.name
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile/functions')
        self.assertEqual(resp.status_code, 404)


class TestProfileFunctionDetail(unittest.TestCase):
    """Tests for GET /.../profile/functions/{fn_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_function_detail(self):
        """Get disassembly for a specific function."""
        run_uuid, test_name = _setup_run_with_profile(self.app)

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile/functions/main')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], 'main')
        self.assertIn('counters', data)
        self.assertIn('disassembly_format', data)
        self.assertEqual(data['disassembly_format'], 'raw')
        self.assertIn('instructions', data)
        self.assertIsInstance(data['instructions'], list)
        self.assertEqual(len(data['instructions']), 2)

        inst = data['instructions'][0]
        self.assertIn('address', inst)
        self.assertIn('counters', inst)
        self.assertIn('text', inst)

    def test_function_detail_nonexistent_function(self):
        """404 for a function name not in the profile."""
        run_uuid, test_name = _setup_run_with_profile(self.app)

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile/functions/no_such_fn')
        self.assertEqual(resp.status_code, 404)

    def test_function_detail_nonexistent_run(self):
        """404 for a nonexistent run UUID."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.get(
            PREFIX + f'/runs/{fake_uuid}/tests/some.test/profile/functions/main')
        self.assertEqual(resp.status_code, 404)

    def test_function_detail_no_profile(self):
        """404 when sample has no profile."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'fndet-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'fndet-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        test = create_test(
            session, ts,
            f'test.suite/fndet-noprof-{uuid.uuid4().hex[:8]}')
        create_sample(session, ts, run, test)
        session.commit()
        run_uuid = run.uuid
        test_name = test.name
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/profile/functions/main')
        self.assertEqual(resp.status_code, 404)


class TestProfileAuth(unittest.TestCase):
    """Auth tests for profile endpoints (all use @require_scope('read'))."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._run_uuid, cls._test_name = _setup_run_with_profile(cls.app)

    def test_profile_metadata_no_auth_allowed(self):
        """Unauthenticated GET for profile metadata is allowed by default."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile')
        self.assertEqual(resp.status_code, 200)

    def test_profile_metadata_read_scope_allowed(self):
        """A valid read-scoped token works for profile metadata."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile',
            headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_profile_functions_no_auth_allowed(self):
        """Unauthenticated GET for profile functions is allowed by default."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile/functions')
        self.assertEqual(resp.status_code, 200)

    def test_profile_functions_read_scope_allowed(self):
        """A valid read-scoped token works for profile functions."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile/functions',
            headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_profile_function_detail_no_auth_allowed(self):
        """Unauthenticated GET for function detail is allowed by default."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile/functions/main')
        self.assertEqual(resp.status_code, 200)

    def test_profile_function_detail_read_scope_allowed(self):
        """A valid read-scoped token works for function detail."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile/functions/main',
            headers=headers)
        self.assertEqual(resp.status_code, 200)


class TestProfileUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._run_uuid, cls._test_name = _setup_run_with_profile(cls.app)

    def test_profile_metadata_unknown_param_returns_400(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_profile_functions_unknown_param_returns_400(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile/functions?bogus=1')
        self.assertEqual(resp.status_code, 400)

    def test_profile_function_detail_unknown_param_returns_400(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/profile/functions/main?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
