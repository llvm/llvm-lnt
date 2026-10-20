"""Convert a Linux perf profile into an LNT v5 profile document.

This implements ``lnt v5 convert-profile``, whose only input format so far is
perf.data. docs/v5_convert_profile.rst specifies it.

perf.data is read by cPerf, the same extension v4 uses (see
lnt/testing/profile/cPerf.cpp), which returns absolute counts: exactly what a
v5 profile document holds. What is left to do here is to name the functions,
to give each function an explicit 0 for the counters it has no sample of, and
to keep the document within what a v5 instance accepts.
"""

import base64
import gzip
import json
import shlex
import subprocess
from collections import Counter
from collections.abc import Callable
from typing import Any

from lnt.testing.profile.perf import LinuxPerfProfile

# Where the command reports what it leaves out of the profile.
Warn = Callable[[str], None]

# The limits a v5 instance puts on a profile document, copied from v5's design
# (O7). The copy is best effort: the instance is the authority, and may change
# them without this copy following. A profile it refuses fails the whole run
# carrying it, so the point is to catch one when converting it.
MAX_FUNCTIONS = 10000
MAX_INSTRUCTIONS = 100000
MAX_FUNCTION_NAME_BYTES = 2048
MAX_ADDRESS = 2**63 - 1
MAX_COMPRESSED_SIZE = 4 * 1024 * 1024
MAX_DOCUMENT_SIZE = 32 * 1024 * 1024


class ConvertError(Exception):
    """A problem that keeps the profile from being converted."""


def _import_perf(path: str, objdump: str,
                 binary_cache_root: str) -> dict[str, Any]:
    """cPerf's reading of `path`, with mangled function names."""
    try:
        from lnt.testing.profile import cPerf  # type: ignore
    except ImportError as e:
        raise ConvertError('the cPerf extension, which reads perf.data, is '
                           'not available: %s' % e)
    try:
        data: dict[str, Any] = cPerf.importPerf(path, objdump,
                                                binary_cache_root, False)
    except (AssertionError, RuntimeError) as e:
        raise ConvertError('cannot read %s: %s' % (path, e))
    return data


def _demangled(names: list[str], cxxfilt: str) -> list[str]:
    """`names`, each demangled by `cxxfilt`, in one process."""
    if not names:
        return []
    # -n: llvm-cxxfilt on Darwin would otherwise strip a leading underscore,
    # leaving `Z3fooi` rather than demangling `_Z3fooi`.
    command = shlex.split(cxxfilt) + ['-n']
    try:
        result = subprocess.run(command, input='\n'.join(names) + '\n',
                                capture_output=True, encoding='utf-8',
                                errors='replace')
    except OSError as e:
        raise ConvertError('cannot run %s: %s' % (cxxfilt, e))
    lines = result.stdout.split('\n')[:-1]
    if result.returncode != 0 or len(lines) != len(names):
        raise ConvertError('%s did not demangle the function names: %s' %
                           (cxxfilt, result.stderr.strip() or
                            'exit status %d' % result.returncode))
    return lines


def _fits(name: str) -> bool:
    return len(name.encode('utf-8')) <= MAX_FUNCTION_NAME_BYTES


def _shortened(name: str) -> str:
    """`name`, cut short enough for a warning."""
    return name if len(name) <= 80 else name[:80] + '...'


def convert_perf(path: str, objdump: str, binary_cache_root: str,
                 cxxfilt: str, disassembly_format: str,
                 warn: Warn) -> dict[str, Any]:
    """The v5 profile document of the perf.data file at `path`.

    Functions that a v5 instance would refuse are left out, each with a
    warning; anything else it would refuse is a ConvertError.
    """
    # cPerf trusts its input, and asserts or crashes on what is not perf.data.
    if not LinuxPerfProfile.checkFile(path):
        raise ConvertError('%s is not a perf.data file' % path)
    data = _import_perf(path, objdump, binary_cache_root)

    # Without demangling, objdump prints a name as one word, after whatever
    # it prints before it: a visibility such as `.hidden`, or a dynamic
    # symbol's version, such as `Base`.
    #
    # A function listed under several names, such as an alias, or a symbol
    # both static and dynamic, comes out of cPerf once per name, with the same
    # instructions. Only one name is kept, so that its counts are not listed
    # twice: the first, in code-point order, of those short enough to be kept.
    kept: list[tuple[str, list[Any]]] = []
    by_start: dict[int, list[list[Any]]] = {}
    names = {raw: raw.split()[-1] for raw in data['functions'] if raw.strip()}
    for raw in sorted(names, key=lambda raw: (not _fits(names[raw]),
                                              names[raw])):
        mangled = names[raw]
        lines = data['functions'][raw]['data']
        if lines:
            aliases = by_start.setdefault(lines[0][1], [])
            if lines in aliases:
                continue
            aliases.append(lines)
        kept.append((mangled, lines))

    taken: set[str] = set()
    functions = []
    demangled = _demangled([mangled for mangled, _ in kept], cxxfilt)
    # A demangled name is not unique: a C1 and a C2 constructor are both
    # `A::A()`, for example. Every function whose demangled name another
    # function shares is named by its mangled name, rather than giving the
    # demangled one to whichever comes first, which would depend on what else
    # the profile lists.
    shared = Counter(demangled)
    for (mangled, lines), readable in zip(kept, demangled):
        candidates = (readable, mangled) if shared[readable] == 1 else (mangled,)
        name = next((name for name in candidates
                     if _fits(name) and name not in taken), None)
        if name is None:
            if _fits(mangled):
                problem = 'is the same as another function\'s'
            else:
                problem = 'is longer than %d bytes' % MAX_FUNCTION_NAME_BYTES
            warn('left out the function %s: its name, even mangled, %s' %
                 (_shortened(mangled), problem))
            continue
        if len(lines) > MAX_INSTRUCTIONS:
            warn('left out the function %s: it has %d instructions, more '
                 'than %d' % (_shortened(name), len(lines), MAX_INSTRUCTIONS))
            continue
        if any(address > MAX_ADDRESS for _, address, _ in lines):
            warn('left out the function %s: its addresses are larger than '
                 '%d' % (_shortened(name), MAX_ADDRESS))
            continue
        taken.add(name)
        instructions = [
            {'address': address, 'counters': counters, 'text': text}
            for counters, address, text in lines
        ]
        # perf samples every event over the whole recording, so a function
        # where no sample of an event landed has an estimated count of 0: say
        # so, since v5 shows a function without a counter as not having it.
        # Instructions still leave such counters out, which v5 shows the same
        # as a 0.
        if instructions:
            present: set[str] = set().union(*(c for c, _, _ in lines))
            zeros = {counter: 0 for counter in data['counters']
                     if counter not in present}
            first = instructions[0]
            first['counters'] = {**first['counters'], **zeros}
        functions.append({'name': name, 'instructions': instructions})

    if len(functions) > MAX_FUNCTIONS:
        raise ConvertError('the profile has %d functions, more than %d' %
                           (len(functions), MAX_FUNCTIONS))
    if not functions:
        warn('the profile lists no function: check that %s can read the '
             'profiled binaries (see --binary-cache-root)' % objdump)
    return {
        'disassembly_format': disassembly_format,
        'counters': data['counters'],
        'functions': functions,
    }


def serialize(document: dict[str, Any], encode: bool) -> bytes:
    """`document` as JSON, or, with `encode`, as a test entry's `profile`:
    gzip-compressed, then base64-encoded.

    It is a ConvertError for it to be larger than a v5 instance accepts.
    """
    text = json.dumps(document, ensure_ascii=False,
                      separators=(',', ':')).encode('utf-8')
    if len(text) > MAX_DOCUMENT_SIZE:
        raise ConvertError('the profile document is %d bytes, more than the '
                           '%d a v5 instance accepts' %
                           (len(text), MAX_DOCUMENT_SIZE))
    # mtime=0, so that converting the same profile twice gives the same bytes.
    compressed = gzip.compress(text, mtime=0)
    if len(compressed) > MAX_COMPRESSED_SIZE:
        raise ConvertError('the profile document is %d bytes compressed, more '
                           'than the %d a v5 instance accepts' %
                           (len(compressed), MAX_COMPRESSED_SIZE))
    return base64.b64encode(compressed) if encode else text
