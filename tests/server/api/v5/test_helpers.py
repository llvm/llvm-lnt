# Unit tests for v5 API helper functions.
#
# These tests exercise pure helpers that do not require a database or
# Flask application context, so they can run directly with unittest.
#
# RUN: python %s
# END.

import datetime
import unittest

import marshmallow as ma

from lnt.server.api.v5.helpers import (
    dump_response, escape_like, format_utc, parse_datetime,
)

UTC = datetime.timezone.utc


class TestParseDatetime(unittest.TestCase):
    """Tests for parse_datetime()."""

    def test_naive_datetime_assumed_utc(self):
        """A naive ISO string (no timezone) should be treated as UTC."""
        result = parse_datetime('2024-01-15T10:00:00')
        self.assertEqual(result, datetime.datetime(2024, 1, 15, 10, 0, 0, tzinfo=UTC))

    def test_utc_timezone(self):
        """A datetime with explicit +00:00 offset should remain UTC."""
        result = parse_datetime('2024-01-15T10:00:00+00:00')
        self.assertEqual(result, datetime.datetime(2024, 1, 15, 10, 0, 0, tzinfo=UTC))

    def test_z_suffix(self):
        """The 'Z' suffix is equivalent to +00:00 (UTC)."""
        result = parse_datetime('2024-01-15T10:00:00Z')
        self.assertEqual(result, datetime.datetime(2024, 1, 15, 10, 0, 0, tzinfo=UTC))

    def test_positive_offset_converted_to_utc(self):
        """+05:00 means the local time is 5 hours ahead of UTC, so
        10:00+05:00 should become 05:00 UTC."""
        result = parse_datetime('2024-01-15T10:00:00+05:00')
        self.assertEqual(result, datetime.datetime(2024, 1, 15, 5, 0, 0, tzinfo=UTC))

    def test_negative_offset_converted_to_utc(self):
        """-05:00 means the local time is 5 hours behind UTC, so
        10:00-05:00 should become 15:00 UTC."""
        result = parse_datetime('2024-01-15T10:00:00-05:00')
        self.assertEqual(result, datetime.datetime(2024, 1, 15, 15, 0, 0, tzinfo=UTC))

    def test_result_is_utc_aware(self):
        """The returned datetime must always be timezone-aware UTC."""
        result = parse_datetime('2024-01-15T10:00:00+05:00')
        self.assertEqual(result.tzinfo, UTC)

    def test_empty_string_returns_none(self):
        self.assertIsNone(parse_datetime(''))

    def test_none_returns_none(self):
        self.assertIsNone(parse_datetime(None))

    def test_invalid_string_returns_none(self):
        self.assertIsNone(parse_datetime('not-a-date'))


class TestFormatUtc(unittest.TestCase):
    """Tests for format_utc()."""

    def test_none_returns_none(self):
        self.assertIsNone(format_utc(None))

    def test_aware_utc_datetime_produces_z_suffix(self):
        dt = datetime.datetime(2024, 1, 15, 10, 0, 0, tzinfo=UTC)
        self.assertEqual(format_utc(dt), '2024-01-15T10:00:00Z')

    def test_aware_utc_with_microseconds(self):
        dt = datetime.datetime(2024, 1, 15, 10, 0, 0, 123456, tzinfo=UTC)
        self.assertEqual(format_utc(dt), '2024-01-15T10:00:00.123456Z')

    def test_naive_datetime_assumed_utc(self):
        """A naive datetime is treated as UTC."""
        dt = datetime.datetime(2024, 1, 15, 10, 0, 0)
        self.assertEqual(format_utc(dt), '2024-01-15T10:00:00Z')

    def test_non_utc_offset_converted(self):
        """A non-UTC aware datetime is converted to UTC before formatting."""
        tz_plus5 = datetime.timezone(datetime.timedelta(hours=5))
        dt = datetime.datetime(2024, 1, 15, 15, 0, 0, tzinfo=tz_plus5)
        self.assertEqual(format_utc(dt), '2024-01-15T10:00:00Z')


class TestEscapeLike(unittest.TestCase):
    """Tests for escape_like()."""

    def test_no_special_chars(self):
        """Plain strings should pass through unchanged."""
        self.assertEqual(escape_like('hello'), 'hello')

    def test_percent_escaped(self):
        self.assertEqual(escape_like('100%'), '100\\%')

    def test_underscore_escaped(self):
        self.assertEqual(escape_like('a_b'), 'a\\_b')

    def test_backslash_escaped(self):
        """Backslashes must be escaped so they are not interpreted as the
        LIKE escape character."""
        self.assertEqual(escape_like('a\\b'), 'a\\\\b')

    def test_backslash_escaped_before_wildcards(self):
        """A backslash followed by a wildcard must produce an escaped
        backslash followed by an escaped wildcard — the order of
        replacements matters."""
        self.assertEqual(escape_like('a\\%b'), 'a\\\\\\%b')
        self.assertEqual(escape_like('a\\_b'), 'a\\\\\\_b')

    def test_all_special_chars_together(self):
        self.assertEqual(escape_like('\\%_'), '\\\\\\%\\_')

    def test_empty_string(self):
        self.assertEqual(escape_like(''), '')


class _TestSchema(ma.Schema):
    """Minimal schema for testing dump_response()."""
    name = ma.fields.String(required=True)
    value = ma.fields.Integer(required=True)


class TestDumpResponse(unittest.TestCase):
    """Tests for dump_response()."""

    def setUp(self):
        self.schema = _TestSchema()

    def test_valid_data_passes(self):
        result = dump_response(self.schema, {'name': 'foo', 'value': 42})
        self.assertEqual(result, {'name': 'foo', 'value': 42})

    def test_extra_key_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            dump_response(self.schema, {'name': 'foo', 'value': 42, 'extra': 1})
        self.assertIn('extra', str(ctx.exception))

    def test_missing_required_field_raises_validation_error(self):
        with self.assertRaises(ma.ValidationError):
            dump_response(self.schema, {'name': 'foo'})


if __name__ == '__main__':
    unittest.main()
