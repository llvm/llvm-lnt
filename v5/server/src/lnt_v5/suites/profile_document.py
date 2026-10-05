"""O7's profile document: what a submission carries for a profile, and how it is stored.

A test entry's `profile` is a JSON document, gzip-compressed and base64-encoded (O1, O7). This
module validates it in full and hands back the rows `{suite}.profile` and `{suite}.profile_function`
store (D5), with each function's instructions compressed in a layout of its own choosing, which only
`instructions` below reads back. `document_json` turns those rows back into a document (E7).

The document is parsed with msgspec rather than pydantic, which reads every other request body: a
profile carries hundreds of thousands of instructions, and pydantic's models take about three times
the memory and several times as long to build. What msgspec's declarative constraints cannot express
is checked by hand, from a hook per function rather than per instruction, which would give back
much of that.
"""

from __future__ import annotations

import base64
import zlib
from collections.abc import Iterable, Iterator
from compression import zstd
from dataclasses import dataclass
from itertools import accumulate, pairwise, repeat
from math import isfinite
from typing import Annotated, cast

import msgspec
from msgspec import Meta, Struct

from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.strings import NUL
from lnt_v5.suites.tables import INTEGER_MAX

# O7's caps on one profile, each several times the largest seen on lnt.llvm.org. These are limits
# on a profile, not on the request body, which is refused with I4's 413 instead. The decompressed
# cap is the one that bounds memory, since the whole document is parsed before anything is stored.
MAX_COMPRESSED_SIZE = 4 * 1024 * 1024
MAX_DOCUMENT_SIZE = 32 * 1024 * 1024
MAX_INSTRUCTIONS = 100_000
MAX_FUNCTIONS = 10_000

# The longest base64 encoding of a document within the compressed cap, so that an oversized profile
# is refused before it is decoded. It admits up to two bytes more than the cap, which the check on
# the decoded length catches.
MAX_ENCODED_SIZE = 4 * ((MAX_COMPRESSED_SIZE + 2) // 3)

# O7's cap on a function name, in UTF-8 bytes. A name travels in `?function=` (I1), and at this
# length it fits the 8 KiB request line common proxies allow even fully percent-encoded. It also
# keeps `{suite}.profile_function`'s key within a btree entry (see `tables.py`).
MAX_FUNCTION_NAME_BYTES = 2048

# About as compact as v4's binary format was, at a fraction of the highest levels' encoding time.
_ZSTD_LEVEL = 9

# Exactly the ASCII whitespace O7 makes insignificant in the base64. `str.split()`'s set would also
# drop U+00A0 and friends, which are outside the alphabet and must be refused.
_WHITESPACE = str.maketrans("", "", " \t\n\r\v\f")

# An address or a top-level counter: a non-negative integer as D3 reads one. A union because
# msgspec's `int` refuses `8.0`, which D3 accepts; `_integer` applies the rest of D3's rule.
Integer = Annotated[int, Meta(ge=0)] | Annotated[float, Meta(ge=0)]

# A count at an instruction: a real, since a sampling producer reports estimates. msgspec refuses a
# number no finite double holds.
Count = Annotated[float, Meta(ge=0)]

# A function's or a counter's name, which has to name something.
Name = Annotated[str, Meta(min_length=1)]


def _no_nul(value: str, what: str) -> None:
    """Refuse a NUL, which D3 refuses in every string a request carries."""
    if NUL in value:
        raise ValueError(f"{what} must not contain a NUL character (U+0000)")


def _integer(value: int | float, what: str) -> int:
    """`value` as the integer it stands for, or a refusal (D3): `8.0` is 8, and `8.5` is refused."""
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f"{what} is {value}, which is not a whole number")
        value = int(value)
    if value > INTEGER_MAX:
        raise ValueError(f"{what} is {value}, which is larger than an integer can be")
    return value


# `gc=False` on all three: none can be part of a reference cycle, and a document holds hundreds of
# thousands of them for the garbage collector to otherwise track.


class InstructionDocument(Struct, forbid_unknown_fields=True, gc=False):
    """One instruction: where it is, what was counted there, and its disassembled text.

    Checked by its function's hook, not one of its own.
    """

    address: Integer
    # Not `Name`: `ProfileDocument` checks these against its top-level counters, which are.
    counters: dict[str, Count]
    text: str


class FunctionDocument(Struct, forbid_unknown_fields=True, gc=False):
    """One function, as its instructions. Its own counters are derived, never submitted."""

    name: Name
    instructions: Annotated[list[InstructionDocument], Meta(max_length=MAX_INSTRUCTIONS)]

    def __post_init__(self) -> None:
        """Every rule over the function's instructions, in one pass.

        Also replaces each address with the integer it stands for, which is what is stored.
        """
        _no_nul(self.name, "a function name")
        if len(self.name.encode()) > MAX_FUNCTION_NAME_BYTES:
            raise ValueError(
                f"the function name '{self.name[:50]}...' is longer than "
                f"{MAX_FUNCTION_NAME_BYTES} bytes in UTF-8"
            )
        if not self.instructions:
            return
        expected = self.instructions[0].counters.keys()
        for position, instruction in enumerate(self.instructions):
            # The position is only spelled out for a refusal: this runs once per instruction.
            try:
                _no_nul(instruction.text, "its text")
                instruction.address = _integer(instruction.address, "its address")
            except ValueError as error:
                raise ValueError(f"instruction {position}: {error}") from None
            if instruction.counters.keys() != expected:
                raise ValueError(
                    f"instruction {position} carries the counters "
                    f"{sorted(instruction.counters)} where the first one carries "
                    f"{sorted(expected)}; every instruction of a function carries the same counters"
                )


class ProfileDocument(Struct, forbid_unknown_fields=True, gc=False):
    """The document a submission's `profile` decodes to (O7).

    Its functions are checked before this is: msgspec builds the children first.
    """

    disassembly_format: str
    counters: dict[Name, Integer]
    functions: Annotated[list[FunctionDocument], Meta(max_length=MAX_FUNCTIONS)]

    def __post_init__(self) -> None:
        _no_nul(self.disassembly_format, "the disassembly format")
        for counter, value in self.counters.items():
            _no_nul(counter, "a counter name")
            self.counters[counter] = _integer(value, f"the top-level counter '{counter}'")
        if len({function.name for function in self.functions}) != len(self.functions):
            raise ValueError("two functions have the same name")
        # The client shows a function's counters as shares of the top-level ones (PF4). The first
        # instruction speaks for its function, whose hook has checked that every instruction
        # carries the same counters.
        for function in self.functions:
            if function.instructions:
                unknown = function.instructions[0].counters.keys() - self.counters.keys()
                if unknown:
                    raise ValueError(
                        f"function '{function.name}' carries the counters {sorted(unknown)}, which "
                        f"are not top-level counters; every counter of an instruction is one of "
                        f"the profile's top-level counters"
                    )


_DECODER = msgspec.json.Decoder(ProfileDocument)


class _Columns(Struct, gc=False):
    """A function's instructions as they are stored: one list per field rather than per instruction.

    Addresses are stored as deltas from the previous one, starting from zero, because deltas within
    a function are small and repetitive, and compress well.
    """

    address_deltas: list[int]
    counters: dict[str, list[float]]
    text: list[str]


_COLUMNS_DECODER = msgspec.json.Decoder(_Columns)

_ENCODER = msgspec.json.Encoder()


@dataclass(frozen=True, slots=True)
class StoredFunction:
    """One `{suite}.profile_function` row: a function's index entry and its compressed instructions.

    `counters` are the function's own, each the sum of that counter over its instructions (O7).
    """

    name: str
    counters: dict[str, float]
    length: int
    instructions: bytes


@dataclass(frozen=True, slots=True)
class StoredProfile:
    """What `{suite}.profile` and `{suite}.profile_function` store for one submitted profile."""

    disassembly_format: str
    counters: dict[str, int]
    functions: list[StoredFunction]


def stored_profile(encoded: str) -> StoredProfile:
    """The rows a submitted profile is stored as, or a 400 (O7)."""
    document = _parsed(_decompressed(_decoded(encoded)))
    return StoredProfile(
        disassembly_format=document.disassembly_format,
        # `__post_init__` has replaced every top-level counter by the integer it stands for.
        counters=cast(dict[str, int], document.counters),
        functions=[_stored(function) for function in document.functions],
    )


def instructions(data: bytes) -> Iterator[tuple[int, dict[str, float], str]]:
    """The address, counters and text of each instruction a stored function holds, in order.

    The inverse of `_stored`, over bytes only this module wrote.
    """
    columns = _COLUMNS_DECODER.decode(zstd.decompress(data))
    names = list(columns.counters)
    # A function measured with no counters has no columns to zip, but still one row per instruction;
    # `repeat` is endless, so only finite columns can be held to the same length.
    values = zip(*columns.counters.values(), strict=True) if names else repeat(())
    for address, row, text in zip(
        accumulate(columns.address_deltas), values, columns.text, strict=bool(names)
    ):
        yield address, dict(zip(names, row, strict=True)), text


def document_json(
    disassembly_format: str, counters: dict[str, int], functions: Iterable[tuple[str, bytes]]
) -> bytearray:
    """A stored profile as the JSON profile document it was submitted as, uncompressed (E7).

    `functions` are the name and stored instructions of each function, in the order the document is
    to list them. The document is written into one buffer a function at a time, so that only one
    function's instructions are ever held as Python objects -- a whole profile's would take several
    times the memory of the document -- and no part of the document is copied to assemble it.
    """
    document = bytearray(b'{"disassembly_format":')
    _ENCODER.encode_into(disassembly_format, document, -1)
    document += b',"counters":'
    _ENCODER.encode_into(counters, document, -1)
    document += b',"functions":['
    for index, (name, stored) in enumerate(functions):
        document += b'{"name":' if index == 0 else b',{"name":'
        _ENCODER.encode_into(name, document, -1)
        document += b',"instructions":'
        _ENCODER.encode_into(
            [
                InstructionDocument(address=address, counters=values, text=text)
                for address, values, text in instructions(stored)
            ],
            document,
            -1,
        )
        document += b"}"
    document += b"]}"
    return document


def _stored(function: FunctionDocument) -> StoredFunction:
    """A function's row: its counters, the sums of its columns (O7), and its instructions in the
    layout `instructions` reads.
    """
    rows = function.instructions
    # Integers by now; see `FunctionDocument.__post_init__`.
    addresses = [cast(int, instruction.address) for instruction in rows]
    columns = _Columns(
        address_deltas=[after - before for before, after in pairwise([0, *addresses])],
        counters={
            counter: [instruction.counters[counter] for instruction in rows]
            for counter in (rows[0].counters if rows else ())
        },
        text=[instruction.text for instruction in rows],
    )
    counters = {counter: sum(values) for counter, values in columns.counters.items()}
    for counter, total in counters.items():
        if not isfinite(total):
            raise _refused(
                f"function '{function.name}': the '{counter}' counters sum to more than a finite "
                f"number can hold"
            )
    return StoredFunction(
        name=function.name,
        counters=counters,
        length=len(rows),
        instructions=zstd.compress(msgspec.json.encode(columns), level=_ZSTD_LEVEL),
    )


def _decoded(encoded: str) -> bytes:
    """The compressed document a base64 string stands for.

    The whitespace O7 allows is removed and the rest decoded strictly: Python's lenient mode
    discards *every* character outside the alphabet, so a string that is not base64 at all would
    decode to whatever happened to remain. Line breaks are not payload, so the size gate measures
    the string without them.
    """
    data_only = encoded.translate(_WHITESPACE)
    if len(data_only) > MAX_ENCODED_SIZE:
        raise _too_large("compressed", MAX_COMPRESSED_SIZE)
    try:
        compressed = base64.b64decode(data_only, validate=True)
    except ValueError as error:
        # binascii.Error for a bad alphabet or bad padding, and a plain ValueError for a string
        # carrying non-ASCII; the former is a subclass of the latter.
        raise _refused(f"not valid base64: {error}") from error
    if len(compressed) > MAX_COMPRESSED_SIZE:
        raise _too_large("compressed", MAX_COMPRESSED_SIZE)
    return compressed


def _decompressed(compressed: bytes) -> bytes:
    """The document a gzip stream holds, expanded no further than the cap allows.

    Incremental, with a ceiling one byte past the cap, rather than `gzip.decompress`: that would
    expand a compression bomb in full before anything could measure it. Exactly one gzip member,
    since O7 compresses one document.
    """
    decompressor = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    try:
        document = decompressor.decompress(compressed, MAX_DOCUMENT_SIZE + 1)
    except zlib.error as error:
        raise _refused(f"not valid gzip data: {error}") from error
    if len(document) > MAX_DOCUMENT_SIZE:
        raise _too_large("decompressed", MAX_DOCUMENT_SIZE)
    if not decompressor.eof:
        raise _refused("the gzip stream ends before its data does")
    if decompressor.unused_data:
        raise _refused("data follows the end of the gzip stream")
    return document


def _parsed(document: bytes) -> ProfileDocument:
    try:
        return _DECODER.decode(document)
    except (msgspec.DecodeError, UnicodeDecodeError) as error:
        # `ValidationError` subclasses `DecodeError`, and carries both a declared constraint's
        # refusal and a `__post_init__`'s. Bytes that are not UTF-8 raise neither, but a bare
        # `UnicodeDecodeError`, which would otherwise be a 500.
        raise _refused(f"not a valid profile document: {error}") from error


def _refused(problem: str) -> ApiError:
    return ApiError(ErrorCode.INVALID_REQUEST, f"profile: {problem}")


def _too_large(what: str, limit: int) -> ApiError:
    return _refused(
        f"larger than the {limit} byte limit on a {what} profile; note that this is not the limit "
        f"on the request body, which is reported as 413"
    )
