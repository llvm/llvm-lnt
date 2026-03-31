# Unit tests for the regression state mapping helpers (state_to_api / state_to_db).
# These are pure-function tests that do not require a database.
#
# RUN: python %s
# END.

import sys
import unittest

# Ensure the project root is importable.
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))

from lnt.server.api.v5.schemas.regressions import (
    STATE_TO_DB,
    state_to_api,
    state_to_db,
)


class TestStateToApi(unittest.TestCase):
    """Tests for state_to_api()."""

    def test_all_known_states_round_trip(self):
        """Every known DB integer maps to its expected API string."""
        for api_string, db_int in STATE_TO_DB.items():
            with self.subTest(db_int=db_int, expected=api_string):
                self.assertEqual(state_to_api(db_int), api_string)

    def test_unknown_int_returns_unknown_prefix(self):
        """An unmapped integer returns 'unknown_<value>' instead of 'detected'."""
        result = state_to_api(999)
        self.assertEqual(result, 'unknown_999')

    def test_unknown_negative_int(self):
        result = state_to_api(-1)
        self.assertEqual(result, 'unknown_-1')

    def test_unknown_none_value(self):
        """None is not a valid DB state and should be flagged."""
        result = state_to_api(None)
        self.assertEqual(result, 'unknown_None')

    def test_unknown_state_logs_warning(self):
        """A warning should be logged when an unknown state is encountered."""
        with self.assertLogs(
            'lnt.server.api.v5.schemas.regressions', level='WARNING'
        ) as cm:
            state_to_api(999)
        self.assertTrue(
            any('999' in msg for msg in cm.output),
            f"Expected '999' in log output, got: {cm.output}",
        )


class TestStateToDb(unittest.TestCase):
    """Tests for state_to_db()."""

    def test_all_known_strings_round_trip(self):
        for api_string, db_int in STATE_TO_DB.items():
            with self.subTest(api_string=api_string, expected=db_int):
                self.assertEqual(state_to_db(api_string), db_int)

    def test_unknown_string_returns_none(self):
        self.assertIsNone(state_to_db('bogus_state'))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], exit=True)
