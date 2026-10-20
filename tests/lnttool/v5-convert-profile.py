# Test `lnt v5 convert-profile`: on a real perf.data file read with a fake
# objdump, and, with cPerf's reading of it stubbed out, on the functions a v5
# instance would refuse.
#
# RUN: rm -rf %t.dir && mkdir -p %t.dir
# RUN: python %s %S/../testing/Inputs %t.dir > %t.out
# RUN: filecheck %s < %t.out

import base64
import gzip
import json
import os
import sys

from click.testing import CliRunner

import lnt.util.v5_profile
from lnt.lnttool.v5 import action_convert_profile

INPUTS, TMP = sys.argv[1], sys.argv[2]


def write(name, content):
    path = os.path.join(TMP, name)
    with open(path, 'w') as f:
        f.write(content)
    return path


# objdump, as the cPerf tests fake it, recording the arguments it is run with.
OBJDUMP_LOG = os.path.join(TMP, 'objdump.log')
FAKE_OBJDUMP = write('objdump.py', '''
import subprocess, sys
with open(%r, 'a') as log:
    log.write(' '.join(sys.argv[2:]) + '\\n')
sys.exit(subprocess.call([sys.executable, %r] + sys.argv[1:]))
''' % (OBJDUMP_LOG, os.path.join(INPUTS, 'fake-objdump.py')))
OBJDUMP = '%s %s %s' % (sys.executable, FAKE_OBJDUMP,
                        os.path.join(INPUTS, 'fib-aarch64.objdump'))

# c++filt, demangling the names of DEMANGLED and leaving others as they are.
DEMANGLED = {
    '_Z3fooi': 'foo(int)',
    '_Z3bari': 'bar(int)',
    '_ZN1AC1Ev': 'A::A()',
    '_ZN1AC2Ev': 'A::A()',
    '_ZN1BC1Ev': 'B::B()',
    '_ZN1BC2Ev': 'B::B()',
    '_Z4longv': 'long' + 'x' * 3000,
}
FAKE_CXXFILT = write('cxxfilt.py', '''
import json, sys
assert sys.argv[1:] == ['-n'], sys.argv
names = json.loads(%r)
for line in sys.stdin:
    print(names.get(line.rstrip('\\n'), line.rstrip('\\n')))
''' % json.dumps(DEMANGLED))
CXXFILT = '%s %s' % (sys.executable, FAKE_CXXFILT)
FAILING_CXXFILT = '%s -c "import sys; sys.exit(3)"' % sys.executable

PERF_DATA = os.path.join(INPUTS, 'fib-aarch64.perf_data')


OUT = os.path.join(TMP, 'out')


def run(*args, perf_data=PERF_DATA, objdump=OBJDUMP, cxxfilt=CXXFILT):
    return CliRunner().invoke(
        action_convert_profile,
        [perf_data, '--objdump', objdump, '--cxxfilt', cxxfilt] + list(args))


def written():
    """Whether the last `convert` wrote its output file."""
    print('written: %s' % os.path.exists(OUT))


def convert(*args, **kwargs):
    """Run the command; print what it reports, and return what it wrote."""
    if os.path.exists(OUT):
        os.remove(OUT)
    result = run('-o', OUT, *args, **kwargs)
    print(result.output, end='')
    print('exit: %d' % result.exit_code)
    if not os.path.exists(OUT):
        return None
    with open(OUT, 'rb') as f:
        return f.read()


# ---------------------------------------------------------------------------
print('# CONVERT')
document = json.loads(convert())
fib, = document['functions']
print('format: %s, counters: %s' % (document['disassembly_format'],
                                    document['counters']))
print('functions: %s, instructions: %d' % (fib['name'],
                                           len(fib['instructions'])))
for instruction in fib['instructions'][:3]:
    print(json.dumps(instruction, sort_keys=True))
# Raw counts, as cPerf counts them, and no counter at an instruction where it
# counted nothing. The function has a sample of its one counter, so it gets no
# explicit 0.
# CHECK-LABEL: # CONVERT
# CHECK-NEXT: exit: 0
# CHECK-NEXT: format: objdump, counters: {'cycles': 240949386}
# CHECK-NEXT: functions: fib, instructions: 14
# CHECK-NEXT: {"address": 4196040, "counters": {"cycles": 54033197}, "text": "{{.*}}stp{{.*}}"}
# CHECK-NEXT: {"address": 4196044, "counters": {"cycles": 50040290}, "text": "{{.*}}stp{{.*}}"}
# CHECK-NEXT: {"address": 4196048, "counters": {}, "text": "{{.*}}add{{.*}}"}

# The symbols are read without demangling them, which c++filt does instead.
with open(OBJDUMP_LOG) as f:
    print([line for line in f.read().splitlines() if '-t' in line])
# CHECK-NEXT: ['-t -T /root/fib']

# ---------------------------------------------------------------------------
print('# OUTPUT')
encoded = convert('--encode')
print(json.loads(gzip.decompress(base64.b64decode(encoded))) == document)
print(convert('--encode') == encoded)
# Without -o, the result goes to standard output.
print(run('--encode').stdout_bytes == encoded)
# The document, gzip-compressed and base64-encoded, the same every time.
# CHECK-LABEL: # OUTPUT
# CHECK-NEXT: exit: 0
# CHECK-NEXT: True
# CHECK-NEXT: exit: 0
# CHECK-NEXT: True
# CHECK-NEXT: True

# ---------------------------------------------------------------------------
print('# OPTIONS')
# objdump and the binary cache root default to the variables v4 uses.
open(OBJDUMP_LOG, 'w').close()
result = CliRunner(env={'CMAKE_OBJDUMP': OBJDUMP,
                        'LNT_BINARY_CACHE_ROOT': '/cache'}).invoke(
    action_convert_profile,
    [PERF_DATA, '--cxxfilt', CXXFILT, '--disassembly-format', 'gnu-objdump'])
print('exit: %d, format: %s' % (
    result.exit_code, json.loads(result.stdout_bytes)['disassembly_format']))
with open(OBJDUMP_LOG) as f:
    print(sorted({line.split()[-1] for line in f.read().splitlines()}))
# CHECK-LABEL: # OPTIONS
# CHECK-NEXT: exit: 0, format: gnu-objdump
# CHECK-NEXT: ['/cache/root/fib']

# ---------------------------------------------------------------------------
print('# NOT PERF')
convert(perf_data=write('empty', ''))
convert(perf_data=write('text', 'PERFILE1 is not quite it'))
written()
convert('-o', os.path.join(TMP, 'no', 'such', 'dir'))
# Nothing is written when the profile cannot be converted.
# CHECK-LABEL: # NOT PERF
# CHECK-NEXT: error: {{.*}}empty is not a perf.data file
# CHECK-NEXT: exit: 1
# CHECK-NEXT: error: {{.*}}text is not a perf.data file
# CHECK-NEXT: exit: 1
# CHECK-NEXT: written: False
# CHECK-NEXT: error: Could not open file {{.*}}dir{{.*}}
# CHECK-NEXT: exit: 1

# ---------------------------------------------------------------------------
print('# CXXFILT')
convert(cxxfilt='/no/such/c++filt')
convert(cxxfilt=FAILING_CXXFILT)
# CHECK-LABEL: # CXXFILT
# CHECK-NEXT: error: cannot run /no/such/c++filt: {{.*}}
# CHECK-NEXT: exit: 1
# CHECK-NEXT: error: {{.*}} did not demangle the function names: exit status 3
# CHECK-NEXT: exit: 1

# ---------------------------------------------------------------------------
# From here on, cPerf's reading of the profile is stubbed out.


def lines(start, count=1):
    """`count` instructions from `start`, as cPerf gives them."""
    return [[{'cycles': 1}, start + 4 * i, 'nop'] for i in range(count)]


def stub(functions, counters={'cycles': 100}):
    lnt.util.v5_profile._import_perf = lambda *args: {
        'counters': counters,
        'functions': {name: {'counters': {}, 'data': data}
                      for name, data in functions.items()},
    }


def names():
    print(sorted(function['name'] for function in json.loads(convert())
                 ['functions']))


print('# NAMES')
stub({
    '_Z3fooi': lines(0x100),
    # A visibility, and a dynamic symbol's version, are not part of the name:
    # these are one function, listed twice.
    '.hidden _Z3bari': lines(0x200),
    'Base        _Z3bari': lines(0x200),
    # Aliases are kept once, under the first name.
    '_ZN1AC1Ev': lines(0x300),
    '_ZN1AC2Ev': lines(0x300),
    # Different functions of the same demangled name both keep their mangled
    # names.
    '_ZN1BC1Ev': lines(0x400),
    '_ZN1BC2Ev': lines(0x500),
    # A demangled name too long to be kept gives way to the mangled one.
    '_Z4longv': lines(0x600),
    # Of aliases, the one kept is one whose name is short enough.
    '_Z' + 'y' * 3000: lines(0x700),
    'short_alias': lines(0x700),
    'c_function': [],
    # An empty name, which cPerf can give, names nothing.
    '': lines(0x800),
})
names()
# CHECK-LABEL: # NAMES
# CHECK-NEXT: exit: 0
# CHECK-NEXT: ['A::A()', '_Z4longv', '_ZN1BC1Ev', '_ZN1BC2Ev', 'bar(int)', 'c_function', 'foo(int)', 'short_alias']

# ---------------------------------------------------------------------------
print('# LEFT OUT')
stub({
    'kept': lines(0x100),
    '_Z' + 'x' * 3000: lines(0x200),
    'same': lines(0x300),
    'Base        same': lines(0x400),
    'huge': lines(0x500, lnt.util.v5_profile.MAX_INSTRUCTIONS + 1),
    'kernel': lines(2**63),
})
names()
# CHECK-LABEL: # LEFT OUT
# CHECK-NEXT: warning: left out the function huge: it has 100001 instructions, more than 100000
# CHECK-NEXT: warning: left out the function kernel: its addresses are larger than 9223372036854775807
# CHECK-NEXT: warning: left out the function same: its name, even mangled, is the same as another function's
# CHECK-NEXT: warning: left out the function _Zxxx{{x*}}...: its name, even mangled, is longer than 2048 bytes
# CHECK-NEXT: exit: 0
# CHECK-NEXT: ['kept', 'same']

stub({})
names()
# CHECK-NEXT: warning: the profile lists no function: check that {{.*}} can read the profiled binaries {{.*}}
# CHECK-NEXT: exit: 0
# CHECK-NEXT: []

# ---------------------------------------------------------------------------
print('# ZEROS')
# perf samples every event everywhere: a function gets an explicit 0, on its
# first instruction, for each counter of the profile it has no sample of.
stub({
    'none': [[{}, 0x100, 'nop'], [{}, 0x104, 'ret']],
    'some': [[{'cycles': 1}, 0x200, 'nop'], [{'misses': 2}, 0x204, 'ret']],
    'cycles': [[{'cycles': 1}, 0x300, 'nop'], [{}, 0x304, 'ret']],
    'empty': [],
}, counters={'cycles': 100, 'misses': 10, 'stalls': 5})
for function in json.loads(convert())['functions']:
    print(function['name'], json.dumps(
        [instruction['counters'] for instruction in function['instructions']],
        sort_keys=True))
# CHECK-LABEL: # ZEROS
# CHECK-NEXT: exit: 0
# CHECK-NEXT: cycles [{"cycles": 1, "misses": 0, "stalls": 0}, {}]
# CHECK-NEXT: empty []
# CHECK-NEXT: none [{"cycles": 0, "misses": 0, "stalls": 0}, {}]
# CHECK-NEXT: some [{"cycles": 1, "stalls": 0}, {"misses": 2}]

# ---------------------------------------------------------------------------
print('# LIMITS')
stub({'f%d' % i: lines(0x100 * i) for i in range(1, 4)})
lnt.util.v5_profile.MAX_FUNCTIONS = 2
convert()
lnt.util.v5_profile.MAX_FUNCTIONS = 3
lnt.util.v5_profile.MAX_COMPRESSED_SIZE = 10
convert()
lnt.util.v5_profile.MAX_DOCUMENT_SIZE = 10
convert()
written()
# CHECK-LABEL: # LIMITS
# CHECK-NEXT: error: the profile has 3 functions, more than 2
# CHECK-NEXT: exit: 1
# CHECK-NEXT: error: the profile document is {{[0-9]+}} bytes compressed, more than the 10 a v5 instance accepts
# CHECK-NEXT: exit: 1
# CHECK-NEXT: error: the profile document is {{[0-9]+}} bytes, more than the 10 a v5 instance accepts
# CHECK-NEXT: exit: 1
# CHECK-NEXT: written: False
