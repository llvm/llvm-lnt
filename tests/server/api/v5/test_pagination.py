# Tests for the v5 API pagination utilities.
#
# RUN: python %s
# END.

"""These are pure unit tests that do not require a running LNT instance."""

import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from lnt.server.api.v5.pagination import (
    encode_cursor, decode_cursor, cursor_paginate, make_paginated_response,
)


class TestCursorEncoding(unittest.TestCase):
    def test_encode_decode_roundtrip(self):
        for value in [1, 42, 999999]:
            cursor = encode_cursor(value)
            self.assertEqual(decode_cursor(cursor), value)

    def test_decode_none(self):
        self.assertIsNone(decode_cursor(None))

    def test_decode_empty(self):
        self.assertIsNone(decode_cursor(''))

    def test_decode_malformed(self):
        self.assertIsNone(decode_cursor('not-valid-base64!@#'))

    def test_encode_returns_string(self):
        cursor = encode_cursor(42)
        self.assertIsInstance(cursor, str)

    def test_different_ids_produce_different_cursors(self):
        c1 = encode_cursor(1)
        c2 = encode_cursor(2)
        self.assertNotEqual(c1, c2)


class TestCursorPaginate(unittest.TestCase):
    """Test cursor_paginate with a real SQLAlchemy in-memory SQLite database."""

    @classmethod
    def setUpClass(cls):
        from sqlalchemy import create_engine, Column, Integer
        from sqlalchemy.ext.declarative import declarative_base
        from sqlalchemy.orm import sessionmaker

        cls.engine = create_engine('sqlite:///:memory:')
        cls.Base = declarative_base()

        class Item(cls.Base):
            __tablename__ = 'items'
            id = Column(Integer, primary_key=True)

        cls.Item = Item
        cls.Base.metadata.create_all(cls.engine)
        cls.Session = sessionmaker(bind=cls.engine)

    def setUp(self):
        """Insert 10 items with ids 1..10."""
        self.session = self.Session()
        # Clear any leftover rows
        self.session.query(self.Item).delete()
        for i in range(1, 11):
            self.session.add(self.Item(id=i))
        self.session.commit()

    def tearDown(self):
        self.session.close()

    # -- ascending (default) -------------------------------------------------

    def test_ascending_first_page(self):
        query = self.session.query(self.Item)
        items, next_cursor = cursor_paginate(
            query, self.Item.id, limit=3)
        ids = [item.id for item in items]
        self.assertEqual(ids, [1, 2, 3])
        self.assertIsNotNone(next_cursor)

    def test_ascending_second_page(self):
        query = self.session.query(self.Item)
        _, cursor = cursor_paginate(query, self.Item.id, limit=3)
        items, next_cursor = cursor_paginate(
            query, self.Item.id, cursor_str=cursor, limit=3)
        ids = [item.id for item in items]
        self.assertEqual(ids, [4, 5, 6])
        self.assertIsNotNone(next_cursor)

    def test_ascending_all_pages(self):
        """Walk through all pages and collect all items."""
        query = self.session.query(self.Item)
        all_ids = []
        cursor = None
        for _ in range(20):  # safety limit
            items, cursor = cursor_paginate(
                query, self.Item.id, cursor_str=cursor, limit=3)
            all_ids.extend(item.id for item in items)
            if cursor is None:
                break
        self.assertEqual(all_ids, list(range(1, 11)))

    def test_ascending_exact_page_boundary(self):
        """When items exactly fill the limit, next page should be empty."""
        query = self.session.query(self.Item)
        items, cursor = cursor_paginate(query, self.Item.id, limit=10)
        self.assertEqual(len(items), 10)
        self.assertIsNone(cursor)

    # -- descending ----------------------------------------------------------

    def test_descending_first_page(self):
        query = self.session.query(self.Item)
        items, next_cursor = cursor_paginate(
            query, self.Item.id, limit=3, descending=True)
        ids = [item.id for item in items]
        self.assertEqual(ids, [10, 9, 8])
        self.assertIsNotNone(next_cursor)

    def test_descending_second_page(self):
        query = self.session.query(self.Item)
        _, cursor = cursor_paginate(
            query, self.Item.id, limit=3, descending=True)
        items, next_cursor = cursor_paginate(
            query, self.Item.id, cursor_str=cursor, limit=3,
            descending=True)
        ids = [item.id for item in items]
        self.assertEqual(ids, [7, 6, 5])
        self.assertIsNotNone(next_cursor)

    def test_descending_all_pages(self):
        """Walk through all pages descending and collect all items."""
        query = self.session.query(self.Item)
        all_ids = []
        cursor = None
        for _ in range(20):  # safety limit
            items, cursor = cursor_paginate(
                query, self.Item.id, cursor_str=cursor, limit=3,
                descending=True)
            all_ids.extend(item.id for item in items)
            if cursor is None:
                break
        self.assertEqual(all_ids, list(range(10, 0, -1)))

    def test_descending_exact_page_boundary(self):
        """When items exactly fill the limit descending, no next page."""
        query = self.session.query(self.Item)
        items, cursor = cursor_paginate(
            query, self.Item.id, limit=10, descending=True)
        self.assertEqual(len(items), 10)
        self.assertIsNone(cursor)

    def test_descending_single_item_pages(self):
        """Walking one-at-a-time descending yields all items."""
        query = self.session.query(self.Item)
        all_ids = []
        cursor = None
        for _ in range(20):
            items, cursor = cursor_paginate(
                query, self.Item.id, cursor_str=cursor, limit=1,
                descending=True)
            all_ids.extend(item.id for item in items)
            if cursor is None:
                break
        self.assertEqual(all_ids, list(range(10, 0, -1)))

    # -- edge cases ----------------------------------------------------------

    def test_empty_table_ascending(self):
        self.session.query(self.Item).delete()
        self.session.commit()
        query = self.session.query(self.Item)
        items, cursor = cursor_paginate(query, self.Item.id, limit=5)
        self.assertEqual(items, [])
        self.assertIsNone(cursor)

    def test_empty_table_descending(self):
        self.session.query(self.Item).delete()
        self.session.commit()
        query = self.session.query(self.Item)
        items, cursor = cursor_paginate(
            query, self.Item.id, limit=5, descending=True)
        self.assertEqual(items, [])
        self.assertIsNone(cursor)

    def test_limit_clamped_low(self):
        """Limit < 1 should be clamped to 1."""
        query = self.session.query(self.Item)
        items, _ = cursor_paginate(query, self.Item.id, limit=0)
        self.assertEqual(len(items), 1)

    def test_limit_clamped_high(self):
        """Limit > 10000 should be clamped to 10000."""
        query = self.session.query(self.Item)
        items, _ = cursor_paginate(query, self.Item.id, limit=99999)
        # Only 10 items in the table
        self.assertEqual(len(items), 10)

    def test_limit_above_old_cap_now_allowed(self):
        """Limits above the old 500 cap should now work (up to 10000)."""
        for i in range(11, 612):
            self.session.add(self.Item(id=i))
        self.session.commit()

        query = self.session.query(self.Item)
        items, _ = cursor_paginate(query, self.Item.id, limit=611)
        self.assertEqual(len(items), 611)


class TestPaginatedResponse(unittest.TestCase):
    def test_basic_envelope(self):
        result = make_paginated_response(
            items=[{'id': 1}, {'id': 2}],
            next_cursor='abc123',
        )
        self.assertIn('items', result)
        self.assertIn('cursor', result)
        self.assertEqual(result['cursor']['next'], 'abc123')
        self.assertIsNone(result['cursor']['previous'])

    def test_no_next_cursor(self):
        result = make_paginated_response(items=[], next_cursor=None)
        self.assertIsNone(result['cursor']['next'])

    def test_total_included_when_provided(self):
        result = make_paginated_response(
            items=[], next_cursor=None, total=42)
        self.assertEqual(result['total'], 42)

    def test_total_omitted_when_not_provided(self):
        result = make_paginated_response(items=[], next_cursor=None)
        self.assertNotIn('total', result)

    def test_items_preserved(self):
        items = [{'name': 'a'}, {'name': 'b'}]
        result = make_paginated_response(items=items, next_cursor=None)
        self.assertEqual(result['items'], items)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
