"""The run submission payload and its validation (D6, D12).

Pure unit tests: `validate_submission` reaches no database, so the suite's schema is built here
rather than through the API. What is interesting is almost all in the edges -- which shapes of
metric value produce which rows, and which are refused.

Two layers reject a bad submission, and the tests say which one they mean. The payload model
answers a malformed *format* with a pydantic `ValidationError`, which the framework renders as R4's
400 (see `errors.py`); `validate_submission` answers a payload that contradicts the suite's schema
with an `ApiError` carrying that code itself.
"""

from __future__ import annotations

import base64
import uuid
from typing import Any

import pytest
from pydantic import ValidationError

from conftest import encoded_profile, run_payload
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites import submission
from lnt_v5.suites.schema import SuiteSchema
from lnt_v5.suites.submission import (
    MAX_ENCODED_PROFILE_SIZE,
    MAX_PROFILE_SIZE,
    RunSubmission,
    ValidatedSubmission,
    decode_profile,
    validate_submission,
)
from lnt_v5.suites.tables import NAME_LENGTH

# A suite declaring one metric of every type D3 offers, plus fields on both entities, so that one
# schema can answer every typing question the tests ask.
NTS = SuiteSchema.model_validate(
    {
        "name": "nts",
        "metrics": [
            {"name": "execution_time", "type": "real"},
            {"name": "compile_status", "type": "integer"},
            {"name": "notes", "type": "text"},
            {"name": "measured_at", "type": "datetime"},
        ],
        "machine_fields": [
            {"name": "hardware", "type": "text"},
            {"name": "core_count", "type": "integer"},
        ],
        "commit_fields": [
            {"name": "author", "type": "text"},
            {"name": "committed_at", "type": "datetime"},
        ],
    }
)

UUID = "550e8400-e29b-41d4-a716-446655440000"


def parsed(**overrides: Any) -> RunSubmission:
    """The payload as the model reads it, without validating it against the schema."""
    return RunSubmission.model_validate(run_payload(**overrides))


def validated(**overrides: Any) -> ValidatedSubmission:
    return validate_submission(NTS, parsed(**overrides))


def refused(**overrides: Any) -> str:
    """The message of the 400 a submission is refused with."""
    with pytest.raises(ApiError) as caught:
        validated(**overrides)
    assert caught.value.code is ErrorCode.INVALID_REQUEST
    return caught.value.message


def one_test(**entry: Any) -> Any:
    """A submission carrying a single test entry, validated."""
    return validated(tests=[{"name": "bench", **entry}]).tests[0]


def refused_test(**entry: Any) -> str:
    return refused(tests=[{"name": "bench", **entry}])


def row(**measured: Any) -> dict[str, Any]:
    """One sample row as validation produces it: every declared metric, null where none was sent.

    A test states the values it cares about and this fills in the rest, because every row carries
    the whole declared set (D6) -- which is the uniformity the write layer's one executemany binds
    to. Written out in full by the two tests that are *about* that, so the fact is stated somewhere
    other than in this helper.
    """
    return {metric.name: None for metric in NTS.metrics} | measured


class TestFormatVersion:
    def test_accepts_the_one_format_that_exists(self) -> None:
        assert parsed().format_version == "5"

    @pytest.mark.parametrize("version", ["4", "", "5.0", 5, None])
    def test_rejects_anything_else(self, version: Any) -> None:
        with pytest.raises(ValidationError):
            parsed(format_version=version)

    def test_requires_it(self) -> None:
        body = run_payload()
        del body["format_version"]
        with pytest.raises(ValidationError):
            RunSubmission.model_validate(body)


class TestUuid:
    def test_keeps_the_one_the_client_supplied(self) -> None:
        assert validated(uuid=UUID).uuid == UUID

    def test_normalizes_to_lowercase(self) -> None:
        assert validated(uuid=UUID.upper()).uuid == UUID

    @pytest.mark.parametrize(
        "version_nibble",
        # D6 accepts any UUID version, so the nibble that names one is not looked at -- v1, v4, v7
        # and the nil UUID's 0 are all submittable.
        ["1", "4", "7", "0", "f"],
    )
    def test_accepts_any_version(self, version_nibble: str) -> None:
        value = f"550e8400-e29b-{version_nibble}1d4-a716-446655440000"
        assert validated(uuid=value).uuid == value

    def test_generates_a_v4_when_omitted(self) -> None:
        generated = validated().uuid
        parsed_uuid = uuid.UUID(generated)
        assert parsed_uuid.version == 4
        assert str(parsed_uuid) == generated

    def test_generates_a_different_one_each_time(self) -> None:
        assert validated().uuid != validated().uuid

    @pytest.mark.parametrize(
        "value",
        [
            "",
            "550e8400e29b41d4a716446655440000",  # unhyphenated
            "{550e8400-e29b-41d4-a716-446655440000}",  # braced
            "urn:uuid:550e8400-e29b-41d4-a716-446655440000",
            "550e8400-e29b-41d4-a716-44665544000",  # a digit short
            "550e8400-e29b-41d4-a716-4466554400000",  # a digit long
            "550e8400-e29b-41d4-a716-44665544000g",  # not hex
            "550e8400e29b-41d4-a716-4466554400000",  # hyphens in the wrong places
            f"{UUID}\n",  # a trailing newline, which an unanchored pattern would admit
            f" {UUID}",
        ],
    )
    def test_rejects_anything_but_the_hyphenated_form(self, value: str) -> None:
        # Deliberately narrower than a UUID library, which would accept the first four of these.
        with pytest.raises(ValidationError):
            parsed(uuid=value)


class TestPayloadShape:
    def test_rejects_an_unknown_top_level_key(self) -> None:
        with pytest.raises(ValidationError):
            parsed(submitted_at="2026-01-01T00:00:00Z")

    @pytest.mark.parametrize("key", ["machine", "commit", "tests"])
    def test_requires_the_keys_a_run_cannot_do_without(self, key: str) -> None:
        body = run_payload()
        del body[key]
        with pytest.raises(ValidationError):
            RunSubmission.model_validate(body)

    def test_accepts_a_run_that_measured_nothing(self) -> None:
        # D6: `tests` is required, but a run with an empty one is a run.
        assert validated(tests=[]).tests == []

    def test_defaults_run_parameters_to_an_empty_object(self) -> None:
        assert validated().run_parameters == {}

    def test_keeps_run_parameters_verbatim(self) -> None:
        # A run has no declared field list, so nothing about the blob is validated or normalized.
        blob = {"build_config": "Release", "jobs": 8, "flags": ["-O2"], "nested": {"a": None}}
        assert validated(run_parameters=blob).run_parameters == blob

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_rejects_a_non_finite_number_in_run_parameters(self, value: float) -> None:
        # D3's rule, reaching into the one blob with no declared shape to enforce it through: JSON
        # has no literal for any of these, yet Python's parser reads all three.
        assert "JSON has no literal" in refused(run_parameters={"x": value})

    def test_refuses_a_commit_tag(self) -> None:
        # D6: a tag is editorial and PATCH-only, so sending one is a 400 rather than a value
        # silently dropped.
        with pytest.raises(ValidationError):
            parsed(commit={"value": "abc123", "tag": "release-18.1"})

    def test_refuses_an_unknown_key_beside_the_entity_object(self) -> None:
        with pytest.raises(ValidationError):
            parsed(machine={"name": "linux", "os": "linux"})


class TestNulCharacter:
    """D3: a value the stored representation cannot hold is a 400, at every place one can arrive.

    The NUL character is D3's second instance of that rule, beside the non-finite numbers.
    PostgreSQL stores it in neither a `text` column nor a `jsonb` value and raises a `DataError`,
    which is neither an integrity failure nor a missing relation -- so nothing attributes it, the
    catch-all handler sees it, and a value the caller supplied comes back as a 500.

    Enumerated per site rather than checked once, because the rule is only worth anything if it
    holds at every one of them: a submission can carry a NUL in either identity attribute, in a
    test name, in a declared field, in a metric, and anywhere inside `run_parameters`.
    """

    @pytest.mark.parametrize(
        "body",
        [
            {"machine": {"name": "lin\x00ux"}},
            {"commit": {"value": "abc\x00123"}},
            {"tests": [{"name": "suite/be\x00nch"}]},
        ],
    )
    def test_rejects_one_in_an_identity_attribute_or_a_test_name(
        self, body: dict[str, Any]
    ) -> None:
        # Refused by the payload model rather than by `validate_submission`, since these are typed
        # independently of the suite's schema.
        with pytest.raises(ValidationError):
            parsed(**body)

    def test_rejects_one_in_a_declared_text_field(self) -> None:
        assert "'hardware' is declared" in refused(
            machine={"name": "linux", "fields": {"hardware": "x86\x0064"}}
        )

    def test_rejects_one_in_a_text_metric(self) -> None:
        assert "'notes' is declared" in refused_test(notes="cle\x00an")

    @pytest.mark.parametrize(
        ("blob", "where"),
        [
            ({"x": "a\x00b"}, "'run_parameters.x'"),
            ({"nested": {"deep": ["fine", "a\x00b"]}}, "'run_parameters.nested.deep[1]'"),
            ({"a\x00b": "fine"}, "a key in 'run_parameters'"),
            ({"nested": {"a\x00b": 1}}, "a key in 'run_parameters.nested'"),
        ],
    )
    def test_rejects_one_anywhere_in_run_parameters(self, blob: dict[str, Any], where: str) -> None:
        # Keys as well as values, and at any depth: a JSONB object key is as much a string the
        # caller chose as the value beside it, and refusing only values would leave the 500 intact.
        message = refused(run_parameters=blob)

        assert "NUL character" in message
        assert where in message


class TestMachineAndCommit:
    def test_carries_the_identity_and_built_in_attributes(self) -> None:
        result = validated(
            machine={"name": "linux", "tracked": False},
            commit={"value": "abc123", "ordinal": 42},
        )
        assert (result.machine.name, result.machine.tracked) == ("linux", False)
        assert (result.commit.value, result.commit.ordinal) == ("abc123", 42)

    def test_defaults_tracked_to_true_and_ordinal_to_none(self) -> None:
        result = validated()
        assert result.machine.tracked is True
        assert result.commit.ordinal is None

    def test_types_fields_against_the_schema(self) -> None:
        result = validated(
            machine={"name": "linux", "fields": {"hardware": "x86_64", "core_count": 8.0}},
            commit={"value": "abc123", "fields": {"author": "Jane"}},
        )
        # `8.0` reaches the column as the integer 8: JSON has one number type (D3).
        assert result.machine.fields == {"hardware": "x86_64", "core_count": 8}
        assert result.commit.fields == {"author": "Jane"}

    @pytest.mark.parametrize(
        ("entity", "body"),
        [
            ("machine", {"name": "linux", "fields": {"hardware": 5}}),
            ("machine", {"name": "linux", "fields": {"core_count": "8"}}),
            ("commit", {"value": "abc123", "fields": {"committed_at": 5}}),
        ],
    )
    def test_rejects_a_field_of_the_wrong_type(self, entity: str, body: dict[str, Any]) -> None:
        assert "is declared" in refused(**{entity: body})

    @pytest.mark.parametrize("value", ["x86_64", None])
    def test_rejects_an_undeclared_field_whatever_its_value(self, value: Any) -> None:
        # Null or not, the key is checked for being declared before it is dropped: a typo must not
        # become a silently accepted no-op.
        message = refused(machine={"name": "linux", "fields": {"hardwear": value}})
        assert "'hardwear' is not declared" in message

    def test_drops_an_explicit_null_field(self) -> None:
        # D6: in a submission a null means "no value submitted", not "clear the stored value" --
        # which is what it means in a PATCH. It is neither written nor compared.
        result = validated(
            machine={"name": "linux", "fields": {"hardware": None, "core_count": 8}},
            commit={"value": "abc123", "fields": {"author": None, "committed_at": None}},
        )
        assert result.machine.fields == {"core_count": 8}
        assert result.commit.fields == {}

    def test_rejects_a_name_no_url_could_address(self) -> None:
        # R1, enforced by the entity objects these nest (see suites/entities.py).
        with pytest.raises(ValidationError):
            parsed(machine={"name": "a/b"})
        with pytest.raises(ValidationError):
            parsed(commit={"value": ".."})


class TestTestNames:
    def test_requires_a_name(self) -> None:
        with pytest.raises(ValidationError):
            parsed(tests=[{"execution_time": 1.0}])

    @pytest.mark.parametrize("name", ["", "a" * (NAME_LENGTH + 1)])
    def test_bounds_the_name(self, name: str) -> None:
        with pytest.raises(ValidationError):
            parsed(tests=[{"name": name}])

    @pytest.mark.parametrize("name", ["a", "a" * NAME_LENGTH, "test.suite/benchmark", ".", ".."])
    def test_does_not_require_the_name_to_be_addressable(self, name: str) -> None:
        # R1 exempts test names deliberately: they legitimately contain '/', and there is no
        # endpoint that could refuse one, since tests are created implicitly.
        assert validated(tests=[{"name": name}]).tests[0].name == name

    def test_rejects_two_entries_naming_one_test(self) -> None:
        message = refused(
            tests=[
                {"name": "bench", "execution_time": 1.0},
                {"name": "bench", "execution_time": 2.0},
            ]
        )
        assert "two test entries name 'bench'" in message

    def test_keeps_the_order_the_submission_gave(self) -> None:
        result = validated(tests=[{"name": "c"}, {"name": "a"}, {"name": "b"}])
        assert [test.name for test in result.tests] == ["c", "a", "b"]


class TestMetricValues:
    def test_reads_a_scalar_of_each_declared_type(self) -> None:
        test = one_test(
            execution_time=1.5,
            compile_status=0,
            notes="clean",
            measured_at="2026-04-15T14:30:00Z",
        )
        [sample] = test.samples
        assert sample["execution_time"] == 1.5
        assert sample["compile_status"] == 0
        assert sample["notes"] == "clean"
        assert sample["measured_at"].isoformat() == "2026-04-15T14:30:00+00:00"

    def test_reads_a_whole_number_as_an_integer(self) -> None:
        # D3's leniency, reused from the declared-field path.
        assert one_test(compile_status=8.0).samples[0]["compile_status"] == 8

    def test_reads_an_integer_as_a_real(self) -> None:
        # The other direction of D3's leniency: JSON has one number type, so a producer that
        # happens to measure exactly 2 seconds writes `2`.
        value = one_test(execution_time=2).samples[0]["execution_time"]
        assert isinstance(value, float)
        assert value == 2.0

    @pytest.mark.parametrize(
        ("metric", "value"),
        [
            ("execution_time", "1.5"),
            ("execution_time", True),
            ("compile_status", 8.5),
            ("compile_status", "8"),
            ("notes", 5),
            ("measured_at", 5),
            ("measured_at", "not a date"),
        ],
    )
    def test_rejects_a_value_of_the_wrong_type(self, metric: str, value: Any) -> None:
        message = refused_test(**{metric: value})
        assert message.startswith("test 'bench': ")
        assert f"'{metric}' is declared" in message

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_rejects_a_non_finite_real(self, value: float) -> None:
        # D3: JSON has no literal for any of these, and none survives the round trip -- a stored
        # one comes back as `null`, indistinguishable from a metric the sample does not have.
        assert "'execution_time' is declared" in refused_test(execution_time=value)

    def test_rejects_a_non_finite_element_of_an_array(self) -> None:
        assert "'execution_time' is declared" in refused_test(execution_time=[1.0, float("nan")])

    def test_rejects_an_undeclared_metric(self) -> None:
        message = refused_test(execution_tmie=1.0)
        assert "'execution_tmie' is not declared in this test suite's metrics" in message
        assert "execution_time" in message  # the message lists what is declared

    def test_rejects_a_null_metric(self) -> None:
        # D6: a metric with no value is omitted, not sent as null.
        assert "'execution_time' is null" in refused_test(execution_time=None)

    def test_names_the_test_the_failure_is_about(self) -> None:
        message = refused(
            tests=[{"name": "good", "execution_time": 1.0}, {"name": "bad", "execution_time": "x"}]
        )
        assert message.startswith("test 'bad': ")


class TestSampleRows:
    def test_an_entry_with_no_arrays_yields_one_row(self) -> None:
        assert one_test(execution_time=1.5).samples == [row(execution_time=1.5)]

    def test_an_entry_with_no_metrics_yields_one_row_of_nulls(self) -> None:
        # D6: the row records that the test ran in this run even when it measured nothing, and
        # every declared metric is present and null -- which is what "no value" means.
        assert one_test().samples == [
            {
                "execution_time": None,
                "compile_status": None,
                "notes": None,
                "measured_at": None,
            }
        ]

    def test_an_entry_carrying_only_a_profile_yields_one_row_of_nulls(self) -> None:
        test = one_test(profile=encoded_profile(0, 0))
        assert test.samples == [row()]
        assert test.profile is not None

    def test_every_row_carries_the_same_keys_whatever_the_entry_sent(self) -> None:
        # The invariant the write layer binds its one executemany to: SQLAlchemy Core takes its
        # column list from the first mapping, so rows that disagree on their keys would write the
        # wrong columns. Established here rather than repaired by whoever writes them.
        entries: list[dict[str, Any]] = [
            {},
            {"execution_time": 1.5},
            {"notes": "clean", "compile_status": [0, 1]},
        ]
        declared = {metric.name for metric in NTS.metrics}

        for entry in entries:
            for sample in one_test(**entry).samples:
                assert set(sample) == declared

    def test_an_array_yields_one_row_per_element(self) -> None:
        assert one_test(execution_time=[0.1, 0.2, 0.3]).samples == [
            row(execution_time=0.1),
            row(execution_time=0.2),
            row(execution_time=0.3),
        ]

    def test_a_single_element_array_yields_one_row(self) -> None:
        assert one_test(execution_time=[0.1]).samples == [row(execution_time=0.1)]

    def test_repeats_scalars_across_the_rows(self) -> None:
        assert one_test(execution_time=[0.1, 0.2], notes="clean").samples == [
            row(execution_time=0.1, notes="clean"),
            row(execution_time=0.2, notes="clean"),
        ]

    def test_reads_arrays_of_equal_length_side_by_side(self) -> None:
        assert one_test(execution_time=[0.1, 0.2], compile_status=[0, 1]).samples == [
            row(execution_time=0.1, compile_status=0),
            row(execution_time=0.2, compile_status=1),
        ]

    def test_types_every_element(self) -> None:
        assert one_test(compile_status=[8.0, 9]).samples == [
            row(compile_status=8),
            row(compile_status=9),
        ]
        assert "'compile_status' is declared" in refused_test(compile_status=[0, "1"])

    def test_rejects_arrays_of_different_lengths(self) -> None:
        message = refused_test(execution_time=[0.1, 0.2], compile_status=[0])
        assert "must be the same length" in message

    def test_rejects_an_empty_array(self) -> None:
        # D6: it would produce no rows at all, silently discarding the scalar metrics beside it.
        message = refused_test(execution_time=[], notes="clean")
        assert "'execution_time' is an empty array" in message

    def test_rejects_a_null_element(self) -> None:
        assert "'execution_time' is null" in refused_test(execution_time=[0.1, None])


class TestProfiles:
    def test_decodes_the_blob(self) -> None:
        assert one_test(profile=encoded_profile(1, 2, 3)).profile == bytes([2, 1, 2, 3])

    def test_accepts_a_blob_that_is_only_a_version_byte(self) -> None:
        assert one_test(profile=encoded_profile()).profile == bytes([2])

    @pytest.mark.parametrize("value", [None, ...])
    def test_an_entry_without_one_carries_no_profile(self, value: Any) -> None:
        # Explicit null and omission mean the same thing: no profile.
        entry = {} if value is ... else {"profile": value}
        assert one_test(**entry).profile is None

    @pytest.mark.parametrize("value", ["not base64!", "AAA", "====", "é"])
    def test_rejects_anything_that_is_not_base64(self, value: str) -> None:
        # Strict decoding: Python's lenient mode discards characters outside the alphabet, which
        # would turn a payload that is not base64 at all into whatever remained.
        assert "profile is not valid base64" in refused_test(profile=value)

    def test_accepts_line_wrapped_base64(self) -> None:
        # D12 makes whitespace insignificant, which is what it takes to accept the producers that
        # actually exist: `base64(1)` wraps at 76 columns by default, and so does every MIME
        # encoder. Nothing is lost by stripping it, because what is left is still decoded strictly.
        blob = base64.b64encode(bytes([2, *range(200)])).decode()
        wrapped = "\n".join(blob[index : index + 76] for index in range(0, len(blob), 76))

        assert len(wrapped) > len(blob)  # the wrapping is actually there
        assert one_test(profile=wrapped).profile == bytes([2, *range(200)])

    @pytest.mark.parametrize("spacing", [" ", "\t", "\r\n", "\n\n"])
    def test_accepts_any_ascii_whitespace_anywhere_in_the_blob(self, spacing: str) -> None:
        blob = encoded_profile(1, 2, 3)
        spaced = spacing + spacing.join(blob) + spacing

        assert one_test(profile=spaced).profile == bytes([2, 1, 2, 3])

    @pytest.mark.parametrize("spacing", ["\u00a0", "\u2003"])
    def test_still_rejects_whitespace_from_outside_ascii(self, spacing: str) -> None:
        # The strip is deliberately the ASCII set rather than `str.split()`'s: a non-breaking space
        # or an em space is a character outside the alphabet, which is exactly what strict decoding
        # is there to report rather than quietly drop.
        assert "profile is not valid base64" in refused_test(
            profile=spacing + encoded_profile(1, 2, 3)
        )

    def test_rejects_an_empty_profile(self) -> None:
        assert "profile is empty" in refused_test(profile="")

    def test_rejects_a_profile_of_another_format_version(self) -> None:
        blob = base64.b64encode(bytes([1, 2, 3])).decode()
        assert "declares format version 1" in refused_test(profile=blob)

    def test_rejects_one_larger_than_the_cap_before_decoding_it(self) -> None:
        # The encoded-length gate: 4 characters carry 3 bytes, so a longer string cannot decode to
        # anything within the cap, and refusing here avoids materializing ~50 MB to find out.
        assert "larger than" in refused_test(profile="A" * (MAX_ENCODED_PROFILE_SIZE + 1))

    def test_measures_the_encoded_cap_after_removing_the_whitespace(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Line breaks are not payload, so the gate has to be applied to what is left once they are
        # gone: measuring the string as it arrived would refuse a wrapped profile for a size it
        # does not have -- and wrapping is what the common producers do.
        monkeypatch.setattr(submission, "MAX_ENCODED_PROFILE_SIZE", 5)
        blob = encoded_profile(1, 2)
        wrapped = "\n".join(blob)

        assert len(wrapped) > 5 >= len(blob)
        assert decode_profile(wrapped) == bytes([2, 1, 2])

    def test_rejects_one_larger_than_the_cap_after_decoding_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The gate above admits up to two bytes more than the cap, so this check is what makes
        # `MAX_PROFILE_SIZE` exact. Both caps are lowered rather than a 50 MB blob built, since the
        # window between them is two bytes wide.
        monkeypatch.setattr(submission, "MAX_PROFILE_SIZE", 2)
        monkeypatch.setattr(submission, "MAX_ENCODED_PROFILE_SIZE", 1000)
        assert "larger than" in refused_test(profile=encoded_profile(1, 2))

    def test_the_encoded_cap_admits_every_blob_the_decoded_cap_does(self) -> None:
        # Stated as arithmetic rather than by encoding 50 MB: base64 spends 4 characters on every
        # 3 bytes, rounded up to a whole group.
        assert len(base64.b64encode(b"x" * MAX_PROFILE_SIZE)) == MAX_ENCODED_PROFILE_SIZE


class TestDecodeProfile:
    """`decode_profile` on its own, for the one caller that is not a test entry."""

    def test_returns_the_bytes(self) -> None:
        assert decode_profile(encoded_profile(7)) == bytes([2, 7])

    def test_raises_the_r4_code_for_a_bad_request(self) -> None:
        with pytest.raises(ApiError) as caught:
            decode_profile("nope")
        assert caught.value.code is ErrorCode.INVALID_REQUEST
