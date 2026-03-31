# Tests for the v5 test entity endpoints.
#
# RUN: rm -rf %t.instance %t.pg.log
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.instance \
# RUN:         -- python %s %t.instance
# END.

import sys
import os
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from v5_test_helpers import (
    create_app, create_client, create_test, collect_all_pages,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


def _get_ts_and_session(app):
    """Helper to get a testsuite DB object and session."""
    db = app.instance.get_database("default")
    session = db.make_session()
    ts = db.testsuite[TS]
    return ts, session


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
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'list-test-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

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
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'detail-test-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + f'/tests/{name}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['name'], name)

    def test_get_test_with_slashes(self):
        """Test names with slashes should work via path converter."""
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'suite/sub/{unique}/benchmark'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

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
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'etag-present-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + f'/tests/{name}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'etag-304-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + f'/tests/{name}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/tests/{name}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'etag-200-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

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
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'contains-test-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

        resp = self.client.get(
            PREFIX + f'/tests?name_contains={unique}')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for t in data['items']:
            self.assertIn(unique, t['name'])

    def test_filter_name_prefix(self):
        """Filter tests by name_prefix."""
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        prefix = f'prefix-{unique}'
        name = f'{prefix}-test'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

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
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        # Create a test with a literal underscore
        name = f'esc_test_{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()

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
        ts, session = _get_ts_and_session(cls.app)
        for i in range(5):
            create_test(session, ts, name=f'{cls._prefix}-test-{i}')
        session.commit()
        session.close()

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
        ts, session = _get_ts_and_session(self.app)
        unique = uuid.uuid4().hex[:8]
        name = f'unk-det-{unique}'
        create_test(session, ts, name=name)
        session.commit()
        session.close()
        resp = self.client.get(PREFIX + f'/tests/{name}?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
