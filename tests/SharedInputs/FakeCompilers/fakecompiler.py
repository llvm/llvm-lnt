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

    def print_version(self):
        raise NotImplementedError

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
    def print_version(self):
        print >>sys.stderr, """\
icc version 12.1.3 (gcc version 4.2.1 compatibility)"""

    def print_verbose_info(self):
        print >>sys.stderr, """\
icc: command line warning #10006: ignoring unknown option '-###'"""

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

class Clang_r154331(LLVMCompiler):
    compiler_name = "clang-r154331"

    def print_verbose_info(self):
        self.print_version()
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

    def print_version(self):
        print >>sys.stderr, """\
clang version 3.1 (trunk 154331) (llvm/trunk 154329)
Target: x86_64-apple-darwin11.3.0
Thread model: posix"""

class AppleClang_138_1(LLVMCompiler):
    compiler_name = "apple-clang-138.1"

    def print_verbose_info(self):
        self.print_version()
        print >>sys.stderr, """\
 "%s" "-cc1" "-E" ... more boring stuff here ...""" % (
            g_program,)

    def print_version(self):
        print >>sys.stderr, """\
Apple clang version 2.0 (tags/Apple/clang-138.1) (based on LLVM 2.9svn)
Target: x86_64-apple-darwin11.3.0
Thread model: posix"""

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
    elif args == ('-v',):
        compiler_instance.print_version()
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
