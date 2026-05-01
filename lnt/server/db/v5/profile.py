"""
Profile binary format parser for LNT v5.

Read-only parser for the LNT profile binary format (wire-compatible with
the v4 "ProfileV2" format).  Provides lazy decompression: metadata and
function indices are available immediately, while per-instruction data
(addresses, counters, disassembly text) is decompressed on first access.

The server only reads profiles -- no serialization support is provided.
"""

from __future__ import annotations

import bz2
import io
import struct
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class ProfileParseError(Exception):
    """Raised when profile binary data is corrupt or invalid."""


# ---------------------------------------------------------------------------
# Primitive readers
# ---------------------------------------------------------------------------

def read_uleb128(f: io.BufferedIOBase | io.BytesIO) -> int:
    """Read a ULEB128-encoded unsigned integer."""
    n = 0
    shift = 0
    while True:
        raw = f.read(1)
        if not raw:
            raise ProfileParseError("unexpected end of data in ULEB128")
        b = raw[0]
        n |= (b & 0x7F) << shift
        shift += 7
        if (b & 0x80) == 0:
            return n


def _read_string(f: io.BufferedIOBase | io.BytesIO) -> str:
    """Read a newline-terminated UTF-8 string."""
    line = f.readline()
    if not line or not line.endswith(b"\n"):
        raise ProfileParseError("unexpected end of data in string")
    return line[:-1].decode("utf-8")


def _read_float(f: io.BufferedIOBase | io.BytesIO) -> float:
    """Read a float stored as ULEB128 bit-pattern."""
    num = read_uleb128(f)
    if num == 0:
        return 0.0
    packed = struct.pack(">I", num & 0xFFFFFFFF)
    return struct.unpack(">f", packed)[0]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class FunctionInfo:
    """Metadata for a single function in a profile."""
    counters: dict[str, float]
    length: int


@dataclass
class Instruction:
    """Per-instruction data from a profile."""
    address: int
    counters: dict[str, float]
    text: str


# ---------------------------------------------------------------------------
# Profile parser
# ---------------------------------------------------------------------------

class ProfileData:
    """Read-only profile binary format parser with lazy decompression.

    The binary format consists of 8 sections.  Sections 0-2 and 7
    (Header, CounterNamePool, TopLevelCounters, Functions) are
    uncompressed and read eagerly.  Sections 3-6 (LineCounters,
    LineAddresses, LineText, TextPool) are BZ2-compressed and read
    lazily on first call to :meth:`get_code_for_function`.
    """

    def __init__(self) -> None:
        # Eagerly parsed (uncompressed sections)
        self._disassembly_format: str = ""
        self._counter_names: dict[int, str] = {}
        self._top_level_counters: dict[str, int] = {}
        self._functions: dict[str, FunctionInfo] = {}
        # Per-function offsets into the compressed sections
        self._fn_lc_offset: dict[str, int] = {}
        self._fn_la_offset: dict[str, int] = {}
        self._fn_lt_offset: dict[str, int] = {}
        # Raw compressed bytes (decompressed lazily)
        self._raw_line_counters: bytes = b""
        self._raw_line_addresses: bytes = b""
        self._raw_line_text: bytes = b""
        self._raw_text_pool: bytes = b""
        # Decompressed caches (None = not yet decompressed)
        self._line_counters: bytes | None = None
        self._line_addresses: bytes | None = None
        self._line_text: bytes | None = None
        self._text_pool: bytes | None = None

    # -- Public API --------------------------------------------------------

    @staticmethod
    def validate_version(data: bytes) -> None:
        """Validate that *data* starts with a supported version byte.

        Raises :class:`ProfileParseError` if the data is empty or the
        version is not 2.  This is a lightweight check for use during
        submission -- it does not parse the full blob.
        """
        if not data or data[0] != 2:
            version = data[0] if data else "empty"
            raise ProfileParseError(
                f"unsupported profile format version {version} (expected 2)"
            )

    @staticmethod
    def deserialize(data: bytes) -> ProfileData:
        """Parse a profile binary blob.

        Raises :class:`ProfileParseError` on invalid or corrupt data.
        """
        f = io.BytesIO(data)

        # Version
        try:
            version = read_uleb128(f)
        except ProfileParseError:
            raise ProfileParseError("empty or truncated profile data")
        if version != 2:
            raise ProfileParseError(
                f"unsupported profile format version {version} (expected 2)"
            )

        # Read all 8 section headers.
        try:
            return ProfileData._parse_sections(f)
        except (KeyError, struct.error) as e:
            raise ProfileParseError(f"corrupt profile data: {e}") from e

    @staticmethod
    def _parse_sections(f: io.BytesIO) -> ProfileData:
        """Parse section headers and data from a positioned stream."""
        p = ProfileData()

        #   Sections 0-5,7: offset (ULEB128) + size (ULEB128)
        #   Section 6 (TextPool): offset + size + pool_fname (string)
        headers: list[tuple[int, int]] = []
        for i in range(8):
            offset = read_uleb128(f)
            size = read_uleb128(f)
            if i == 6:  # TextPool: extra pool_fname string
                _read_string(f)  # discard (always empty)
            headers.append((offset, size))

        data_start = f.tell()

        def _section_bytes(idx: int) -> bytes:
            off, sz = headers[idx]
            f.seek(data_start + off)
            return f.read(sz)

        # -- Section 0: Header (uncompressed) ------------------------------
        sec = io.BytesIO(_section_bytes(0))
        p._disassembly_format = _read_string(sec)

        # -- Section 1: CounterNamePool (uncompressed) ---------------------
        sec = io.BytesIO(_section_bytes(1))
        n_names = read_uleb128(sec)
        for i in range(n_names):
            p._counter_names[i] = _read_string(sec)

        # -- Section 2: TopLevelCounters (uncompressed) --------------------
        sec = io.BytesIO(_section_bytes(2))
        n_counters = read_uleb128(sec)
        for _ in range(n_counters):
            idx = read_uleb128(sec)
            val = read_uleb128(sec)
            p._top_level_counters[p._counter_names[idx]] = val

        # -- Sections 3-6: store raw compressed bytes (lazy) ---------------
        p._raw_line_counters = _section_bytes(3)
        p._raw_line_addresses = _section_bytes(4)
        p._raw_line_text = _section_bytes(5)
        p._raw_text_pool = _section_bytes(6)

        # -- Section 7: Functions (uncompressed) ---------------------------
        sec = io.BytesIO(_section_bytes(7))
        n_functions = read_uleb128(sec)
        for _ in range(n_functions):
            name = _read_string(sec)
            length = read_uleb128(sec)
            lc_off = read_uleb128(sec)
            la_off = read_uleb128(sec)
            lt_off = read_uleb128(sec)
            counters: dict[str, float] = {}
            n_fn_counters = read_uleb128(sec)
            for _ in range(n_fn_counters):
                cidx = read_uleb128(sec)
                cval = _read_float(sec)
                counters[p._counter_names[cidx]] = cval
            p._functions[name] = FunctionInfo(counters=counters, length=length)
            p._fn_lc_offset[name] = lc_off
            p._fn_la_offset[name] = la_off
            p._fn_lt_offset[name] = lt_off

        return p

    def get_disassembly_format(self) -> str:
        """Return the disassembly format string (e.g., ``'llvm-objdump'``)."""
        return self._disassembly_format

    def get_top_level_counters(self) -> dict[str, int]:
        """Return aggregate counters for the entire profile.

        No BZ2 decompression needed.
        """
        return dict(self._top_level_counters)

    def get_functions(self) -> dict[str, FunctionInfo]:
        """Return function metadata keyed by name.

        No BZ2 decompression needed.
        """
        return dict(self._functions)

    def get_code_for_function(self, name: str) -> list[Instruction]:
        """Return per-instruction data for a function.

        Triggers BZ2 decompression of compressed sections on first call.

        Raises ``KeyError`` if *name* is not found.
        """
        fn = self._functions[name]  # raises KeyError if missing
        self._ensure_decompressed()

        assert self._line_counters is not None
        assert self._line_addresses is not None
        assert self._line_text is not None
        assert self._text_pool is not None

        counter_names = sorted(fn.counters.keys())

        # LineCounters
        lc_io = io.BytesIO(self._line_counters)
        lc_io.seek(self._fn_lc_offset[name])

        # LineAddresses
        la_io = io.BytesIO(self._line_addresses)
        la_io.seek(self._fn_la_offset[name])

        # LineText
        lt_io = io.BytesIO(self._line_text)
        lt_io.seek(self._fn_lt_offset[name])

        tp_io = io.BytesIO(self._text_pool)

        instructions: list[Instruction] = []
        prev_address = 0
        for _ in range(fn.length):
            # Counters (one float per counter name, sorted)
            ctrs: dict[str, float] = {}
            for cname in counter_names:
                ctrs[cname] = _read_float(lc_io)

            # Address (delta-encoded)
            delta = read_uleb128(la_io)
            address = prev_address + delta
            prev_address = address

            # Text (offset into TextPool)
            tp_offset = read_uleb128(lt_io)
            tp_io.seek(tp_offset)
            text = _read_string(tp_io)

            instructions.append(Instruction(
                address=address,
                counters=ctrs,
                text=text,
            ))

        return instructions

    # -- Internal ----------------------------------------------------------

    def _ensure_decompressed(self) -> None:
        """Decompress BZ2 sections on first access."""
        if self._line_counters is not None:
            return
        try:
            self._line_counters = bz2.decompress(self._raw_line_counters)
            self._line_addresses = bz2.decompress(self._raw_line_addresses)
            self._line_text = bz2.decompress(self._raw_line_text)
            self._text_pool = bz2.decompress(self._raw_text_pool)
        except Exception as e:
            raise ProfileParseError(
                f"failed to decompress profile sections: {e}"
            ) from e
        # Release raw compressed bytes now that we have decompressed copies.
        self._raw_line_counters = b""
        self._raw_line_addresses = b""
        self._raw_line_text = b""
        self._raw_text_pool = b""
