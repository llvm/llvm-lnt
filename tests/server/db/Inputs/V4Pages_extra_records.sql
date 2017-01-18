BEGIN TRANSACTION;
INSERT INTO "NT_Test" ("Name")
 VALUES('SingleSource/UnitTests/ObjC/block-byref-aggr'); -- ID 3 (was 87)
INSERT INTO "compile_Test" ("Name")
 VALUES('compile/403.gcc/combine.c/init/(-O0)'); -- ID 3 (was 38)
 
-- make sure there are 3 machines - to test ?filter-machine-regex= on daily_report page
INSERT INTO "NT_Machine" ("Name", "Parameters", "hardware", "os")
 VALUES('machine2','[]','AArch64','linux'); -- ID 2
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(2,NULL,'152290'); -- ID 3
UPDATE "NT_Order" SET "NextOrder" = 3 WHERE "ID" = 2;
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,3,'run3.json','2012-04-11 16:28:23.000000',
        '2012-04-11 16:28:58.000000',NULL,'[]'); -- ID 3
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(3,1,NULL,NULL,0.001,0.0001,NULL,NULL); -- ID 3
INSERT INTO "NT_Machine" ("Name", "Parameters", "hardware", "os")
 VALUES('machine3','[]','AArch64','linux'); -- ID 3
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(3,NULL,'152291'); -- ID 4
UPDATE "NT_Order" SET "PreviousOrder" = 4 WHERE "ID" = 3;
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters") 
 VALUES(3,4,'run4.json','2012-04-11 16:28:24.000000',
        '2012-04-11 16:28:59.000000',NULL,'[]'); -- ID 4
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(4,1,NULL,NULL,0.001,0.0001,NULL,NULL); -- ID 4
 
-- check that a regression on consecutive runs more than 1 day apart can be detected:
INSERT INTO "NT_Test" VALUES(4,'test1'); -- ID 4
INSERT INTO "NT_Test" VALUES(5,'test2'); -- ID 5
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(NULL,NULL,'152292'); -- ID 5
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,5,'run5.json','2012-05-01 16:28:23.000000',
        '2012-05-01 16:28:58.000000',NULL,'[]'); -- ID 5
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(5,4,0,0,0.001,1.0,NULL,NULL); -- ID 5: passing result
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(5,5,0,1,0.001,1.0,NULL,NULL); -- ID 6: failing result
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(5,NULL,'152293'); -- ID 6
UPDATE "NT_Order" SET "PreviousOrder" = 6 WHERE "ID" = 5;
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,6,'run6.json','2012-05-03 16:28:24.000000',
        '2012-05-03 16:28:59.000000',NULL,'[]'); -- ID 6
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(6,4,0,0,0.001,10.0,NULL,NULL); -- ID 7: passing result 10x slower
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(5,5,0,0,0.001,1.0,NULL,NULL); -- ID 8: passing result

-- check that a failing test result does not show up in the sparkline
INSERT INTO "NT_Test" VALUES(6,'test6'); -- ID 6
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(NULL,NULL,'152294'); -- ID 6
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(NULL,NULL,'152295'); -- ID 7
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(NULL,NULL,'152296'); -- ID 8
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,6,'run7.json','2012-05-10 16:28:23.000000',
        '2012-05-10 16:28:58.000000',NULL,'[]'); -- ID 7
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,7,'run8.json','2012-05-11 16:28:23.000000',
        '2012-05-11 16:28:58.000000',NULL,'[]'); -- ID 8
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,8,'run9.json','2012-05-12 16:28:23.000000',
        '2012-05-12 16:28:58.000000',NULL,'[]'); -- ID 9
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(7,6,0,0,0.001,1.0,NULL,NULL); -- ID 9: passing result
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(8,6,0,1,0.001,1.0,NULL,NULL); -- ID 10: failing result
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(9,6,0,0,0.001,1.2,NULL,NULL); -- ID 11: passing result; 20% bigger,
                                      -- so shown in daily report page.

-- check background colors being produced correctly, corresponding to recorded
-- hashes of the binary.
INSERT INTO "NT_Test" VALUES(7,'test_hash1'); -- ID 7
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(7,7,0,0,0.001,1.0,NULL,NULL,0,'hash1'); -- ID 11: hash1
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(8,7,0,0,0.001,1.0,NULL,NULL,NULL,NULL); -- ID 12: no hash
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(9,7,0,0,0.001,1.2,NULL,NULL,0,'hash2'); -- ID 13: hash2; 20% bigger,
                                      -- so shown in daily report page.

INSERT INTO "NT_Test" VALUES(8,'test_hash2'); -- ID 8
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(7,8,0,0,0.001,1.0,NULL,NULL,0,'hash1'); -- ID 14: hash1
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(8,8,0,0,0.001,1.0,NULL,NULL,0,'hash2'); -- ID 15: hash2
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(9,8,0,0,0.001,1.2,NULL,NULL,0,'hash1'); -- ID 16: hash1; 20% bigger,
                                      -- so shown in daily report page.

INSERT INTO "NT_Test" VALUES(9,'test_mhash_on_run'); -- ID 9
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(7,9,0,0,0.001,1.0,NULL,NULL,0,'hash1'); -- ID 15: hash1
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(7,9,0,0,0.001,1.0,NULL,NULL,0,'hash2'); -- ID 16: hash2, same day
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(8,9,0,0,0.001,1.0,NULL,NULL,1,NULL); -- ID 17: no hash the next day
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes", "hash_status", "hash")
 VALUES(9,9,0,0,0.001,1.2,NULL,NULL,0,'hash3'); -- ID 18: hash3; 20% bigger,
                                      -- so shown in daily report page.


COMMIT;
