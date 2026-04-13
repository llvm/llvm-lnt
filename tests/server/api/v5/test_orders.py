# Tests for the v5 order endpoints.
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
    create_app, create_client, admin_headers, make_scoped_headers,
    collect_all_pages,
)


TS = 'nts'
PREFIX = f'/api/v5/{TS}'


class TestOrderList(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/orders."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_list_returns_200(self):
        resp = self.client.get(PREFIX + '/orders')
        self.assertEqual(resp.status_code, 200)

    def test_list_has_pagination_envelope(self):
        resp = self.client.get(PREFIX + '/orders')
        data = resp.get_json()
        self.assertIn('items', data)
        self.assertIn('cursor', data)
        self.assertIn('next', data['cursor'])
        self.assertIn('previous', data['cursor'])

    def test_list_returns_orders(self):
        """Create an order via the API and verify it appears in the list."""
        rev = f'list-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )

        resp = self.client.get(PREFIX + '/orders')
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        # Each item should have a 'fields' dict
        for item in data['items']:
            self.assertIn('fields', item)
            self.assertIsInstance(item['fields'], dict)

    def test_list_pagination(self):
        """Verify cursor pagination works."""
        for i in range(3):
            rev = f'page-{uuid.uuid4().hex[:6]}-{i}'
            self.client.post(
                PREFIX + '/orders',
                json={'llvm_project_revision': rev},
                headers=admin_headers(),
            )

        resp = self.client.get(PREFIX + '/orders?limit=1')
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        self.assertIsNotNone(data['cursor']['next'])

        # Follow cursor
        cursor = data['cursor']['next']
        resp2 = self.client.get(
            PREFIX + f'/orders?limit=1&cursor={cursor}')
        self.assertEqual(resp2.status_code, 200)
        data2 = resp2.get_json()
        self.assertEqual(len(data2['items']), 1)

    def test_list_no_auth_required_for_read(self):
        """GET should work without auth headers (unauthenticated reads)."""
        resp = self.client.get(PREFIX + '/orders')
        self.assertEqual(resp.status_code, 200)

    def test_invalid_cursor_returns_400(self):
        """An invalid cursor string should return 400."""
        resp = self.client.get(
            PREFIX + '/orders?cursor=not-a-valid-cursor!!!')
        self.assertEqual(resp.status_code, 400)


class TestOrderCreate(unittest.TestCase):
    """Tests for POST /api/v5/{ts}/orders."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_create_order(self):
        """Create an order and verify 201 response."""
        rev = f'create-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertIn('fields', data)
        self.assertEqual(data['fields']['llvm_project_revision'], rev)

    def test_create_order_includes_prev_next(self):
        """Created order response includes prev/next references."""
        rev = f'prevnext-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        # prev/next may be None but the keys should be present
        self.assertIn('previous_order', data)
        self.assertIn('next_order', data)

    def test_create_order_appears_in_list(self):
        """Newly created order appears in the order list."""
        rev = f'appear-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + '/orders')
        data = resp.get_json()
        revs = [item['fields'].get('llvm_project_revision')
                for item in data['items']]
        self.assertIn(rev, revs)

    def test_create_duplicate_409(self):
        """Creating an order with duplicate field values returns 409."""
        rev = f'dup-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 409)

    def test_create_order_missing_field_400(self):
        """Creating without required field returns 400."""
        resp = self.client.post(
            PREFIX + '/orders',
            json={},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_create_order_no_body_400(self):
        """POST without body returns 400."""
        resp = self.client.post(
            PREFIX + '/orders',
            headers=admin_headers(),
            content_type='application/json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_create_order_no_auth_401(self):
        """Creating without auth should return 401."""
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': 'no-auth'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_create_order_read_scope_403(self):
        """Creating with read scope should return 403."""
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': 'read-only'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)

    def test_create_order_submit_scope_ok(self):
        """Submit scope should be sufficient to create orders."""
        headers = make_scoped_headers(self.app, 'submit')
        rev = f'submit-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 201)


class TestOrderDetail(unittest.TestCase):
    """Tests for GET /api/v5/{ts}/orders/{order_value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_get_order_detail(self):
        """Get order detail by primary field value."""
        rev = f'detail-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )

        resp = self.client.get(PREFIX + f'/orders/{rev}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn('fields', data)
        self.assertEqual(data['fields']['llvm_project_revision'], rev)

    def test_get_order_includes_prev_next(self):
        """Order detail includes previous_order and next_order."""
        rev = f'detail-pn-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )

        resp = self.client.get(PREFIX + f'/orders/{rev}')
        data = resp.get_json()
        self.assertIn('previous_order', data)
        self.assertIn('next_order', data)

    def test_get_nonexistent_404(self):
        """Getting a nonexistent order should return 404."""
        resp = self.client.get(
            PREFIX + '/orders/nonexistent-order-xyz')
        self.assertEqual(resp.status_code, 404)

    def test_order_detail_with_neighbors(self):
        """Verify previous/next order references when neighbors exist."""
        # Create two orders via POST so the linked list is maintained
        rev1 = f'100{uuid.uuid4().hex[:4]}'
        rev2 = f'200{uuid.uuid4().hex[:4]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev1},
            headers=admin_headers(),
        )
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev2},
            headers=admin_headers(),
        )

        # At least one of them should have a neighbor
        resp1 = self.client.get(PREFIX + f'/orders/{rev1}')
        resp2 = self.client.get(PREFIX + f'/orders/{rev2}')
        data1 = resp1.get_json()
        data2 = resp2.get_json()

        # We can't predict exact ordering, but the response structure
        # should be correct
        for data in (data1, data2):
            self.assertIn('previous_order', data)
            self.assertIn('next_order', data)
            for neighbor_key in ('previous_order', 'next_order'):
                neighbor = data[neighbor_key]
                if neighbor is not None:
                    self.assertIn('fields', neighbor)
                    self.assertIn('link', neighbor)


class TestOrderDetailETag(unittest.TestCase):
    """ETag tests for GET /api/v5/{ts}/orders/{order_value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_etag_present_on_detail(self):
        """Order detail response should include an ETag header."""
        rev = f'etag-present-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/orders/{rev}')
        self.assertEqual(resp.status_code, 200)
        etag = resp.headers.get('ETag')
        self.assertIsNotNone(etag)
        self.assertTrue(etag.startswith('W/"'))

    def test_etag_304_on_match(self):
        """Sending If-None-Match with the same ETag returns 304."""
        rev = f'etag-304-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/orders/{rev}')
        etag = resp.headers.get('ETag')

        resp2 = self.client.get(
            PREFIX + f'/orders/{rev}',
            headers={'If-None-Match': etag},
        )
        self.assertEqual(resp2.status_code, 304)

    def test_etag_200_on_mismatch(self):
        """Sending If-None-Match with a different ETag returns 200."""
        rev = f'etag-200-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(
            PREFIX + f'/orders/{rev}',
            headers={'If-None-Match': 'W/"stale-etag-value"'},
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.get_json())


class TestOrderUpdate(unittest.TestCase):
    """Tests for PATCH /api/v5/{ts}/orders/{order_value}."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_patch_order(self):
        """PATCH an existing order (currently limited, just confirms 200)."""
        rev = f'patch-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'note': 'test'},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)

    def test_patch_nonexistent_404(self):
        """PATCHing a nonexistent order returns 404."""
        resp = self.client.patch(
            PREFIX + '/orders/nonexistent-patch-xyz',
            json={'note': 'test'},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 404)

    def test_patch_no_auth_401(self):
        """PATCH without auth returns 401."""
        rev = f'patch-noauth-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'note': 'test'},
        )
        self.assertEqual(resp.status_code, 401)

    def test_patch_read_scope_403(self):
        """PATCH with read scope returns 403."""
        rev = f'patch-read-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        headers = make_scoped_headers(self.app, 'read')
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'note': 'test'},
            headers=headers,
        )
        self.assertEqual(resp.status_code, 403)


class TestOrderPagination(unittest.TestCase):
    """Exhaustive cursor pagination tests for GET /api/v5/{ts}/orders."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)
        cls._revisions = []
        for i in range(5):
            rev = f'pag-{uuid.uuid4().hex[:8]}-{i}'
            cls.client.post(
                PREFIX + '/orders',
                json={'llvm_project_revision': rev},
                headers=admin_headers(),
            )
            cls._revisions.append(rev)

    def _collect_all_pages(self):
        url = PREFIX + '/orders?limit=2'
        return collect_all_pages(self, self.client, url)

    def test_pagination_collects_all_items(self):
        """Paginating through all pages collects all created orders."""
        all_items = self._collect_all_pages()
        revisions = [item['fields']['llvm_project_revision']
                     for item in all_items]
        for rev in self._revisions:
            self.assertIn(rev, revisions)

    def test_no_duplicate_items_across_pages(self):
        """No duplicate orders across pages."""
        all_items = self._collect_all_pages()
        revisions = [item['fields']['llvm_project_revision']
                     for item in all_items]
        self.assertEqual(len(revisions), len(set(revisions)))


class TestOrderUnknownParams(unittest.TestCase):
    """Test that unknown query parameters are rejected with 400."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def test_orders_list_unknown_param_returns_400(self):
        resp = self.client.get(PREFIX + '/orders?bogus=1')
        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertIn('bogus', data['error']['message'])

    def test_order_detail_unknown_param_returns_400(self):
        rev = f'unk-det-{uuid.uuid4().hex[:8]}'
        self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev},
            headers=admin_headers(),
        )
        resp = self.client.get(PREFIX + f'/orders/{rev}?bogus=1')
        self.assertEqual(resp.status_code, 400)


class TestOrderTag(unittest.TestCase):
    """Tests for order tagging (tag field on orders)."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.app = create_app(sys.argv[1])
        cls.client = create_client(cls.app)

    def _create_order(self, rev=None, tag=None):
        """Helper to create an order, optionally with a tag."""
        if rev is None:
            rev = f'tag-{uuid.uuid4().hex[:8]}'
        body = {'llvm_project_revision': rev}
        if tag is not None:
            body['tag'] = tag
        resp = self.client.post(
            PREFIX + '/orders',
            json=body,
            headers=admin_headers(),
        )
        return resp, rev

    def test_tag_on_create(self):
        """POST /orders with tag field sets the tag."""
        resp, rev = self._create_order(tag='release-18.1')
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertEqual(data['tag'], 'release-18.1')

    def test_tag_appears_in_detail(self):
        """Tag appears in GET /orders/{value} detail."""
        _, rev = self._create_order(tag='detail-tag')
        resp = self.client.get(PREFIX + f'/orders/{rev}')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['tag'], 'detail-tag')

    def test_tag_appears_in_list(self):
        """Tag appears in GET /orders list items."""
        _, rev = self._create_order(tag='list-tag')
        resp = self.client.get(PREFIX + '/orders?tag=list-tag')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertGreater(len(data['items']), 0)
        self.assertEqual(data['items'][0]['tag'], 'list-tag')

    def test_tag_default_null(self):
        """Orders created without a tag have tag=null."""
        resp, rev = self._create_order()
        self.assertEqual(resp.status_code, 201)
        self.assertIsNone(resp.get_json()['tag'])

    def test_set_tag_via_patch(self):
        """PATCH to set a tag on an existing order."""
        _, rev = self._create_order()
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'tag': 'patched'},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['tag'], 'patched')

        # Verify it persists
        detail = self.client.get(PREFIX + f'/orders/{rev}')
        self.assertEqual(detail.get_json()['tag'], 'patched')

    def test_clear_tag_via_patch(self):
        """PATCH {"tag": null} clears the tag."""
        _, rev = self._create_order(tag='to-clear')
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'tag': None},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.get_json()['tag'])

    def test_tag_too_long_on_patch_400(self):
        """PATCH with >64 char tag returns 400."""
        _, rev = self._create_order()
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'tag': 'x' * 65},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_tag_too_long_on_create_400(self):
        """POST /orders with >64 char tag returns 400."""
        rev = f'tag-long-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev, 'tag': 'x' * 65},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_filter_by_tag(self):
        """Filter orders by exact tag."""
        unique = uuid.uuid4().hex[:8]
        tag_a = f'filter-a-{unique}'
        tag_b = f'filter-b-{unique}'
        self._create_order(tag=tag_a)
        self._create_order(tag=tag_b)

        resp = self.client.get(PREFIX + f'/orders?tag={tag_a}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 1)
        self.assertEqual(data['items'][0]['tag'], tag_a)

    def test_filter_by_tag_prefix(self):
        """Filter orders by tag prefix."""
        unique = uuid.uuid4().hex[:8]
        prefix = f'pfx-{unique}'
        self._create_order(tag=f'{prefix}-18.1')
        self._create_order(tag=f'{prefix}-19.0')
        self._create_order(tag='other-tag')

        resp = self.client.get(PREFIX + f'/orders?tag_prefix={prefix}')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 2)
        for item in data['items']:
            self.assertTrue(item['tag'].startswith(prefix))

    def test_filter_by_nonexistent_tag(self):
        """Filtering by a tag that doesn't exist returns empty results."""
        resp = self.client.get(
            PREFIX + '/orders?tag=nonexistent-tag-xyz-abc')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data['items']), 0)

    def test_patch_without_tag_preserves_existing(self):
        """PATCH with no tag key leaves the existing tag unchanged."""
        _, rev = self._create_order(tag='keep-me')
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'unrelated': 'data'},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()['tag'], 'keep-me')

    def test_non_string_tag_on_create_400(self):
        """POST /orders with a non-string tag returns 400."""
        rev = f'tag-int-{uuid.uuid4().hex[:8]}'
        resp = self.client.post(
            PREFIX + '/orders',
            json={'llvm_project_revision': rev, 'tag': 42},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_non_string_tag_on_patch_400(self):
        """PATCH with a non-string tag returns 400."""
        _, rev = self._create_order()
        resp = self.client.patch(
            PREFIX + f'/orders/{rev}',
            json={'tag': ['not', 'a', 'string']},
            headers=admin_headers(),
        )
        self.assertEqual(resp.status_code, 400)

    def test_tag_exactly_64_chars_accepted(self):
        """A tag with exactly 64 characters is accepted."""
        tag = 'x' * 64
        resp, rev = self._create_order(tag=tag)
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.get_json()['tag'], tag)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
