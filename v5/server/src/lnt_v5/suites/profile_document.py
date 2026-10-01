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
"""

from __future__ import annotations

import base64
import zlib
from functools import cached_property
from typing import Annotated, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from lnt_v5.errors import ApiError, ErrorCode, validation_problems
from lnt_v5.profile_format import (
    MAX_DECOMPRESSED_SIZE,
    MAX_INSTRUCTIONS,
    MAX_NUMBER,
    MAX_REAL,
    MeasuredFunction,
    write_profile,
)
from lnt_v5.strings import Storable
from lnt_v5.suites.entities import IntegerValue, RealValue

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

# The ASCII whitespace D12 makes insignificant in the base64, removed before decoding. Exactly the
# ASCII set rather than `str.split()`'s: that one also eats U+00A0 and friends, which are outside
# the alphabet and are precisely what strict decoding is there to report.
_WHITESPACE = str.maketrans("", "", " \t\n\r\v\f")


def _one_line(value: str) -> str:
    if "\n" in value:
        raise ValueError("must not contain a newline")
    return value


# Every string in a document. A newline is what ends a string in the stored format, and a NUL is
# refused in every string a request carries (D3).
Text = Annotated[str, AfterValidator(_one_line), Storable]

# A function's or a counter's name, which also has to name something.
Name = Annotated[Text, StringConstraints(min_length=1)]

# A raw count at an instruction. Real rather than integer: a producer that samples reports
# estimates, and D3's leniency lets an integer through anyway. Single precision is all the stored
# format holds.
Count = Annotated[RealValue, Field(ge=0, le=MAX_REAL)]

# An address or a top-level counter: whatever the stored format's integers hold.
Unsigned = Annotated[IntegerValue, Field(ge=0, lt=MAX_NUMBER)]


class InstructionDocument(BaseModel):
    """One instruction: where it is, what was counted there, and its disassembled text."""

    model_config = ConfigDict(extra="forbid")

    address: Unsigned
    counters: dict[Name, Count]
    text: Text


class FunctionDocument(BaseModel):
    """One function, as its instructions. Its aggregate counters are derived, never submitted."""

    model_config = ConfigDict(extra="forbid")

    name: Name
    instructions: list[InstructionDocument] = Field(max_length=MAX_INSTRUCTIONS)

    @cached_property
    def counters(self) -> dict[str, float]:
        """Each counter summed over the function's instructions, which is what a function's
        counters are in every profile v4 produced. Derived, so a document cannot contradict itself.
        """
        totals: dict[str, float] = {}
        for instruction in self.instructions:
            for counter, value in instruction.counters.items():
                totals[counter] = totals.get(counter, 0.0) + value
        return totals

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.instructions:
            expected = self.instructions[0].counters.keys()
            previous = self.instructions[0].address
            for position, instruction in enumerate(self.instructions):
                if instruction.counters.keys() != expected:
                    raise ValueError(
                        f"instruction {position} carries the counters "
                        f"{sorted(instruction.counters)} where the first one carries "
                        f"{sorted(expected)}; every instruction of a function carries the same "
                        f"counters"
                    )
                if instruction.address < previous:
                    raise ValueError(
                        f"instruction {position} is at address {instruction.address}, below the "
                        f"{previous} before it; addresses never decrease within a function"
                    )
                previous = instruction.address
        for counter, total in self.counters.items():
            if total > MAX_REAL:
                raise ValueError(f"the '{counter}' counters sum to {total}, which is too large")
        return self


class ProfileDocument(BaseModel):
    """The document a submission's `profile` decodes to (D12)."""

    model_config = ConfigDict(extra="forbid")

    disassembly_format: Text
    counters: dict[Name, Unsigned]
    functions: list[FunctionDocument]

    @model_validator(mode="after")
    def _unique(self) -> Self:
        if len({function.name for function in self.functions}) != len(self.functions):
            raise ValueError("two functions have the same name")
        return self


def stored_profile(encoded: str) -> bytes:
    """The bytes `{suite}.profile` stores for a submitted profile, or a 400 (D12).

    Everything D12 refuses is refused by the validation above, so the writer is never handed a
    document it cannot store.
    """
    document = _parsed(_decompressed(_decoded(encoded)))
    return write_profile(
        document.disassembly_format,
        document.counters,
        {
            function.name: MeasuredFunction(function.counters, function.instructions)
            for function in document.functions
        },
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
        return ProfileDocument.model_validate_json(document)
    except ValidationError as error:
        raise _refused(f"not a valid profile document: {validation_problems(error)}") from error


def _refused(problem: str) -> ApiError:
    return ApiError(ErrorCode.INVALID_REQUEST, f"profile: {problem}")


def _too_large(what: str, limit: int) -> ApiError:
    return _refused(
        f"larger than the {limit} byte limit on a {what} profile; note that this is not the limit "
        f"on the request body, which is reported as 413"
    )
