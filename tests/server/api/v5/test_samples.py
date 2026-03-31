# Tests for the v5 sample endpoints.
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
    collect_all_pages,
)

TS = 'nts'
PREFIX = f'/api/v5/{TS}'

# Profile data in the ProfileV1 format
SAMPLE_PROFILE_DATA = {
    'counters': {'cycles': 12345.0, 'branch-misses': 200.0},
    'disassembly-format': 'raw',
    'functions': {
        'main': {
            'counters': {'cycles': 80.0},
            'data': [
                [0x1000, {'cycles': 50.0}, '\tadd r0, r0, r1'],
            ],
        },
    },
}


def _make_encoded_profile(profile_data=None):
    """Create a base64-encoded profile string suitable for the Profile
    constructor."""
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
    """Create a sample with an associated profile record on disk."""
    encoded = _make_encoded_profile()
    config = _MockConfig(profile_dir)
    profile_obj = ts.Profile(encoded, config, test.name)
    session.add(profile_obj)
    session.flush()

    sample = ts.Sample(run, test)
    sample.profile_id = profile_obj.id
    session.add(sample)
    session.flush()
    return sample


class TestRunSamples(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs/{uuid}/samples."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _setup_run_with_samples(self):
        """Create a run with several samples for testing."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']

        machine = create_machine(
            session, ts, f'sample-test-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'sample-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)

        test1 = create_test(
            session, ts, f'test.suite/bench1-{uuid.uuid4().hex[:8]}')
        test2 = create_test(
            session, ts, f'test.suite/bench2-{uuid.uuid4().hex[:8]}')

        create_sample(session, ts, run, test1)
        create_sample(session, ts, run, test2)

        session.commit()
        # Save values before closing session to avoid DetachedInstanceError
        run_uuid = run.uuid
        test1_name = test1.name
        test2_name = test2.name
        session.close()
        return run_uuid, test1_name, test2_name

    def test_list_samples_empty_run(self):
        """A run with no samples returns an empty list."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'empty-run-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'empty-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        session.commit()
        run_uuid = run.uuid
        session.close()

        resp = self.client.get(PREFIX + f'/runs/{run_uuid}/samples')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertEqual(len(data['items']), 0)

    def test_list_samples_with_data(self):
        """A run with samples returns them."""
        run_uuid, test1_name, test2_name = self._setup_run_with_samples()

        resp = self.client.get(PREFIX + f'/runs/{run_uuid}/samples')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertGreaterEqual(len(data['items']), 2)

        # Verify sample structure
        sample = data['items'][0]
        self.assertIn('test', sample)
        self.assertIn('has_profile', sample)
        self.assertIn('metrics', sample)
        self.assertIsInstance(sample['metrics'], dict)

    def test_list_samples_has_pagination(self):
        """Sample list has pagination envelope."""
        run_uuid, _, _ = self._setup_run_with_samples()
        resp = self.client.get(PREFIX + f'/runs/{run_uuid}/samples')
        data = resp.get_json()
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_list_samples_nonexistent_run(self):
        """404 for a nonexistent run UUID."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.get(PREFIX + f'/runs/{fake_uuid}/samples')
        self.assertEqual(resp.status_code, 404)

    def test_list_samples_has_profile_filter(self):
        """The has_profile=true filter returns only profiled samples."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']

        machine = create_machine(
            session, ts, f'profile-filter-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'pf-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)

        test_no_profile = create_test(
            session, ts,
            f'test.suite/no-profile-{uuid.uuid4().hex[:8]}')
        test_with_profile = create_test(
            session, ts,
            f'test.suite/with-profile-{uuid.uuid4().hex[:8]}')

        # Sample without profile
        create_sample(session, ts, run, test_no_profile)

        # Sample with profile
        profile_dir = self.app.old_config.profileDir
        _create_sample_with_profile(
            session, ts, run, test_with_profile, profile_dir)

        session.commit()
        run_uuid = run.uuid
        session.close()

        # Without filter: should return both
        resp = self.client.get(PREFIX + f'/runs/{run_uuid}/samples')
        self.assertEqual(resp.status_code, 200)
        all_items = resp.get_json()['items']
        self.assertGreaterEqual(len(all_items), 2)

        # With filter: should return only the one with profile
        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/samples?has_profile=true')
        self.assertEqual(resp.status_code, 200)
        profiled_items = resp.get_json()['items']
        self.assertGreaterEqual(len(profiled_items), 1)
        for item in profiled_items:
            self.assertTrue(item['has_profile'])

    def test_list_samples_has_profile_false_returns_all(self):
        """has_profile with a non-true value does not filter."""
        run_uuid, _, _ = self._setup_run_with_samples()
        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/samples?has_profile=false')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        run_uuid, _, _ = self._setup_run_with_samples()
        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/samples?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestRunTestSamples(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/runs/{uuid}/tests/{test_name}/samples."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _setup_run_with_samples(self):
        """Create a run with samples for testing."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']

        machine = create_machine(
            session, ts, f'test-sample-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'ts-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)

        test = create_test(
            session, ts, f'test.suite/specific-{uuid.uuid4().hex[:8]}')
        create_sample(session, ts, run, test)

        session.commit()
        run_uuid = run.uuid
        test_name = test.name
        session.close()
        return run_uuid, test_name

    def test_samples_for_specific_test(self):
        """Get samples for a specific test in a run."""
        run_uuid, test_name = self._setup_run_with_samples()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/samples')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertGreaterEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['test'], test_name)

    def test_samples_for_nonexistent_run(self):
        """404 for a nonexistent run UUID."""
        fake_uuid = str(uuid.uuid4())
        resp = self.client.get(
            PREFIX + f'/runs/{fake_uuid}/tests/some.test/samples')
        self.assertEqual(resp.status_code, 404)

    def test_samples_for_nonexistent_test(self):
        """404 for a nonexistent test name."""
        # Create a real run first
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'nonexist-test-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'ne-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        session.commit()
        run_uuid = run.uuid
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/no.such.test/samples')
        self.assertEqual(resp.status_code, 404)

    def test_samples_test_name_with_slashes(self):
        """Test names with slashes work (using path converter)."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']

        machine = create_machine(
            session, ts, f'slash-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'sl-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)

        # Test name with slashes
        test_name = f'test/suite/sub/bench-{uuid.uuid4().hex[:8]}'
        test = create_test(session, ts, test_name)
        create_sample(session, ts, run, test)

        session.commit()
        run_uuid = run.uuid
        session.close()

        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/samples')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['test'], test_name)

    def test_samples_returns_metrics(self):
        """Sample response includes metrics dict with field values."""
        run_uuid, test_name = self._setup_run_with_samples()
        resp = self.client.get(
            PREFIX + f'/runs/{run_uuid}/tests/{test_name}/samples')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertGreaterEqual(len(data['items']), 1)
        sample = data['items'][0]
        self.assertIn('metrics', sample)
        self.assertIsInstance(sample['metrics'], dict)


class TestSampleAuth(unittest.TestCase):
    """Auth tests for sample endpoints (all use @require_scope('read'))."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

        # Create a run with samples for testing
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'auth-sample-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'auth-sample-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        test = create_test(
            session, ts, f'test.suite/auth-bench-{uuid.uuid4().hex[:8]}')
        create_sample(session, ts, run, test)
        session.commit()
        cls._run_uuid = run.uuid
        cls._test_name = test.name
        session.close()

    def test_run_samples_no_auth_allowed(self):
        """Unauthenticated GET for run samples is allowed by default."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/samples')
        self.assertEqual(resp.status_code, 200)

    def test_run_samples_read_scope_allowed(self):
        """A valid read-scoped token works for run samples."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/samples',
            headers=headers)
        self.assertEqual(resp.status_code, 200)

    def test_test_samples_no_auth_allowed(self):
        """Unauthenticated GET for test-specific samples is allowed by default."""
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/samples')
        self.assertEqual(resp.status_code, 200)

    def test_test_samples_read_scope_allowed(self):
        """A valid read-scoped token works for test-specific samples."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/samples',
            headers=headers)
        self.assertEqual(resp.status_code, 200)


class TestSamplePagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/runs/{uuid}/samples."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'pag-sample-m-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'pag-sample-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        for i in range(5):
            test = create_test(
                session, ts,
                f'pag-sample/test-{uuid.uuid4().hex[:8]}-{i}')
            create_sample(session, ts, run, test)
        session.commit()
        cls._run_uuid = run.uuid
        session.close()

    def _collect_all_pages(self):
        url = PREFIX + f'/runs/{self._run_uuid}/samples?limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all 5 samples."""
        all_items = self._collect_all_pages()
        self.assertEqual(len(all_items), 5)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate test names across pages."""
        all_items = self._collect_all_pages()
        names = [item['test'] for item in all_items]
        self.assertEqual(len(names), len(set(names)))


class TestSampleUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite['nts']
        machine = create_machine(
            session, ts, f'unk-sample-machine-{uuid.uuid4().hex[:8]}')
        order = create_order(
            session, ts, revision=f'unk-sample-rev-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, machine, order)
        test = create_test(
            session, ts, f'test.suite/unk-bench-{uuid.uuid4().hex[:8]}')
        create_sample(session, ts, run, test)
        session.commit()
        cls._run_uuid = run.uuid
        cls._test_name = test.name
        session.close()

    def test_run_samples_unknown_param_returns_400(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/samples?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_test_samples_unknown_param_returns_400(self):
        resp = self.client.get(
            PREFIX + f'/runs/{self._run_uuid}/tests/{self._test_name}/samples?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
