"""D12's profile document: what a submission carries for a profile, and how it is stored.

A test entry's `profile` is a JSON document, gzip-compressed and base64-encoded (D6, D12). This
module takes that string apart, validates the document, and hands back the rows `{suite}.profile`
and `{suite}.profile_function` store (D5). Everything is checked here, at submission, so that a
stored profile is always one the read endpoints can serve.

A function's instructions are stored compressed, in a layout of this module's choosing: D5 leaves
it to the implementation, and nothing but `instructions` below ever reads it back. That layout is
column by column -- the address deltas, then each counter's values, then the text -- under zstd,
which on profiles sampled from lnt.llvm.org stores them in about the space v4's binary format did.
One function per row is what lets the metadata and function-list endpoints answer without
decompressing anything, and a disassembly decompress only its own function.

The document is parsed with msgspec rather than pydantic, which reads every other request body. A
profile carries hundreds of thousands of instructions, and pydantic's models hold one in about three
times the memory msgspec's structs do, and take several times as long to build. msgspec's
declarative constraints cannot express everything D12 asks for, so the rest is checked by hand --
from a hook per function rather than one per instruction, which would give back much of what
msgspec saves.
"""

from __future__ import annotations

import base64
import zlib
from collections.abc import Iterator
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

# D12's caps on one profile: on the compressed document, and on what it decompresses to. Both are
# limits on a profile rather than on the request carrying it, whose body is refused at the transport
# layer with R4's 413 instead (see `config.BODY_LIMIT`). Of the roughly 200,000 profiles on
# lnt.llvm.org, the largest is a 17 MiB document that compresses to 1.1 MiB, so the compressed cap
# is several times that and the decompressed one about twice it. The decompressed cap is the one
# that bounds memory, since the whole document is parsed before anything is stored.
MAX_COMPRESSED_SIZE = 4 * 1024 * 1024
MAX_DOCUMENT_SIZE = 32 * 1024 * 1024

# The compressed cap in base64 characters, so that an oversized profile is refused before it is
# decoded. Base64 spends 4 characters on every 3 bytes, rounded up to a whole group, so this is the
# longest encoding a document within the cap can have; it admits up to two bytes more than the cap,
# which the check on the decoded length then catches.
MAX_ENCODED_SIZE = 4 * ((MAX_COMPRESSED_SIZE + 2) // 3)

# D12's cap on the instructions of one function: several times the largest on lnt.llvm.org, 20,069.
MAX_INSTRUCTIONS = 100_000

# D12's cap on the functions of one profile. The size caps alone admit close to a million empty
# functions, which cost little to submit but are each a row, and all in the unpaginated function
# list. The largest profile on lnt.llvm.org has 79.
MAX_FUNCTIONS = 10_000

# D12's cap on a function name, in UTF-8 bytes, so that every function the list serves can be asked
# for: the name travels in `?function=` (R1), and even fully percent-encoded, at three characters a
# byte, it then fits the 8 KiB request line common servers and proxies allow, nginx's included. The
# longest name on lnt.llvm.org is 744 characters. Raising it is also bounded by the key of
# `{suite}.profile_function` (see `tables.py`); `test_profiles.py` stores a name at the cap.
MAX_FUNCTION_NAME_BYTES = 2048

# The zstd level a function's instructions are compressed at. On the profiles sampled from
# lnt.llvm.org, level 9 stores them in about the space v4's binary format did, at a fraction of the
# time the highest levels take for a few percent less.
_ZSTD_LEVEL = 9

# The ASCII whitespace D12 makes insignificant in the base64, removed before decoding. Exactly the
# ASCII set rather than `str.split()`'s: that one also eats U+00A0 and friends, which are outside
# the alphabet and are precisely what strict decoding is there to report.
_WHITESPACE = str.maketrans("", "", " \t\n\r\v\f")

# An address or a top-level counter: a non-negative integer, read as D3 reads an `integer`. A union
# because msgspec's `int` refuses `8.0`, which D3 accepts; and the upper bound is not declared
# because msgspec decodes an integer of any size before it applies one. `_integer` does the rest,
# the same rule `entities._whole_number` applies to pydantic models.
Integer = Annotated[int, Meta(ge=0)] | Annotated[float, Meta(ge=0)]

# A raw count at an instruction. Real rather than integer: a producer that samples reports
# estimates, and an integer is accepted anyway, as D3 accepts one where a `real` is declared.
# msgspec refuses a number no finite double holds, so every one of these is finite.
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


# `gc=False` on all three: none of them can be part of a reference cycle, so the garbage collector
# need not track them -- which matters when one document is hundreds of thousands of them.


class InstructionDocument(Struct, forbid_unknown_fields=True, gc=False):
    """One instruction: where it is, what was counted there, and its disassembled text.

    Checked by its function rather than by a hook of its own; see the module docstring.
    """

    address: Integer
    # Not `Name`: each of these is one of the profile's top-level counters, which `ProfileDocument`
    # checks once rather than here once per instruction.
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
    """The document a submission's `profile` decodes to (D12).

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


class _Columns(Struct, gc=False):
    """A function's instructions as they are stored: one list per field rather than per instruction.

    Addresses are stored as deltas from the previous one, starting from zero, which is what makes
    them compress: within a function they are close together, and on a RISC target every delta is
    the same number.
    """

    address_deltas: list[int]
    counters: dict[str, list[float]]
    text: list[str]


_COLUMNS_DECODER = msgspec.json.Decoder(_Columns)


@dataclass(frozen=True, slots=True)
class StoredFunction:
    """One `{suite}.profile_function` row: a function's index entry and its compressed instructions.

    `counters` are the function's own, each the sum of that counter over its instructions (D12).
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
    """The rows a submitted profile is stored as, or a 400 (D12)."""
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


def _stored(function: FunctionDocument) -> StoredFunction:
    """A function's row: its counters, and its instructions in the layout `instructions` reads.

    A function's counters are derived as the sums of its columns (D12), so a document cannot
    contradict itself. Computed here rather than in the struct's hook, which has nowhere to keep
    them: msgspec decodes every field a struct declares, so a field to hold them would be one a
    submission could set.
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
