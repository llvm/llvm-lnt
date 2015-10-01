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
INSERT INTO "NT_Test" VALUES(88,'test1');
INSERT INTO "NT_Test" VALUES(89,'test2');
INSERT INTO "NT_Order" ("NextOrder", "PreviousOrder", "llvm_project_revision")
 VALUES(NULL,NULL,'152292'); -- ID 5
INSERT INTO "NT_Run" ("MachineID", "OrderID", "ImportedFrom", "StartTime",
                      "EndTime", "SimpleRunID", "Parameters")
 VALUES(2,5,'run5.json','2012-05-01 16:28:23.000000',
        '2012-05-01 16:28:58.000000',NULL,'[]'); -- ID 5
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(5,88,0,0,0.001,1.0,NULL,NULL); -- ID 5: passing result
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(5,89,0,1,0.001,1.0,NULL,NULL); -- ID 6: failing result
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
 VALUES(6,88,0,0,0.001,10.0,NULL,NULL); -- ID 7: passing result 10x slower
INSERT INTO "NT_Sample" ("RunID", "TestID", "compile_status",
                         "execution_status", "compile_time", "execution_time",
                         "score", "mem_bytes")
 VALUES(5,89,0,0,0.001,1.0,NULL,NULL); -- ID 8: passing result

COMMIT;
