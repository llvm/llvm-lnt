#!/usr/bin/env python

"""
Utilities for "faking" a compiler response.
"""

import inspect
import os
import sys

from optparse import OptionParser, OptionGroup

g_program = None

class FakeCompiler(object):
    compiler_name = None

    def print_verbose_info(self):
        raise NotImplementedError

    def print_dumpmachine(self):
        raise NotImplementedError

    def print_llvm_target(self):
        raise NotImplementedError

    def print_as_version(self):
        print >>sys.stderr, """(assembler version goes here)"""

    def print_ld_version(self):
        print >>sys.stderr, """(linker version goes here)"""
    
class ICCv12_1_3(FakeCompiler):
    compiler_name = "icc-12.1.3"
    def print_verbose_info(self):
        print >>sys.stderr, """\
icc: command line warning #10006: ignoring unknown option '-###'
icc version 12.1.3 (gcc version 4.2.1 compatibility)
/usr/bin/icc-2011-base/bin/intel64/mcpcom    -_g -mP3OPT_inline_alloca -D__HONOR_STD -D__ICC=1210 -D__INTEL_COMPILER=1210 "-_Acpu(x86_64)" "-_Amachine(x86_64)" -D__BLOCKS__ -D__PTRDIFF_TYPE__=long "-D__SIZE_TYPE__=unsigned long" -D__WCHAR_TYPE__=int -D__WINT_TYPE__=int "-D__INTMAX_TYPE__=long int" "-D__UINTMAX_TYPE__=long unsigned int" -D__LONG_MAX__=9223372036854775807L -D__QMSPP_ -D__OPTIMIZE__ -D__NO_MATH_INLINES -D__NO_STRING_INLINES -D__NO_INLINE__ -D__GNUC_GNU_INLINE__ -D__GNUC__=4 -D__GNUC_MINOR__=2 -D__GNUC_PATCHLEVEL__=1 -D__APPLE_CC__=5658 -D__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__=1073 -D__LITTLE_ENDIAN__ -D__DYNAMIC__ "-D__private_extern__=__attribute__((visibility("hidden")))" -D__LP64__ -D_LP64 -D__GXX_ABI_VERSION=1002 -D__USER_LABEL_PREFIX__=_ -D__REGISTER_PREFIX__= -D__INTEL_RTTI__ -D__x86_64 -D__x86_64__ -D_MT -D__INTEL_COMPILER_BUILD_DATE=20120130 -D__PIC__ -D__APPLE__ -D__MACH__ -D__pentium4 -D__pentium4__ -D__tune_pentium4__ -D__SSE2__ -D__SSE3__ -D__SSSE3__ -D__SSE__ -D__MMX__ -_k -_8 -_l -_D -_a -_b -E --gnu_version=421 -_W5 --gcc-extern-inline --multibyte_chars --blocks --array_section --simd --simd_func -mP1OPT_print_version=FALSE -mP1OPT_version=12.1-intel64 -mGLOB_diag_use_message_catalog=FALSE /dev/null
... more boring stuff here ...
"""

    def print_llvm_target(self):
        print """\
icc: command line warning #10006: ignoring unknown option '-flto'
	.file "null"
	.section	__DATA, __data
# End
	.subsections_via_symbols
"""

    def print_dumpmachine(self):
        print """i686-apple-darwin11"""

class LLVMCompiler(FakeCompiler):
    def print_llvm_target(self):
        print """\
; ModuleID = '/dev/null'
target datalayout = "e-p:64:64:64-i1:8:8-i8:8:8-i16:16:16-i32:32:32-i64:64:64-\
f32:32:32-f64:64:64-v64:64:64-v128:128:128-a0:0:64-s0:64:64-f80:128:128-\
n8:16:32:64"
target triple = "x86_64-apple-darwin11.0.0"
"""

    def print_dumpmachine(self):
        print """x86_64-apple-darwin11.0.0"""

# Clang build at r154331 (for example).
class Clang_r154331(LLVMCompiler):
    compiler_name = "clang-r154331"

    def print_verbose_info(self):
        print >>sys.stderr, """\
clang version 3.1 (trunk 154331) (llvm/trunk 154329)
Target: x86_64-apple-darwin11.3.0
Thread model: posix"""
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

# Clang build from a git repository.
class Clang_git(LLVMCompiler):
    compiler_name = "clang-git"

    def print_verbose_info(self):
        print >>sys.stderr, """\
clang version 3.1\
 (git:/git/clang.git 37ce0feee598d82e7220fa0a4b110619cae6ea72)\
 (git:/git/llvm.git 60fca4f64e697ad834ce7ee8c2e478cae394c7dc)
Target: arm-apple-darwin11.4.0
Thread model: posix"""
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

# Clang build from a git repository.
class Clang_git_2(LLVMCompiler):
    compiler_name = "clang-git-2"

    def print_verbose_info(self):
        print >>sys.stderr, """\
clang version 3.2\
 (/d/g/pz/clang.git git:/git/pz/clang.git 8ab09316f63ea99ff23b2684c454b1008b8d5f10)\
 (http://llvm.org/git/llvm.git /d/g/pz/llvm.git git:/git/pb/llvm.git 7c53f795961cc2d35b85d315aadb2ac135a0fdb2)
Target: x86_64-apple-darwin12.2.0
Thread model: posix"""
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

class AppleClang_138_1(LLVMCompiler):
    compiler_name = "apple-clang-138.1"

    def print_verbose_info(self):
        print >>sys.stderr, """\
Apple clang version 2.0 (tags/Apple/clang-138.1) (based on LLVM 2.9svn)
Target: x86_64-apple-darwin11.3.0
Thread model: posix"""
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

fake_compilers = dict((value.compiler_name, value)
                      for key,value in locals().items()
                      if inspect.isclass(value) and \
                          issubclass(value, FakeCompiler))

class ClangNoInfo(LLVMCompiler):
    compiler_name = "clang-no-info"

    def print_verbose_info(self):
        print >>sys.stderr, """\
clang version 3.2
Target: x86_64-bla-bla
Thread model: posix"""
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

class GenericLLVMCompiler(LLVMCompiler):
    compiler_name = "llvm-compiler"

    def print_verbose_info(self):
        print >>sys.stderr, """\
LLVM version 3.3 (git:/git/pz/clang.git 597522d740374f093a089a2acbec5b20466b2f34) (/d/g/pz/llvm git:/git/pz/llvm.git 6e95d969734af111bb33bcec0bcc27fd803a3b76)
Target: x86_64-apple-darwin12.3.0
Thread model: posix"""
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

fake_compilers = dict((value.compiler_name, value)
                      for key,value in locals().items()
                      if inspect.isclass(value) and \
                          issubclass(value, FakeCompiler))

def main():
    global g_program
    g_program = sys.argv[0]

    compiler_name = os.path.basename(sys.argv[0])
    compiler_class = fake_compilers.get(compiler_name)
    if compiler_class is None:
        raise SystemExit("unknown fake compiler %r" % (compiler_name,))

    # Instantiate the compiler class.
    compiler_instance = compiler_class()

    # Pattern match on the arguments to determine what kind of response to fake.
    args = tuple(sys.argv[1:])
    if args == ('-v', '-E', '-x', 'c', '/dev/null', '-###'):
        compiler_instance.print_verbose_info()
    elif args == ('-dumpmachine',):
        compiler_instance.print_dumpmachine()
    elif args == ('-c', '-Wa,-v', '-o', '/dev/null', '-x', 'assembler',
                  '/dev/null'):
        compiler_instance.print_as_version()
    elif args == ('-S', '-flto', '-o', '-', '-x', 'c', '/dev/null'):
        compiler_instance.print_llvm_target()
    elif len(args) == 4 and \
            args[0] == '-Wl,-v' and \
            args[1] == '-o' and \
            args[2] == '/dev/null':
        compiler_instance.print_ld_version()
    else:
        raise SystemExit("unrecognized argument vector: %r" % (
                args,))

if __name__ == '__main__':
    main()
