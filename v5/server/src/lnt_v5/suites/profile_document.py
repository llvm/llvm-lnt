"""D12's profile document: what a submission carries for a profile, and how it becomes stored bytes.

A test entry's `profile` is a JSON document, gzip-compressed and base64-encoded (D6, D12). This
module takes that string apart, validates the document, and hands back the blob `{suite}.profile`
stores. Everything is checked here, at submission, so that a stored profile is always one the read
endpoints can serve: nothing a caller sends ever reaches the reader unvalidated.

What is stored is v4's binary format (`profile_format`), chosen because it is the most compact
representation measured on real profiles. D12 deliberately leaves that encoding to the
implementation; the only traces it leaves on the contract are the rules it cannot represent a
document without -- addresses that never decrease within a function, strings without newlines, and
counter values kept to single precision.

The document is parsed with msgspec rather than pydantic, which reads every other request body. A
profile carries hundreds of thousands of instructions, and pydantic's models hold one in about three
times the memory msgspec's structs do, and take several times as long to build. msgspec's
declarative constraints cannot express everything D12 asks for, so the rest is checked by hand in
`FunctionDocument.__post_init__` and `ProfileDocument.__post_init__` -- once per function rather
than once per instruction, since a hook per instruction would give back much of what msgspec saves.
"""

from __future__ import annotations

import base64
import threading
import zlib
from collections.abc import Mapping, Sequence
from typing import Annotated, cast

import msgspec
from msgspec import Meta, Struct

from lnt_v5.errors import ApiError, ErrorCode
from lnt_v5.profile_format import (
    MAX_DECOMPRESSED_SIZE,
    MAX_INSTRUCTIONS,
    MAX_NUMBER,
    MAX_REAL,
    InstructionData,
    MeasuredFunction,
    write_profile,
)
from lnt_v5.strings import NUL

# D12's caps on one profile: on the compressed document, and on what it decompresses to. Both are
# limits on a profile rather than on the request carrying it, whose body is refused at the transport
# layer with R4's 413 instead (see `config.BODY_LIMIT`). The compressed cap is several times the
# largest profile on lnt.llvm.org; the decompressed one admits whatever a document within the
# compressed cap legitimately expands to, at the ratio real profiles compress at. It is the stored
# format's own expansion limit, so that everything admitted here can be stored and read back.
MAX_COMPRESSED_SIZE = 4 * 1024 * 1024
MAX_DOCUMENT_SIZE = MAX_DECOMPRESSED_SIZE

# The compressed cap in base64 characters, so that an oversized profile is refused before it is
# decoded. Base64 spends 4 characters on every 3 bytes, rounded up to a whole group, so this is the
# longest encoding a document within the cap can have; it admits up to two bytes more than the cap,
# which the check on the decoded length then catches.
MAX_ENCODED_SIZE = 4 * ((MAX_COMPRESSED_SIZE + 2) // 3)

# How many profiles one worker encodes at once. Encoding a profile at the caps above holds hundreds
# of megabytes for a few seconds, and FastAPI runs submissions on a threadpool of dozens of threads,
# so without a bound a burst of concurrent submissions multiplies that until the process runs out of
# memory. One at a time costs little throughput, since most of the work holds the GIL anyway, and
# makes the worst case per worker one profile's worth. Nothing waiting here holds a database
# connection: submission validates before it takes one.
_ENCODING = threading.BoundedSemaphore(1)

# The ASCII whitespace D12 makes insignificant in the base64, removed before decoding. Exactly the
# ASCII set rather than `str.split()`'s: that one also eats U+00A0 and friends, which are outside
# the alphabet and are precisely what strict decoding is there to report.
_WHITESPACE = str.maketrans("", "", " \t\n\r\v\f")

# An address or a top-level counter: a non-negative integer below 2**64, read as D3 reads an
# `integer`. A union because msgspec's `int` refuses `8.0`, which D3 accepts; and the upper bound is
# not declared because msgspec's bounds stop at 64-bit signed integers. `_unsigned` does the rest.
Unsigned = Annotated[int, Meta(ge=0)] | Annotated[float, Meta(ge=0)]

# A raw count at an instruction. Real rather than integer: a producer that samples reports
# estimates, and an integer is accepted anyway, as D3 accepts one where a `real` is declared. Single
# precision is all the stored format holds.
Count = Annotated[float, Meta(ge=0, le=MAX_REAL)]

# A function's or a counter's name, which has to name something.
Name = Annotated[str, Meta(min_length=1)]


def _text(value: str, what: str) -> None:
    """Refuse a string the document cannot carry: a newline ends a string in the stored format, and
    a NUL is refused in every string a request carries (D3)."""
    if "\n" in value:
        raise ValueError(f"{what} must not contain a newline")
    if NUL in value:
        raise ValueError(f"{what} must not contain a NUL character (U+0000)")


def _unsigned(value: int | float, what: str) -> int:
    """`value` as the integer it stands for, or a refusal (D3): `8.0` is 8, and `8.5` is refused."""
    if isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f"{what} is {value}, which is not a whole number")
        value = int(value)
    if value >= MAX_NUMBER:
        raise ValueError(f"{what} is {value}, which is not below 2**64")
    return value


# `gc=False` on all three: none of them can be part of a reference cycle, so the garbage collector
# need not track them -- which matters when one document is hundreds of thousands of them.


class InstructionDocument(Struct, forbid_unknown_fields=True, gc=False):
    """One instruction: where it is, what was counted there, and its disassembled text.

    Checked by its function rather than by a hook of its own; see the module docstring.
    """

    address: Unsigned
    counters: dict[Name, Count]
    text: str


class FunctionDocument(Struct, forbid_unknown_fields=True, gc=False):
    """One function, as its instructions. Its own counters are derived, never submitted."""

    name: Name
    instructions: Annotated[list[InstructionDocument], Meta(max_length=MAX_INSTRUCTIONS)]

    def __post_init__(self) -> None:
        """Every rule over the function's instructions, in one pass.

        Also replaces each address with the integer it stands for, which is what the writer takes.
        """
        _text(self.name, "a function name")
        if not self.instructions:
            return
        expected = self.instructions[0].counters.keys()
        # Every instruction carries these names, so checking them once checks them all.
        for counter in expected:
            _text(counter, "a counter name")
        previous = 0
        for position, instruction in enumerate(self.instructions):
            _text(instruction.text, f"instruction {position}'s text")
            if instruction.counters.keys() != expected:
                raise ValueError(
                    f"instruction {position} carries the counters "
                    f"{sorted(instruction.counters)} where the first one carries "
                    f"{sorted(expected)}; every instruction of a function carries the same counters"
                )
            address = _unsigned(instruction.address, f"instruction {position}'s address")
            if address < previous:
                raise ValueError(
                    f"instruction {position} is at address {address}, below the {previous} "
                    f"before it; addresses never decrease within a function"
                )
            instruction.address = previous = address


class ProfileDocument(Struct, forbid_unknown_fields=True, gc=False):
    """The document a submission's `profile` decodes to (D12).

    Its functions are checked before this is: msgspec builds the children first.
    """

    disassembly_format: str
    counters: dict[Name, Unsigned]
    functions: list[FunctionDocument]

    def __post_init__(self) -> None:
        _text(self.disassembly_format, "the disassembly format")
        for counter, value in self.counters.items():
            _text(counter, "a counter name")
            self.counters[counter] = _unsigned(value, f"the top-level counter '{counter}'")
        if len({function.name for function in self.functions}) != len(self.functions):
            raise ValueError("two functions have the same name")
        # A client shows a function's counter as its share of the top-level one (`client/
        # profiles.md`), which needs the top-level one to exist. The first instruction speaks for
        # the function, since its own hook has checked that every instruction carries the same.
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


def stored_profile(encoded: str) -> bytes:
    """The bytes `{suite}.profile` stores for a submitted profile, or a 400 (D12).

    Everything D12 refuses is refused before the writer runs, so it is never handed a document it
    cannot store. Profiles are encoded one at a time per worker; see `_ENCODING`.
    """
    with _ENCODING:
        document = _parsed(_decompressed(_decoded(encoded)))
        functions = {
            # The casts restate what `__post_init__` established: every address and every top-level
            # counter has been replaced by the integer it stands for.
            function.name: MeasuredFunction(
                _counters(function), cast(Sequence[InstructionData], function.instructions)
            )
            for function in document.functions
        }
        return write_profile(
            document.disassembly_format, cast(Mapping[str, int], document.counters), functions
        )


def _counters(function: FunctionDocument) -> dict[str, float]:
    """A function's counters: each the sum of that counter over its instructions (D12).

    Derived, so a document cannot contradict itself. Computed here rather than in the struct's hook,
    which has nowhere to keep it: msgspec decodes every field a struct declares, so a field to hold
    it would be one a submission could set.
    """
    totals: dict[str, float] = {}
    for instruction in function.instructions:
        for counter, value in instruction.counters.items():
            totals[counter] = totals.get(counter, 0.0) + value
    for counter, total in totals.items():
        if total > MAX_REAL:
            raise _refused(
                f"function '{function.name}': the '{counter}' counters sum to {total}, which is "
                f"larger than single precision can hold"
            )
    return totals


def _decoded(encoded: str) -> bytes:
    """The compressed document a base64 string stands for.

    D12 makes ASCII whitespace insignificant and everything else outside the alphabet an error, so
    the whitespace is removed and what is left is decoded strictly. Stripping first accepts the
    common producers -- `base64(1)` wraps at 76 columns by default, as does every MIME encoder --
    and decoding strictly afterwards keeps the rule honest: Python's lenient mode discards *every*
    character outside the alphabet, so a string that is not base64 at all would decode to whatever
    happened to remain. The size gate is applied to the stripped string, since line breaks are not
    payload.
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
    since D12 compresses one document.
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
        # `DecodeError` includes every `ValidationError`, which subclasses it: a refusal by a
        # declared constraint, and each `ValueError` a `__post_init__` raises, which msgspec reports
        # with its location. Bytes that are not UTF-8 are refused with neither, but as a bare
        # `UnicodeDecodeError`, which would otherwise be a 500.
        raise _refused(f"not a valid profile document: {error}") from error


def _refused(problem: str) -> ApiError:
    return ApiError(ErrorCode.INVALID_REQUEST, f"profile: {problem}")


def _too_large(what: str, limit: int) -> ApiError:
    return _refused(
        f"larger than the {limit} byte limit on a {what} profile; note that this is not the limit "
        f"on the request body, which is reported as 413"
    )
