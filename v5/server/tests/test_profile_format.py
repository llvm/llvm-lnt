"""D12's profile binary format reader (`lnt_v5.profile_format`).

Pure unit tests: the reader touches no database and no request.

The blobs at the top were produced by v4's own writer (`lnt/testing/profile/profilev2impl.py`, at
the root of this repository) and are embedded rather than generated, so what is tested is the
format as it exists in the wild rather than the format as this tree imagines it. Everything else is
surgery on those blobs: `sections` takes one apart, `rebuilt` puts one back together, and the
corruption tests replace one piece in between. `test_taking_a_blob_apart_and_back_together_is_exact`
is what keeps that surgery honest -- if it stopped producing byte-identical blobs, every corruption
test below would be testing something other than the corruption it names.
"""

from __future__ import annotations

import base64
import bz2
from collections.abc import Sequence

import pytest

from lnt_v5 import profile_format
from lnt_v5.profile_format import PROFILE_FORMAT_VERSION, ProfileError, read_profile

# A profile of three functions written by v4 from this ProfileV1 data:
#
#     {'counters': {'cycles': 1234567, 'branch-misses': 890, 'instructions': 9999},
#      'disassembly-format': 'llvm-objdump',
#      'functions': {
#        'main': {'counters': {'cycles': 100.0, 'branch-misses': 2.0, 'instructions': 12.5},
#                 'data': [[{'cycles': 50.0, 'branch-misses': 1.0, 'instructions': 4.0},
#                           0x1000, 'push rbp'],
#                          [{'cycles': 25.0, 'branch-misses': 0.5, 'instructions': 4.0},
#                           0x1004, 'add r0, r0, r1'],
#                          [{'cycles': 25.0, 'branch-misses': 0.5, 'instructions': 4.0},
#                           0x1008, 'add r0, r0, r1'],
#                          [{'cycles': 0.0, 'branch-misses': 0.0, 'instructions': 0.5},
#                           0x2000, 'ret']]},
#        '_Z3foov': {'counters': {'cycles': 50.0},
#                    'data': [[{'cycles': 30.0}, 0x3000, 'add r0, r0, r1'],
#                             [{'cycles': 20.0}, 0x3004, 'ret']]},
#        'no_instructions': {'counters': {'cycles': 0.0}, 'data': []}}}
#
# Between them those cover what the interesting paths need: a counter set that is a strict subset
# of the pool (`_Z3foov`), text repeated within and across functions so the pool is really shared,
# a gap in the addresses, a fractional value, a zero value, and a function with no instructions.
GOLDEN = (
    "AgANDSMwCztEfzSzASncAUEKnQJHbGx2bS1vYmpkdW1wCgNicmFuY2gtbWlzc2VzCmN5Y2xlcwppbnN0cnVjdGlvbnMK"
    "AwD6BgGHrUsCj05CWmg5MUFZJlNZTDzkeAAADsB0zABEA5AAQABAAABEIAAxANAAlT0gaeiQqLXJG8jkxKYMEGCi1AHx"
    "dyRThQkEw85HgEJaaDkxQVkmU1m/G/wEAAAD8UCEAAAAwABAAEAAAEAgACIPSegwAguD1F3JFOFCQvxv8BBCWmg5MUFZ"
    "JlNZt/e4igAAAmAAQACIACAAIbEGYaJOLuSKcKEhb+9xFEJaaDkxQVkmU1lDeGJqAAAGWYAAEEAEYAA2QF4AIAAxTAAA"
    "1NDJpp6alXHYHpBxLPWbLkBkl8XckU4UJBDeGJqAA19aM2Zvb3YKAgAAAAEBgICgkgRtYWluCgQKAwMDAICAgIAEAYCA"
    "oJYEAoCAoIoEbm9faW5zdHJ1Y3Rpb25zCgA+CQgBAQA="
)

# The same writer on `{'counters': {}, 'disassembly-format': 'raw', 'functions': {}}`: a profile
# that measured nothing. Its compressed sections are still there, holding nothing.
NO_FUNCTIONS = (
    "AgAEBAEFAQYOFA4iDjAlClUBcmF3CgAAQlpoORdyRThQkAAAAABCWmg5F3JFOFCQAAAAAEJaaDkXckU4UJAAAAAAQlpo"
    "OTFBWSZTWZ59lp0AAABAAAAQIAAhGEaC7kinChITz7LToAA="
)

# The eight sections, named the way the reader names them. Restated here rather than imported: a
# test that took the layout from the module under test could not catch it getting the layout wrong.
HEADER = 0
COUNTER_NAME_POOL = 1
TOP_LEVEL_COUNTERS = 2
LINE_COUNTERS = 3
LINE_ADDRESSES = 4
LINE_TEXT = 5
TEXT_POOL = 6
FUNCTIONS = 7
COMPRESSED = (LINE_COUNTERS, LINE_ADDRESSES, LINE_TEXT, TEXT_POOL)

ADD = "add r0, r0, r1"


def blob(encoded: str = GOLDEN) -> bytes:
    return base64.b64decode(encoded)


def uleb(value: int) -> bytes:
    """`value` as the format writes a number."""
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def number(data: bytes, at: int) -> tuple[int, int]:
    """The number at `at`, and where it ends."""
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, at


def sections(data: bytes | None = None) -> list[bytes]:
    """A blob's eight sections, as stored -- the compressed ones still compressed."""
    data = blob() if data is None else data
    at = 1  # The version.
    table: list[tuple[int, int]] = []
    for index in range(8):
        offset, at = number(data, at)
        size, at = number(data, at)
        if index == TEXT_POOL:
            at = data.index(b"\n", at) + 1  # The external pool file name.
        table.append((offset, size))
    return [data[at + offset : at + offset + size] for offset, size in table]


def rebuilt(parts: Sequence[bytes], pool_file: str = "") -> bytes:
    """A blob carrying these eight sections, with a section table to match."""
    table = bytearray(uleb(PROFILE_FORMAT_VERSION))
    offset = 0
    for index, part in enumerate(parts):
        table += uleb(offset) + uleb(len(part))
        if index == TEXT_POOL:
            table += pool_file.encode() + b"\n"
        offset += len(part)
    return bytes(table) + b"".join(parts)


def replacing(index: int, part: bytes) -> bytes:
    """The golden blob with one whole section replaced."""
    parts = sections()
    parts[index] = part
    return rebuilt(parts)


def patching(index: int, old: bytes, new: bytes) -> bytes:
    """The golden blob with one byte sequence replaced inside one uncompressed section."""
    parts = sections()
    assert old in parts[index], f"{old!r} is not in section {index}"
    parts[index] = parts[index].replace(old, new, 1)
    return rebuilt(parts)


def unreadable(data: bytes, function: str | None = None) -> str:
    """The message a blob is refused with, reading its index or one function's disassembly."""
    with pytest.raises(ProfileError) as caught:
        profile = read_profile(data)
        if function is not None:
            profile.instructions(function)
    return str(caught.value)


def unreadable_from(profile: profile_format.Profile, function: str) -> str:
    """The same, for a profile already parsed -- what the laziness tests need, since the point is
    that the index read and the disassembly read fail at different times."""
    with pytest.raises(ProfileError) as caught:
        profile.instructions(function)
    return str(caught.value)


def read_fully(data: bytes) -> None:
    """Read everything in a blob, letting a `ProfileError` -- and nothing else -- pass.

    The whole guarantee the endpoints rest on, as one callable: whatever is wrong with a blob, the
    reader's answer is a `ProfileError`, never some primitive's idea of what went wrong.
    """
    try:
        profile = read_profile(data)
        for name in profile.functions:
            profile.instructions(name)
    except ProfileError:
        return
    except Exception as error:
        pytest.fail(f"raised {type(error).__name__} rather than ProfileError: {error}")


class TestReadingARealProfile:
    """The golden blob, against the data v4 was asked to write."""

    def test_the_disassembly_format_is_the_one_the_producer_declared(self) -> None:
        assert read_profile(blob()).disassembly_format == "llvm-objdump"

    def test_top_level_counters_are_integers(self) -> None:
        # Unlike every other counter in a profile, which are floats.
        counters = read_profile(blob()).counters
        assert counters == {"cycles": 1234567, "branch-misses": 890, "instructions": 9999}
        assert all(isinstance(value, int) for value in counters.values())

    def test_the_index_names_every_function_with_its_counters_and_length(self) -> None:
        functions = read_profile(blob()).functions
        assert set(functions) == {"main", "_Z3foov", "no_instructions"}
        assert functions["main"].counters == {
            "cycles": 100.0,
            "branch-misses": 2.0,
            "instructions": 12.5,
        }
        assert functions["main"].length == 4
        assert functions["main"].name == "main"

    def test_a_function_may_be_measured_with_fewer_counters_than_the_pool_holds(self) -> None:
        # `_Z3foov` has only 'cycles', where the pool holds three names. Its per-instruction data
        # therefore carries one value per instruction, not three, and reading it as three would
        # silently shift everything after the first instruction.
        profile = read_profile(blob())
        assert profile.functions["_Z3foov"].counters == {"cycles": 50.0}
        assert [instruction.counters for instruction in profile.instructions("_Z3foov")] == [
            {"cycles": 30.0},
            {"cycles": 20.0},
        ]

    def test_disassembly_carries_the_address_counters_and_text_of_each_instruction(self) -> None:
        instructions = read_profile(blob()).instructions("main")
        assert [(one.address, one.text) for one in instructions] == [
            (0x1000, "push rbp"),
            (0x1004, ADD),
            (0x1008, ADD),
            # Addresses are stored as deltas, and this one is 0xFF8 past the previous instruction:
            # a function is not required to be contiguous.
            (0x2000, "ret"),
        ]
        assert instructions[0].counters == {
            "cycles": 50.0,
            "branch-misses": 1.0,
            "instructions": 4.0,
        }

    def test_a_counter_value_may_be_fractional_or_zero(self) -> None:
        # Zero is the one value v4 writes as a literal 0 rather than as a bit pattern, and 12.5
        # is there because a float that survives a round trip by accident would still be wrong.
        profile = read_profile(blob())
        assert profile.functions["main"].counters["instructions"] == 12.5
        assert profile.instructions("main")[3].counters == {
            "cycles": 0.0,
            "branch-misses": 0.0,
            "instructions": 0.5,
        }

    def test_repeated_text_reads_back_as_the_same_string(self) -> None:
        # Two instructions of 'main' and one of `_Z3foov` share one entry in the text pool, which
        # is the whole reason the format has a pool.
        profile = read_profile(blob())
        assert profile.instructions("main")[1].text == ADD
        assert profile.instructions("main")[2].text == ADD
        assert profile.instructions("_Z3foov")[0].text == ADD

    def test_a_function_with_no_instructions_has_no_disassembly(self) -> None:
        profile = read_profile(blob())
        assert profile.functions["no_instructions"].length == 0
        assert list(profile.instructions("no_instructions")) == []

    def test_a_profile_that_measured_nothing_reads_as_empty(self) -> None:
        profile = read_profile(blob(NO_FUNCTIONS))
        assert profile.disassembly_format == "raw"
        assert profile.counters == {}
        assert profile.functions == {}

    def test_asking_for_a_function_the_profile_does_not_have_is_not_corruption(self) -> None:
        # A `KeyError` rather than a `ProfileError`, because the endpoint owes that caller a 404
        # and the blob is perfectly fine.
        with pytest.raises(KeyError):
            read_profile(blob()).instructions("nosuchfunction")

    def test_disassembly_can_be_read_more_than_once(self) -> None:
        # The second call takes the cached sections rather than the compressed ones, which are
        # released once they have been expanded.
        profile = read_profile(blob())
        assert profile.instructions("main") == profile.instructions("main")


class TestFormatVersion:
    """D12 fixes the version at 2, and nothing else is read."""

    def test_the_golden_blob_declares_the_version_the_constant_names(self) -> None:
        assert blob()[0] == PROFILE_FORMAT_VERSION

    @pytest.mark.parametrize("version", [0, 1, 3, 127])
    def test_refuses_any_other_version(self, version: int) -> None:
        message = unreadable(bytes([version]) + blob()[1:])
        assert f"declares format version {version}" in message

    def test_refuses_an_empty_blob(self) -> None:
        # The degenerate case of the same check: there is no version to read.
        assert "profile is empty" in unreadable(b"")

    def test_refuses_something_that_is_not_a_profile_at_all(self) -> None:
        assert unreadable(b"<html>not a profile</html>")


class TestLaziness:
    """Reading the index must not decompress anything -- the point of the format (D12)."""

    def golden_with_unreadable_compression(self) -> bytes:
        parts = sections()
        for index in COMPRESSED:
            parts[index] = b"this is not bz2 data"
        return rebuilt(parts)

    def test_the_index_reads_even_when_every_compressed_section_is_garbage(self) -> None:
        profile = read_profile(self.golden_with_unreadable_compression())
        assert profile.disassembly_format == "llvm-objdump"
        assert profile.counters["cycles"] == 1234567
        assert profile.functions["main"].length == 4
        assert profile.functions["main"].counters["cycles"] == 100.0

    def test_disassembly_is_what_finally_trips_over_it(self) -> None:
        profile = read_profile(self.golden_with_unreadable_compression())
        with pytest.raises(ProfileError, match="not valid bz2"):
            profile.instructions("main")

    def test_a_failed_expansion_leaves_the_profile_able_to_report_it_again(self) -> None:
        # The compressed sections are released only once they have been expanded; releasing them
        # eagerly would make the second attempt fail differently, or not at all.
        profile = read_profile(self.golden_with_unreadable_compression())
        first = unreadable_from(profile, "main")
        assert unreadable_from(profile, "main") == first


class TestTakingABlobApart:
    """The surgery the corruption tests below are built on, checked against the real thing."""

    @pytest.mark.parametrize("encoded", [GOLDEN, NO_FUNCTIONS])
    def test_taking_a_blob_apart_and_back_together_is_exact(self, encoded: str) -> None:
        assert rebuilt(sections(blob(encoded))) == blob(encoded)


class TestCorruption:
    """Every way a blob can be wrong, reported as one exception with something to say."""

    def test_a_section_reaching_past_the_end_of_the_blob(self) -> None:
        parts = sections()
        truncated = rebuilt(parts)[: -len(parts[FUNCTIONS])]
        assert "past the end of the" in unreadable(truncated)

    def test_a_string_that_is_never_terminated(self) -> None:
        assert "ends in the middle of a string" in unreadable(
            patching(HEADER, b"llvm-objdump\n", b"llvm-objdump")
        )

    def test_a_string_that_is_not_utf_8(self) -> None:
        assert "not valid UTF-8" in unreadable(
            patching(HEADER, b"llvm-objdump", b"llvm-objdum\xff")
        )

    def test_a_counter_index_the_name_pool_has_no_name_for(self) -> None:
        # The top-level counters name their counter by index into the pool; 99 is not one of the
        # three names the pool holds.
        assert "counter index 99 is out of range" in unreadable(
            patching(TOP_LEVEL_COUNTERS, b"\x03\x00", b"\x03" + uleb(99))
        )

    def test_a_count_larger_than_the_section_could_possibly_hold(self) -> None:
        assert "claims 1000000 functions" in unreadable(
            patching(FUNCTIONS, b"\x03_Z3foov\n", uleb(1_000_000) + b"_Z3foov\n")
        )

    def test_a_number_wider_than_anything_in_the_format(self) -> None:
        # Ten bytes of ULEB128 carry 70 bits, so a number can be the right length and still be
        # wider than any address, offset or count.
        assert "wider than the 64 bits" in unreadable(
            patching(TOP_LEVEL_COUNTERS, b"\x03\x00", b"\x03" + uleb(1 << 65))
        )

    def test_a_number_that_never_ends(self) -> None:
        assert "runs past the 10 bytes" in unreadable(
            patching(TOP_LEVEL_COUNTERS, b"\x03\x00", b"\x03" + b"\xff" * 20)
        )

    def test_a_float_that_is_not_a_32_bit_bit_pattern(self) -> None:
        assert "too wide to be a 32-bit float" in unreadable(
            patching(FUNCTIONS, uleb(0x42480000), uleb(1 << 32))
        )

    def test_a_float_that_is_not_a_finite_number(self) -> None:
        # 0x7F800000 is +Inf. No counter is infinite, and no JSON response could carry it.
        assert "which no counter value is" in unreadable(
            patching(FUNCTIONS, uleb(0x42480000), uleb(0x7F800000))
        )

    def test_a_compressed_section_that_is_not_bz2(self) -> None:
        assert "not valid bz2" in unreadable(replacing(LINE_COUNTERS, b"garbage"), "main")

    def test_a_bz2_stream_that_stops_early(self) -> None:
        parts = sections()
        assert "ends before its data does" in unreadable(
            replacing(LINE_COUNTERS, parts[LINE_COUNTERS][:-4]), "main"
        )

    def test_bytes_left_over_after_a_bz2_stream(self) -> None:
        parts = sections()
        assert "follow the end of the bz2 stream" in unreadable(
            replacing(LINE_COUNTERS, parts[LINE_COUNTERS] + b"tail"), "main"
        )

    def test_a_text_offset_that_is_not_in_the_pool(self) -> None:
        # `_Z3foov` starts at offset 0 of LineText, so this replaces exactly its two entries.
        assert "past the end of the" in unreadable(
            replacing(LINE_TEXT, bz2.compress(uleb(9999) * 2)), "_Z3foov"
        )

    def test_a_function_offset_that_is_past_the_end_of_its_section(self) -> None:
        # `_Z3foov`'s three per-line offsets are all 0; this sends the last of them, into LineText,
        # well past the end of the expanded section.
        assert "past the end of the" in unreadable(
            patching(
                FUNCTIONS, b"_Z3foov\n\x02\x00\x00\x00", b"_Z3foov\n\x02\x00\x00" + uleb(9999)
            ),
            "_Z3foov",
        )

    def test_a_profile_whose_text_pool_lives_in_another_file(self) -> None:
        # v4 scaffolded shared text pools and never implemented them; a blob naming one carries
        # only half of what it needs.
        assert "names the external pool file 'shared.pool'" in unreadable(
            rebuilt(sections(), pool_file="shared.pool")
        )


class TestBounds:
    """A corrupt blob must fail fast rather than make the server do the work it claims to need."""

    def test_an_absurd_instruction_count_is_refused_before_any_of_it_is_built(self) -> None:
        # The number a function would have to claim to make a list nothing could hold. Refused
        # against the absolute cap, so the size of the blob is beside the point.
        assert "more than the 1000000" in unreadable(
            patching(FUNCTIONS, b"_Z3foov\n\x02", b"_Z3foov\n" + uleb(2**40)), "_Z3foov"
        )

    def test_an_instruction_count_larger_than_the_address_data_that_remains(self) -> None:
        # Below the absolute cap, so what catches it is the exact bound: every instruction spends
        # at least one byte on its address delta, and this function does not have that many.
        assert "bytes of addresses remain" in unreadable(
            patching(FUNCTIONS, b"_Z3foov\n\x02", b"_Z3foov\n" + uleb(10_000)), "_Z3foov"
        )

    def test_the_index_of_such_a_profile_still_reads(self) -> None:
        # The bound belongs to the disassembly, not to the index: a function claiming nonsense
        # does not make the profile's metadata unreadable.
        data = patching(FUNCTIONS, b"_Z3foov\n\x02", b"_Z3foov\n" + uleb(2**40))
        assert read_profile(data).functions["main"].length == 4

    def test_sections_that_expand_beyond_the_budget(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Lowered rather than crafting a bomb: bz2 reaches ratios beyond 200 000:1, so a blob that
        # exceeded the real budget would be a few kilobytes of data and minutes of test time.
        monkeypatch.setattr(profile_format, "MAX_DECOMPRESSED_SIZE", 4)
        assert "expand beyond the 4 byte limit" in unreadable(blob(), "main")

    def test_the_budget_is_shared_by_all_four_sections(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Enough for the first section alone, not for all of them: a per-section budget would let
        # a profile expand to four times what it is allowed.
        expanded = [len(bz2.decompress(sections()[index])) for index in COMPRESSED]
        monkeypatch.setattr(profile_format, "MAX_DECOMPRESSED_SIZE", expanded[0])
        assert "expand beyond the" in unreadable(blob(), "main")
        monkeypatch.setattr(profile_format, "MAX_DECOMPRESSED_SIZE", sum(expanded))
        assert read_profile(blob()).instructions("main")


class TestSweeps:
    """Whatever is wrong with a blob, the answer is a `ProfileError`.

    Exhaustive rather than representative. The cases above name the corruptions worth naming; these
    two cover the ones nobody thought of, which is where a stray `struct.error` or `IndexError`
    would come from.
    """

    def test_every_prefix_of_a_valid_blob_is_read_or_refused(self) -> None:
        data = blob()
        for length in range(len(data) + 1):
            read_fully(data[:length])

    @pytest.mark.parametrize("flip", [0x01, 0x80, 0xFF])
    def test_every_single_byte_change_to_a_valid_blob_is_read_or_refused(self, flip: int) -> None:
        # Three masks rather than one: 0x80 is the continuation bit of a number, so flipping it
        # produces the plausible-looking-but-wrong blobs that a bound is most likely to miss.
        data = blob()
        for position in range(len(data)):
            damaged = bytearray(data)
            damaged[position] ^= flip
            read_fully(bytes(damaged))
