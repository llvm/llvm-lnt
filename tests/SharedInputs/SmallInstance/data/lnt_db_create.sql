BEGIN TRANSACTION;
CREATE TABLE "SchemaVersion" (
	"Name" VARCHAR(256) NOT NULL, 
	"Version" INTEGER, 
	PRIMARY KEY ("Name"), 
	UNIQUE ("Name")
);
INSERT INTO "SchemaVersion" VALUES('__core__',6);
CREATE TABLE "TestSuite" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"Name" VARCHAR(256), 
	"DBKeyName" VARCHAR(256), 
	"Version" VARCHAR(16), 
	UNIQUE ("Name")
);
INSERT INTO "TestSuite" ("Name", "DBKeyName") VALUES('nts','NT');         --ID 1
INSERT INTO "TestSuite" ("Name", "DBKeyName") VALUES('compile','compile');--ID 2
CREATE TABLE "StatusKind" (
	"ID" INTEGER NOT NULL, 
	"Name" VARCHAR(256), 
        PRIMARY KEY ("ID"),
	UNIQUE ("Name")
);
INSERT INTO "StatusKind" VALUES(0,'PASS');
INSERT INTO "StatusKind" VALUES(1,'FAIL');
INSERT INTO "StatusKind" VALUES(2,'XFAIL');
CREATE TABLE "SampleType" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"Name" VARCHAR(256), 
	UNIQUE ("Name")
);
INSERT INTO "SampleType" ("Name") VALUES('Real');   -- ID 1
INSERT INTO "SampleType" ("Name") VALUES('Status'); -- ID 2
CREATE TABLE "TestSuiteRunFields" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"TestSuiteID" INTEGER, 
	"Name" VARCHAR(256), 
	"InfoKey" VARCHAR(256), 
	FOREIGN KEY("TestSuiteID") REFERENCES "TestSuite" ("ID")
);
CREATE TABLE "TestSuiteOrderFields" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"TestSuiteID" INTEGER, 
	"Name" VARCHAR(256), 
	"InfoKey" VARCHAR(256), 
	"Ordinal" INTEGER, 
	FOREIGN KEY("TestSuiteID") REFERENCES "TestSuite" ("ID")
);
INSERT INTO "TestSuiteOrderFields" ("TestSuiteID", "Name", "InfoKey", "Ordinal")
 VALUES(1,'llvm_project_revision','run_order',0); -- ID 1
INSERT INTO "TestSuiteOrderFields" ("TestSuiteID", "Name", "InfoKey", "Ordinal")
 VALUES(2,'llvm_project_revision','run_order',0); -- ID 2
CREATE TABLE "TestSuiteSampleFields" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"TestSuiteID" INTEGER, 
	"Name" VARCHAR(256), 
	"Type" INTEGER, 
	"InfoKey" VARCHAR(256), 
	status_field INTEGER, bigger_is_better INTEGER DEFAULT 0, 
	FOREIGN KEY("TestSuiteID") REFERENCES "TestSuite" ("ID"), 
	FOREIGN KEY("Type") REFERENCES "SampleType" ("ID"), 
	FOREIGN KEY(status_field) REFERENCES "TestSuiteSampleFields" ("ID")
);
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(1,'compile_status',2,'.compile.status',NULL,0); -- ID 1
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(1,'execution_status',2,'.exec.status',NULL,0);  -- ID 2
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(1,'compile_time',1,'.compile',1,0);             -- ID 3
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(1,'execution_time',1,'.exec',2,0);              -- ID 4
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'user_status',2,'.user.status',NULL,0);       -- ID 5
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'sys_status',2,'.sys.status',NULL,0);         -- ID 6
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'wall_status',2,'.wall.status',NULL,0);       -- ID 7
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'size_status',2,'.size.status',NULL,0);       -- ID 8
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'mem_status',2,'.mem.status',NULL,0);         -- ID 9
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'user_time',1,'.user',5,0);                   -- ID 10
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'sys_time',1,'.sys',6,0);                     -- ID 11
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'wall_time',1,'.wall',7,0);                   -- ID 12
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'size_bytes',1,'.size',8,0);                  -- ID 13
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(2,'mem_bytes',1,'.mem',9,0);                    -- ID 14
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(1,'score',1,'.score',NULL,1);                   -- ID 15
INSERT INTO "TestSuiteSampleFields" ("TestSuiteID", "Name", "Type", "InfoKey",
                                     "status_field", "bigger_is_better")
 VALUES(1,'mem_bytes',1,'.mem',NULL,0);                 -- ID 16
CREATE TABLE "TestSuiteMachineFields" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"TestSuiteID" INTEGER, 
	"Name" VARCHAR(256), 
	"InfoKey" VARCHAR(256), 
	FOREIGN KEY("TestSuiteID") REFERENCES "TestSuite" ("ID")
);
INSERT INTO "TestSuiteMachineFields" ("TestSuiteID", "Name", "InfoKey")
 VALUES(1,'hardware','hardware');       -- ID 1
INSERT INTO "TestSuiteMachineFields" ("TestSuiteID", "Name", "InfoKey")
 VALUES(1,'os','os');                   -- ID 2
INSERT INTO "TestSuiteMachineFields" ("TestSuiteID", "Name", "InfoKey")
 VALUES(2,'hardware','hw.model');       -- ID 3
INSERT INTO "TestSuiteMachineFields" ("TestSuiteID", "Name", "InfoKey")
 VALUES(2,'os_version','kern.version'); -- ID 4
CREATE TABLE "NT_Order" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"NextOrder" INTEGER, 
	"PreviousOrder" INTEGER, 
	llvm_project_revision VARCHAR(256), 
	FOREIGN KEY("NextOrder") REFERENCES "NT_Order" ("ID"), 
	FOREIGN KEY("PreviousOrder") REFERENCES "NT_Order" ("ID")
);
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(NULL,NULL,'154331'); -- ID 1
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(1,NULL,'152289');    -- ID 2
UPDATE "NT_Order" SET "PreviousOrder"=2 WHERE "ID"=1;
CREATE TABLE "NT_Machine" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"Name" VARCHAR(256), 
	"Parameters" BLOB, 
	hardware VARCHAR(256), 
	os VARCHAR(256)
);
INSERT INTO "NT_Machine" ("Name", "Parameters", "hardware", "os")
 VALUES('localhost__clang_DEV__x86_64',
        '[["name", "localhost"], ["uname", "Darwin localhost 11.3.0 Darwin Kernel Version 11.3.0: Thu Jan 12 18:47:41 PST 2012; root:xnu-1699.24.23~1/RELEASE_X86_64 x86_64"]]',
        'x86_64','Darwin 11.3.0'); -- ID 1
CREATE TABLE "NT_Test" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"Name" VARCHAR(256)
);
INSERT INTO "NT_Test" ("Name")
 VALUES('SingleSource/UnitTests/2006-12-01-float_varg'); -- ID 1
INSERT INTO "NT_Test" ("Name")
 VALUES('SingleSource/UnitTests/2006-12-04-DynAllocAndRestore'); -- ID 2
CREATE TABLE "NT_Run" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"MachineID" INTEGER, 
	"OrderID" INTEGER, 
	"ImportedFrom" VARCHAR(512), 
	"StartTime" DATETIME, 
	"EndTime" DATETIME, 
	"SimpleRunID" INTEGER, 
	"Parameters" BLOB, 
	FOREIGN KEY("MachineID") REFERENCES "NT_Machine" ("ID"), 
	FOREIGN KEY("OrderID") REFERENCES "NT_Order" ("ID")
);
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(1,1,
        'server/db/Inputs/lnt_v0.4.0_filled_instance/lnt_tmp/default/2012-04/data-2012-04-11_16-47-40bEjSGd.plist','2012-04-11 16:28:23.000000','2012-04-11 16:28:58.000000',
        NULL, CAST('[["ARCH", "x86_64"], ["CC_UNDER_TEST_IS_CLANG", "1"], ["CC_UNDER_TEST_TARGET_IS_X86_64", "1"], ["DISABLE_CBE", "1"], ["DISABLE_JIT", "1"], ["ENABLE_HASHED_PROGRAM_OUTPUT", "1"], ["ENABLE_OPTIMIZED", "1"], ["LLC_OPTFLAGS", "-O3"], ["LLI_OPTFLAGS", "-O3"], ["OPTFLAGS", "-O3"], ["TARGET_CC", "None"], ["TARGET_CXX", "None"], ["TARGET_FLAGS", ""], ["TARGET_LLVMGCC", "/tmp/bin/clang"], ["TARGET_LLVMGXX", "/tmp/bin/clang++"], ["TEST", "simple"], ["USE_REFERENCE_OUTPUT", "1"], ["__report_version__", "1"], ["cc1_exec_hash", "faf962f75130a6a50b5e8f61048c27ece631d0fd"], ["cc_alt_src_branch", "trunk"], ["cc_alt_src_revision", "154329"], ["cc_as_version", "LLVM (http://llvm.org/):\n  LLVM version 3.1svn\n  Optimized build.\n  Built Apr  9 2012 (11:55:07).\n  Default target: x86_64-apple-darwin11.3.0\n  Host CPU: corei7-avx"], ["cc_build", "DEV"], ["cc_exec_hash", "faf962f75130a6a50b5e8f61048c27ece631d0fd"], ["cc_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-123.2.1\nLibrary search paths:\n\t/usr/lib\n\t/usr/local/lib\nFramework search paths:\n\t/Library/Frameworks/\n\t/System/Library/Frameworks/"], ["cc_name", "clang"], ["cc_src_branch", "trunk"], ["cc_src_revision", "154331"], ["cc_target", "x86_64-apple-macosx10.7.0"], ["cc_version", "clang version 3.1 (trunk 154331) (llvm/trunk 154329)\nTarget: x86_64-apple-darwin11.3.0\nThread model: posix\n \"/tmp/bin/clang\" \"-cc1\" \"-triple\" \"x86_64-apple-macosx10.7.0\" \"-E\" \"-disable-free\" \"-disable-llvm-verifier\" \"-main-file-name\" \"null\" \"-pic-level\" \"2\" \"-mdisable-fp-elim\" \"-masm-verbose\" \"-munwind-tables\" \"-target-cpu\" \"core2\" \"-v\" \"-resource-dir\" \"/tmp/bin/../lib/clang/3.1\" \"-fmodule-cache-path\" \"/var/folders/32/jb9nf1gs6hx12s0brx1xdy8w0000gn/T/clang-module-cache\" \"-fdebug-compilation-dir\" \"/tmp/SANDBOX\" \"-ferror-limit\" \"19\" \"-fmessage-length\" \"0\" \"-stack-protector\" \"1\" \"-mstackrealign\" \"-fblocks\" \"-fobjc-runtime-has-arc\" \"-fobjc-runtime-has-weak\" \"-fobjc-dispatch-method=mixed\" \"-fobjc-default-synthesize-properties\" \"-fdiagnostics-show-option\" \"-o\" \"-\" \"-x\" \"c\" \"/dev/null\""], ["cc_version_number", "3.1"], ["inferred_run_order", "154331"], ["sw_vers", "ProductName:\tMac OS X\nProductVersion:\t10.7.3\nBuildVersion:\t11D50b"], ["test_suite_revision", "154271"]]' AS BLOB)
       ); -- ID 1
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(1,2,
        'report.json','2012-04-11 21:13:53.000000','2012-04-11 21:14:49.000000',
        NULL, CAST('[["ARCH", "x86_64"], ["CC_UNDER_TEST_IS_CLANG", "1"], ["CC_UNDER_TEST_TARGET_IS_X86_64", "1"], ["DISABLE_CBE", "1"], ["DISABLE_JIT", "1"], ["ENABLE_HASHED_PROGRAM_OUTPUT", "1"], ["ENABLE_OPTIMIZED", "1"], ["LLC_OPTFLAGS", "-O3"], ["LLI_OPTFLAGS", "-O3"], ["OPTFLAGS", "-O3"], ["TARGET_CC", "None"], ["TARGET_CXX", "None"], ["TARGET_FLAGS", ""], ["TARGET_LLVMGCC", "/tmp/bin/clang"], ["TARGET_LLVMGXX", "/tmp/bin/clang++"], ["TEST", "simple"], ["USE_REFERENCE_OUTPUT", "1"], ["__report_version__", "1"], ["cc1_exec_hash", "984ed8386e2acc8aef74ac3e59ef5e18b7406257"], ["cc_alt_src_branch", "trunk"], ["cc_alt_src_revision", "152288"], ["cc_as_version", "LLVM (http://llvm.org/):\n  LLVM version 3.1svn\n  Optimized build.\n  Built Mar  7 2012 (15:19:54).\n  Default target: x86_64-apple-darwin11.3.0\n  Host CPU: corei7-avx"], ["cc_build", "DEV"], ["cc_exec_hash", "984ed8386e2acc8aef74ac3e59ef5e18b7406257"], ["cc_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-123.2.1\nLibrary search paths:\n\t/usr/lib\n\t/usr/local/lib\nFramework search paths:\n\t/Library/Frameworks/\n\t/System/Library/Frameworks/"], ["cc_name", "clang"], ["cc_src_branch", "trunk"], ["cc_src_revision", "152289"], ["cc_target", "x86_64-apple-macosx10.7.0"], ["cc_version", "clang version 3.1 (trunk 152289) (llvm/trunk 152288)\nTarget: x86_64-apple-darwin11.3.0\nThread model: posix\n \"/tmp/bin/clang\" \"-cc1\" \"-triple\" \"x86_64-apple-macosx10.7.0\" \"-E\" \"-disable-free\" \"-disable-llvm-verifier\" \"-main-file-name\" \"null\" \"-pic-level\" \"1\" \"-mdisable-fp-elim\" \"-masm-verbose\" \"-munwind-tables\" \"-target-cpu\" \"core2\" \"-v\" \"-resource-dir\" \"/tmp/bin/../lib/clang/3.1\" \"-fmodule-cache-path\" \"/var/folders/32/jb9nf1gs6hx12s0brx1xdy8w0000gn/T/clang-module-cache\" \"-fdebug-compilation-dir\" \"/tmp/SANDBOX\" \"-ferror-limit\" \"19\" \"-fmessage-length\" \"0\" \"-stack-protector\" \"1\" \"-mstackrealign\" \"-fblocks\" \"-fobjc-runtime-has-arc\" \"-fobjc-runtime-has-weak\" \"-fobjc-dispatch-method=mixed\" \"-fobjc-default-synthesize-properties\" \"-fdiagnostics-show-option\" \"-o\" \"-\" \"-x\" \"c\" \"/dev/null\""], ["cc_version_number", "3.1"], ["inferred_run_order", "152289"], ["sw_vers", "ProductName:\tMac OS X\nProductVersion:\t10.7.3\nBuildVersion:\t11D50b"], ["test_suite_revision", "154271"]]' AS BLOB)
       ); -- ID 2
CREATE TABLE "NT_Sample" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"RunID" INTEGER, 
	"TestID" INTEGER, 
	compile_status INTEGER, 
	execution_status INTEGER, 
	compile_time FLOAT, 
	execution_time FLOAT, score FLOAT, "mem_bytes" FLOAT, 
	FOREIGN KEY("RunID") REFERENCES "NT_Run" ("ID"), 
	FOREIGN KEY("TestID") REFERENCES "NT_Test" ("ID"), 
	FOREIGN KEY(compile_status) REFERENCES "StatusKind" ("ID"), 
	FOREIGN KEY(execution_status) REFERENCES "StatusKind" ("ID")
);
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(1,1,NULL,NULL,0.007,0.0003,NULL,NULL); -- ID 1
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(1,2,NULL,NULL,0.0072,0.0003,NULL,NULL); -- ID 2
CREATE TABLE "compile_Machine" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"Name" VARCHAR(256), 
	"Parameters" BLOB, 
	hardware VARCHAR(256), 
	os_version VARCHAR(256)
);
INSERT INTO "compile_Machine" ("Name", "Parameters", "hardware", "os_version")
 VALUES('localhost',
        CAST('[["hw.activecpu", "8"], ["hw.availcpu", "8"], ["hw.busfrequency", "100000000"], ["hw.busfrequency_max", "100000000"], ["hw.busfrequency_min", "100000000"], ["hw.byteorder", "1234"], ["hw.cacheconfig", "8 2 2 8 0 0 0 0 0 0"], ["hw.cachelinesize", "64"], ["hw.cachesize", "8589934592 32768 262144 6291456 0 0 0 0 0 0"], ["hw.cpu64bit_capable", "1"], ["hw.cpufamily", "1418770316"], ["hw.cpufrequency", "2200000000"], ["hw.cpufrequency_max", "2200000000"], ["hw.cpufrequency_min", "2200000000"], ["hw.cpusubtype", "4"], ["hw.cputype", "7"], ["hw.epoch", "0"], ["hw.l1dcachesize", "32768"], ["hw.l1icachesize", "32768"], ["hw.l2cachesize", "262144"], ["hw.l2settings", "1"], ["hw.logicalcpu", "8"], ["hw.logicalcpu_max", "8"], ["hw.machine", "x86_64"], ["hw.memsize", "8589934592"], ["hw.ncpu", "8"], ["hw.optional.floatingpoint", "1"], ["hw.optional.mmx", "1"], ["hw.optional.sse", "1"], ["hw.optional.sse2", "1"], ["hw.optional.sse3", "1"], ["hw.optional.sse4_1", "1"], ["hw.optional.sse4_2", "1"], ["hw.optional.supplementalsse3", "1"], ["hw.optional.x86_64", "1"], ["hw.packages", "1"], ["hw.pagesize", "4096"], ["hw.physicalcpu", "4"], ["hw.physicalcpu_max", "4"], ["hw.physmem", "2147483648"], ["hw.tbfrequency", "1000000000"], ["hw.vectorunit", "1"], ["kern.aiomax", "90"], ["kern.aioprocmax", "16"], ["kern.aiothreads", "4"], ["kern.argmax", "262144"], ["kern.clockrate: hz", "second level name clockrate: hz in kern.clockrate: hz is invalid"], ["kern.coredump", "1"], ["kern.corefile", "/cores/core.%P"], ["kern.delayterm", "0"], ["kern.hostid", "0"], ["kern.hostname", "localhost"], ["kern.job_control", "1"], ["kern.maxfiles", "12288"], ["kern.maxfilesperproc", "10240"], ["kern.maxproc", "1064"], ["kern.maxprocperuid", "709"], ["kern.maxvnodes", "132096"], ["kern.netboot", "0"], ["kern.ngroups", "16"], ["kern.nisdomainname", ""], ["kern.nx", "1"], ["kern.osrelease", "11.3.0"], ["kern.osrevision", "199506"], ["kern.ostype", "Darwin"], ["kern.osversion", "11D50b"], ["kern.posix1version", "200112"], ["kern.procname", ""], ["kern.rage_vnode", "0"], ["kern.safeboot", "0"], ["kern.saved_ids", "1"], ["kern.securelevel", "0"], ["kern.shreg_private", "0"], ["kern.speculative_reads_disabled", "0"], ["kern.sugid_coredump", "0"], ["kern.thread_name", "kern"], ["machdep.cpu.address_bits.physical", "36"], ["machdep.cpu.address_bits.virtual", "48"], ["machdep.cpu.arch_perf.events", "0"], ["machdep.cpu.arch_perf.events_number", "7"], ["machdep.cpu.arch_perf.fixed_number", "3"], ["machdep.cpu.arch_perf.fixed_width", "48"], ["machdep.cpu.arch_perf.number", "4"], ["machdep.cpu.arch_perf.version", "3"], ["machdep.cpu.arch_perf.width", "48"], ["machdep.cpu.brand", "0"], ["machdep.cpu.brand_string", "Intel(R) Core(TM) i7-2720QM CPU @ 2.20GHz"], ["machdep.cpu.cache.L2_associativity", "8"], ["machdep.cpu.cache.linesize", "64"], ["machdep.cpu.cache.size", "256"], ["machdep.cpu.core_count", "4"], ["machdep.cpu.cores_per_package", "8"], ["machdep.cpu.extfamily", "0"], ["machdep.cpu.extfeature_bits", "672139520 1"], ["machdep.cpu.extfeatures", "SYSCALL XD EM64T LAHF RDTSCP TSCI"], ["machdep.cpu.extmodel", "2"], ["machdep.cpu.family", "6"], ["machdep.cpu.feature_bits", "3219913727 532341759"], ["machdep.cpu.features", "FPU VME DE PSE TSC MSR PAE MCE CX8 APIC SEP MTRR PGE MCA CMOV PAT PSE36 CLFSH DS ACPI MMX FXSR SSE SSE2 SS HTT TM PBE SSE3 PCLMULQDQ DTES64 MON DSCPL VMX SMX EST TM2 SSSE3 CX16 TPR PDCM SSE4.1 SSE4.2 xAPIC POPCNT AES PCID XSAVE OSXSAVE TSCTMR AVX1.0"], ["machdep.cpu.logical_per_package", "16"], ["machdep.cpu.max_basic", "13"], ["machdep.cpu.max_ext", "2147483656"], ["machdep.cpu.microcode_version", "26"], ["machdep.cpu.model", "42"], ["machdep.cpu.mwait.extensions", "3"], ["machdep.cpu.mwait.linesize_max", "64"], ["machdep.cpu.mwait.linesize_min", "64"], ["machdep.cpu.mwait.sub_Cstates", "135456"], ["machdep.cpu.signature", "132775"], ["machdep.cpu.stepping", "7"], ["machdep.cpu.thermal.ACNT_MCNT", "1"], ["machdep.cpu.thermal.dynamic_acceleration", "1"], ["machdep.cpu.thermal.sensor", "1"], ["machdep.cpu.thermal.thresholds", "2"], ["machdep.cpu.thread_count", "8"], ["machdep.cpu.tlb.data.large", "32"], ["machdep.cpu.tlb.data.large_level1", ""], ["machdep.cpu.tlb.data.small", "64"], ["machdep.cpu.tlb.data.small_level1", ""], ["machdep.cpu.tlb.inst.large", ""], ["machdep.cpu.tlb.inst.small", "64"], ["machdep.cpu.vendor", "GenuineIntel"]]' AS BLOB),
        'MacBookPro8,2',
        'Darwin Kernel Version 11.3.0: Thu Jan 12 18:47:41 PST 2012; root:xnu-1699.24.23~1/RELEASE_X86_64'
       ); -- ID 1
INSERT INTO "compile_Machine" ("Name", "Parameters", "hardware", "os_version")
 VALUES('MacBook-Pro.local',
        CAST('[["hw.activecpu", "8"], ["hw.availcpu", "sysctl: unknown oid ''hw.availcpu''"], ["hw.busfrequency", "100000000"], ["hw.busfrequency_max", "100000000"], ["hw.busfrequency_min", "100000000"], ["hw.byteorder", "1234"], ["hw.cacheconfig", "8 2 2 8 0 0 0 0 0 0"], ["hw.cachelinesize", "64"], ["hw.cachesize", "8589934592 32768 262144 6291456 0 0 0 0 0 0"], ["hw.cpu64bit_capable", "1"], ["hw.cpufamily", "526772277"], ["hw.cpufrequency", "2300000000"], ["hw.cpufrequency_max", "2300000000"], ["hw.cpufrequency_min", "2300000000"], ["hw.cpusubtype", "4"], ["hw.cputype", "7"], ["hw.epoch", "0"], ["hw.l1dcachesize", "32768"], ["hw.l1icachesize", "32768"], ["hw.l2cachesize", "262144"], ["hw.l2settings", "1"], ["hw.logicalcpu", "8"], ["hw.logicalcpu_max", "8"], ["hw.machine", "x86_64"], ["hw.memsize", "8589934592"], ["hw.ncpu", "8"], ["hw.optional.floatingpoint", "1"], ["hw.optional.mmx", "1"], ["hw.optional.sse", "1"], ["hw.optional.sse2", "1"], ["hw.optional.sse3", "1"], ["hw.optional.sse4_1", "1"], ["hw.optional.sse4_2", "1"], ["hw.optional.supplementalsse3", "1"], ["hw.optional.x86_64", "1"], ["hw.packages", "1"], ["hw.pagesize", "4096"], ["hw.physicalcpu", "4"], ["hw.physicalcpu_max", "4"], ["hw.physmem", "2147483648"], ["hw.tbfrequency", "1000000000"], ["hw.vectorunit", "1"], ["kern.aiomax", "90"], ["kern.aioprocmax", "16"], ["kern.aiothreads", "4"], ["kern.argmax", "262144"], ["kern.clockrate: hz", "sysctl: unknown oid ''kern.clockrate: hz''"], ["kern.coredump", "1"], ["kern.corefile", "/cores/core.%P"], ["kern.delayterm", "0"], ["kern.hostid", "0"], ["kern.hostname", "MacBook-Pro.local"], ["kern.job_control", "1"], ["kern.maxfiles", "12288"], ["kern.maxfilesperproc", "10240"], ["kern.maxproc", "1064"], ["kern.maxprocperuid", "709"], ["kern.maxvnodes", "132096"], ["kern.netboot", "0"], ["kern.ngroups", "16"], ["kern.nisdomainname", ""], ["kern.nx", "1"], ["kern.osrelease", "14.0.0"], ["kern.osrevision", "199506"], ["kern.ostype", "Darwin"], ["kern.osversion", "14A253a"], ["kern.posix1version", "200112"], ["kern.procname", ""], ["kern.rage_vnode", "0"], ["kern.safeboot", "0"], ["kern.saved_ids", "1"], ["kern.securelevel", "0"], ["kern.shreg_private", "0"], ["kern.speculative_reads_disabled", "0"], ["kern.sugid_coredump", "0"], ["kern.thread_name", "sysctl: unknown oid ''kern.thread_name''"], ["mac_addr.awdl0", "f6:cb:e5:c2:b5:98"], ["mac_addr.bridge0", "22:c9:d0:64:64:00"], ["mac_addr.en0", "20:c9:d0:46:d3:59"], ["mac_addr.en1", "32:00:17:d9:ff:a0"], ["mac_addr.en2", "32:00:17:d9:ff:a1"], ["mac_addr.en4", "a8:20:66:29:b0:6e"], ["mac_addr.p2p0", "02:c9:d0:46:d3:59"], ["machdep.cpu.address_bits.physical", "36"], ["machdep.cpu.address_bits.virtual", "48"], ["machdep.cpu.arch_perf.events", "0"], ["machdep.cpu.arch_perf.events_number", "7"], ["machdep.cpu.arch_perf.fixed_number", "3"], ["machdep.cpu.arch_perf.fixed_width", "48"], ["machdep.cpu.arch_perf.number", "4"], ["machdep.cpu.arch_perf.version", "3"], ["machdep.cpu.arch_perf.width", "48"], ["machdep.cpu.brand", "0"], ["machdep.cpu.brand_string", "Intel(R) Core(TM) i7-3615QM CPU @ 2.30GHz"], ["machdep.cpu.cache.L2_associativity", "8"], ["machdep.cpu.cache.linesize", "64"], ["machdep.cpu.cache.size", "256"], ["machdep.cpu.core_count", "4"], ["machdep.cpu.cores_per_package", "8"], ["machdep.cpu.extfamily", "0"], ["machdep.cpu.extfeature_bits", "4967106816"], ["machdep.cpu.extfeatures", "SYSCALL XD EM64T LAHF RDTSCP TSCI"], ["machdep.cpu.extmodel", "3"], ["machdep.cpu.family", "6"], ["machdep.cpu.feature_bits", "9203919201183202303"], ["machdep.cpu.features", "FPU VME DE PSE TSC MSR PAE MCE CX8 APIC SEP MTRR PGE MCA CMOV PAT PSE36 CLFSH DS ACPI MMX FXSR SSE SSE2 SS HTT TM PBE SSE3 PCLMULQDQ DTES64 MON DSCPL VMX EST TM2 SSSE3 CX16 TPR PDCM SSE4.1 SSE4.2 x2APIC POPCNT AES PCID XSAVE OSXSAVE TSCTMR AVX1.0 RDRAND F16C"], ["machdep.cpu.logical_per_package", "16"], ["machdep.cpu.max_basic", "13"], ["machdep.cpu.max_ext", "2147483656"], ["machdep.cpu.microcode_version", "21"], ["machdep.cpu.model", "58"], ["machdep.cpu.mwait.extensions", "3"], ["machdep.cpu.mwait.linesize_max", "64"], ["machdep.cpu.mwait.linesize_min", "64"], ["machdep.cpu.mwait.sub_Cstates", "135456"], ["machdep.cpu.signature", "198313"], ["machdep.cpu.stepping", "9"], ["machdep.cpu.thermal.ACNT_MCNT", "1"], ["machdep.cpu.thermal.dynamic_acceleration", "1"], ["machdep.cpu.thermal.sensor", "1"], ["machdep.cpu.thermal.thresholds", "2"], ["machdep.cpu.thread_count", "8"], ["machdep.cpu.tlb.data.large", "32"], ["machdep.cpu.tlb.data.large_level1", ""], ["machdep.cpu.tlb.data.small", "64"], ["machdep.cpu.tlb.data.small_level1", ""], ["machdep.cpu.tlb.inst.large", "8"], ["machdep.cpu.tlb.inst.small", "64"], ["machdep.cpu.vendor", "GenuineIntel"]]' AS BLOB),
        'MacBookPro10,1',
        'Darwin Kernel Version 14.0.0: Thu May 29 20:54:07 PDT 2014; root:xnu-2763~1/DEVELOPMENT_X86_64'
       ); -- ID 2
CREATE TABLE "compile_Test" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"Name" VARCHAR(256)
);
INSERT INTO "compile_Test" ("Name")
 VALUES('compile/OmniGroupFrameworks/NSBezierPath-OAExtensions.m/assembly/(-O0 -g)'
       ); -- ID 1
INSERT INTO "compile_Test" ("Name")
 VALUES('compile/JavaScriptCore/Interpreter.cpp/init/(-O0 -g)'); -- ID 2
CREATE TABLE "compile_Order" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"NextOrder" INTEGER, 
	"PreviousOrder" INTEGER, 
	llvm_project_revision VARCHAR(256), 
	FOREIGN KEY("NextOrder") REFERENCES "compile_Order" ("ID"), 
	FOREIGN KEY("PreviousOrder") REFERENCES "compile_Order" ("ID")
);
INSERT INTO "compile_Order" ("NextOrder", "PreviousOrder",
                             "llvm_project_revision")
 VALUES(NULL,NULL,'154331'); -- ID 1
INSERT INTO "compile_Order" ("NextOrder", "PreviousOrder",
                             "llvm_project_revision")
 VALUES(1,NULL,'154335');    -- ID 2
INSERT INTO "compile_Order" ("NextOrder", "PreviousOrder",
                             "llvm_project_revision")
 VALUES(2,NULL,'154339');    -- ID 3
UPDATE "compile_Order" SET "PreviousOrder"=2 WHERE "ID"=1;
UPDATE "compile_Order" SET "PreviousOrder"=3 WHERE "ID"=2;
CREATE TABLE "compile_Run" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"MachineID" INTEGER, 
	"OrderID" INTEGER, 
	"ImportedFrom" VARCHAR(512), 
	"StartTime" DATETIME, 
	"EndTime" DATETIME, 
	"SimpleRunID" INTEGER, 
	"Parameters" BLOB, 
	FOREIGN KEY("MachineID") REFERENCES "compile_Machine" ("ID"), 
	FOREIGN KEY("OrderID") REFERENCES "compile_Order" ("ID")
);
INSERT INTO "compile_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(1,1,
        'server/db/Inputs/lnt_v0.4.0_filled_instance/lnt_tmp/default/2012-04/data-2012-04-11_16-47-40o2zWJN.plist',
        '2012-04-11 16:30:33.000000','2012-04-11 16:40:13.000000',NULL,
        CAST('[["__report_version__", "1"], ["cc", "/tmp/bin/clang"], ["cc1_exec_hash", "faf962f75130a6a50b5e8f61048c27ece631d0fd"], ["cc_alt_src_branch", "trunk"], ["cc_alt_src_revision", "154329"], ["cc_as_version", "LLVM (http://llvm.org/):\n  LLVM version 3.1svn\n  Optimized build.\n  Built Apr  9 2012 (11:55:07).\n  Default target: x86_64-apple-darwin11.3.0\n  Host CPU: corei7-avx"], ["cc_build", "DEV"], ["cc_exec_hash", "faf962f75130a6a50b5e8f61048c27ece631d0fd"], ["cc_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-123.2.1\nLibrary search paths:\n\t/usr/lib\n\t/usr/local/lib\nFramework search paths:\n\t/Library/Frameworks/\n\t/System/Library/Frameworks/"], ["cc_name", "clang"], ["cc_src_branch", "trunk"], ["cc_src_revision", "154331"], ["cc_target", "x86_64-apple-macosx10.7.0"], ["cc_version", "clang version 3.1 (trunk 154331) (llvm/trunk 154329)\nTarget: x86_64-apple-darwin11.3.0\nThread model: posix\n \"/tmp/bin/clang\" \"-cc1\" \"-triple\" \"x86_64-apple-macosx10.7.0\" \"-E\" \"-disable-free\" \"-disable-llvm-verifier\" \"-main-file-name\" \"null\" \"-pic-level\" \"2\" \"-mdisable-fp-elim\" \"-masm-verbose\" \"-munwind-tables\" \"-target-cpu\" \"core2\" \"-v\" \"-resource-dir\" \"/tmp/bin/../lib/clang/3.1\" \"-fmodule-cache-path\" \"/var/folders/32/jb9nf1gs6hx12s0brx1xdy8w0000gn/T/clang-module-cache\" \"-fdebug-compilation-dir\" \"/tmp/SANDBOX\" \"-ferror-limit\" \"19\" \"-fmessage-length\" \"0\" \"-stack-protector\" \"1\" \"-mstackrealign\" \"-fblocks\" \"-fobjc-runtime-has-arc\" \"-fobjc-runtime-has-weak\" \"-fobjc-dispatch-method=mixed\" \"-fobjc-default-synthesize-properties\" \"-fdiagnostics-show-option\" \"-o\" \"-\" \"-x\" \"c\" \"/dev/null\""], ["cc_version_number", "3.1"], ["hw.usermem", "728748032"], ["inferred_run_order", "154331"], ["kern.boottime", "{ sec = 1332011482, usec = 0 } Sat Mar 17 12:11:22 2012"], ["kern.usrstack", "1667633152"], ["kern.usrstack64", "140735023362048"], ["run_count", "3"], ["sys_as_version", "Apple Inc version cctools-800~266, GNU assembler version 1.38"], ["sys_cc_version", "Using built-in specs.\nTarget: i686-apple-darwin11\nConfigured with: /private/var/tmp/llvmgcc42/llvmgcc42-2335.15~62/src/configure --disable-checking --enable-werror --prefix=/Developer/usr/llvm-gcc-4.2 --mandir=/share/man --enable-languages=c,objc,c++,obj-c++ --program-prefix=llvm- --program-transform-name=/^[cg][^.-]*$/s/$/-4.2/ --with-slibdir=/usr/lib --build=i686-apple-darwin11 --enable-llvm=/private/var/tmp/llvmgcc42/llvmgcc42-2335.15~62/dst-llvmCore/Developer/usr/local --program-prefix=i686-apple-darwin11- --host=x86_64-apple-darwin11 --target=i686-apple-darwin11 --with-gxx-include-dir=/usr/include/c++/4.2.1\nThread model: posix\ngcc version 4.2.1 (Based on Apple Inc. build 5658) (LLVM build 2335.15.00)"], ["sys_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-123.2.1\nllvm version 2.9svn, from Apple Clang 2.0 (build 138.1)"], ["sys_xcodebuild", "Xcode 4.1\nBuild version 11A511a"]]' AS BLOB)
       ); -- ID 1
INSERT INTO "compile_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,2,
        '/Users/cmatthews/src/lnt/tests/SharedInputs/SmallInstance/lnt_tmp/default/2014-06/data-2014-06-03_20-59-47BCt5TE.plist',
        '2014-06-02 20:59:42.000000','2014-06-02 21:59:47.000000',NULL,
        CAST('[["__report_version__", "1"], ["cc", "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"], ["cc1_exec_hash", "b18490c69cebfbdd20500c473684b7093a8b2c62"], ["cc_alt_src_branch", "based on LLVM"], ["cc_alt_src_revision", "3.5svn"], ["cc_as_version", "clang: error: unsupported argument ''-v'' to option ''Wa,''"], ["cc_build", "PROD"], ["cc_dumpmachine", "x86_64-apple-darwin14.0.0"], ["cc_exec_hash", "b18490c69cebfbdd20500c473684b7093a8b2c62"], ["cc_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-241\nconfigured to support archs: armv6 armv7 armv7s arm64 i386 x86_64 x86_64h armv6m armv7m armv7em\nLibrary search paths:\n\t/usr/lib\n\t/usr/local/lib\nFramework search paths:\n\t/Library/Frameworks/\n\t/System/Library/Frameworks/"], ["cc_name", "apple_clang"], ["cc_src_branch", "clang-600.0.34.2"], ["cc_src_tag", "600.0.34.2"], ["cc_target", "x86_64-apple-macosx10.10.0"], ["cc_target_assembly", "; ModuleID = ''/dev/null''\ntarget datalayout = \"e-m:o-i64:64-f80:128-n8:16:32:64-S128\"\ntarget triple = \"x86_64-apple-macosx10.10.0\"\n\n!llvm.ident = !{!0}\n\n!0 = metadata !{metadata !\"Apple LLVM version 6.0 (clang-600.0.34.2) (based on LLVM 3.5svn)\"}"], ["cc_version", "Apple LLVM version 6.0 (clang-600.0.34.2) (based on LLVM 3.5svn)\nTarget: x86_64-apple-darwin14.0.0\nThread model: posix\n \"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang\" \"-cc1\" \"-triple\" \"x86_64-apple-macosx10.10.0\" \"-E\" \"-disable-free\" \"-disable-llvm-verifier\" \"-main-file-name\" \"null\" \"-mrelocation-model\" \"pic\" \"-pic-level\" \"2\" \"-mdisable-fp-elim\" \"-masm-verbose\" \"-munwind-tables\" \"-target-cpu\" \"core2\" \"-target-linker-version\" \"241\" \"-v\" \"-resource-dir\" \"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/../lib/clang/6.0\" \"-fdebug-compilation-dir\" \"/Users/cmatthews/src/lnt/tests\" \"-ferror-limit\" \"19\" \"-fmessage-length\" \"0\" \"-stack-protector\" \"1\" \"-mstackrealign\" \"-fblocks\" \"-fobjc-runtime=macosx-10.10.0\" \"-fencode-extended-block-signature\" \"-fdiagnostics-show-option\" \"-vectorize-slp\" \"-o\" \"-\" \"-x\" \"c\" \"/dev/null\""], ["cc_version_number", "6.0"], ["hw.usermem", "974143488"], ["inferred_run_order", "600.0.34.2"], ["kern.boottime", "{ sec = 1401769065, usec = 0 } Mon Jun  2 21:17:45 2014"], ["kern.usrstack", "1548972032"], ["kern.usrstack64", "140734545977344"], ["run_count", "1"], ["sys_as_version", "Apple Inc version cctools-861, GNU assembler version 1.38"], ["sys_cc_version", "Configured with: --prefix=/Applications/Xcode.app/Contents/Developer/usr --with-gxx-include-dir=/usr/include/c++/4.2.1\nApple LLVM version 6.0 (clang-600.0.34) (based on LLVM 3.5svn)\nTarget: x86_64-apple-darwin14.0.0\nThread model: posix"], ["sys_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-241\nconfigured to support archs: i386 x86_64 x86_64h arm64\nLTO support using: LLVM version 3.5svn"], ["sys_xcodebuild", "Xcode 6.0\nBuild version 6A233"]]' AS BLOB)
       ); -- ID 2
INSERT INTO "compile_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,2,
        '/Users/cmatthews/src/lnt/tests/SharedInputs/SmallInstance/lnt_tmp/default/2014-06/data-2014-06-03_21-00-37ADDeLS.plist',
        '2014-06-03 21:00:16.000000','2014-06-03 21:00:37.000000',NULL,
        CAST('[["__report_version__", "1"], ["cc", "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"], ["cc1_exec_hash", "b18490c69cebfbdd20500c473684b7093a8b2c62"], ["cc_alt_src_branch", "based on LLVM"], ["cc_alt_src_revision", "3.5svn"], ["cc_as_version", "clang: error: unsupported argument ''-v'' to option ''Wa,''"], ["cc_build", "PROD"], ["cc_dumpmachine", "x86_64-apple-darwin14.0.0"], ["cc_exec_hash", "b18490c69cebfbdd20500c473684b7093a8b2c62"], ["cc_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-241\nconfigured to support archs: armv6 armv7 armv7s arm64 i386 x86_64 x86_64h armv6m armv7m armv7em\nLibrary search paths:\n\t/usr/lib\n\t/usr/local/lib\nFramework search paths:\n\t/Library/Frameworks/\n\t/System/Library/Frameworks/"], ["cc_name", "apple_clang"], ["cc_src_branch", "clang-600.0.34.2"], ["cc_src_tag", "600.0.34.2"], ["cc_target", "x86_64-apple-macosx10.10.0"], ["cc_target_assembly", "; ModuleID = ''/dev/null''\ntarget datalayout = \"e-m:o-i64:64-f80:128-n8:16:32:64-S128\"\ntarget triple = \"x86_64-apple-macosx10.10.0\"\n\n!llvm.ident = !{!0}\n\n!0 = metadata !{metadata !\"Apple LLVM version 6.0 (clang-600.0.34.2) (based on LLVM 3.5svn)\"}"], ["cc_version", "Apple LLVM version 6.0 (clang-600.0.34.2) (based on LLVM 3.5svn)\nTarget: x86_64-apple-darwin14.0.0\nThread model: posix\n \"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang\" \"-cc1\" \"-triple\" \"x86_64-apple-macosx10.10.0\" \"-E\" \"-disable-free\" \"-disable-llvm-verifier\" \"-main-file-name\" \"null\" \"-mrelocation-model\" \"pic\" \"-pic-level\" \"2\" \"-mdisable-fp-elim\" \"-masm-verbose\" \"-munwind-tables\" \"-target-cpu\" \"core2\" \"-target-linker-version\" \"241\" \"-v\" \"-resource-dir\" \"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/../lib/clang/6.0\" \"-fdebug-compilation-dir\" \"/Users/cmatthews/src/lnt/tests\" \"-ferror-limit\" \"19\" \"-fmessage-length\" \"0\" \"-stack-protector\" \"1\" \"-mstackrealign\" \"-fblocks\" \"-fobjc-runtime=macosx-10.10.0\" \"-fencode-extended-block-signature\" \"-fdiagnostics-show-option\" \"-vectorize-slp\" \"-o\" \"-\" \"-x\" \"c\" \"/dev/null\""], ["cc_version_number", "6.0"], ["hw.usermem", "1000357888"], ["inferred_run_order", "600.0.34.2"], ["kern.boottime", "{ sec = 1401769065, usec = 0 } Mon Jun  2 21:17:45 2014"], ["kern.usrstack", "1570906112"], ["kern.usrstack64", "140734551621632"], ["run_count", "3"], ["sys_as_version", "Apple Inc version cctools-861, GNU assembler version 1.38"], ["sys_cc_version", "Configured with: --prefix=/Applications/Xcode.app/Contents/Developer/usr --with-gxx-include-dir=/usr/include/c++/4.2.1\nApple LLVM version 6.0 (clang-600.0.34) (based on LLVM 3.5svn)\nTarget: x86_64-apple-darwin14.0.0\nThread model: posix"], ["sys_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-241\nconfigured to support archs: i386 x86_64 x86_64h arm64\nLTO support using: LLVM version 3.5svn"], ["sys_xcodebuild", "Xcode 6.0\nBuild version 6A233"]]' AS BLOB)
       ); -- ID 3
INSERT INTO "compile_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,3,
        '/Users/cmatthews/src/lnt/tests/SharedInputs/SmallInstance/lnt_tmp/default/2014-06/data-2014-06-03_21-03-15G7p553.plist',
        '2014-06-04 21:03:07.000000','2014-06-04 21:03:15.000000',NULL,
        CAST('[["__report_version__", "1"], ["cc", "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"], ["cc1_exec_hash", "b18490c69cebfbdd20500c473684b7093a8b2c62"], ["cc_alt_src_branch", "based on LLVM"], ["cc_alt_src_revision", "3.5svn"], ["cc_as_version", "clang: error: unsupported argument ''-v'' to option ''Wa,''"], ["cc_build", "PROD"], ["cc_dumpmachine", "x86_64-apple-darwin14.0.0"], ["cc_exec_hash", "b18490c69cebfbdd20500c473684b7093a8b2c62"], ["cc_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-241\nconfigured to support archs: armv6 armv7 armv7s arm64 i386 x86_64 x86_64h armv6m armv7m armv7em\nLibrary search paths:\n\t/usr/lib\n\t/usr/local/lib\nFramework search paths:\n\t/Library/Frameworks/\n\t/System/Library/Frameworks/"], ["cc_name", "apple_clang"], ["cc_src_branch", "clang-600.0.34.2"], ["cc_src_tag", "600.0.34.2"], ["cc_target", "x86_64-apple-macosx10.10.0"], ["cc_target_assembly", "; ModuleID = ''/dev/null''\ntarget datalayout = \"e-m:o-i64:64-f80:128-n8:16:32:64-S128\"\ntarget triple = \"x86_64-apple-macosx10.10.0\"\n\n!llvm.ident = !{!0}\n\n!0 = metadata !{metadata !\"Apple LLVM version 6.0 (clang-600.0.34.2) (based on LLVM 3.5svn)\"}"], ["cc_version", "Apple LLVM version 6.0 (clang-600.0.34.2) (based on LLVM 3.5svn)\nTarget: x86_64-apple-darwin14.0.0\nThread model: posix\n \"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang\" \"-cc1\" \"-triple\" \"x86_64-apple-macosx10.10.0\" \"-E\" \"-disable-free\" \"-disable-llvm-verifier\" \"-main-file-name\" \"null\" \"-mrelocation-model\" \"pic\" \"-pic-level\" \"2\" \"-mdisable-fp-elim\" \"-masm-verbose\" \"-munwind-tables\" \"-target-cpu\" \"core2\" \"-target-linker-version\" \"241\" \"-v\" \"-resource-dir\" \"/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/../lib/clang/6.0\" \"-fdebug-compilation-dir\" \"/Users/cmatthews/src/lnt/tests\" \"-ferror-limit\" \"19\" \"-fmessage-length\" \"0\" \"-stack-protector\" \"1\" \"-mstackrealign\" \"-fblocks\" \"-fobjc-runtime=macosx-10.10.0\" \"-fencode-extended-block-signature\" \"-fdiagnostics-show-option\" \"-vectorize-slp\" \"-o\" \"-\" \"-x\" \"c\" \"/dev/null\""], ["cc_version_number", "6.0"], ["hw.usermem", "998539264"], ["inferred_run_order", "600.0.34.2"], ["kern.boottime", "{ sec = 1401769065, usec = 0 } Mon Jun  2 21:17:45 2014"], ["kern.usrstack", "1383366656"], ["kern.usrstack64", "140734738419712"], ["run_count", "3"], ["sys_as_version", "Apple Inc version cctools-861, GNU assembler version 1.38"], ["sys_cc_version", "Configured with: --prefix=/Applications/Xcode.app/Contents/Developer/usr --with-gxx-include-dir=/usr/include/c++/4.2.1\nApple LLVM version 6.0 (clang-600.0.34) (based on LLVM 3.5svn)\nTarget: x86_64-apple-darwin14.0.0\nThread model: posix"], ["sys_ld_version", "@(#)PROGRAM:ld  PROJECT:ld64-241\nconfigured to support archs: i386 x86_64 x86_64h arm64\nLTO support using: LLVM version 3.5svn"], ["sys_xcodebuild", "Xcode 6.0\nBuild version 6A233"]]' AS BLOB)
       ); -- ID 4
CREATE TABLE "compile_Sample" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"RunID" INTEGER, 
	"TestID" INTEGER, 
	user_status INTEGER, 
	sys_status INTEGER, 
	wall_status INTEGER, 
	size_status INTEGER, 
	mem_status INTEGER, 
	user_time FLOAT, 
	sys_time FLOAT, 
	wall_time FLOAT, 
	size_bytes FLOAT, 
	mem_bytes FLOAT, 
	FOREIGN KEY("RunID") REFERENCES "compile_Run" ("ID"), 
	FOREIGN KEY("TestID") REFERENCES "compile_Test" ("ID"), 
	FOREIGN KEY(user_status) REFERENCES "StatusKind" ("ID"), 
	FOREIGN KEY(sys_status) REFERENCES "StatusKind" ("ID"), 
	FOREIGN KEY(wall_status) REFERENCES "StatusKind" ("ID"), 
	FOREIGN KEY(size_status) REFERENCES "StatusKind" ("ID"), 
	FOREIGN KEY(mem_status) REFERENCES "StatusKind" ("ID")
);
INSERT INTO "compile_Sample" ("RunID", "TestID", user_status, sys_status,
                              wall_status, size_status, mem_status, user_time,
                              sys_time, wall_time, size_bytes, mem_bytes)
 VALUES(1,1,NULL,NULL,NULL,NULL,NULL,0.336512,0.02585,0.365776,165852.0,
        33353728.0); -- ID 1
INSERT INTO "compile_Sample" ("RunID", "TestID", user_status, sys_status,
                              wall_status, size_status, mem_status, user_time,
                              sys_time, wall_time, size_bytes, mem_bytes)
 VALUES(1,1,NULL,NULL,NULL,NULL,NULL,0.338633,0.027111,0.367148,165852.0,
        33353728.0); -- ID 2
CREATE TABLE "NT_FieldChange" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"StartOrderID" INTEGER, 
	"EndOrderID" INTEGER, 
	"TestID" INTEGER, 
	"MachineID" INTEGER, 
	"FieldID" INTEGER, 
	FOREIGN KEY("StartOrderID") REFERENCES "NT_Order" ("ID"), 
	FOREIGN KEY("EndOrderID") REFERENCES "NT_Order" ("ID"), 
	FOREIGN KEY("TestID") REFERENCES "NT_Test" ("ID"), 
	FOREIGN KEY("MachineID") REFERENCES "NT_Machine" ("ID"), 
	FOREIGN KEY("FieldID") REFERENCES "TestSuiteSampleFields" ("ID")
);
CREATE TABLE "compile_FieldChange" (
	"ID" INTEGER PRIMARY KEY NOT NULL, 
	"StartOrderID" INTEGER, 
	"EndOrderID" INTEGER, 
	"TestID" INTEGER, 
	"MachineID" INTEGER, 
	"FieldID" INTEGER, 
	FOREIGN KEY("StartOrderID") REFERENCES "compile_Order" ("ID"), 
	FOREIGN KEY("EndOrderID") REFERENCES "compile_Order" ("ID"), 
	FOREIGN KEY("TestID") REFERENCES "compile_Test" ("ID"), 
	FOREIGN KEY("MachineID") REFERENCES "compile_Machine" ("ID"), 
	FOREIGN KEY("FieldID") REFERENCES "TestSuiteSampleFields" ("ID")
);
CREATE INDEX "ix_TestSuiteRunFields_TestSuiteID" ON "TestSuiteRunFields" ("TestSuiteID");
CREATE INDEX "ix_TestSuiteOrderFields_TestSuiteID" ON "TestSuiteOrderFields" ("TestSuiteID");
CREATE INDEX "ix_TestSuiteSampleFields_TestSuiteID" ON "TestSuiteSampleFields" ("TestSuiteID");
CREATE INDEX "ix_TestSuiteMachineFields_TestSuiteID" ON "TestSuiteMachineFields" ("TestSuiteID");
CREATE INDEX "ix_NT_Machine_Name" ON "NT_Machine" ("Name");
CREATE INDEX "ix_NT_Run_MachineID" ON "NT_Run" ("MachineID");
CREATE INDEX "ix_NT_Run_OrderID" ON "NT_Run" ("OrderID");
CREATE INDEX "ix_NT_Sample_RunID_TestID" ON "NT_Sample" ("RunID", "TestID");
CREATE INDEX "ix_NT_Sample_TestID" ON "NT_Sample" ("TestID");
CREATE INDEX "ix_compile_Machine_Name" ON "compile_Machine" ("Name");
CREATE INDEX "ix_compile_Run_MachineID" ON "compile_Run" ("MachineID");
CREATE INDEX "ix_compile_Run_OrderID" ON "compile_Run" ("OrderID");
CREATE INDEX "ix_compile_Sample_TestID" ON "compile_Sample" ("TestID");
CREATE INDEX "ix_compile_Sample_RunID_TestID" ON "compile_Sample" ("RunID", "TestID");
CREATE UNIQUE INDEX "ix_NT_Machine_Unique" ON "NT_Machine" ("Name", "Parameters", hardware, os);
CREATE UNIQUE INDEX "ix_NT_Test_Name" ON "NT_Test" ("Name");
CREATE UNIQUE INDEX "ix_compile_Machine_Unique" ON "compile_Machine" ("Name", "Parameters", hardware, os_version);
CREATE UNIQUE INDEX "ix_compile_Test_Name" ON "compile_Test" ("Name");
COMMIT;
