"""The schema document (D3, D4): what it accepts, what it refuses, and what it normalizes to."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from lnt_v5 import examples
from lnt_v5.suites.schema import AttributeType, SuiteSchema

# The schema from D4, which exercises every list, the repository, and most of the optional keys.
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
            "dashboard": True,
        },
        {"name": "execution_time", "type": "real", "dashboard": True},
        {"name": "compile_status", "type": "integer"},
    ],
    "machine_fields": [
        {"name": "hardware", "type": "text", "searchable": True},
        {"name": "os", "type": "text", "searchable": True, "listed": True},
        {"name": "core_count", "type": "integer"},
    ],
    "commit_fields": [
        {"name": "git_sha", "type": "text", "searchable": True},
        {"name": "author", "type": "text", "searchable": True},
        {"name": "commit_message", "type": "text"},
        {"name": "commit_timestamp", "type": "datetime", "listed": True},
    ],
    "repository": examples.REPOSITORY,
}


# Every key of a schema entry holding free text for the UI (D4), with the list it belongs to.
LABELS = [
    ("metrics", "display_name"),
    ("metrics", "unit"),
    ("metrics", "unit_abbrev"),
    ("commit_fields", "display_name"),
    ("machine_fields", "display_name"),
]


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
        # I1: suite-scoped resources live below /api/suites/, so routing reserves no suite name at
        # all. Only the namespace collisions above are refused.
        SuiteSchema.model_validate(schema(name=name))


class TestEntryNames:
    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    @pytest.mark.parametrize(
        "name", ["Compile Time", "_internal", "2nd_run", "dash-ed", "é", "ipc\n", "", "a" * 64]
    )
    def test_must_be_an_identifier(self, list_name: str, name: str) -> None:
        # An entry name becomes a column name, so it is an identifier (D4).
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [{"name": name, "type": "text"}]}))

    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    @pytest.mark.parametrize("name", ["CompileTime", "A" * 63])
    def test_may_have_capitals_unlike_a_suite_name(self, list_name: str, name: str) -> None:
        parsed = SuiteSchema.model_validate(schema(**{list_name: [{"name": name, "type": "text"}]}))
        assert [entry.name for entry in getattr(parsed, list_name)] == [name]

    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    def test_are_case_sensitive(self, list_name: str) -> None:
        # D4: names that differ only by case are different names, and so different columns.
        entries = [{"name": "IPC", "type": "real"}, {"name": "ipc", "type": "real"}]
        parsed = SuiteSchema.model_validate(schema(**{list_name: entries}))
        assert [entry.name for entry in getattr(parsed, list_name)] == ["IPC", "ipc"]

    @pytest.mark.parametrize(
        ("list_name", "name"),
        [("metrics", "Run_ID"), ("commit_fields", "ID"), ("machine_fields", "Name")],
    )
    def test_may_differ_from_a_built_in_column_by_case_alone(
        self, list_name: str, name: str
    ) -> None:
        # D4: the collision with a built-in column is checked exactly, like uniqueness.
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
        with pytest.raises(ValidationError, match="built-in column on 'commit'"):
            SuiteSchema.model_validate(schema(commit_fields=[{"name": name, "type": "text"}]))

    @pytest.mark.parametrize("name", ["id", "name", "tracked"])
    def test_a_machine_field_cannot_shadow_a_machine_column(self, name: str) -> None:
        with pytest.raises(ValidationError, match="built-in column on 'machine'"):
            SuiteSchema.model_validate(schema(machine_fields=[{"name": name, "type": "text"}]))

    @pytest.mark.parametrize("name", ["run_id", "test_id", "repetition"])
    def test_a_metric_cannot_shadow_a_sample_column(self, name: str) -> None:
        with pytest.raises(ValidationError, match="built-in column on 'sample'"):
            SuiteSchema.model_validate(schema(metrics=[{"name": name, "type": "real"}]))

    def test_a_metric_may_be_named_id(self) -> None:
        # D5: `{suite}.sample` has no `id` column; its key is `(run_id, test_id, repetition)`.
        parsed = SuiteSchema.model_validate(schema(metrics=[{"name": "id", "type": "real"}]))
        assert [metric.name for metric in parsed.metrics] == ["id"]

    def test_a_metric_cannot_shadow_a_coverage_column(self) -> None:
        # D5: a metric is also a flag column on `test_coverage`, beside that table's built-ins.
        # `test_id` is one too, but `sample` claims it first.
        with pytest.raises(ValidationError, match="built-in column on 'test_coverage'"):
            SuiteSchema.model_validate(schema(metrics=[{"name": "machine_id", "type": "real"}]))

    @pytest.mark.parametrize("name", ["name", "profile"])
    def test_a_metric_may_share_a_name_with_a_key_of_a_test_entry(self, name: str) -> None:
        # O1: a test entry's metrics are in its samples, apart from its `name` and `profile`.
        parsed = SuiteSchema.model_validate(schema(metrics=[{"name": name, "type": "real"}]))
        assert [metric.name for metric in parsed.metrics] == [name]


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

    @pytest.mark.parametrize(
        ("list_name", "attribute"),
        [("commit_fields", AttributeType.DATETIME), ("machine_fields", AttributeType.INTEGER)],
    )
    def test_a_field_of_any_type_can_be_listed(
        self, list_name: str, attribute: AttributeType
    ) -> None:
        # Unlike `searchable`, `display` and `dashboard`, `listed` has no type restriction (D3).
        entry = {"name": "entry", "type": attribute.value, "listed": True}
        parsed = SuiteSchema.model_validate(schema(**{list_name: [entry]}))
        assert getattr(parsed, list_name)[0].listed

    @pytest.mark.parametrize("list_name", ["metrics", "commit_fields", "machine_fields"])
    def test_is_required_on_every_entry(self, list_name: str) -> None:
        # D3: there is no default type.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [{"name": "entry"}]}))

    @pytest.mark.parametrize("attribute", ["string", "float", "bool", "status", "hash", "default"])
    def test_rejects_a_type_outside_that_set(self, attribute: str) -> None:
        # `status`, `hash` and `default` are v4 spellings, and v5 keeps no compatibility with them.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(metrics=[{"name": "m", "type": attribute}]))


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
            # Only a commit or machine field is searchable (O4), and only a commit field is the
            # UI's display value (D4).
            ("metrics", "searchable", True),
            ("metrics", "display", True),
            ("machine_fields", "display", True),
            # Only a metric is charted on the Dashboard.
            ("commit_fields", "dashboard", False),
            ("machine_fields", "dashboard", False),
            # Only a commit or machine field has a column in the list of its entity.
            ("metrics", "listed", False),
        ],
    )
    def test_a_key_that_means_nothing_for_a_list_is_refused(
        self, list_name: str, key: str, value: Any
    ) -> None:
        # Accepting it silently would leave the author believing it had an effect.
        entry = {"name": "entry", "type": "text", key: value}
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [entry]}))

    @pytest.mark.parametrize(("list_name", "key"), LABELS)
    @pytest.mark.parametrize("value", ["", "a\x00b"])
    def test_a_label_is_refused_when_empty_or_holding_a_nul(
        self, list_name: str, key: str, value: str
    ) -> None:
        # D4: null says there is none, and an empty string could only say the same. D3: a NUL
        # cannot be in any value.
        entry = {"name": "entry", "type": "text", key: value}
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(**{list_name: [entry]}))

    @pytest.mark.parametrize(("list_name", "key"), LABELS)
    @pytest.mark.parametrize("value", [None, " "])
    def test_a_label_may_be_null_or_only_spaces(
        self, list_name: str, key: str, value: str | None
    ) -> None:
        # Spaces are not rejected, nor turned into null: only the empty string is redundant.
        entry = {"name": "entry", "type": "text", key: value}
        parsed = SuiteSchema.model_validate(schema(**{list_name: [entry]}))
        assert getattr(getattr(parsed, list_name)[0], key) == value

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

    @pytest.mark.parametrize("attribute", ["real", "integer", "datetime"])
    def test_only_a_text_field_can_be(self, attribute: str) -> None:
        # D4: the display value stands in for the commit string, which is text.
        entry = {"name": "entry", "type": attribute, "display": True}
        with pytest.raises(ValidationError, match="display field"):
            SuiteSchema.model_validate(schema(commit_fields=[entry]))

    @pytest.mark.parametrize("attribute", ["real", "integer", "datetime"])
    def test_a_non_text_field_may_still_say_it_is_not(self, attribute: str) -> None:
        # The normalized form carries `display: false` on every commit field (D4), so it has to be
        # accepted back on one of any type.
        entry = {"name": "entry", "type": attribute, "display": False}
        SuiteSchema.model_validate(schema(commit_fields=[entry]))


class TestDashboard:
    @pytest.mark.parametrize("attribute", ["real", "integer"])
    def test_a_numeric_metric_can_be_shown(self, attribute: str) -> None:
        parsed = SuiteSchema.model_validate(
            schema(metrics=[{"name": "m", "type": attribute, "dashboard": True}])
        )
        assert parsed.metrics[0].dashboard

    @pytest.mark.parametrize("attribute", ["text", "datetime"])
    def test_nothing_else_can_be(self, attribute: str) -> None:
        # D3: a card charts a geomean, which only a numeric metric has.
        entry = {"name": "m", "type": attribute, "dashboard": True}
        with pytest.raises(ValidationError, match="dashboard"):
            SuiteSchema.model_validate(schema(metrics=[entry]))

    @pytest.mark.parametrize("attribute", ["text", "datetime"])
    def test_a_non_numeric_metric_may_still_say_it_is_not(self, attribute: str) -> None:
        # The normalized form carries `dashboard: false` on every metric (D4).
        SuiteSchema.model_validate(
            schema(metrics=[{"name": "m", "type": attribute, "dashboard": False}])
        )


# Templates the web UI checks against too, so that the two agree. Kept with the
# client's tests, since the client is built from its own directory alone.
URL_TEMPLATES: dict[str, Any] = json.loads(
    (Path(__file__).parents[2] / "client" / "src" / "test" / "url-templates.json").read_text()
)
TEMPLATE_CASES = [
    (key, template, verdict == "valid")
    for key in ("commit_url", "range_url")
    for verdict in ("valid", "invalid")
    for template in URL_TEMPLATES[key][verdict]
]


class TestRepository:
    def test_accepts_every_key(self) -> None:
        parsed = SuiteSchema.model_validate(schema(repository=examples.REPOSITORY))

        assert parsed.model_dump()["repository"] == examples.REPOSITORY

    @pytest.mark.parametrize(("key", "template", "valid"), TEMPLATE_CASES)
    def test_checks_a_url_template(self, key: str, template: str, valid: bool) -> None:
        document = schema(repository={key: template})
        if valid:
            assert SuiteSchema.model_validate(document).repository.model_dump()[key] == template
        else:
            with pytest.raises(ValidationError):
                SuiteSchema.model_validate(document)

    @pytest.mark.parametrize("value", ["", "Git\x00Hub"])
    def test_a_label_is_refused_when_empty_or_holding_a_nul(self, value: str) -> None:
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(repository={"label": value}))

    def test_an_unknown_key_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(repository={"url": "https://example.com/{commit}"}))

    def test_the_block_cannot_be_null(self) -> None:
        # Like a list, it is omitted rather than null, and each of its keys is cleared on its own.
        with pytest.raises(ValidationError):
            SuiteSchema.model_validate(schema(repository=None))


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
                "dashboard": False,
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
                "listed": False,
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
                "listed": False,
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

    def test_names_all_three_lists_and_the_repository_even_when_a_schema_omits_them(self) -> None:
        assert SuiteSchema.model_validate(schema()).model_dump() == {
            "name": "nts",
            "metrics": [],
            "commit_fields": [],
            "machine_fields": [],
            "repository": {"label": None, "commit_url": None, "range_url": None},
        }

    def test_fills_in_every_key_of_the_repository(self) -> None:
        parsed = SuiteSchema.model_validate(schema(repository={"label": "GitHub"}))

        assert parsed.model_dump()["repository"] == {
            "label": "GitHub",
            "commit_url": None,
            "range_url": None,
        }

    def test_round_trips_through_its_own_output(self) -> None:
        # The property endpoints.md relies on: what `GET` returns is what `POST` accepts.
        parsed = SuiteSchema.model_validate(EXAMPLE)

        assert SuiteSchema.model_validate(parsed.model_dump(mode="json")) == parsed
