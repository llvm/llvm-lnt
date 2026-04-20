// Realistic profile test fixtures.
//
// These provide production-scale mock data for profile tests: C++ mangled
// function names, realistic x86-64 disassembly, skewed counter distributions,
// and multi-counter profiles. Use alongside (not replacing) the minimal
// fixtures that test edge cases.

import type {
  ProfileListItem, ProfileMetadata, ProfileFunctionInfo,
  ProfileFunctionDetail, ProfileInstruction,
} from '../../types';

// ---------------------------------------------------------------------------
// Function list (~15 functions with realistic counter skew)
// ---------------------------------------------------------------------------

export const realisticFunctions: ProfileFunctionInfo[] = [
  { name: '_ZN5llvm12SelectionDAG15computeKnownBitsENS_7SDValueERKNS_3APEE', counters: { cycles: 34.2, 'branch-misses': 28.1, 'cache-misses': 41.3, instructions: 31.7 }, length: 187 },
  { name: '_ZN5llvm16InstCombinerImpl7visitOrERNS_14BinaryOperatorE', counters: { cycles: 14.8, 'branch-misses': 12.3, 'cache-misses': 8.9, instructions: 15.1 }, length: 124 },
  { name: '_ZN5llvm15ScalarEvolution14getSCEVAtScopeENS_4SCEVEPKNS_4LoopE', counters: { cycles: 11.2, 'branch-misses': 15.7, 'cache-misses': 6.2, instructions: 10.8 }, length: 93 },
  { name: '_ZN5llvm12MemorySSA18buildMemorySSAForERNS_10BasicBlockE', counters: { cycles: 8.4, 'branch-misses': 7.2, 'cache-misses': 12.1, instructions: 7.9 }, length: 68 },
  { name: '_ZNSt6vectorIiSaIiEE9push_backEOi', counters: { cycles: 6.1, 'branch-misses': 3.8, 'cache-misses': 9.4, instructions: 5.3 }, length: 42 },
  { name: '_ZN5llvm14DominatorTreeBase10recalculateERNS_8FunctionE', counters: { cycles: 5.3, 'branch-misses': 6.9, 'cache-misses': 3.7, instructions: 5.8 }, length: 56 },
  { name: '_ZN5llvm12LiveInterval10MergeValueERNS_8VNInfoE', counters: { cycles: 4.7, 'branch-misses': 4.1, 'cache-misses': 2.8, instructions: 4.2 }, length: 38 },
  { name: '_ZN5llvm6MCExpr11evaluateAsERNS_7MCValueERKNS_11MCAsmLayoutEPKNS_11MCFixupE', counters: { cycles: 3.9, 'branch-misses': 5.2, 'cache-misses': 1.9, instructions: 4.1 }, length: 31 },
  { name: '_ZN5llvm17RegisterCoalescer14joinCopyInstsERKNS_12CoalescerPairERNS_14LiveIntervalsE', counters: { cycles: 3.1, 'branch-misses': 4.3, 'cache-misses': 2.1, instructions: 3.4 }, length: 47 },
  { name: 'main', counters: { cycles: 2.4, 'branch-misses': 1.8, 'cache-misses': 1.2, instructions: 2.6 }, length: 23 },
  { name: '_ZN5llvm6object11ELFFileBase14createSectionsEv', counters: { cycles: 1.8, 'branch-misses': 2.4, 'cache-misses': 3.1, instructions: 1.9 }, length: 35 },
  { name: '__libc_start_main', counters: { cycles: 1.2, 'branch-misses': 0.8, 'cache-misses': 0.4, instructions: 1.1 }, length: 18 },
  { name: '_ZN5llvm12DenseMapBaseINS_8DenseMapIPKNS_5ValueENS_14SmallPtrSetImplIS4_EELj4ENS_12DenseMapInfoIS4_EENS_6detail12DenseMapPairIS4_S6_EEEES4_S6_S8_SB_E4findERKS4_', counters: { cycles: 0.9, 'branch-misses': 1.1, 'cache-misses': 1.8, instructions: 0.8 }, length: 12 },
  { name: '_start', counters: { cycles: 0.4, 'branch-misses': 0.2, 'cache-misses': 0.1, instructions: 0.3 }, length: 5 },
  { name: '_ZN5llvm9StringRef5splitEc', counters: { cycles: 0.3, 'branch-misses': 0.1, 'cache-misses': 0.0, instructions: 0.2 }, length: 8 },
];

// ---------------------------------------------------------------------------
// Function detail for the hottest function (~50 instructions, x86-64)
// ---------------------------------------------------------------------------

function makeInstruction(addr: number, cycles: number, branchMisses: number, cacheMisses: number, instr: number, text: string): ProfileInstruction {
  return { address: addr, counters: { cycles, 'branch-misses': branchMisses, 'cache-misses': cacheMisses, instructions: instr }, text };
}

export const realisticFunctionDetail: ProfileFunctionDetail = {
  name: '_ZN5llvm12SelectionDAG15computeKnownBitsENS_7SDValueERKNS_3APEE',
  counters: { cycles: 34.2, 'branch-misses': 28.1, 'cache-misses': 41.3, instructions: 31.7 },
  disassembly_format: 'llvm-objdump',
  instructions: [
    makeInstruction(0x401000, 0.1, 0.0, 0.0, 0.1, 'push   rbp'),
    makeInstruction(0x401001, 0.1, 0.0, 0.0, 0.1, 'mov    rbp, rsp'),
    makeInstruction(0x401004, 0.1, 0.0, 0.0, 0.1, 'sub    rsp, 0x30'),
    makeInstruction(0x401008, 0.2, 0.0, 0.3, 0.2, 'mov    qword ptr [rbp - 0x8], rdi'),
    makeInstruction(0x40100c, 0.1, 0.0, 0.0, 0.1, 'mov    dword ptr [rbp - 0xc], esi'),
    makeInstruction(0x40100f, 0.1, 0.0, 0.0, 0.1, 'mov    qword ptr [rbp - 0x18], rdx'),
    makeInstruction(0x401013, 0.3, 0.1, 0.5, 0.3, 'mov    rax, qword ptr [rbp - 0x8]'),
    makeInstruction(0x401017, 0.2, 0.0, 0.4, 0.2, 'mov    ecx, dword ptr [rax + 0x4]'),
    makeInstruction(0x40101a, 0.8, 1.2, 0.1, 0.5, 'cmp    ecx, 0x20'),
    makeInstruction(0x40101d, 0.6, 2.1, 0.0, 0.4, 'jge    0x4010a0'),
    makeInstruction(0x401023, 0.2, 0.0, 0.3, 0.2, 'mov    rdx, qword ptr [rbp - 0x18]'),
    makeInstruction(0x401027, 0.1, 0.0, 0.0, 0.1, 'mov    esi, dword ptr [rdx]'),
    makeInstruction(0x401029, 0.3, 0.1, 0.6, 0.3, 'mov    rdi, qword ptr [rax + 0x10]'),
    makeInstruction(0x40102d, 18.2, 8.3, 22.1, 16.4, 'call   _ZN5llvm3APInt12intersectWithERKS0_'),
    makeInstruction(0x401032, 0.4, 0.0, 1.2, 0.4, 'mov    qword ptr [rbp - 0x20], rax'),
    makeInstruction(0x401036, 0.2, 0.0, 0.3, 0.2, 'mov    ecx, dword ptr [rbp - 0xc]'),
    makeInstruction(0x401039, 0.5, 0.8, 0.0, 0.3, 'test   ecx, ecx'),
    makeInstruction(0x40103b, 0.3, 1.4, 0.0, 0.2, 'je     0x401070'),
    makeInstruction(0x401041, 0.1, 0.0, 0.0, 0.1, 'mov    rdi, qword ptr [rbp - 0x20]'),
    makeInstruction(0x401045, 0.2, 0.0, 0.4, 0.2, 'mov    rsi, qword ptr [rbp - 0x18]'),
    makeInstruction(0x401049, 5.1, 3.2, 4.8, 4.7, 'call   _ZN5llvm3APInt8setBitEj'),
    makeInstruction(0x40104e, 0.3, 0.0, 0.8, 0.3, 'mov    rax, qword ptr [rbp - 0x20]'),
    makeInstruction(0x401052, 0.1, 0.0, 0.0, 0.1, 'mov    ecx, dword ptr [rax + 0x8]'),
    makeInstruction(0x401055, 0.4, 0.6, 0.0, 0.3, 'cmp    ecx, dword ptr [rbp - 0xc]'),
    makeInstruction(0x401058, 0.2, 0.9, 0.0, 0.2, 'jne    0x401080'),
    makeInstruction(0x40105e, 0.1, 0.0, 0.0, 0.1, 'mov    rdi, qword ptr [rbp - 0x8]'),
    makeInstruction(0x401062, 0.1, 0.0, 0.2, 0.1, 'mov    esi, dword ptr [rbp - 0xc]'),
    makeInstruction(0x401065, 0.2, 0.0, 0.3, 0.2, 'mov    rdx, qword ptr [rbp - 0x20]'),
    makeInstruction(0x401069, 0.1, 0.0, 0.0, 0.1, 'add    rsp, 0x30'),
    makeInstruction(0x40106d, 0.1, 0.0, 0.0, 0.1, 'pop    rbp'),
    makeInstruction(0x40106e, 0.1, 0.1, 0.0, 0.1, 'ret'),
    // Second basic block (branch target from je 0x401070)
    makeInstruction(0x401070, 0.2, 0.0, 0.3, 0.2, 'mov    rdi, qword ptr [rbp - 0x8]'),
    makeInstruction(0x401074, 0.1, 0.0, 0.2, 0.1, 'mov    rsi, qword ptr [rbp - 0x20]'),
    makeInstruction(0x401078, 1.8, 1.1, 2.4, 1.6, 'call   _ZN5llvm3APInt10clearAllBitsEv'),
    makeInstruction(0x40107d, 0.1, 0.1, 0.0, 0.1, 'jmp    0x401069'),
    // Third basic block (branch target from jne 0x401080)
    makeInstruction(0x401080, 0.2, 0.0, 0.4, 0.2, 'mov    rdi, qword ptr [rbp - 0x8]'),
    makeInstruction(0x401084, 0.1, 0.0, 0.0, 0.1, 'mov    esi, 0x1'),
    makeInstruction(0x401089, 0.1, 0.0, 0.2, 0.1, 'mov    rdx, qword ptr [rbp - 0x20]'),
    makeInstruction(0x40108d, 0.8, 0.4, 1.2, 0.7, 'call   _ZN5llvm13KnownBits12makeConstantERKNS_3APIntE'),
    makeInstruction(0x401092, 0.1, 0.0, 0.0, 0.1, 'mov    qword ptr [rbp - 0x28], rax'),
    makeInstruction(0x401096, 0.2, 0.0, 0.3, 0.2, 'mov    rdi, qword ptr [rbp - 0x28]'),
    makeInstruction(0x40109a, 0.1, 0.1, 0.0, 0.1, 'jmp    0x401069'),
    // Fourth basic block (branch target from jge 0x4010a0)
    makeInstruction(0x4010a0, 0.3, 0.0, 0.5, 0.3, 'mov    rdi, qword ptr [rbp - 0x8]'),
    makeInstruction(0x4010a4, 0.1, 0.0, 0.0, 0.1, 'mov    esi, dword ptr [rbp - 0xc]'),
    makeInstruction(0x4010a7, 0.2, 0.0, 0.3, 0.2, 'mov    rdx, qword ptr [rbp - 0x18]'),
    makeInstruction(0x4010ab, 0.4, 0.2, 0.8, 0.4, 'call   _ZN5llvm12SelectionDAG21computeKnownBitsImplENS_7SDValueERKNS_3APEEj'),
    makeInstruction(0x4010b0, 0.2, 0.0, 0.4, 0.2, 'mov    qword ptr [rbp - 0x20], rax'),
    makeInstruction(0x4010b4, 0.1, 0.1, 0.0, 0.1, 'jmp    0x401069'),
  ],
};

// ---------------------------------------------------------------------------
// Profile metadata (top-level counters)
// ---------------------------------------------------------------------------

export const realisticMetadataA: ProfileMetadata = {
  uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
  test: 'SingleSource/Benchmarks/Dhrystone/dry',
  run_uuid: 'run-aaa-111',
  counters: {
    cycles: 4523891,
    'branch-misses': 18742,
    'cache-misses': 3201,
    instructions: 12847623,
  },
  disassembly_format: 'llvm-objdump',
};

export const realisticMetadataB: ProfileMetadata = {
  uuid: 'f1e2d3c4-b5a6-0987-fedc-ba9876543210',
  test: 'SingleSource/Benchmarks/Dhrystone/dry',
  run_uuid: 'run-bbb-222',
  counters: {
    cycles: 4891204,       // +8.1% regression
    'branch-misses': 15903, // -15.1% improvement
    'cache-misses': 3198,   // -0.1% unchanged (noise)
    instructions: 12847623, // identical (same code, different branch behavior)
  },
  disassembly_format: 'llvm-objdump',
};

// ---------------------------------------------------------------------------
// Profile listing items
// ---------------------------------------------------------------------------

export const realisticProfileList: ProfileListItem[] = [
  { test: 'SingleSource/Benchmarks/Dhrystone/dry', uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' },
  { test: 'SingleSource/Benchmarks/Stanford/Towers', uuid: 'b2c3d4e5-f6a7-8901-bcde-f01234567890' },
  { test: 'MultiSource/Benchmarks/Olden/bh/bh', uuid: 'c3d4e5f6-a7b8-9012-cdef-012345678901' },
];
