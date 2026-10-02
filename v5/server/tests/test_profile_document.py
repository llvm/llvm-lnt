"""D12's profile document (`suites.profile_document`): decoding, validation, what is stored.

Pure unit tests: nothing here touches a database. What comes out of `stored_profile` is checked by
reading it back with the format reader, since the stored encoding is the server's own business --
what D12 promises is that the profile reads back as the document described it.
"""

from __future__ import annotations

import base64
import gzip
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from conftest import encoded_profile, single
from lnt_v5 import profile_format
from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.profile_format import MAX_INSTRUCTIONS, Instruction, Profile, read_profile
from lnt_v5.suites import profile_document
from lnt_v5.suites.profile_document import (
    MAX_COMPRESSED_SIZE,
    MAX_ENCODED_SIZE,
    MAX_FUNCTIONS,
    stored_profile,
)


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


def stored(value: dict[str, Any] | bytes | str) -> Profile:
    """What a document reads back as once stored."""
    encoded = value if isinstance(value, str) else encoded_profile(value)
    return read_profile(stored_profile(encoded))


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
        profile = stored(
            document(
                {
                    "name": "main",
                    "instructions": [
                        instruction(0x1000, "push rbp", cycles=1200, instructions=900),
                        instruction(0x1004, "ret", cycles=300, instructions=450),
                    ],
                },
                disassembly_format="llvm-objdump",
                counters={"cycles": 9123456, "instructions": 2**63},
            )
        )

        assert profile.disassembly_format == "llvm-objdump"
        assert profile.counters == {"cycles": 9123456, "instructions": 2**63}
        assert list(profile.instructions("main")) == [
            Instruction(
                address=0x1000, counters={"cycles": 1200, "instructions": 900}, text="push rbp"
            ),
            Instruction(address=0x1004, counters={"cycles": 300, "instructions": 450}, text="ret"),
        ]

    def test_derives_a_functions_counters_as_the_sums_over_its_instructions(self) -> None:
        profile = stored(
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
        )

        assert profile.functions["main"].counters == {"cycles": 4.0, "misses": 2.0}
        assert profile.functions["main"].length == 2

    def test_a_function_may_carry_fewer_counters_than_the_profile(self) -> None:
        profile = stored(
            document(
                {"name": "f", "instructions": [instruction(cycles=1)]},
                counters={"cycles": 10, "misses": 10},
            )
        )

        assert profile.functions["f"].counters == {"cycles": 1.0}

    def test_a_function_with_no_instructions_has_no_counters(self) -> None:
        profile = stored(document({"name": "empty", "instructions": []}))

        assert profile.functions["empty"].counters == {}
        assert profile.functions["empty"].length == 0

    def test_a_profile_may_list_no_functions(self) -> None:
        # Five of the 199 profiles sampled from lnt.llvm.org are like this.
        assert stored(document(functions=[])).functions == {}

    def test_counter_values_are_kept_to_single_precision(self) -> None:
        profile = stored(document({"name": "f", "instructions": [instruction(cycles=123456789.0)]}))

        assert profile.instructions("f")[0].counters == {"cycles": single(123456789.0)}

    def test_reads_numbers_as_d3_does(self) -> None:
        # An integer is accepted where a count is a real, and `8.0` where an integer is expected.
        profile = stored(
            document(
                counters={"cycles": 8.0},
                functions=[
                    {"name": "f", "instructions": [instruction(cycles=3) | {"address": 4.0}]}
                ],
            )
        )

        assert profile.counters == {"cycles": 8}
        assert profile.instructions("f")[0].address == 4

    def test_addresses_may_repeat(self) -> None:
        # Only a decrease is refused.
        profile = stored(document({"name": "f", "instructions": [instruction(8), instruction(8)]}))

        assert [one.address for one in profile.instructions("f")] == [8, 8]

    def test_any_text_without_a_newline_or_a_nul_survives(self) -> None:
        name = "std::operator/(λ const&, ünïcode) &"
        profile = stored(document({"name": name, "instructions": [instruction(text="")]}))

        assert profile.instructions(name)[0].text == ""


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
        assert stored(wrapped).functions.keys() == {"main"}

    @pytest.mark.parametrize("spacing", [" ", "\t", "\r\n"])
    def test_accepts_any_ascii_whitespace_anywhere(self, spacing: str) -> None:
        encoded = encoded_profile(document())

        assert stored(spacing + spacing.join(encoded) + spacing).functions.keys() == {"main"}

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

        assert stored("\n".join(encoded)).functions.keys() == {"main"}

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
            pytest.param(document(counters={"cycles": 2**64}), id="top-level counter too wide"),
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
                document({"name": "f", "instructions": [instruction(address=2**64)]}),
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

    def test_refuses_a_document_that_is_not_utf_8(self) -> None:
        assert "not a valid profile document" in refused(b'{"disassembly_format": "\xff"}')

    @pytest.mark.parametrize(
        "broken",
        [
            pytest.param(document(disassembly_format="raw\n"), id="format"),
            pytest.param(document(counters={"cyc\nles": 1}), id="counter name"),
            pytest.param(document({"name": "f\n", "instructions": []}), id="function name"),
            pytest.param(
                document({"name": "f", "instructions": [instruction(text="a\nb")]}), id="text"
            ),
        ],
    )
    def test_refuses_a_newline_in_any_string(self, broken: dict[str, Any]) -> None:
        assert "must not contain a newline" in refused(broken)

    def test_refuses_a_nul_in_any_string(self) -> None:
        # D3 refuses a NUL in every string a request carries.
        broken = document({"name": "f", "instructions": [instruction(text="a\x00b")]})

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

    def test_refuses_an_address_lower_than_the_one_before_it(self) -> None:
        backwards = document({"name": "f", "instructions": [instruction(8), instruction(4)]})

        assert "addresses never decrease within a function" in refused(backwards)

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

    def test_refuses_a_function_of_too_many_instructions(self) -> None:
        many = document(
            {
                "name": "f",
                "instructions": [instruction(index) for index in range(MAX_INSTRUCTIONS + 1)],
            }
        )

        assert "not a valid profile document" in refused(many)

    def test_refuses_a_count_single_precision_cannot_hold(self) -> None:
        huge = document({"name": "f", "instructions": [instruction(cycles=1e39)]})

        assert "not a valid profile document" in refused(huge)

    def test_refuses_counts_whose_sum_single_precision_cannot_hold(self) -> None:
        # Each value fits, but the function's derived counter does not.
        summed = document(
            {"name": "f", "instructions": [instruction(cycles=3e38), instruction(cycles=3e38)]}
        )

        assert "counters sum to" in refused(summed)


class TestConcurrency:
    def test_encodes_one_profile_at_a_time(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The writer is the last step and the encoding's peak, so a slow stand-in for it shows
        # whether two encodings ever overlap.
        guard = threading.Lock()
        running = 0
        most = 0
        write = profile_format.write_profile

        def slow_write(*args: Any) -> bytes:
            nonlocal running, most
            with guard:
                running += 1
                most = max(most, running)
            time.sleep(0.05)
            with guard:
                running -= 1
            return write(*args)

        monkeypatch.setattr(profile_document, "write_profile", slow_write)
        encoded = encoded_profile(document())
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(stored_profile, [encoded] * 4))

        assert most == 1

    def test_a_refused_profile_does_not_keep_the_next_one_waiting(self) -> None:
        refused(b"{not json")

        assert profile_document._ENCODING.acquire(blocking=False)
        profile_document._ENCODING.release()
