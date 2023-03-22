#!/bin/bash

# While it is quite common for ET_DYN ELF files to have virtual addresses equal
# to file offsets, these are different entities. For example, the code segment
# is sometimes shifted by one page or so.
#
# This script prepares an executable file with code contained in a section
# that has VirtAddr == FileOffset + 0x1000.
#
# In addition, this script also creates two regular executables:
# a position-independent executable and a static one to check the handling of
# the more traditional layout of ELF segments for ET_DYN and ET_EXEC binaries.
#
# A few simple checks are performed to make sure the heuristics used to create
# the required segment layouts still work.

cd "$(dirname $0)"

save_objdump_output() {
  local path_to_elf="$1"
  local addr_correct="$2"

  local basename="$(basename "$path_to_elf")"

  llvm-objdump "$path_to_elf" -t > "../${basename}.objdump.out"
  llvm-objdump "$path_to_elf" -p > "../${basename}.objdump.p.out"
  llvm-objdump "$path_to_elf" -j .text --disassemble-symbols=correct > "../${basename}.objdump.${addr_correct}.out"
}

record_perf_data() {
  local path_to_elf="$1"
  local basename="$(basename "$path_to_elf")"
  local path_to_perf_data="../${basename}.perf_data"
  local num_of_iterations=100000000

  rm -f "$path_to_perf_data"
  perf record -e cpu-clock -o "$path_to_perf_data" "$path_to_elf" $num_of_iterations

  # It is probably not a good idea to put very large *.perf_data files to git
  size_in_bytes=$(stat --format='%s' "$path_to_perf_data")
  if [ $size_in_bytes -gt 50000 ]; then
    echo "perf produced too large output file ${path_to_perf_data}, try decreasing"
    echo "the number of iterations or passing -F option to 'perf record'."
    exit 1
  fi
}

save_test_case() {
  local path_to_elf="$1"
  local addr_correct="$2"

  record_perf_data "$path_to_elf"
  save_objdump_output "$path_to_elf" $addr_correct
}

check_file() {
  local file="$1"
  local line="$2"

  # Use pcregrep to simplify handling of newlines (it is possible to embed \n
  # into the regex and not have them being matched by a dot)
  if ! pcregrep -M "$line" "$file"; then
    echo "Unexpected test case generated: file '$file' should contain '$line'"
    exit 1
  fi
}

clang -Os -o /tmp/segments-shifted segments.c -pie -Wl,-T,segments.lds
clang -Os -o /tmp/segments-dyn     segments.c -pie
clang -Os -o /tmp/segments-exec    segments.c -static

save_test_case /tmp/segments-shifted 0x2000
check_file ../segments-shifted.objdump.out "00002000 .* correct"
# The expected objdump -p output is something like this (note off != vaddr):
#     LOAD off    0x0000000000000618 vaddr 0x0000000000001618 paddr 0x0000000000001618 align 2**12
#          filesz 0x0000000000002a3d memsz 0x0000000000002a3d flags r-x
check_file ../segments-shifted.objdump.p.out "LOAD off    0x(0+)0000(...) vaddr 0x\g{1}0001\g{2} paddr.*\n.*flags r-x"

# Feel free to update the value of "correct" symbol in the static case if it is changed
save_test_case /tmp/segments-exec 0x403000
check_file ../segments-exec.objdump.out "00403000 .* correct"
check_file ../segments-exec.objdump.p.out "LOAD off    0x(0+)0001000 vaddr 0x(0+)0401000 paddr.*\n.*flags r-x"

save_test_case /tmp/segments-dyn 0x3000
check_file ../segments-dyn.objdump.out "00003000 .* correct"
check_file ../segments-dyn.objdump.p.out "LOAD off    0x(0+)0001000 vaddr 0x(0+)0001000 paddr.*\n.*flags r-x"
