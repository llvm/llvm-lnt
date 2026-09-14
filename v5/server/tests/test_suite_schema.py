"""The schema document (D3, D4): what it accepts, what it refuses, and what it normalizes to."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from lnt_v5.suites.schema import (
    NUMERIC_TYPES,
    AttributeType,
    SuiteSchema,
)

# The schema from D4, which exercises every list and most of the optional keys.
EXAMPLE: dict[str, Any] = {
    "name": "nts",
    "metrics": [
        {
            "name": "compile_time",
            "type": "real",
            "display_name": "Compile Time",
            "unit": "seconds",
            "unit_abbrev": "s",
            "bigger_is_better": False,
        },
        {"name": "execution_time", "type": "real"},
        {"name": "compile_status", "type": "integer"},
    ],
    "machine_fields": [
        {"name": "hardware", "type": "text", "searchable": True},
        {"name": "os", "type": "text", "searchable": True},
        {"name": "core_count", "type": "integer"},
    ],
    "commit_fields": [
        {"name": "git_sha", "type": "text", "searchable": True},
        {"name": "author", "type": "text", "searchable": True},
        {"name": "commit_message", "type": "text"},
        {"name": "commit_timestamp", "type": "datetime"},
    ],
}


def schema(**overrides: Any) -> dict[str, Any]:
    """A minimal valid schema, with whichever keys a test cares about replaced."""
    return {"name": "nts"} | overrides


class TestSuiteName:
    def test_accepts_the_documented_example(self) -> None:
        assert SuiteSchema.model_validate(EXAMPLE).name == "nts"

    @pytest.mark.parametrize("name", ["a", "nts", "test_suite_2", "a" * 63])
    def test_accepts_a_lowercase_identifier(self, name: str) -> None:
        SuiteSchema.model_validate(schema(name=name))

    @pytest.mark.parametrize(
        "name",
        [
            "",
            "NTS",  # D4 admits lowercase only
            "test suite",
            "test-suite",
            "2fast",  # must start with a letter
            "_private",
            "nts\n",  # a trailing newline must not slip past the anchors
            "a" * 64,  # one over PostgreSQL's identifier limit
        ],
    )
    def test_rejects_anything_that_is_not_one(self, name: str) -> None:
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(name=name))

    @pytest.mark.parametrize("name", ["public", "information_schema", "pg_catalog", "pg_"])
    def test_rejects_a_name_no_namespace_can_be_created_under(self, name: str) -> None:
        # D4: these satisfy the pattern and are rejected anyway, because the suite name is also
        # the name of the namespace holding its tables.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(name=name))

    @pytest.mark.parametrize("name", ["admin", "suites", "api"])
    def test_reserves_nothing_for_routing(self, name: str) -> None:
        # R1: suite-scoped resources live below /api/suites/, so routing reserves no suite name at
        # all. Only the namespace collisions above are refused.
        SuiteSchema.model_validate(schema(name=name))


class TestEntryNames:
    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    @pytest.mark.parametrize("name", ["Compile Time", "CompileTime", "_internal", "2nd_run", ""])
    def test_follow_the_same_rule_as_a_suite_name(self, list_name: str, name: str) -> None:
        # An entry name becomes a column name, so it is an identifier for the same reason a suite
        # name is (D4).
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [{"name": name, "type": "text"}]}))

    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    def test_may_be_a_postgresql_reserved_word(self, list_name: str) -> None:
        # Nothing in the schema needs them reserved; tables.py quotes every identifier so that
        # they work. See the round-trip in test_suite_tables.py.
        SuiteSchema.model_validate(schema(**{list_name: [{"name": "order", "type": "integer"}]}))

    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    def test_may_appear_once_per_list(self, list_name: str) -> None:
        entries = [{"name": "duplicated", "type": "text"}] * 2
        with pytest.raises(ValidationError, match="more than once"):
            SuiteSchema.model_validate(schema(**{list_name: entries}))

    def test_may_be_shared_across_lists(self) -> None:
        # A metric `os` and a machine field `os` are columns on different tables and never meet.
        SuiteSchema.model_validate(
            schema(
                metrics=[{"name": "os", "type": "integer"}],
                machine_fields=[{"name": "os", "type": "text"}],
                commit_fields=[{"name": "os", "type": "text"}],
            )
        )

    @pytest.mark.parametrize("name", ["id", "commit", "ordinal", "tag"])
    def test_a_commit_field_cannot_shadow_a_commit_column(self, name: str) -> None:
        with pytest.raises(ValidationError, match="built-in column"):
            SuiteSchema.model_validate(schema(commit_fields=[{"name": name, "type": "text"}]))

    @pytest.mark.parametrize("name", ["id", "name", "tracked"])
    def test_a_machine_field_cannot_shadow_a_machine_column(self, name: str) -> None:
        with pytest.raises(ValidationError, match="built-in column"):
            SuiteSchema.model_validate(schema(machine_fields=[{"name": name, "type": "text"}]))

    @pytest.mark.parametrize("name", ["id", "run_id", "test_id"])
    def test_a_metric_cannot_shadow_a_sample_column(self, name: str) -> None:
        with pytest.raises(ValidationError, match="built-in column"):
            SuiteSchema.model_validate(schema(metrics=[{"name": name, "type": "real"}]))

    @pytest.mark.parametrize("name", ["name", "profile"])
    def test_a_metric_cannot_shadow_a_reserved_submission_key(self, name: str) -> None:
        # D6: a test entry is `name` plus metric values, with `profile` carrying base64 profile
        # data. A metric called either could never be given a value, so the suite is refused
        # rather than created in a state where one of its metrics is unreachable.
        with pytest.raises(ValidationError, match="built-in column"):
            SuiteSchema.model_validate(schema(metrics=[{"name": name, "type": "real"}]))


class TestTypes:
    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    @pytest.mark.parametrize("attribute", list(AttributeType))
    def test_every_list_draws_from_one_shared_set(
        self, list_name: str, attribute: AttributeType
    ) -> None:
        # D3: one set of attribute types, shared by all three lists.
        SuiteSchema.model_validate(
            schema(**{list_name: [{"name": "entry", "type": attribute.value}]})
        )

    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    def test_is_required_on_every_entry(self, list_name: str) -> None:
        # D4: there is no default type.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [{"name": "entry"}]}))

    @pytest.mark.parametrize("attribute", ["string", "float", "bool", "status", "hash", "default"])
    def test_rejects_a_type_outside_that_set(self, attribute: str) -> None:
        # `status`, `hash` and `default` are v4 spellings, and v5 keeps no compatibility with them.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(metrics=[{"name": "m", "type": attribute}]))

    def test_the_numeric_types_are_the_ones_arithmetic_is_defined_over(self) -> None:
        # D3: what `POST /trends` requires of a metric, and what the Dashboard and Compare pages
        # filter their metric pickers by.
        assert {AttributeType.REAL, AttributeType.INTEGER} == NUMERIC_TYPES


class TestPresentationKeys:
    @pytest.mark.parametrize("key", ["unit", "unit_abbrev"])
    def test_a_metric_carries_its_unit(self, key: str) -> None:
        SuiteSchema.model_validate(schema(metrics=[{"name": "m", "type": "real", key: "s"}]))

    @pytest.mark.parametrize(
        ("list_name", "key", "value"),
        [
            # Only a metric has a direction: a machine's `os` is not better for being bigger.
            ("commit_fields", "bigger_is_better", True),
            ("machine_fields", "bigger_is_better", True),
            ("commit_fields", "unit", "s"),
            ("machine_fields", "unit_abbrev", "s"),
            # Only a commit or machine field is searchable (D9), and only a commit field is the
            # UI's display value (D4).
            ("metrics", "searchable", True),
            ("metrics", "display", True),
            ("machine_fields", "display", True),
        ],
    )
    def test_a_key_that_means_nothing_for_a_list_is_refused(
        self, list_name: str, key: str, value: Any
    ) -> None:
        # Accepting it silently would leave the author believing it had an effect.
        entry = {"name": "entry", "type": "text", key: value}
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [entry]}))

    def test_an_unknown_key_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(metrics=[{"name": "m", "type": "real", "unt": "s"}]))

    def test_an_unknown_top_level_key_is_refused(self) -> None:
        # In particular `format_version`, which D4 says the schema does not carry.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(format_version="5"))


class TestSearchable:
    def test_a_text_field_can_be_searchable(self) -> None:
        SuiteSchema.model_validate(
            schema(commit_fields=[{"name": "git_sha", "type": "text", "searchable": True}])
        )

    @pytest.mark.parametrize("attribute", ["real", "integer", "datetime"])
    @pytest.mark.parametrize("list_name", ["commit_fields", "machine_fields"])
    def test_nothing_else_can_be(self, list_name: str, attribute: str) -> None:
        # D3: `?search=` is substring matching, which only means something over text.
        entry = {"name": "entry", "type": attribute, "searchable": True}
        with pytest.raises(ValidationError, match="searchable"):
            SuiteSchema.model_validate(schema(**{list_name: [entry]}))

    @pytest.mark.parametrize("attribute", ["real", "integer", "datetime"])
    def test_a_non_text_field_may_still_say_so_explicitly(self, attribute: str) -> None:
        entry = {"name": "entry", "type": attribute, "searchable": False}
        SuiteSchema.model_validate(schema(commit_fields=[entry]))


class TestDisplayField:
    def test_one_commit_field_may_be_the_display_value(self) -> None:
        parsed = SuiteSchema.model_validate(
            schema(
                commit_fields=[
                    {"name": "git_sha", "type": "text", "display": True},
                    {"name": "author", "type": "text"},
                ]
            )
        )

        assert parsed.display_field is not None
        assert parsed.display_field.name == "git_sha"

    def test_no_more_than_one_may_be(self) -> None:
        with pytest.raises(ValidationError, match="at most one commit field"):
            SuiteSchema.model_validate(
                schema(
                    commit_fields=[
                        {"name": "git_sha", "type": "text", "display": True},
                        {"name": "author", "type": "text", "display": True},
                    ]
                )
            )

    def test_a_schema_need_not_have_one(self) -> None:
        # D4: without one, the UI falls back to the raw commit string.
        assert SuiteSchema.model_validate(EXAMPLE).display_field is None


class TestNormalization:
    """D4's stored and returned form: every optional key present and explicit.

    This is what makes a schema fetched from one instance postable verbatim to another, and it is
    what the `schema` table holds -- so these defaults are part of the wire contract, not an
    internal detail.
    """

    def test_fills_in_every_optional_key_on_a_metric(self) -> None:
        parsed = SuiteSchema.model_validate(schema(metrics=[{"name": "m", "type": "real"}]))

        assert parsed.model_dump()["metrics"] == [
            {
                "name": "m",
                "type": AttributeType.REAL,
                "display_name": None,
                "unit": None,
                "unit_abbrev": None,
                "bigger_is_better": False,
            }
        ]

    def test_fills_in_every_optional_key_on_a_commit_field(self) -> None:
        parsed = SuiteSchema.model_validate(schema(commit_fields=[{"name": "c", "type": "text"}]))

        assert parsed.model_dump()["commit_fields"] == [
            {
                "name": "c",
                "type": AttributeType.TEXT,
                "display_name": None,
                "searchable": False,
                "display": False,
            }
        ]

    def test_fills_in_every_optional_key_on_a_machine_field(self) -> None:
        parsed = SuiteSchema.model_validate(schema(machine_fields=[{"name": "m", "type": "text"}]))

        assert parsed.model_dump()["machine_fields"] == [
            {
                "name": "m",
                "type": AttributeType.TEXT,
                "display_name": None,
                "searchable": False,
            }
        ]

    def test_leaves_display_name_unset_rather_than_copying_the_name(self) -> None:
        # The UI falls back to `name` at render time. Copying it here would make the returned
        # document differ from the one posted, and would leave a stale label behind if the entry
        # were ever replaced.
        parsed = SuiteSchema.model_validate(
            schema(metrics=[{"name": "compile_time", "type": "real"}])
        )

        assert parsed.metrics[0].display_name is None

    def test_names_all_three_lists_even_when_a_schema_omits_them(self) -> None:
        assert SuiteSchema.model_validate(schema()).model_dump() == {
            "name": "nts",
            "metrics": [],
            "commit_fields": [],
            "machine_fields": [],
        }

    def test_round_trips_through_its_own_output(self) -> None:
        # The property endpoints.md relies on: what `GET` returns is what `POST` accepts.
        parsed = SuiteSchema.model_validate(EXAMPLE)

        assert SuiteSchema.model_validate(parsed.model_dump(mode="json")) == parsed
