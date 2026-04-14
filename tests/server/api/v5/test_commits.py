# Tests for the v5 commit endpoints.
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
    create_app, create_client, admin_headers, make_scoped_headers,
    create_commit, collect_all_pages,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


class TestCommitList(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/commits."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200(self):
        """GET /commits returns 200."""
        resp = self.client.get(PREFIX + '/commits')
        self.assertEqual(resp.status_code, 200)

    def test_list_has_pagination_envelope(self):
        """Response includes cursor pagination envelope."""
        resp = self.client.get(PREFIX + '/commits')
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_list_returns_commits(self):
        """Create a commit via DB and verify it appears in the list."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        rev = f'list-{uuid.uuid4().hex[:8]}'
        create_commit(session, ts, commit=rev)
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + '/commits')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        for item in data['items']:
            self.assertIn('commit', item)
            self.assertIn('ordinal', item)
            self.assertIn('fields', item)
            self.assertIsInstance(item['fields'], dict)

    def test_list_pagination(self):
        """Verify cursor pagination works."""
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        for i in range(3):
            create_commit(
                session, ts,
                commit=f'page-{uuid.uuid4().hex[:6]}-{i}')
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + '/commits?limit=1')
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        self.assertIsNotNone(data['cursor']['next'])

        cursor = data['cursor']['next']
        resp2 = self.client.get(
            PREFIX + f'/commits?limit=1&cursor={cursor}')
        self.assertEqual(resp2.status_code, 200)
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 1)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        resp = self.client.get(
            PREFIX + '/commits?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestCommitSearch(unittest.TestCase):
    """Tests for the search parameter on GET /commits."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_search_by_commit_prefix(self):
        """Search by commit string prefix."""
        unique = uuid.uuid4().hex[:8]
        prefix = f'srch-{unique}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        create_commit(session, ts, commit=f'{prefix}-aaa')
        create_commit(session, ts, commit=f'{prefix}-bbb')
        create_commit(session, ts, commit=f'other-{uuid.uuid4().hex[:8]}')
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + f'/commits?search={prefix}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 2)
        for item in data['items']:
            self.assertTrue(item['commit'].startswith(prefix))

    def test_search_no_match(self):
        """Search with no matches returns empty list."""
        resp = self.client.get(
            PREFIX + '/commits?search=nonexistent-prefix-xyz')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.get_json()['items']), 0)


class TestCommitCreate(unittest.TestCase):
    """Tests for POST /api/v5/{ts}/commits."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_create_commit(self):
        """Create a commit and verify 201 response."""
        rev = f'create-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['commit'], rev)
        self.assertIsNone(data['ordinal'])

    def test_create_commit_with_ordinal(self):
        """Create a commit with an explicit ordinal."""
        rev = f'ordinal-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': rev, 'ordinal': 42},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['ordinal'], 42)

    def test_create_commit_with_fields(self):
        """Create a commit with commit_fields metadata."""
        rev = f'fields-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': rev,
                  'llvm_project_revision': 'abc123'},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['fields']['llvm_project_revision'], 'abc123')

    def test_create_commit_includes_prev_next(self):
        """Created commit response includes prev/next references."""
        rev = f'prevnext-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('previous_commit', data)
        self.assertIn('next_commit', data)

    def test_create_commit_appears_in_list(self):
        """Newly created commit appears in the list."""
        rev = f'appear-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + '/commits')
        data = resp.get_json()
        commits = [item['commit'] for item in data['items']]
        self.assertIn(rev, commits)

    def test_create_duplicate_409(self):
        """Creating a commit with a duplicate string returns 409."""
        rev = f'dup-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)

    def test_create_missing_commit_400(self):
        """Creating without required commit field returns 400."""
        resp = self.client.post(
            PREFIX + '/commits',
            json={},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_create_no_body_400(self):
        """POST without body returns 400."""
        resp = self.client.post(
            PREFIX + '/commits',
            headers=admin_headers(),
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_create_no_auth_401(self):
        """Creating without auth should return 401."""
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': 'no-auth'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_create_read_scope_403(self):
        """Creating with read scope should return 403."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': 'read-only'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_submit_scope_ok(self):
        """Creating with submit scope should succeed."""
        headers = make_scoped_headers(self.app, 'submit')
        rev = f'submit-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)


class TestCommitDetail(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/commits/{value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_detail(self):
        """Get commit detail by commit string."""
        rev = f'detail-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        create_commit(session, ts, commit=rev)
        session.commit()
        session.close()

        resp = self.client.get(PREFIX + f'/commits/{rev}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['commit'], rev)
        self.assertIn('ordinal', data)
        self.assertIn('fields', data)
        self.assertIn('previous_commit', data)
        self.assertIn('next_commit', data)

    def test_get_nonexistent_404(self):
        """Getting a nonexistent commit should return 404."""
        resp = self.client.get(
            PREFIX + '/commits/nonexistent-commit-xyz')
        self.assertEqual(resp.status_code, 404)

    def test_detail_with_neighbors(self):
        """Verify prev/next references when neighbors exist."""
        rev1 = f'nbr1-{uuid.uuid4().hex[:8]}'
        rev2 = f'nbr2-{uuid.uuid4().hex[:8]}'
        rev3 = f'nbr3-{uuid.uuid4().hex[:8]}'
        # Create commits with ordinals
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev1, 'ordinal': 100},
            headers=admin_headers(),
        )
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev2, 'ordinal': 200},
            headers=admin_headers(),
        )
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev3, 'ordinal': 300},
            headers=admin_headers(),
        )

        # Middle commit should have both neighbors
        resp = self.client.get(PREFIX + f'/commits/{rev2}')
        data = resp.get_json()
        self.assertIsNotNone(data['previous_commit'])
        self.assertIsNotNone(data['next_commit'])
        self.assertEqual(data['previous_commit']['commit'], rev1)
        self.assertEqual(data['next_commit']['commit'], rev3)

    def test_detail_no_ordinal_no_neighbors(self):
        """Commits without ordinal have null neighbors."""
        rev = f'no-ord-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/commits/{rev}')
        data = resp.get_json()
        self.assertIsNone(data['previous_commit'])
        self.assertIsNone(data['next_commit'])


class TestCommitDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/commits/{value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present(self):
        """Commit detail response should include an ETag header."""
        rev = f'etag-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/commits/{rev}')
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.headers.get('ETag'))
        self.assertTrue(resp.headers['ETag'].startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        rev = f'etag304-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/commits/{rev}')
        etag = resp.headers['ETag']

        resp2 = self.client.get(
            PREFIX + f'/commits/{rev}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        rev = f'etag200-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/commits/{rev}',
            headers={'If-None-Match': 'W/"stale"'},
        )
        self.assertEqual(resp.status_code, 200)


class TestCommitUpdate(unittest.TestCase):
    """Tests for PATCH /api/v5/{ts}/commits/{value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_set_ordinal(self):
        """PATCH to set an ordinal on a commit."""
        rev = f'setord-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'ordinal': 9999},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['ordinal'], 9999)

    def test_clear_ordinal(self):
        """PATCH with ordinal=null clears the ordinal."""
        rev = f'clrord-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev, 'ordinal': 9998},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'ordinal': None},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.get_json()['ordinal'])

    def test_update_commit_field(self):
        """PATCH updates a commit field value."""
        rev = f'updfld-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'llvm_project_revision': 'updated123'},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            resp.get_json()['fields']['llvm_project_revision'],
            'updated123')

    def test_patch_nonexistent_404(self):
        """PATCH nonexistent commit returns 404."""
        resp = self.client.patch(
            PREFIX + '/commits/nonexistent-xyz',
            json={'ordinal': 1},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 404)

    def test_patch_no_auth_401(self):
        """PATCH without auth returns 401."""
        rev = f'noauth-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'ordinal': 1},
        )
        self.assertEqual(resp.status_code, 401)

    def test_patch_read_scope_403(self):
        """PATCH with read scope returns 403."""
        rev = f'readp-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'ordinal': 1},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)


class TestCommitDelete(unittest.TestCase):
    """Tests for DELETE /api/v5/{ts}/commits/{value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_delete_commit(self):
        """Delete a commit and verify it's gone."""
        rev = f'delc-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.delete(
            PREFIX + f'/commits/{rev}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 204)

        resp = self.client.get(PREFIX + f'/commits/{rev}')
        self.assertEqual(resp.status_code, 404)

    def test_delete_nonexistent_404(self):
        """Deleting a nonexistent commit should return 404."""
        resp = self.client.delete(
            PREFIX + '/commits/nonexistent-del-xyz',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 404)

    def test_delete_with_fieldchange_409(self):
        """Delete a commit referenced by a FieldChange returns 409."""
        from v5_test_helpers import (
            create_machine, create_test, create_fieldchange,
        )
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        c1 = create_commit(session, ts,
                           commit=f'fc-start-{uuid.uuid4().hex[:8]}')
        c2 = create_commit(session, ts,
                           commit=f'fc-end-{uuid.uuid4().hex[:8]}')
        c1_commit = c1.commit  # save before closing session
        machine = create_machine(
            session, ts, name=f'fc-del-{uuid.uuid4().hex[:8]}')
        test = create_test(
            session, ts, name=f'fc-del/test/{uuid.uuid4().hex[:8]}')
        create_fieldchange(session, ts, c1, c2, machine, test,
                           'execution_time')
        session.commit()
        session.close()

        resp = self.client.delete(
            PREFIX + f'/commits/{c1_commit}',
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)

    def test_delete_cascades_to_runs(self):
        """Deleting a commit cascades to its runs."""
        from v5_test_helpers import create_machine, create_run
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        c = create_commit(session, ts,
                          commit=f'casc-{uuid.uuid4().hex[:8]}')
        c_commit = c.commit  # save before closing session
        m = create_machine(
            session, ts, name=f'casc-m-{uuid.uuid4().hex[:8]}')
        run = create_run(session, ts, m, c)
        run_uuid = run.uuid
        session.commit()
        session.close()

        self.client.delete(
            PREFIX + f'/commits/{c_commit}',
            headers=admin_headers(),
        )

        # Run should be gone too
        resp = self.client.get(PREFIX + f'/runs/{run_uuid}')
        self.assertEqual(resp.status_code, 404)


class TestCommitPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /commits."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._commits = []
        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        for i in range(5):
            rev = f'pag-{uuid.uuid4().hex[:8]}-{i}'
            create_commit(session, ts, commit=rev)
            cls._commits.append(rev)
        session.commit()
        session.close()

    def _collect_all_pages(self):
        url = PREFIX + '/commits?limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all commits."""
        all_items = self._collect_all_pages()
        commits = [item['commit'] for item in all_items]
        for rev in self._commits:
            self.assertIn(rev, commits)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate commits across pages."""
        all_items = self._collect_all_pages()
        commits = [item['commit'] for item in all_items]
        self.assertEqual(len(commits), len(set(commits)))


class TestCommitUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_unknown_param_returns_400(self):
        """Unknown query param on list returns 400."""
        resp = self.client.get(PREFIX + '/commits?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_detail_unknown_param_returns_400(self):
        """Unknown query param on detail returns 400."""
        rev = f'unk-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/commits/{rev}?bogus=1')
        self.assertEqual(resp.status_code, 400)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
