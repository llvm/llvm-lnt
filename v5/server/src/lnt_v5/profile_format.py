"""The binary format profiles are stored in: v4's version 2 format, read and written.

D12 leaves the stored encoding of a profile to the implementation. This one is v4's, unchanged,
because it is the most compact of the representations measured on lnt.llvm.org's profiles, and
because its index is readable without decompressing anything: listing a profile's functions and
their aggregate counters costs no decompression, and only a request for one function's disassembly
pays for it. That is why `read_profile` parses the index eagerly and defers the rest to the first
call to `Profile.instructions`.

Every blob is written by `write_profile`, from a document D12 has already validated, and
`write_profile` reproduces v4's writer byte for byte -- which its tests check against blobs v4
wrote.

The format
----------

A blob is built from two primitives. An *integer* is ULEB128: groups of seven bits, least
significant first, the high bit of every byte but the last one set. A *string* is UTF-8 terminated
by a newline, which it therefore cannot contain. A *float* is the integer whose value is the
number's IEEE-754 single-precision bit pattern.

The blob begins with the format version, the integer 2, followed by a section table: eight headers,
one per section in the order below, each an offset and a size. Offsets are relative to the end of
the table. The TextPool header carries one more field, a string naming an external file the pool
lives in instead -- scaffolding v4 never implemented, so it is always empty.

1. **Header**: the disassembly format, as a string.
2. **CounterNamePool**: a count, then that many strings. Everything else names a counter by its
   index into this list.
3. **TopLevelCounters**: a count, then that many pairs of counter index and integer value.
4. **LineCounters**: per instruction, one float per counter *of its function*, in ascending order of
   counter name.
5. **LineAddresses**: per instruction, the delta from the previous instruction's address; a
   function's addresses start from zero, so its first delta is its first address.
6. **LineText**: per instruction, the byte offset of its text within TextPool. A zero follows each
   function's offsets, which a reader never sees, since the index says how many to read.
7. **TextPool**: strings one after another, each distinct text once, addressed by byte offset.
8. **Functions**, the index: a count, then per function its name, its instruction count, its
   offsets into LineCounters, LineAddresses and LineText in that order, then a count of its
   counters followed by that many pairs of counter index and float value.

Sections 4 to 7 are each an independent bz2 stream, and the offsets into them address their
decompressed bytes. Sections 1, 2, 3 and 8 are stored as written, and are the index.

Reading defensively
-------------------

A blob the server wrote should always read back, so a failure means corruption in storage or a bug
here. The reader still believes nothing a blob claims, so that either turns into one recognizable
`ProfileError` rather than whichever of `struct.error`, `UnicodeDecodeError`, `KeyError` or
`OSError` a primitive happened to raise -- or into a hang, or an allocation nothing can satisfy:

- Every byte is read through `_Reader`, which bounds-checks before it reads and validates after it
  decodes. A net at the two entry points catches whatever some overlooked path might raise.
- Every count is refused unless the section it indexes has at least one byte per element, which it
  must, since no element of this format encodes in zero bytes.
- A function's instruction count is bounded by `MAX_INSTRUCTIONS`, and the compressed sections
  expand under one budget for the whole profile, `MAX_DECOMPRESSED_SIZE`.
- A ULEB128 integer is at most ten bytes and at most 64 bits.
"""

from __future__ import annotations

import bz2
import struct
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from typing import NoReturn, Protocol

# The format version, the first thing in a blob.
PROFILE_FORMAT_VERSION = 2

# How much the four compressed sections may expand to, together, for one profile. D12's cap on a
# decompressed document is defined as this (`suites.profile_document`), and a document always
# expands to less in this format, which spends fewer bytes than JSON on every part of it.
MAX_DECOMPRESSED_SIZE = 64 * 1024 * 1024

# D12's cap on the instructions of one function: several times the largest function measured on
# lnt.llvm.org, and what keeps one request's materialized disassembly to a size a server can hold.
MAX_INSTRUCTIONS = 100_000

# The longest ULEB128 encoding read, and one past the widest value one may hold. Ten bytes carry 70
# bits, so the byte limit alone would admit a value no quantity in this format can have; both are
# checked.
_MAX_NUMBER_BYTES = 10
MAX_NUMBER = 1 << 64

# The largest finite single-precision value, which is all a float in this format can hold.
MAX_REAL: float = struct.unpack(">f", bytes.fromhex("7f7fffff"))[0]

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
# checks below fail to anticipate is still a `ProfileError`. Enumerated rather than `Exception`, so
# that a `TypeError` or an `AttributeError` -- a bug in this module -- is not dressed up as a
# corrupt profile.
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
    blob's contents. Every blob is one the server wrote, so this is a fault -- R4's generic
    `internal_error` -- and the message says what is wrong with the blob for whoever reads the log.
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
    `ProfileError`. `io.BytesIO` would not do: its `read` past the end returns short rather than
    failing, and its `seek` to a negative offset raises a bare `ValueError`.

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
                if value >= MAX_NUMBER:
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
        """One float, stored as the ULEB128 encoding of its IEEE-754 single-precision bits."""
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
        # Before anything is decompressed, let alone built: the exact bound below needs the
        # expanded sections, and this one does not.
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

    # Views rather than copies: the four compressed sections are nearly the whole blob, and two of
    # the three read endpoints never expand any of them. `BZ2Decompressor` takes a memoryview.
    whole = memoryview(data)

    def raw(index: int) -> memoryview:
        offset, size = table[index]
        return whole[start + offset : start + offset + size]

    def section(index: int) -> _Reader:
        return _Reader(bytes(raw(index)), _SECTIONS[index])

    disassembly_format = section(_HEADER).string()
    counter_names = _read_counter_names(section(_COUNTER_NAME_POOL))
    counters = _read_top_level_counters(section(_TOP_LEVEL_COUNTERS), counter_names)
    functions, offsets = _read_functions(section(_FUNCTIONS), counter_names)

    compressed = {index: raw(index) for index in _COMPRESSED}

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


# --------------------------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------------------------


class InstructionData(Protocol):
    """One instruction as `write_profile` takes it: `Instruction`, or anything shaped like it."""

    @property
    def address(self) -> int: ...
    @property
    def counters(self) -> Mapping[str, float]: ...
    @property
    def text(self) -> str: ...


@dataclass(frozen=True, slots=True)
class MeasuredFunction:
    """One function as `write_profile` takes it: its aggregate counters and its instructions.

    Every instruction must carry exactly the function's counters. The format stores one value per
    counter of the function for each instruction and no names, so that is a precondition rather
    than something the format could record otherwise.
    """

    counters: Mapping[str, float]
    instructions: Sequence[InstructionData]


class _Writer:
    """An append-only buffer that encodes the format's two primitives, and refuses what they cannot
    hold rather than writing something `_Reader` would not read back."""

    def __init__(self) -> None:
        self._data = bytearray()

    @property
    def position(self) -> int:
        return len(self._data)

    def getvalue(self) -> bytes:
        return bytes(self._data)

    def number(self, value: int) -> None:
        """One ULEB128 integer, within the width `_Reader.number` accepts."""
        if not 0 <= value < MAX_NUMBER:
            raise ValueError(f"{value} is not an integer in [0, 2**64)")
        while value > 0x7F:
            self._data.append(value & 0x7F | 0x80)
            value >>= 7
        self._data.append(value)

    def string(self, value: str) -> None:
        """One newline-terminated UTF-8 string, which therefore cannot contain a newline."""
        if "\n" in value:
            raise ValueError(f"{value!r} contains a newline, which ends a string in this format")
        try:
            self._data += value.encode() + b"\n"
        except UnicodeEncodeError as error:
            raise ValueError(f"{value!r} is not encodable as UTF-8: {error}") from None

    def real(self, value: float) -> None:
        """One float, as the ULEB128 encoding of its IEEE-754 single-precision bits.

        Zero is written as the literal 0, as v4 does, which also folds -0.0 into it.
        """
        if value == 0.0:
            self.number(0)
            return
        if not isfinite(value):
            raise ValueError(f"{value} is not a finite number")
        try:
            packed = struct.pack(">f", value)
        except OverflowError:
            raise ValueError(f"{value} is too large for single precision") from None
        self.number(struct.unpack(">I", packed)[0])


def write_profile(
    disassembly_format: str,
    counters: Mapping[str, int],
    functions: Mapping[str, MeasuredFunction],
) -> bytes:
    """The blob `read_profile` reads back as this profile.

    Byte for byte what v4's writer produces for the same data, down to the order it emits things
    in: functions and counters sorted by name, and each distinct instruction text pooled once, at
    its first use. Counter values come back rounded to single precision, which is all the format
    stores.

    The profile must be one `read_profile` can read back, which D12's validation of a submitted
    document guarantees (see `suites.profile_document`): at most `MAX_INSTRUCTIONS` per function,
    addresses that never decrease within one, and every instruction carrying exactly its
    function's counters. A document within D12's cap on its decompressed size always expands to
    less than `MAX_DECOMPRESSED_SIZE` here. What the primitives cannot encode -- a newline in a
    string, a number outside [0, 2**64), a float single precision cannot hold -- is a `ValueError`.
    """
    ordered = sorted(functions.items())

    names = sorted(
        {*counters, *(counter for _, function in ordered for counter in function.counters)}
    )
    index = {counter: position for position, counter in enumerate(names)}

    header = _Writer()
    header.string(disassembly_format)

    pool = _Writer()
    pool.number(len(names))
    for counter in names:
        pool.string(counter)

    top_level = _Writer()
    top_level.number(len(counters))
    for counter, value in sorted(counters.items()):
        top_level.number(index[counter])
        top_level.number(value)

    line_counters, line_addresses, line_text, text_pool = _Writer(), _Writer(), _Writer(), _Writer()
    pooled: dict[str, int] = {}
    index_entries = _Writer()
    index_entries.number(len(ordered))
    for name, function in ordered:
        index_entries.string(name)
        index_entries.number(len(function.instructions))
        index_entries.number(line_counters.position)
        index_entries.number(line_addresses.position)
        index_entries.number(line_text.position)
        index_entries.number(len(function.counters))
        for counter, aggregate in sorted(function.counters.items()):
            index_entries.number(index[counter])
            index_entries.real(aggregate)

        measured = sorted(function.counters)
        previous = 0
        for instruction in function.instructions:
            for counter in measured:
                line_counters.real(instruction.counters[counter])
            line_addresses.number(instruction.address - previous)
            previous = instruction.address
            if instruction.text not in pooled:
                pooled[instruction.text] = text_pool.position
                text_pool.string(instruction.text)
            line_text.number(pooled[instruction.text])
        # The terminator v4 emits after each function's offsets; see the module docstring.
        line_text.number(0)

    # v4's pool starts out as a lone newline that the first string overwrites, so a profile with no
    # instructions at all stores that newline rather than nothing.
    expanded = [
        line_counters.getvalue(),
        line_addresses.getvalue(),
        line_text.getvalue(),
        text_pool.getvalue() or b"\n",
    ]

    sections = [
        header.getvalue(),
        pool.getvalue(),
        top_level.getvalue(),
        *(bz2.compress(section) for section in expanded),
        index_entries.getvalue(),
    ]
    blob = _Writer()
    blob.number(PROFILE_FORMAT_VERSION)
    offset = 0
    for position, section in enumerate(sections):
        blob.number(offset)
        blob.number(len(section))
        if position == _TEXT_POOL:
            blob.string("")  # No external pool file; see `_read_section_table`.
        offset += len(section)
    return blob.getvalue() + b"".join(sections)
