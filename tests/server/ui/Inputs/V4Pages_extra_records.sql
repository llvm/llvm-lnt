BEGIN TRANSACTION;
INSERT INTO "NT_Test" VALUES(87,'SingleSource/UnitTests/ObjC/block-byref-aggr');
INSERT INTO "compile_Test" VALUES(38,'compile/403.gcc/combine.c/init/(-O0)');
-- make sure there are 3 machines - to test ?filter-machine-regex= on daily_report page
INSERT INTO "NT_Machine" VALUES(2,'machine2','[]','AArch64','linux');
UPDATE "NT_Order" SET "NextOrder" = 5 WHERE "ID" = 4;
INSERT INTO "NT_Order" VALUES(5,4,6,'152290');
INSERT INTO "NT_Run" VALUES(3,2,5,'run3.json','2012-04-11 16:28:23.000000','2012-04-11 16:28:58.000000',NULL,'[]');
INSERT INTO "NT_Sample" VALUES(3,3,1,NULL,NULL,0.001,0.0001,NULL);
INSERT INTO "NT_Machine" VALUES(3,'machine3','[]','AArch64','linux');
INSERT INTO "NT_Order" VALUES(6,5,NULL,'152291');
INSERT INTO "NT_Run" VALUES(4,3,6,'run4.json','2012-04-11 16:28:24.000000','2012-04-11 16:28:59.000000',NULL,'[]');
INSERT INTO "NT_Sample" VALUES(4,4,1,NULL,NULL,0.001,0.0001,NULL);
COMMIT;
