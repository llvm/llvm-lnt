"""D12's profile binary format, read.

The format is v4's, unchanged: a profile is produced elsewhere, stored verbatim, and this is the
only thing in v5 that interprets it. It is eight sections behind a table of (offset, size) pairs,
built from exactly two primitives -- newline-terminated UTF-8 strings and ULEB128 integers -- with
four of the sections bz2-compressed. The point of that layout is that the index is readable without
touching the compressed part, so listing a profile's functions and their aggregate counters costs
no decompression at all and only a request for one function's disassembly pays for it. That is why
`read_profile` parses the four uncompressed sections eagerly and defers the rest to the first call
to `Profile.instructions`; the endpoints that serve metadata and the function list would otherwise
carry the cost of the data they do not serve.

Nothing here writes. Profiles arrive already encoded (D12) and the server never produces one, so a
serializer would be a second, untested statement of what the format is.

**Every way a stored blob can fail to be read is a `ProfileError`.** That guarantee is what the
endpoints rest on: R4 makes a profile that cannot be deserialized an `internal_error` 500, and it
can only report that if the failure arrives as one recognizable exception rather than as whichever
of `struct.error`, `UnicodeDecodeError`, `KeyError`, `ValueError`, `EOFError` or `OSError` the
underlying primitive happened to raise. It holds by construction rather than by a net: every byte
is read through `_Reader`, which bounds-checks before it reads and validates after it decodes, so
there is no path from blob to primitive that can raise anything else. A net is there anyway, at the
two entry points, in case some path was overlooked.

Corruption must also be cheap to discover. A blob that has been corrupted -- or crafted -- can
claim any size it likes, so nothing here believes a number that describes how much work to do:

- Every count is refused up front unless the section it indexes has at least one byte per element,
  which it must, since no element of this format encodes in zero bytes.
- A function's instruction count is bounded by `MAX_INSTRUCTIONS`: one byte of address delta expands
  into an instruction object hundreds of times its size, so nothing derived from the stored size
  bounds the work. It is also checked against the address bytes that remain to the function, which
  is not a second memory bound -- the loop could not run past them anyway -- but a fast failure with
  a message that says which section is short.
- The compressed sections expand under one budget for the whole profile, `MAX_DECOMPRESSED_SIZE`.
  bz2 reaches ratios beyond 200 000:1 on the repetitive data these sections hold, so no bound
  derived from the stored size means anything and only an absolute ceiling does.
- A ULEB128 integer is at most ten bytes and at most 64 bits, which every quantity the format
  carries -- an address, an offset into the blob, a count, a 32-bit float pattern -- fits in.
"""

from __future__ import annotations

import bz2
import struct
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import NoReturn

# D12: the format version, which is the first thing in a blob and is fixed at 2. Owned here rather
# than by the submission path that also checks it: that check exists so a blob nothing can read is
# refused at the door, which it only does if both halves agree on what version 2 means.
PROFILE_FORMAT_VERSION = 2

# How much the four compressed sections may expand to, together, for one profile. An absolute
# ceiling, because nothing derived from the stored size bounds this -- see the module docstring.
# Chosen to dominate D5's 50 MB cap on a stored profile at the ratios these sections actually reach
# when they hold real data (measured between 3:1 and 6:1), so that a well-formed profile the server
# accepted is one it can still read. It cannot guarantee that, since bz2's ratio has no upper bound
# and D12 says so; what it buys is that only a pathologically compressible blob lands on the wrong
# side, rather than any large one.
MAX_DECOMPRESSED_SIZE = 320 * 1024 * 1024

# How many instructions one function may claim. Real functions are thousands of instructions long;
# this is three orders of magnitude of headroom, and it is what keeps one request's materialized
# disassembly to a size a server can hold.
MAX_INSTRUCTIONS = 1_000_000

# The longest ULEB128 encoding read, and the widest value one may hold. Ten bytes carry 70 bits, so
# the byte limit alone would admit a value no quantity in this format can have; both are checked.
_MAX_NUMBER_BYTES = 10
_MAX_NUMBER = 1 << 64

# The eight sections, in the order their headers appear. The indices are how a section is named in
# a message, and `_TEXT_POOL` is singled out below because its header is the one that is not just
# an (offset, size) pair.
_SECTIONS = (
    "Header",
    "CounterNamePool",
    "TopLevelCounters",
    "LineCounters",
    "LineAddresses",
    "LineText",
    "TextPool",
    "Functions",
)
_HEADER = 0
_COUNTER_NAME_POOL = 1
_TOP_LEVEL_COUNTERS = 2
_LINE_COUNTERS = 3
_LINE_ADDRESSES = 4
_LINE_TEXT = 5
_TEXT_POOL = 6
_FUNCTIONS = 7

# The four that are bz2-compressed, in the order they are expanded.
_COMPRESSED = (_LINE_COUNTERS, _LINE_ADDRESSES, _LINE_TEXT, _TEXT_POOL)

# The exception families a decoding primitive raises, caught at the entry points so that a case the
# validation below fails to anticipate is still a `ProfileError`. Deliberately enumerated rather
# than `Exception`: a `TypeError` or an `AttributeError` here is a bug in this module, and dressing
# one up as a corrupt profile is how it would never get found. `LookupError` and `MemoryError` are
# in the list because a blob is the only thing that could plausibly provoke either. `ProfileError`
# descends from `Exception` alone and so is in none of these families, which is what lets a message
# the validation already worded through the net unchanged rather than re-wrapped.
_DECODING_FAILURES = (
    ValueError,  # also UnicodeDecodeError, and bz2 on a malformed stream
    struct.error,
    LookupError,
    ArithmeticError,  # also OverflowError, from a number too wide to convert
    EOFError,
    OSError,  # bz2 on invalid data
    MemoryError,
)


class ProfileError(Exception):
    """A stored profile cannot be read.

    The only exception `read_profile` and `Profile.instructions` raise for anything to do with the
    blob's contents. R4 turns it into an `internal_error` 500: a profile the server accepted and
    stored and now cannot parse is the server's problem, not the caller's, so the message says what
    is wrong with the blob for whoever reads the log rather than for whoever made the request.
    """


@dataclass(frozen=True, slots=True)
class Function:
    """One function in a profile's index.

    `counters` are the function's aggregate values, one per counter the function was measured with
    -- which may be fewer than the profile's pool holds. `length` is its instruction count, which
    is what `Profile.instructions` will return; it is read from the index, so it is available
    without decompressing anything.
    """

    name: str
    counters: Mapping[str, float]
    length: int


@dataclass(frozen=True, slots=True)
class Instruction:
    """One instruction's address, counter values and disassembly text."""

    address: int
    counters: Mapping[str, float]
    text: str


@dataclass(frozen=True, slots=True)
class _Offsets:
    """Where one function's per-instruction data begins in each of the three per-line sections.

    Kept beside the index rather than on `Function`, which describes a profile to the endpoints and
    has no business carrying offsets into a binary format.
    """

    counters: int
    addresses: int
    text: int


class _Reader:
    """A bounds-checked cursor over one section's bytes.

    Every byte of a profile is read through one of these. Each method checks what it needs before
    it reads it and validates what it decoded afterwards, so none of them can raise anything but a
    `ProfileError` -- which is what makes the module's guarantee a property of the code rather than
    of a `try` around it. `io.BytesIO` would not do: its `read` past the end returns short rather
    than failing, and its `seek` to a negative offset raises a bare `ValueError`.

    `section` names what is being read, so that a message says where in the blob the trouble is.
    """

    def __init__(self, data: bytes, section: str) -> None:
        self._data = data
        self._section = section
        self._position = 0

    @property
    def position(self) -> int:
        return self._position

    @property
    def remaining(self) -> int:
        return len(self._data) - self._position

    def fail(self, problem: str) -> NoReturn:
        raise ProfileError(f"{self._section}: {problem}")

    def seek(self, offset: int) -> None:
        if offset > len(self._data):
            self.fail(f"offset {offset} is past the end of the {len(self._data)} byte section")
        self._position = offset

    def number(self) -> int:
        """One ULEB128 integer."""
        value = 0
        for shift in range(0, 7 * _MAX_NUMBER_BYTES, 7):
            if self._position >= len(self._data):
                self.fail("data ends in the middle of a number")
            byte = self._data[self._position]
            self._position += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                if value >= _MAX_NUMBER:
                    self.fail(f"the number {value} is wider than the 64 bits anything here needs")
                return value
        self.fail(f"a number runs past the {_MAX_NUMBER_BYTES} bytes anything here needs")

    def count(self, what: str) -> int:
        """How many of something follows, refused up front if the section cannot hold that many.

        Nothing in this format encodes in zero bytes, so the bytes left in the section are an upper
        bound on the number of elements that can still be in it -- a cheap, exact bound that costs
        a corrupt count its chance to make the loop that follows do any work at all.
        """
        value = self.number()
        if value > self.remaining:
            self.fail(f"claims {value} {what}, but only {self.remaining} bytes remain")
        return value

    def string(self) -> str:
        """One newline-terminated UTF-8 string."""
        end = self._data.find(b"\n", self._position)
        if end < 0:
            self.fail("data ends in the middle of a string")
        raw = self._data[self._position : end]
        self._position = end + 1
        try:
            return raw.decode()
        except UnicodeDecodeError as error:
            self.fail(f"a string is not valid UTF-8: {error}")

    def real(self) -> float:
        """One float, stored as the ULEB128 encoding of its IEEE-754 single-precision bits.

        The full unsigned 32-bit range is accepted, so a negative value reads back as itself. v4's
        writer cannot actually produce one -- it converts the pattern through a *signed* 32-bit
        field, and its ULEB128 writer does not terminate on the negative result -- but the encoding
        is unambiguous and refusing half of it would buy nothing. Anything wider than 32 bits is not
        a pattern at all, and is corruption.
        """
        bits = self.number()
        if bits >= 1 << 32:
            self.fail(f"{bits} is too wide to be a 32-bit float bit pattern")
        value: float = struct.unpack(">f", struct.pack(">I", bits))[0]
        if not isfinite(value):
            # D3 admits no infinite or NaN value anywhere in this system, which is the reason this
            # is refused; that JSON could not express one either is a corroboration rather than the
            # rule, so the contract here does not depend on how a response is rendered.
            self.fail(f"the bit pattern 0x{bits:08x} is {value}, which no counter value is")
        return value


class Profile:
    """A parsed profile: an index that is ready, and per-instruction data that is not.

    Built by `read_profile`. Three attributes carry the index, and cost no decompression:

    - `disassembly_format`, how an instruction's text was produced, e.g. 'llvm-objdump';
    - `counters`, the profile's top-level counters, which are integers unlike every other counter
      in a profile;
    - `functions`, the functions by name, in the order the blob lists them.

    `instructions` is the one thing that decompresses.

    Not thread-safe: the first call to `instructions` mutates the instance to cache the expanded
    sections. One profile is parsed per request and not shared, which is what makes that fine.
    """

    def __init__(
        self,
        disassembly_format: str,
        counters: Mapping[str, int],
        functions: Mapping[str, Function],
        offsets: Mapping[str, _Offsets],
        compressed: Mapping[int, memoryview],
    ) -> None:
        self.disassembly_format = disassembly_format
        self.counters = counters
        self.functions = functions
        self._offsets = offsets
        self._compressed = compressed
        self._expanded: Mapping[int, bytes] | None = None

    def instructions(self, name: str) -> Sequence[Instruction]:
        """One function's disassembly, decompressing the per-line sections if nothing has yet.

        The name must be one of `functions`; a caller that cannot promise that should ask
        `functions` first, since this raises `KeyError` for anything else the way any mapping does.
        That is not a `ProfileError` and must not be treated as one -- a name that is not in the
        index says nothing about the blob.
        """
        function = self.functions[name]
        offsets = self._offsets[name]
        try:
            return self._instructions(function, offsets)
        except _DECODING_FAILURES as error:
            raise ProfileError(
                f"function '{name}' could not be read: {type(error).__name__}: {error}"
            ) from error

    def _instructions(self, function: Function, offsets: _Offsets) -> Sequence[Instruction]:
        # Before anything is decompressed, let alone built; see the module docstring for why an
        # absolute cap and not only the exact bound below.
        if function.length > MAX_INSTRUCTIONS:
            raise ProfileError(
                f"function '{function.name}' claims {function.length} instructions, more than the "
                f"{MAX_INSTRUCTIONS} a profile may hold for one function"
            )

        sections = self._sections()

        counters = _Reader(sections[_LINE_COUNTERS], _SECTIONS[_LINE_COUNTERS])
        counters.seek(offsets.counters)
        addresses = _Reader(sections[_LINE_ADDRESSES], _SECTIONS[_LINE_ADDRESSES])
        addresses.seek(offsets.addresses)
        text = _Reader(sections[_LINE_TEXT], _SECTIONS[_LINE_TEXT])
        text.seek(offsets.text)
        pool = _Reader(sections[_TEXT_POOL], _SECTIONS[_TEXT_POOL])

        # The exact bound, and again before a single instruction is built. The address delta is the
        # one field every instruction spends at least a byte on whatever else it holds -- a function
        # measured with no counters at all spends nothing in LineCounters.
        if function.length > addresses.remaining:
            addresses.fail(
                f"function '{function.name}' claims {function.length} instructions, but only "
                f"{addresses.remaining} bytes of addresses remain"
            )

        # The writer emits one value per counter of *this* function, in sorted name order, for each
        # instruction; the per-line data carries no names of its own to recover the order from.
        measured = sorted(function.counters)

        instructions: list[Instruction] = []
        address = 0
        for _ in range(function.length):
            values = {counter: counters.real() for counter in measured}
            # Addresses are stored as deltas from the previous one, which is what makes the section
            # compress: on a RISC target every delta is the same number.
            address += addresses.number()
            pool.seek(text.number())
            instructions.append(Instruction(address=address, counters=values, text=pool.string()))
        return instructions

    def _sections(self) -> Mapping[int, bytes]:
        """The four compressed sections, expanded once under one budget and kept."""
        if self._expanded is None:
            expanded: dict[int, bytes] = {}
            budget = MAX_DECOMPRESSED_SIZE
            for section in _COMPRESSED:
                expanded[section] = _expand(self._compressed[section], section, budget)
                budget -= len(expanded[section])
            self._expanded = expanded
            # Released only now: a failure above leaves the profile exactly as it was, so a second
            # attempt reports the same thing rather than finding the sections empty.
            self._compressed = {}
        return self._expanded


def read_profile(data: bytes) -> Profile:
    """The profile a stored blob holds, or a `ProfileError` (D12).

    Reads the index and leaves the per-line sections compressed; see the module docstring for why
    that split is the whole point of the format.
    """
    try:
        return _read_profile(data)
    except _DECODING_FAILURES as error:
        raise ProfileError(f"profile could not be read: {type(error).__name__}: {error}") from error


def _read_profile(data: bytes) -> Profile:
    if not data:
        raise ProfileError("profile is empty, so it carries no format version")

    blob = _Reader(data, "profile")
    version = blob.number()
    if version != PROFILE_FORMAT_VERSION:
        raise ProfileError(
            f"profile declares format version {version}, but only version "
            f"{PROFILE_FORMAT_VERSION} is supported"
        )

    table = _read_section_table(blob, len(data))
    start = blob.position

    def raw(index: int) -> bytes:
        offset, size = table[index]
        return data[start + offset : start + offset + size]

    def section(index: int) -> _Reader:
        return _Reader(raw(index), _SECTIONS[index])

    disassembly_format = section(_HEADER).string()
    counter_names = _read_counter_names(section(_COUNTER_NAME_POOL))
    counters = _read_top_level_counters(section(_TOP_LEVEL_COUNTERS), counter_names)
    functions, offsets = _read_functions(section(_FUNCTIONS), counter_names)

    # Views rather than copies, because between them these four are the whole blob -- the index is
    # rounding error next to them -- and two of the three endpoints never expand any of them. A
    # slice would double the resident bytes of a 50 MB profile to serve a response that reads none
    # of it. `BZ2Decompressor` takes a memoryview, so nothing downstream has to care.
    whole = memoryview(data)
    compressed = {
        index: whole[start + table[index][0] : start + table[index][0] + table[index][1]]
        for index in _COMPRESSED
    }

    return Profile(
        disassembly_format=disassembly_format,
        counters=counters,
        functions=functions,
        offsets=offsets,
        compressed=compressed,
    )


def _read_section_table(blob: _Reader, length: int) -> list[tuple[int, int]]:
    """The eight (offset, size) pairs, each checked to lie inside the blob.

    Offsets are relative to the end of the table, which is why the whole table is read before any
    of it can be resolved. Checked here rather than where a section is read, because a short read
    off the end of the blob would otherwise pass for a truncated section and be reported as
    whatever the section's own parser tripped over first.
    """
    table: list[tuple[int, int]] = []
    for index in range(len(_SECTIONS)):
        offset = blob.number()
        size = blob.number()
        if index == _TEXT_POOL:
            # The TextPool header carries one field the others do not: the name of an external file
            # the pool may live in instead of in this blob. v4 scaffolded that and never implemented
            # it -- its own reader raises on a non-empty name -- so a blob naming one is a blob
            # whose disassembly text is somewhere v5 has no notion of.
            pool = blob.string()
            if pool:
                raise ProfileError(
                    f"the TextPool section names the external pool file '{pool}', and a profile "
                    f"whose text is not in the profile cannot be read"
                )
        table.append((offset, size))

    end_of_table = blob.position
    for (offset, size), name in zip(table, _SECTIONS, strict=True):
        if end_of_table + offset + size > length:
            raise ProfileError(
                f"the {name} section runs from offset {offset} for {size} bytes, past the end of "
                f"the {length} byte profile"
            )
    return table


def _read_counter_names(pool: _Reader) -> Sequence[str]:
    """The counter names every other section refers to by index."""
    return [pool.string() for _ in range(pool.count("counter names"))]


def _read_top_level_counters(section: _Reader, names: Sequence[str]) -> Mapping[str, int]:
    """The profile's aggregate counters, which are integers rather than floats."""
    counters: dict[str, int] = {}
    for _ in range(section.count("counters")):
        # Named before the value is read: a subscripted assignment evaluates its right-hand side
        # first, so writing this as one statement would read the pair in the wrong order.
        counter = _counter_name(section, names)
        counters[counter] = section.number()
    return counters


def _read_functions(
    section: _Reader, names: Sequence[str]
) -> tuple[Mapping[str, Function], Mapping[str, _Offsets]]:
    """The index: every function's aggregate counters, instruction count and per-line offsets."""
    functions: dict[str, Function] = {}
    offsets: dict[str, _Offsets] = {}
    for _ in range(section.count("functions")):
        name = section.string()
        length = section.number()
        where = _Offsets(
            counters=section.number(), addresses=section.number(), text=section.number()
        )
        counters: dict[str, float] = {}
        for _ in range(section.count("counters")):
            counter = _counter_name(section, names)
            counters[counter] = section.real()
        functions[name] = Function(name=name, counters=counters, length=length)
        offsets[name] = where
    return functions, offsets


def _counter_name(section: _Reader, names: Sequence[str]) -> str:
    """One counter's name, read as an index into the pool."""
    index = section.number()
    if index >= len(names):
        section.fail(f"counter index {index} is out of range; the pool holds {len(names)} names")
    return names[index]


def _expand(data: memoryview, section: int, budget: int) -> bytes:
    """One bz2 section, decompressed within what is left of the profile's budget.

    Incremental rather than `bz2.decompress`, which would expand a compression bomb in full before
    anything could measure it.
    """
    name = _SECTIONS[section]
    over_budget = (
        f"{name}: the profile's sections expand beyond the {MAX_DECOMPRESSED_SIZE} byte limit"
    )
    if budget <= 0:
        raise ProfileError(over_budget)
    decompressor = bz2.BZ2Decompressor()
    try:
        expanded = decompressor.decompress(data, max_length=budget)
    except (OSError, EOFError, ValueError) as error:
        raise ProfileError(f"{name}: is not valid bz2 data: {error}") from error
    if not decompressor.eof:
        if decompressor.needs_input:
            raise ProfileError(f"{name}: the bz2 stream ends before its data does")
        raise ProfileError(over_budget)
    if decompressor.unused_data:
        raise ProfileError(
            f"{name}: {len(decompressor.unused_data)} bytes follow the end of the bz2 stream"
        )
    return expanded
