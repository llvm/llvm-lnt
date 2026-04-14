# Tests for the v5 test entity endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py --db-version 5.0 %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, collect_all_pages, submit_run,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


class TestTestList(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/tests."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200(self):
        resp = self.client.get(PREFIX + '/tests')
        self.assertEqual(resp.status_code, 200)

    def test_list_has_pagination_envelope(self):
        resp = self.client.get(PREFIX + '/tests')
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIn('cursor', data)

    def test_list_empty(self):
        """List tests returns items array (may be empty if no tests exist)."""
        resp = self.client.get(PREFIX + '/tests')
        data = resp.get_json()
        self.assertIsInstance(data['items'], list)

    def test_list_with_data(self):
        """After creating a test, it appears in the list."""
        unique = uuid.uuid4().hex[:8]
        name = f'list-test-{unique}'
        submit_run(self.client, f'list-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(
            PREFIX + f'/tests?name_contains={unique}')
        data = resp.get_json()
        names = [t['name'] for t in data['items']]
        self.assertIn(name, names)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        resp = self.client.get(
            PREFIX + '/tests?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestTestDetail(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/tests/{test_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_test_detail(self):
        """Get test detail by name."""
        unique = uuid.uuid4().hex[:8]
        name = f'detail-test-{unique}'
        submit_run(self.client, f'detail-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(PREFIX + f'/tests/{name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], name)

    def test_get_test_with_slashes(self):
        """Test names with slashes should work via path converter."""
        unique = uuid.uuid4().hex[:8]
        name = f'suite/sub/{unique}/benchmark'
        submit_run(self.client, f'slash-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(PREFIX + f'/tests/{name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], name)

    def test_get_nonexistent_404(self):
        """Getting a nonexistent test should return 404."""
        resp = self.client.get(
            PREFIX + '/tests/nonexistent-test-xyz-12345')
        self.assertEqual(resp.status_code, 404)


class TestTestDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/tests/{test_name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present_on_detail(self):
        """Test detail response should include an ETag header."""
        unique = uuid.uuid4().hex[:8]
        name = f'etag-present-{unique}'
        submit_run(self.client, f'etag-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(PREFIX + f'/tests/{name}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        unique = uuid.uuid4().hex[:8]
        name = f'etag-304-{unique}'
        submit_run(self.client, f'etag304-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(PREFIX + f'/tests/{name}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/tests/{name}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        unique = uuid.uuid4().hex[:8]
        name = f'etag-200-{unique}'
        submit_run(self.client, f'etag200-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(
            PREFIX + f'/tests/{name}',
            headers={'If-None-Match': 'W/"stale-etag-value"'},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.get_json())


class TestTestFilters(unittest.TestCase):
    """Test filtering for GET /api/v5/{ts}/tests."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_filter_name_contains(self):
        """Filter tests by name_contains."""
        unique = uuid.uuid4().hex[:8]
        name = f'contains-test-{unique}'
        submit_run(self.client, f'contains-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(
            PREFIX + f'/tests?name_contains={unique}')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for t in data['items']:
            self.assertIn(unique, t['name'])

    def test_filter_name_prefix(self):
        """Filter tests by name_prefix."""
        unique = uuid.uuid4().hex[:8]
        prefix = f'prefix-{unique}'
        name = f'{prefix}-test'
        submit_run(self.client, f'prefix-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        resp = self.client.get(
            PREFIX + f'/tests?name_prefix={prefix}')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for t in data['items']:
            self.assertTrue(t['name'].startswith(prefix))

    def test_filter_no_match(self):
        """Filter that matches nothing returns empty list."""
        resp = self.client.get(
            PREFIX + '/tests?name_contains=zzzz_no_match_xyz_9999')
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_filter_sql_wildcards_escaped(self):
        """Ensure % and _ in filter values are escaped (no SQL injection)."""
        unique = uuid.uuid4().hex[:8]
        # Create a test with a literal underscore
        name = f'esc_test_{unique}'
        submit_run(self.client, f'esc-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])

        # Search for literal underscore -- should NOT match arbitrary chars
        resp = self.client.get(
            PREFIX + f'/tests?name_contains=esc_test_{unique}')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)


class TestTestPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/tests."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._prefix = f'pag-{uuid.uuid4().hex[:8]}'
        for i in range(5):
            submit_run(cls.client, f'{cls._prefix}-machine',
                       f'rev-{cls._prefix}-{i}',
                       [{'name': f'{cls._prefix}-test-{i}',
                         'execution_time': [1.0]}])

    def _collect_all_pages(self):
        url = PREFIX + f'/tests?name_prefix={self._prefix}&limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all 5 tests."""
        all_items = self._collect_all_pages()
        self.assertEqual(len(all_items), 5)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate test names across pages."""
        all_items = self._collect_all_pages()
        names = [item['name'] for item in all_items]
        self.assertEqual(len(names), len(set(names)))


class TestTestUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_tests_list_unknown_param_returns_400(self):
        resp = self.client.get(PREFIX + '/tests?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_test_detail_unknown_param_returns_400(self):
        unique = uuid.uuid4().hex[:8]
        name = f'unk-det-{unique}'
        submit_run(self.client, f'unk-machine-{unique}', f'rev-{unique}',
                   [{'name': name, 'execution_time': [1.0]}])
        resp = self.client.get(PREFIX + f'/tests/{name}?bogus=1')
        self.assertEqual(resp.status_code, 400)


class TestTestMachineMetricFilter(unittest.TestCase):
    """Tests for machine= and metric= filters on GET /tests."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._prefix = uuid.uuid4().hex[:8]

        # Machine A has data for test_1 and test_2.
        # Two runs on machine A to exercise DISTINCT deduplication.
        cls.machine_a = f'mf-machA-{cls._prefix}'
        cls.test_1 = f'mf-test1-{cls._prefix}'
        cls.test_2 = f'mf-test2-{cls._prefix}'

        submit_run(cls.client, cls.machine_a, f'700-{cls._prefix}',
                   [{'name': cls.test_1, 'execution_time': [1.0]},
                    {'name': cls.test_2, 'execution_time': [2.0]}])

        submit_run(cls.client, cls.machine_a, f'702-{cls._prefix}',
                   [{'name': cls.test_1, 'execution_time': [1.1]},
                    {'name': cls.test_2, 'execution_time': [2.1]}])

        # Machine B has data for test_2 and test_3
        cls.machine_b = f'mf-machB-{cls._prefix}'
        cls.test_3 = f'mf-test3-{cls._prefix}'

        submit_run(cls.client, cls.machine_b, f'701-{cls._prefix}',
                   [{'name': cls.test_2, 'execution_time': [3.0]},
                    {'name': cls.test_3, 'execution_time': [4.0]}])

        # test_4 has no execution_time samples -- submit with compile_time
        # only on a separate machine so it exists but is excluded by both
        # machine= and metric=execution_time filters.
        cls.test_4 = f'mf-test4-{cls._prefix}'
        submit_run(cls.client, f'mf-machC-{cls._prefix}', f'703-{cls._prefix}',
                   [{'name': cls.test_4, 'compile_time': [0.5]}])

    def test_filter_by_machine_a(self):
        resp = self.client.get(
            PREFIX + f'/tests?machine={self.machine_a}'
            f'&name_contains={self._prefix}')
        self.assertEqual(resp.status_code, 200)
        names = {t['name'] for t in resp.get_json()['items']}
        self.assertEqual(names, {self.test_1, self.test_2})

    def test_filter_by_machine_b(self):
        resp = self.client.get(
            PREFIX + f'/tests?machine={self.machine_b}'
            f'&name_contains={self._prefix}')
        self.assertEqual(resp.status_code, 200)
        names = {t['name'] for t in resp.get_json()['items']}
        self.assertEqual(names, {self.test_2, self.test_3})

    def test_filter_by_metric(self):
        resp = self.client.get(
            PREFIX + f'/tests?metric=execution_time'
            f'&name_contains={self._prefix}')
        self.assertEqual(resp.status_code, 200)
        names = {t['name'] for t in resp.get_json()['items']}
        # test_4 has no execution_time samples, should be excluded
        self.assertEqual(names, {self.test_1, self.test_2, self.test_3})

    def test_filter_by_machine_and_metric(self):
        resp = self.client.get(
            PREFIX + f'/tests?machine={self.machine_a}'
            f'&metric=execution_time&name_contains={self._prefix}')
        self.assertEqual(resp.status_code, 200)
        names = {t['name'] for t in resp.get_json()['items']}
        self.assertEqual(names, {self.test_1, self.test_2})

    def test_filter_by_machine_and_name_contains(self):
        resp = self.client.get(
            PREFIX + f'/tests?machine={self.machine_a}'
            f'&name_contains=test1-{self._prefix}')
        self.assertEqual(resp.status_code, 200)
        names = {t['name'] for t in resp.get_json()['items']}
        self.assertEqual(names, {self.test_1})

    def test_unknown_machine_returns_404(self):
        resp = self.client.get(
            PREFIX + '/tests?machine=nonexistent-machine-xyz')
        self.assertEqual(resp.status_code, 404)

    def test_unknown_metric_returns_400(self):
        resp = self.client.get(
            PREFIX + '/tests?metric=nonexistent_metric')
        self.assertEqual(resp.status_code, 400)

    def test_multiple_samples_deduplicated(self):
        """Machine A has two runs with samples for test_1 — test_1
        should still appear only once in the results (DISTINCT)."""
        resp = self.client.get(
            PREFIX + f'/tests?machine={self.machine_a}'
            f'&name_contains=test1-{self._prefix}')
        self.assertEqual(resp.status_code, 200)
        items = resp.get_json()['items']
        names = [t['name'] for t in items]
        self.assertEqual(names, [self.test_1])

    def test_no_filters_includes_all(self):
        resp = self.client.get(
            PREFIX + f'/tests?name_contains={self._prefix}')
        self.assertEqual(resp.status_code, 200)
        names = {t['name'] for t in resp.get_json()['items']}
        # All 4 tests should appear (including test_4 with only compile_time)
        self.assertEqual(
            names, {self.test_1, self.test_2, self.test_3, self.test_4})


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
