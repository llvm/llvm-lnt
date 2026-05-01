# Profile binary format parser tests.
#
# These are pure Python unit tests (no database needed).  They use the
# v4 profilev2impl serializer to create valid blobs and verify that the
# v5 parser reads them correctly.
#
# RUN: python %s
# END.

import io
import unittest

from lnt.server.db.v5.profile import (
    ProfileData,
    ProfileParseError,
    read_uleb128,
)


# ---------------------------------------------------------------------------
# Helpers: create profile blobs using the v4 serializer
# ---------------------------------------------------------------------------

def _make_v1_profile_data(
    disassembly_format: str = "raw",
    counters: dict | None = None,
    functions: dict | None = None,
) -> dict:
    """Build a v1-format profile dict (used as input to ProfileV2.upgrade)."""
    if counters is None:
        counters = {"cycles": 1000}
    if functions is None:
        functions = {
            "main": {
                "counters": {"cycles": 50.0},
                "data": [
                    [{"cycles": 30.0}, 0x1000, "push rbp"],
                    [{"cycles": 20.0}, 0x1004, "mov rsp, rbp"],
                ],
            }
        }
    return {
        "disassembly-format": disassembly_format,
        "counters": counters,
        "functions": {
            name: {
                "counters": fdata["counters"],
                "data": fdata["data"],
            }
            for name, fdata in functions.items()
        },
    }


def _v1_to_v2_bytes(v1_data: dict) -> bytes:
    """Convert a v1 profile dict to v2 binary format using the v4 serializer."""
    from lnt.testing.profile.profilev1impl import ProfileV1
    from lnt.testing.profile.profilev2impl import ProfileV2

    v1 = ProfileV1(v1_data)
    v2 = ProfileV2.upgrade(v1)
    return v2.serialize()


def _make_basic_profile_bytes(**kwargs) -> bytes:
    """Create a valid v2 profile blob with optional overrides."""
    data = _make_v1_profile_data(**kwargs)
    return _v1_to_v2_bytes(data)


# ---------------------------------------------------------------------------
# ULEB128 tests
# ---------------------------------------------------------------------------

class TestULEB128(unittest.TestCase):
    def _encode(self, n: int) -> bytes:
        """Encode n as ULEB128."""
        buf = bytearray()
        while True:
            b = n & 0x7F
            n >>= 7
            if n != 0:
                b |= 0x80
            buf.append(b)
            if n == 0:
                break
        return bytes(buf)

    def test_zero(self):
        self.assertEqual(read_uleb128(io.BytesIO(self._encode(0))), 0)

    def test_single_byte_max(self):
        self.assertEqual(read_uleb128(io.BytesIO(self._encode(127))), 127)

    def test_two_byte_min(self):
        self.assertEqual(read_uleb128(io.BytesIO(self._encode(128))), 128)

    def test_two_byte_max(self):
        self.assertEqual(read_uleb128(io.BytesIO(self._encode(16383))), 16383)

    def test_three_byte_min(self):
        self.assertEqual(read_uleb128(io.BytesIO(self._encode(16384))), 16384)

    def test_large_value(self):
        val = 2**32 - 1
        self.assertEqual(read_uleb128(io.BytesIO(self._encode(val))), val)

    def test_truncated_raises(self):
        with self.assertRaises(ProfileParseError):
            read_uleb128(io.BytesIO(b""))


# ---------------------------------------------------------------------------
# Round-trip tests (v4 serializer -> v5 parser)
# ---------------------------------------------------------------------------

class TestProfileRoundTrip(unittest.TestCase):
    def test_basic_profile(self):
        blob = _make_basic_profile_bytes()
        p = ProfileData.deserialize(blob)

        self.assertEqual(p.get_disassembly_format(), "raw")
        self.assertEqual(p.get_top_level_counters(), {"cycles": 1000})

        funcs = p.get_functions()
        self.assertIn("main", funcs)
        self.assertEqual(funcs["main"].length, 2)
        self.assertAlmostEqual(funcs["main"].counters["cycles"], 50.0, places=1)

    def test_instructions(self):
        blob = _make_basic_profile_bytes()
        p = ProfileData.deserialize(blob)

        instructions = p.get_code_for_function("main")
        self.assertEqual(len(instructions), 2)

        self.assertEqual(instructions[0].address, 0x1000)
        self.assertAlmostEqual(instructions[0].counters["cycles"], 30.0, places=1)
        self.assertEqual(instructions[0].text, "push rbp")

        self.assertEqual(instructions[1].address, 0x1004)
        self.assertAlmostEqual(instructions[1].counters["cycles"], 20.0, places=1)
        self.assertEqual(instructions[1].text, "mov rsp, rbp")

    def test_multiple_functions(self):
        data = _make_v1_profile_data(
            counters={"cycles": 5000, "branch-misses": 200},
            functions={
                "foo": {
                    "counters": {"cycles": 30.0, "branch-misses": 5.0},
                    "data": [
                        [{"cycles": 30.0, "branch-misses": 5.0}, 0x2000, "ret"],
                    ],
                },
                "bar": {
                    "counters": {"cycles": 20.0, "branch-misses": 3.0},
                    "data": [
                        [{"cycles": 10.0, "branch-misses": 1.0}, 0x3000, "nop"],
                        [{"cycles": 10.0, "branch-misses": 2.0}, 0x3004, "ret"],
                    ],
                },
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)

        counters = p.get_top_level_counters()
        self.assertEqual(counters["cycles"], 5000)
        self.assertEqual(counters["branch-misses"], 200)

        funcs = p.get_functions()
        self.assertEqual(len(funcs), 2)
        self.assertIn("foo", funcs)
        self.assertIn("bar", funcs)
        self.assertEqual(funcs["foo"].length, 1)
        self.assertEqual(funcs["bar"].length, 2)

        foo_insns = p.get_code_for_function("foo")
        self.assertEqual(len(foo_insns), 1)
        self.assertEqual(foo_insns[0].address, 0x2000)
        self.assertEqual(foo_insns[0].text, "ret")

        bar_insns = p.get_code_for_function("bar")
        self.assertEqual(len(bar_insns), 2)
        self.assertEqual(bar_insns[0].address, 0x3000)
        self.assertEqual(bar_insns[1].address, 0x3004)

    def test_many_counters(self):
        ctr_names = {f"counter_{i}": i * 100 for i in range(6)}
        fn_ctrs = {f"counter_{i}": float(i) for i in range(6)}
        insn_ctrs = {f"counter_{i}": float(i) * 0.5 for i in range(6)}
        data = _make_v1_profile_data(
            counters=ctr_names,
            functions={
                "f": {
                    "counters": fn_ctrs,
                    "data": [[insn_ctrs, 0x100, "nop"]],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)

        self.assertEqual(len(p.get_top_level_counters()), 6)
        insns = p.get_code_for_function("f")
        self.assertEqual(len(insns[0].counters), 6)

    def test_single_instruction_function(self):
        data = _make_v1_profile_data(
            functions={
                "tiny": {
                    "counters": {"cycles": 100.0},
                    "data": [[{"cycles": 100.0}, 0x0, "ret"]],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        insns = p.get_code_for_function("tiny")
        self.assertEqual(len(insns), 1)

    def test_zero_counter_values(self):
        data = _make_v1_profile_data(
            counters={"cycles": 0},
            functions={
                "f": {
                    "counters": {"cycles": 0.0},
                    "data": [[{"cycles": 0.0}, 0x100, "nop"]],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        self.assertEqual(p.get_top_level_counters()["cycles"], 0)
        insns = p.get_code_for_function("f")
        self.assertAlmostEqual(insns[0].counters["cycles"], 0.0)

    def test_large_addresses(self):
        data = _make_v1_profile_data(
            functions={
                "f": {
                    "counters": {"cycles": 10.0},
                    "data": [
                        [{"cycles": 5.0}, 0xFFFF0000, "nop"],
                        [{"cycles": 5.0}, 0xFFFF1000, "ret"],
                    ],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        insns = p.get_code_for_function("f")
        self.assertEqual(insns[0].address, 0xFFFF0000)
        self.assertEqual(insns[1].address, 0xFFFF1000)

    def test_lazy_decompression(self):
        """Metadata access does not trigger BZ2 decompression."""
        blob = _make_basic_profile_bytes()
        p = ProfileData.deserialize(blob)

        # These should work without decompressing
        p.get_disassembly_format()
        p.get_top_level_counters()
        p.get_functions()

        # Compressed sections should still be None (not decompressed)
        self.assertIsNone(p._line_counters)

    def test_unknown_function_raises_keyerror(self):
        blob = _make_basic_profile_bytes()
        p = ProfileData.deserialize(blob)
        with self.assertRaises(KeyError):
            p.get_code_for_function("nonexistent")

    def test_empty_function(self):
        """A function with 0 instructions should return an empty list."""
        data = _make_v1_profile_data(
            functions={
                "empty_fn": {
                    "counters": {"cycles": 0.0},
                    "data": [],
                },
                "nonempty": {
                    "counters": {"cycles": 10.0},
                    "data": [[{"cycles": 10.0}, 0x100, "nop"]],
                },
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        insns = p.get_code_for_function("empty_fn")
        self.assertEqual(insns, [])
        # Non-empty function should still work
        self.assertEqual(len(p.get_code_for_function("nonempty")), 1)


# ---------------------------------------------------------------------------
# Error case tests (hand-crafted bytes)
# ---------------------------------------------------------------------------

class TestProfileErrors(unittest.TestCase):
    def test_empty_blob(self):
        with self.assertRaises(ProfileParseError):
            ProfileData.deserialize(b"")

    def test_wrong_version(self):
        # Version 3 encoded as ULEB128
        with self.assertRaises(ProfileParseError) as ctx:
            ProfileData.deserialize(b"\x03")
        self.assertIn("version 3", str(ctx.exception))

    def test_version_zero(self):
        with self.assertRaises(ProfileParseError):
            ProfileData.deserialize(b"\x00")

    def test_truncated_header(self):
        # Valid version byte, but truncated section headers
        with self.assertRaises(ProfileParseError):
            ProfileData.deserialize(b"\x02\x00")

    def test_corrupt_bz2(self):
        """Valid headers but corrupt compressed data should raise on access."""
        blob = _make_basic_profile_bytes()
        p = ProfileData.deserialize(blob)

        # Corrupt the raw BZ2 data
        p._raw_line_counters = b"not valid bz2 data"
        p._line_counters = None  # Reset cache

        with self.assertRaises(ProfileParseError) as ctx:
            p.get_code_for_function("main")
        self.assertIn("decompress", str(ctx.exception))


# ---------------------------------------------------------------------------
# Float encoding edge cases
# ---------------------------------------------------------------------------

class TestFloatEncoding(unittest.TestCase):
    def test_zero_float(self):
        """0.0 is special-cased to ULEB128(0)."""
        data = _make_v1_profile_data(
            functions={
                "f": {
                    "counters": {"cycles": 0.0},
                    "data": [[{"cycles": 0.0}, 0x100, "nop"]],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        insns = p.get_code_for_function("f")
        self.assertEqual(insns[0].counters["cycles"], 0.0)

    def test_small_positive_float(self):
        data = _make_v1_profile_data(
            functions={
                "f": {
                    "counters": {"cycles": 0.001},
                    "data": [[{"cycles": 0.001}, 0x100, "nop"]],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        insns = p.get_code_for_function("f")
        self.assertAlmostEqual(insns[0].counters["cycles"], 0.001, places=3)

    def test_large_positive_float(self):
        data = _make_v1_profile_data(
            functions={
                "f": {
                    "counters": {"cycles": 99.99},
                    "data": [[{"cycles": 99.99}, 0x100, "nop"]],
                }
            },
        )
        blob = _v1_to_v2_bytes(data)
        p = ProfileData.deserialize(blob)
        insns = p.get_code_for_function("f")
        self.assertAlmostEqual(insns[0].counters["cycles"], 99.99, places=1)


if __name__ == "__main__":
    unittest.main()
