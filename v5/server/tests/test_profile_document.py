"""D12's profile document (`suites.profile_document`): decoding, validation, what is stored.

Pure unit tests: nothing here touches a database. A function's stored instructions are checked by
reading them back with `instructions`, since their encoding is the server's own business -- what
D12 promises is that the profile is served as the document described it.
"""

from __future__ import annotations

import base64
import gzip
import json
from typing import Any

import pytest

from conftest import encoded_profile
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.suites import profile_document
from lnt_v5.suites.profile_document import (
    MAX_COMPRESSED_SIZE,
    MAX_ENCODED_SIZE,
    MAX_FUNCTION_NAME_BYTES,
    MAX_FUNCTIONS,
    MAX_INSTRUCTIONS,
    StoredFunction,
    StoredProfile,
    instructions,
    stored_profile,
)
from lnt_v5.suites.tables import INTEGER_MAX


def instruction(address: float = 0, text: str = "ret", **counters: Any) -> dict[str, Any]:
    return {"address": address, "counters": counters or {"cycles": 1}, "text": text}


def document(*functions: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    """A profile document with these functions; by default one function of one instruction."""
    if not functions:
        functions = ({"name": "main", "instructions": [instruction()]},)
    return {
        "disassembly_format": "raw",
        "counters": {"cycles": 10},
        "functions": list(functions),
    } | (overrides)


def stored(value: dict[str, Any] | bytes | str) -> StoredProfile:
    """What a document is stored as."""
    encoded = value if isinstance(value, str) else encoded_profile(value)
    return stored_profile(encoded)


def function(profile: StoredProfile, name: str) -> StoredFunction:
    return next(function for function in profile.functions if function.name == name)


def read_back(value: dict[str, Any], name: str = "main") -> list[dict[str, Any]]:
    """One function's instructions, as a document lists them, once stored and read back."""
    return [
        {"address": address, "counters": counters, "text": text}
        for address, counters, text in instructions(function(stored(value), name).instructions)
    ]


def refused(value: dict[str, Any] | bytes | str) -> str:
    """The message of the 400 a profile is refused with."""
    encoded = value if isinstance(value, str) else encoded_profile(value)
    with pytest.raises(ApiError) as caught:
        stored_profile(encoded)
    assert caught.value.code is ErrorCode.INVALID_REQUEST
    assert caught.value.message.startswith("profile: ")
    return caught.value.message


class TestWhatIsStored:
    def test_reads_back_as_the_document_described(self) -> None:
        listed = [
            instruction(0x1000, "push rbp", cycles=1200, instructions=900),
            instruction(0x1004, "ret", cycles=300, instructions=450),
        ]
        value = document(
            {"name": "main", "instructions": listed},
            disassembly_format="llvm-objdump",
            counters={"cycles": 9123456, "instructions": INTEGER_MAX},
        )

        profile = stored(value)

        assert profile.disassembly_format == "llvm-objdump"
        assert profile.counters == {"cycles": 9123456, "instructions": INTEGER_MAX}
        assert read_back(value) == listed

    def test_derives_a_functions_counters_as_the_sums_over_its_instructions(self) -> None:
        main = function(
            stored(
                document(
                    {
                        "name": "main",
                        "instructions": [
                            instruction(0, cycles=1.5, misses=2),
                            instruction(4, cycles=2.5, misses=0),
                        ],
                    },
                    counters={"cycles": 10, "misses": 10},
                )
            ),
            "main",
        )

        assert main.counters == {"cycles": 4.0, "misses": 2.0}
        assert main.length == 2

    def test_a_function_may_carry_fewer_counters_than_the_profile(self) -> None:
        profile = stored(
            document(
                {"name": "f", "instructions": [instruction(cycles=1)]},
                counters={"cycles": 10, "misses": 10},
            )
        )

        assert function(profile, "f").counters == {"cycles": 1.0}

    def test_a_function_with_no_instructions_has_no_counters(self) -> None:
        value = document({"name": "empty", "instructions": []})
        empty = function(stored(value), "empty")

        assert (empty.counters, empty.length) == ({}, 0)
        assert read_back(value, "empty") == []

    def test_a_profile_may_list_no_functions(self) -> None:
        # Five of the 199 profiles sampled from lnt.llvm.org are like this.
        assert stored(document(functions=[])).functions == []

    def test_keeps_the_functions_in_the_order_the_document_lists_them(self) -> None:
        names = ["zeta", "alpha", "middle"]
        profile = stored(document(*({"name": name, "instructions": []} for name in names)))

        assert [function.name for function in profile.functions] == names

    def test_counter_values_are_kept_exactly(self) -> None:
        value = document({"name": "f", "instructions": [instruction(cycles=123456789.1)]})

        assert read_back(value, "f")[0]["counters"] == {"cycles": 123456789.1}

    def test_instructions_may_carry_no_counters(self) -> None:
        listed = [
            {"address": 0, "counters": {}, "text": "nop"},
            {"address": 4, "counters": {}, "text": "ret"},
        ]
        value = document({"name": "f", "instructions": listed})

        assert read_back(value, "f") == listed
        assert function(stored(value), "f").counters == {}

    def test_reads_numbers_as_d3_does(self) -> None:
        # An integer is accepted where a count is a real, and `8.0` where an integer is expected.
        value = document(
            counters={"cycles": 8.0},
            functions=[{"name": "f", "instructions": [instruction(cycles=3) | {"address": 4.0}]}],
        )

        assert stored(value).counters == {"cycles": 8}
        assert read_back(value, "f") == [instruction(4, cycles=3.0)]

    def test_addresses_may_go_in_any_order(self) -> None:
        # Instructions are kept in the order the document lists them, whatever their addresses.
        listed = [instruction(8), instruction(8), instruction(4), instruction(INTEGER_MAX)]

        assert read_back(document({"name": "f", "instructions": listed}), "f") == listed

    def test_any_text_without_a_nul_survives(self) -> None:
        name = "std::operator/(λ const&, ünïcode) &\nsecond line"
        listed = [instruction(text=""), instruction(text="a\nb\tc")]

        assert read_back(document({"name": name, "instructions": listed}), name) == listed


class TestEncoding:
    """Base64 around exactly one gzip member (D12)."""

    @pytest.mark.parametrize("value", ["not base64!", "AAA", "====", "é"])
    def test_refuses_anything_that_is_not_base64(self, value: str) -> None:
        # Strict decoding: Python's lenient mode discards characters outside the alphabet, which
        # would turn a payload that is not base64 at all into whatever remained.
        assert "not valid base64" in refused(value)

    def test_accepts_line_wrapped_base64(self) -> None:
        # D12 makes whitespace insignificant, which is what it takes to accept `base64(1)` and every
        # MIME encoder, which wrap at 76 columns.
        encoded = encoded_profile(document())
        wrapped = "\n".join(encoded[index : index + 76] for index in range(0, len(encoded), 76))

        assert wrapped != encoded
        assert stored(wrapped) == stored(encoded)

    @pytest.mark.parametrize("spacing", [" ", "\t", "\r\n"])
    def test_accepts_any_ascii_whitespace_anywhere(self, spacing: str) -> None:
        encoded = encoded_profile(document())

        assert stored(spacing + spacing.join(encoded) + spacing) == stored(encoded)

    @pytest.mark.parametrize("spacing", ["\u00a0", "\u2003"])
    def test_still_refuses_whitespace_from_outside_ascii(self, spacing: str) -> None:
        assert "not valid base64" in refused(spacing + encoded_profile(document()))

    def test_refuses_a_document_that_is_not_compressed(self) -> None:
        plain = base64.b64encode(json.dumps(document()).encode()).decode()

        assert "not valid gzip data" in refused(plain)

    @pytest.mark.parametrize("value", ["", base64.b64encode(gzip.compress(b"{}")[:-4]).decode()])
    def test_refuses_a_gzip_stream_that_stops_early(self, value: str) -> None:
        assert "ends before its data does" in refused(value)

    def test_refuses_a_second_gzip_member(self) -> None:
        raw = json.dumps(document()).encode()
        twice = base64.b64encode(gzip.compress(raw) + gzip.compress(raw)).decode()

        assert "data follows the end of the gzip stream" in refused(twice)


class TestSizes:
    def test_refuses_an_encoding_longer_than_the_cap_before_decoding_it(self) -> None:
        assert "larger than the 4194304 byte limit" in refused("A" * (MAX_ENCODED_SIZE + 1))

    def test_measures_the_encoding_once_its_whitespace_is_gone(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        encoded = encoded_profile(document())
        monkeypatch.setattr(profile_document, "MAX_ENCODED_SIZE", len(encoded))

        assert stored("\n".join(encoded)) == stored(encoded)

    def test_refuses_a_compressed_document_over_the_cap(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The encoded gate admits up to two bytes more than the cap, so this check is what makes
        # the cap exact.
        encoded = encoded_profile(document())
        monkeypatch.setattr(
            profile_document, "MAX_COMPRESSED_SIZE", len(base64.b64decode(encoded)) - 1
        )

        assert "byte limit on a compressed profile" in refused(encoded)

    def test_the_encoded_cap_admits_every_document_the_compressed_cap_does(self) -> None:
        assert len(base64.b64encode(b"x" * MAX_COMPRESSED_SIZE)) == MAX_ENCODED_SIZE

    def test_refuses_a_document_that_decompresses_beyond_the_cap(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A compression bomb in miniature: a megabyte of spaces compresses to about a kilobyte.
        monkeypatch.setattr(profile_document, "MAX_DOCUMENT_SIZE", 1000)

        assert "byte limit on a decompressed profile" in refused(b" " * 1_000_000)


class TestDocument:
    def test_refuses_what_is_not_json(self) -> None:
        assert "not a valid profile document" in refused(b"{not json")

    @pytest.mark.parametrize(
        "broken",
        [
            pytest.param({"counters": {}, "functions": []}, id="missing key"),
            pytest.param(document(extra=1), id="extra key"),
            pytest.param(document(counters={"cycles": -1}), id="negative top-level counter"),
            pytest.param(document(counters={"cycles": 1.5}), id="fractional top-level counter"),
            pytest.param(
                document(counters={"cycles": INTEGER_MAX + 1}), id="top-level counter too wide"
            ),
            pytest.param(document(counters={"cycles": True}), id="boolean top-level counter"),
            pytest.param(document(counters={"": 1}), id="empty counter name"),
            pytest.param(document({"name": "", "instructions": []}), id="empty function name"),
            pytest.param(
                document({"name": "f", "instructions": [instruction(cycles=-1)]}),
                id="negative count",
            ),
            pytest.param(
                document({"name": "f", "instructions": [instruction(cycles="1")]}),
                id="string count",
            ),
            pytest.param(
                document({"name": "f", "instructions": [instruction(address=-4)]}),
                id="negative address",
            ),
            pytest.param(
                document({"name": "f", "instructions": [instruction(address=4.5)]}),
                id="fractional address",
            ),
            pytest.param(
                document({"name": "f", "instructions": [instruction(address=INTEGER_MAX + 1)]}),
                id="address too wide",
            ),
            pytest.param(
                document({"name": "f", "instructions": [instruction(address=2.0**64)]}),
                id="whole-number address too wide",
            ),
            pytest.param(
                document({"name": "f", "instructions": [instruction() | {"extra": 1}]}),
                id="extra instruction key",
            ),
        ],
    )
    def test_refuses_a_document_of_the_wrong_shape(self, broken: dict[str, Any]) -> None:
        assert "not a valid profile document" in refused(broken)

    def test_refuses_a_non_finite_count(self) -> None:
        # Python's JSON writer emits `NaN`, which is not JSON but which some parsers accept.
        raw = json.dumps(
            document({"name": "f", "instructions": [instruction(cycles=float("nan"))]})
        )

        assert "not a valid profile document" in refused(raw.encode())

    @pytest.mark.parametrize("field", ["address", "count", "top-level counter"])
    def test_refuses_a_number_too_large_to_be_finite(self, field: str) -> None:
        # Valid JSON, but no finite double holds it.
        raw = {
            "address": json.dumps(document()).replace('"address": 0', '"address": 1e400'),
            "count": json.dumps(document()).replace('{"cycles": 1}', '{"cycles": 1e400}'),
            "top-level counter": json.dumps(document()).replace(
                '{"cycles": 10}', '{"cycles": 1e400}'
            ),
        }[field]

        assert "1e400" in raw
        assert "not a valid profile document" in refused(raw.encode())

    def test_refuses_counts_whose_sum_is_not_finite(self) -> None:
        # Each value is finite, but the function's derived counter would not be.
        summed = document(
            {"name": "f", "instructions": [instruction(cycles=1e308), instruction(cycles=1e308)]}
        )

        assert "counters sum to more than a finite number can hold" in refused(summed)

    def test_refuses_a_document_that_is_not_utf_8(self) -> None:
        assert "not a valid profile document" in refused(b'{"disassembly_format": "\xff"}')

    @pytest.mark.parametrize(
        "broken",
        [
            pytest.param(document(disassembly_format="raw\x00"), id="format"),
            pytest.param(document(counters={"cyc\x00les": 1}), id="counter name"),
            pytest.param(document({"name": "f\x00", "instructions": []}), id="function name"),
            pytest.param(
                document({"name": "f", "instructions": [instruction(text="a\x00b")]}), id="text"
            ),
        ],
    )
    def test_refuses_a_nul_in_any_string(self, broken: dict[str, Any]) -> None:
        # D3 refuses a NUL in every string a request carries.
        assert "NUL" in refused(broken)

    def test_refuses_two_functions_of_the_same_name(self) -> None:
        twice = {"name": "f", "instructions": []}

        assert "two functions have the same name" in refused(document(twice, twice))

    def test_refuses_instructions_carrying_different_counters(self) -> None:
        mixed = document(
            {"name": "f", "instructions": [instruction(cycles=1), instruction(misses=1)]}
        )

        assert "every instruction of a function carries the same counters" in refused(mixed)

    def test_refuses_an_instruction_counter_the_top_level_does_not_carry(self) -> None:
        stray = document({"name": "f", "instructions": [instruction(misses=1)]})

        assert "not top-level counters" in refused(stray)

    def test_refuses_a_profile_of_too_many_functions(self) -> None:
        many = document(
            *({"name": f"f{index}", "instructions": []} for index in range(MAX_FUNCTIONS + 1))
        )

        assert "not a valid profile document" in refused(many)

    def test_accepts_a_profile_of_as_many_functions_as_the_cap(self) -> None:
        most = document(
            *({"name": f"f{index}", "instructions": []} for index in range(MAX_FUNCTIONS))
        )

        assert len(stored(most).functions) == MAX_FUNCTIONS

    def test_refuses_a_function_name_too_long_to_be_asked_for(self) -> None:
        # Measured in UTF-8 bytes, which is what percent-encoding multiplies: 1,025 two-byte
        # characters are over the cap.
        long = document({"name": "é" * (MAX_FUNCTION_NAME_BYTES // 2 + 1), "instructions": []})

        assert f"longer than {MAX_FUNCTION_NAME_BYTES} bytes" in refused(long)

    def test_accepts_a_function_name_as_long_as_the_cap(self) -> None:
        name = "a" * MAX_FUNCTION_NAME_BYTES

        assert stored(document({"name": name, "instructions": []})).functions[0].name == name

    def test_refuses_a_function_of_too_many_instructions(self) -> None:
        many = document(
            {
                "name": "f",
                "instructions": [instruction(index) for index in range(MAX_INSTRUCTIONS + 1)],
            }
        )

        assert "not a valid profile document" in refused(many)
