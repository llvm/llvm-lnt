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
    create_commit, create_machine, create_run, collect_all_pages,
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

    def test_create_missing_commit_422(self):
        """Creating without required commit field returns 422."""
        resp = self.client.post(
            PREFIX + '/commits',
            json={},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 422)

    def test_create_no_body_422(self):
        """POST without body returns 422."""
        resp = self.client.post(
            PREFIX + '/commits',
            headers=admin_headers(),
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 422)

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

    def test_patch_triage_scope_403(self):
        """PATCH with triage scope (one below manage) returns 403."""
        rev = f'triagep-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'ordinal': 1},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_patch_manage_scope_200(self):
        """PATCH with manage scope (the required scope) succeeds."""
        rev = f'mngp-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.patch(
            PREFIX + f'/commits/{rev}',
            json={'ordinal': 1},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 200)


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

    def test_delete_with_regression_409(self):
        """Delete a commit referenced by a Regression returns 409."""
        from v5_test_helpers import create_machine, create_test
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        c = create_commit(session, ts,
                          commit=f'reg-ref-{uuid.uuid4().hex[:8]}')
        c_commit = c.commit
        m = create_machine(session, ts,
                           name=f'reg-del-{uuid.uuid4().hex[:8]}')
        t = create_test(session, ts,
                        name=f'reg-del/test/{uuid.uuid4().hex[:8]}')

        from v5_test_helpers import create_regression
        create_regression(
            session, ts,
            indicators=[{'machine_id': m.id, 'test_id': t.id,
                         'metric': 'execution_time'}],
            commit=c)
        session.commit()
        session.close()

        resp = self.client.delete(
            PREFIX + f'/commits/{c_commit}',
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

    def test_delete_no_auth_401(self):
        """DELETE without auth returns 401."""
        rev = f'delna-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        resp = self.client.delete(PREFIX + f'/commits/{rev}')
        self.assertEqual(resp.status_code, 401)

    def test_delete_triage_scope_403(self):
        """DELETE with triage scope (one below manage) returns 403."""
        rev = f'deltri-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'triage')
        resp = self.client.delete(
            PREFIX + f'/commits/{rev}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_delete_manage_scope_204(self):
        """DELETE with manage scope (the required scope) succeeds."""
        rev = f'delmng-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/commits',
            json={'commit': rev},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'manage')
        resp = self.client.delete(
            PREFIX + f'/commits/{rev}',
            headers=headers,
        )
        self.assertEqual(resp.status_code, 204)


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


class TestCommitMachineFilter(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/commits?machine={name}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

        db = cls.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]

        cls.m1_name = f'mf-m1-{uuid.uuid4().hex[:8]}'
        cls.m2_name = f'mf-m2-{uuid.uuid4().hex[:8]}'
        m1 = create_machine(session, ts, name=cls.m1_name)
        m2 = create_machine(session, ts, name=cls.m2_name)

        cls.c_both = f'mf-both-{uuid.uuid4().hex[:8]}'
        cls.c_m1_only = f'mf-m1only-{uuid.uuid4().hex[:8]}'
        cls.c_m2_only = f'mf-m2only-{uuid.uuid4().hex[:8]}'
        cls.c_no_runs = f'mf-noruns-{uuid.uuid4().hex[:8]}'

        c_both = create_commit(session, ts, commit=cls.c_both)
        c_m1 = create_commit(session, ts, commit=cls.c_m1_only)
        c_m2 = create_commit(session, ts, commit=cls.c_m2_only)
        create_commit(session, ts, commit=cls.c_no_runs)

        create_run(session, ts, m1, c_both)
        create_run(session, ts, m2, c_both)
        create_run(session, ts, m1, c_m1)
        create_run(session, ts, m2, c_m2)
        session.commit()
        session.close()

    def _get_commits(self, **params):
        qs = '&'.join(f'{k}={v}' for k, v in params.items())
        url = PREFIX + '/commits'
        if qs:
            url += '?' + qs
        items = collect_all_pages(self, self.client, url)
        return [item['commit'] for item in items]

    def test_filter_by_machine(self):
        """Only commits with runs on the specified machine are returned."""
        commits = self._get_commits(machine=self.m1_name)
        self.assertIn(self.c_both, commits)
        self.assertIn(self.c_m1_only, commits)
        self.assertNotIn(self.c_m2_only, commits)
        self.assertNotIn(self.c_no_runs, commits)

    def test_filter_by_other_machine(self):
        """Filtering by m2 returns m2's commits."""
        commits = self._get_commits(machine=self.m2_name)
        self.assertIn(self.c_both, commits)
        self.assertIn(self.c_m2_only, commits)
        self.assertNotIn(self.c_m1_only, commits)

    def test_unknown_machine_returns_404(self):
        """Filtering by a nonexistent machine returns 404."""
        resp = self.client.get(
            PREFIX + '/commits?machine=nonexistent-machine-xyz')
        self.assertEqual(resp.status_code, 404)

    def test_machine_combined_with_search(self):
        """machine= and search= filters combine (intersection)."""
        prefix = self.c_m1_only[:10]
        commits = self._get_commits(machine=self.m1_name, search=prefix)
        self.assertIn(self.c_m1_only, commits)
        self.assertNotIn(self.c_both, commits)


class TestCommitSortOrdinal(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/commits?sort=ordinal."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

        # Create commits with specific ordinals (non-contiguous, large to avoid
        # collisions with other test classes that also create ordinals).
        cls.c1 = f'so-c1-{uuid.uuid4().hex[:8]}'
        cls.c2 = f'so-c2-{uuid.uuid4().hex[:8]}'
        cls.c3 = f'so-c3-{uuid.uuid4().hex[:8]}'
        cls.c_no_ord = f'so-noord-{uuid.uuid4().hex[:8]}'

        cls.ord1 = 500010
        cls.ord2 = 500050
        cls.ord3 = 500100

        cls.client.post(PREFIX + '/commits',
                        json={'commit': cls.c1, 'ordinal': cls.ord1},
                        headers=admin_headers())
        cls.client.post(PREFIX + '/commits',
                        json={'commit': cls.c2, 'ordinal': cls.ord2},
                        headers=admin_headers())
        cls.client.post(PREFIX + '/commits',
                        json={'commit': cls.c3, 'ordinal': cls.ord3},
                        headers=admin_headers())
        cls.client.post(PREFIX + '/commits',
                        json={'commit': cls.c_no_ord},
                        headers=admin_headers())

    def test_sort_ordinal_order(self):
        """Commits are returned in ascending ordinal order."""
        url = PREFIX + '/commits?sort=ordinal'
        items = collect_all_pages(self, self.client, url)
        commits = [item['commit'] for item in items]
        idx1 = commits.index(self.c1)
        idx2 = commits.index(self.c2)
        idx3 = commits.index(self.c3)
        self.assertLess(idx1, idx2)
        self.assertLess(idx2, idx3)

    def test_sort_ordinal_excludes_null(self):
        """Commits without ordinals are excluded."""
        url = PREFIX + '/commits?sort=ordinal'
        items = collect_all_pages(self, self.client, url)
        commits = [item['commit'] for item in items]
        self.assertNotIn(self.c_no_ord, commits)

    def test_sort_ordinal_pagination(self):
        """Cursor pagination works with ordinal as cursor column."""
        resp = self.client.get(
            PREFIX + '/commits?sort=ordinal&limit=1')
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        first = data['items'][0]['ordinal']

        # Follow the cursor
        cursor = data['cursor']['next']
        self.assertIsNotNone(cursor)
        resp2 = self.client.get(
            PREFIX + f'/commits?sort=ordinal&limit=1&cursor={cursor}')
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 1)
        second = data2['items'][0]['ordinal']
        self.assertGreater(second, first)

    def test_invalid_sort_returns_422(self):
        """Invalid sort value returns 422 (schema validation)."""
        resp = self.client.get(PREFIX + '/commits?sort=bogus')
        self.assertEqual(resp.status_code, 422)

    def test_sort_ordinal_with_machine(self):
        """sort=ordinal combines with machine= filter."""
        # Create a machine with runs on c1 and c3 only
        m_name = f'so-m-{uuid.uuid4().hex[:8]}'
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        m = create_machine(session, ts, name=m_name)
        # Look up commits created in setUpClass (they exist in the DB)
        c1_obj = ts.get_commit(session, commit=self.c1)
        c3_obj = ts.get_commit(session, commit=self.c3)
        self.assertIsNotNone(c1_obj, "c1 should exist")
        self.assertIsNotNone(c3_obj, "c3 should exist")
        create_run(session, ts, m, c1_obj)
        create_run(session, ts, m, c3_obj)
        session.commit()
        session.close()

        url = PREFIX + f'/commits?sort=ordinal&machine={m_name}'
        items = collect_all_pages(self, self.client, url)
        commits = [item['commit'] for item in items]
        self.assertIn(self.c1, commits)
        self.assertIn(self.c3, commits)
        self.assertNotIn(self.c2, commits)
        self.assertNotIn(self.c_no_ord, commits)
        # Verify order
        self.assertLess(commits.index(self.c1), commits.index(self.c3))


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


class TestCommitResolve(unittest.TestCase):
    """Tests for POST /api/v5/{ts}/commits/resolve."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _create(self, commit, **kwargs):
        """Create a commit via the API and return the response."""
        body = {'commit': commit, **kwargs}
        return self.client.post(
            PREFIX + '/commits', json=body, headers=admin_headers())

    def _resolve(self, commits, headers=None):
        """POST to /commits/resolve and return the response."""
        kw = {'json': {'commits': commits}}
        if headers is not None:
            kw['headers'] = headers
        return self.client.post(PREFIX + '/commits/resolve', **kw)

    def test_resolve_basic(self):
        """Resolve two existing commits with correct fields and dict-keyed response."""
        rev1 = f'res-{uuid.uuid4().hex[:8]}'
        rev2 = f'res-{uuid.uuid4().hex[:8]}'
        self._create(rev1, llvm_project_revision='sha-aaa')
        self._create(rev2, llvm_project_revision='sha-bbb')

        resp = self._resolve([rev1, rev2])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('results', data)
        self.assertIn('not_found', data)
        self.assertEqual(len(data['results']), 2)
        self.assertEqual(len(data['not_found']), 0)

        # Verify dict keys are the commit strings
        self.assertIn(rev1, data['results'])
        self.assertIn(rev2, data['results'])

        # Verify each value has the CommitSummarySchema shape
        item1 = data['results'][rev1]
        self.assertEqual(item1['commit'], rev1)
        self.assertIn('ordinal', item1)
        self.assertIn('fields', item1)
        self.assertEqual(item1['fields']['llvm_project_revision'], 'sha-aaa')

        item2 = data['results'][rev2]
        self.assertEqual(item2['commit'], rev2)
        self.assertEqual(item2['fields']['llvm_project_revision'], 'sha-bbb')

    def test_resolve_not_found(self):
        """Mix of found and missing commits; missing in not_found."""
        rev = f'res-nf-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        missing = f'res-missing-{uuid.uuid4().hex[:8]}'

        resp = self._resolve([rev, missing])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['results']), 1)
        self.assertIn(rev, data['results'])
        self.assertEqual(data['not_found'], [missing])

    def test_resolve_all_not_found(self):
        """All missing -> empty results, populated not_found."""
        m1 = f'res-allnf-{uuid.uuid4().hex[:8]}'
        m2 = f'res-allnf-{uuid.uuid4().hex[:8]}'

        resp = self._resolve([m1, m2])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['results']), 0)
        self.assertEqual(set(data['not_found']), {m1, m2})

    def test_resolve_empty_list_422(self):
        """Empty commits array -> 422."""
        resp = self._resolve([])
        self.assertEqual(resp.status_code, 422)

    def test_resolve_missing_field_422(self):
        """No commits key in body -> 422."""
        resp = self.client.post(
            PREFIX + '/commits/resolve',
            json={},
        )
        self.assertEqual(resp.status_code, 422)

    def test_resolve_unknown_field_422(self):
        """Extra field in body -> 422 (BaseSchema raises on unknown)."""
        resp = self.client.post(
            PREFIX + '/commits/resolve',
            json={'commits': ['abc'], 'extra': 'bad'},
        )
        self.assertEqual(resp.status_code, 422)

    def test_resolve_null_in_commits_422(self):
        """null value in commits array -> 422."""
        resp = self.client.post(
            PREFIX + '/commits/resolve',
            json={'commits': ['valid', None]},
        )
        self.assertEqual(resp.status_code, 422)

    def test_resolve_includes_ordinal(self):
        """Ordinal value present in resolved commit."""
        rev = f'res-ord-{uuid.uuid4().hex[:8]}'
        self._create(rev, ordinal=12345)

        resp = self._resolve([rev])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['results'][rev]['ordinal'], 12345)

    def test_resolve_null_ordinal(self):
        """Commit with no ordinal returns ordinal: null."""
        rev = f'res-nullord-{uuid.uuid4().hex[:8]}'
        self._create(rev)

        resp = self._resolve([rev])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsNone(data['results'][rev]['ordinal'])

    def test_resolve_deduplicates(self):
        """Duplicate values in request -> single dict entry."""
        rev = f'res-dup-{uuid.uuid4().hex[:8]}'
        self._create(rev)

        resp = self._resolve([rev, rev, rev])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['results']), 1)
        self.assertIn(rev, data['results'])
        self.assertEqual(len(data['not_found']), 0)

    def test_resolve_large_batch(self):
        """A large batch (1000 items) succeeds."""
        # Create 1000 commits via direct DB access for speed.
        db = self.app.instance.get_database("default")
        session = db.make_session()
        ts = db.testsuite[TS]
        revs = [f'res-lim-{uuid.uuid4().hex[:8]}-{i}' for i in range(1000)]
        for rev in revs:
            create_commit(session, ts, commit=rev)
        session.commit()
        session.close()

        resp = self._resolve(revs)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['results']), 1000)
        self.assertEqual(len(data['not_found']), 0)

    def test_resolve_all_found_empty_not_found(self):
        """All found -> not_found is [] (not null/omitted)."""
        rev = f'res-af-{uuid.uuid4().hex[:8]}'
        self._create(rev)

        resp = self._resolve([rev])
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data['not_found'], [])
        self.assertIsInstance(data['not_found'], list)

    def test_resolve_unauthenticated_ok(self):
        """No auth header -> 200 (read scope allows unauthenticated)."""
        rev = f'res-noauth-{uuid.uuid4().hex[:8]}'
        self._create(rev)

        # No headers argument -> no Authorization header
        resp = self._resolve([rev])
        self.assertEqual(resp.status_code, 200)


class TestCommitTag(unittest.TestCase):
    """Tests for the built-in 'tag' column on Commit."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _create(self, commit, **kwargs):
        """Create a commit via POST and return the response."""
        body = {'commit': commit, **kwargs}
        return self.client.post(
            PREFIX + '/commits', json=body, headers=admin_headers())

    def _patch(self, commit, **kwargs):
        """PATCH a commit and return the response."""
        return self.client.patch(
            PREFIX + f'/commits/{commit}',
            json=kwargs, headers=admin_headers())

    def test_tag_null_on_creation(self):
        """POST /commits creates a commit with tag=null."""
        rev = f'tag-null-{uuid.uuid4().hex[:8]}'
        resp = self._create(rev)
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('tag', data)
        self.assertIsNone(data['tag'])

    def test_set_tag_via_patch(self):
        """PATCH sets the tag value."""
        rev = f'tag-set-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        resp = self._patch(rev, tag='release-18')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['tag'], 'release-18')

    def test_clear_tag_via_patch(self):
        """PATCH with tag=null clears the tag."""
        rev = f'tag-clr-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        self._patch(rev, tag='release-18')
        resp = self._patch(rev, tag=None)
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.get_json()['tag'])

    def test_tag_in_detail_response(self):
        """GET /commits/{value} includes the tag."""
        rev = f'tag-det-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        self._patch(rev, tag='v1.0')
        resp = self.client.get(PREFIX + f'/commits/{rev}')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['tag'], 'v1.0')

    def test_tag_in_list_response(self):
        """GET /commits items include the tag key."""
        rev = f'tag-lst-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        self._patch(rev, tag='list-tag')
        # Use search to find our specific commit in the paginated list.
        resp = self.client.get(PREFIX + f'/commits?search={rev}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        matching = [i for i in data['items'] if i['commit'] == rev]
        self.assertEqual(len(matching), 1)
        self.assertIn('tag', matching[0])
        self.assertEqual(matching[0]['tag'], 'list-tag')

    def test_tag_in_resolve_response(self):
        """POST /commits/resolve includes the tag."""
        rev = f'tag-res-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        self._patch(rev, tag='resolved-tag')
        resp = self.client.post(
            PREFIX + '/commits/resolve',
            json={'commits': [rev]})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn(rev, data['results'])
        self.assertEqual(data['results'][rev]['tag'], 'resolved-tag')

    def test_tag_in_neighbor_response(self):
        """Neighbor commits in detail include tag."""
        unique = uuid.uuid4().hex[:6]
        rev1 = f'tag-nb1-{unique}'
        rev2 = f'tag-nb2-{unique}'
        # Create commits first, then assign unique ordinals via PATCH.
        self._create(rev1)
        self._create(rev2)
        self._patch(rev1, ordinal=7770001, tag='nb-tag-1')
        self._patch(rev2, ordinal=7770002, tag='nb-tag-2')
        resp = self.client.get(PREFIX + f'/commits/{rev2}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIsNotNone(data['previous_commit'],
                             'expected previous_commit to be set')
        self.assertIn('tag', data['previous_commit'])
        self.assertEqual(data['previous_commit']['tag'], 'nb-tag-1')

    def test_search_matches_tag(self):
        """GET /commits?search= matches the tag value."""
        unique = uuid.uuid4().hex[:8]
        rev = f'tag-srch-{unique}'
        tag_value = f'release-{unique}'
        self._create(rev)
        self._patch(rev, tag=tag_value)
        resp = self.client.get(PREFIX + f'/commits?search=release-{unique}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        commits = [i['commit'] for i in data['items']]
        self.assertIn(rev, commits)

    def test_search_does_not_match_null_tag(self):
        """Search only matches commits with a matching tag, not null tags."""
        unique = uuid.uuid4().hex[:8]
        rev_no_tag = f'tag-notag-{unique}'
        rev_with_tag = f'tag-witht-{unique}'
        tag_value = f'release-{unique}'
        self._create(rev_no_tag)
        self._create(rev_with_tag)
        self._patch(rev_with_tag, tag=tag_value)
        resp = self.client.get(PREFIX + f'/commits?search=release-{unique}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        commits = [i['commit'] for i in data['items']]
        self.assertIn(rev_with_tag, commits)
        self.assertNotIn(rev_no_tag, commits)

    def test_post_ignores_tag(self):
        """POST /commits ignores a tag value (tag is PATCH-only)."""
        rev = f'tag-ign-{uuid.uuid4().hex[:8]}'
        resp = self._create(rev, tag='foo')
        self.assertEqual(resp.status_code, 201)
        self.assertIsNone(resp.get_json()['tag'])

    def test_tag_not_unique(self):
        """Two commits can have the same tag value."""
        tag_value = f'shared-tag-{uuid.uuid4().hex[:8]}'
        rev1 = f'tag-nu1-{uuid.uuid4().hex[:8]}'
        rev2 = f'tag-nu2-{uuid.uuid4().hex[:8]}'
        self._create(rev1)
        self._create(rev2)
        resp1 = self._patch(rev1, tag=tag_value)
        resp2 = self._patch(rev2, tag=tag_value)
        self.assertEqual(resp1.status_code, 200)
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp1.get_json()['tag'], tag_value)
        self.assertEqual(resp2.get_json()['tag'], tag_value)

    def test_tag_length_over_256_rejected(self):
        """PATCH with a tag longer than 256 chars returns 422."""
        rev = f'tag-long-{uuid.uuid4().hex[:8]}'
        self._create(rev)
        resp = self._patch(rev, tag='x' * 257)
        self.assertEqual(resp.status_code, 422)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
