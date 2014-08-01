# RUN: rm -rf %t.install
# RUN: dropdb --if-exists testdb
# RUN: createdb testdb

# RUN: lnt create %t.install --db-dir postgresql://localhost/ --default-db testdb

# Import a test set.
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --commit=1 --show-sample-count

# Import a test set.
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --commit=1 --show-sample-count

# Check that we remove both the sample and the run, and that we don't commit by
# default.
#
# RUN: lnt updatedb %t.install --testsuite nts \
# RUN:     --delete-run 1 --show-sql > %t.out
# RUN: FileCheck --check-prefix CHECK-RUNRM %s < %t.out

# CHECK-RUNRM: DELETE FROM "NT_Sample" WHERE "NT_Sample"."RunID" IN (%(RunID_1)s)
# CHECK-RUNRM-NEXT: {'RunID_1': 1}
# CHECK-RUNRM: DELETE FROM "NT_Run" WHERE "NT_Run"."ID" IN (%(ID_1)s)
# CHECK-RUNRM-NEXT: {'ID_1': 1}
# CHECK-RUNRM: ROLLBACK

# Check that we remove runs when we remove a machine.
#
# RUN: lnt updatedb %t.install --testsuite nts \
# RUN:     --delete-machine "LNT SAMPLE MACHINE" --commit=1 --show-sql > %t.out
# RUN: FileCheck --check-prefix CHECK-MACHINERM %s < %t.out

# CHECK-MACHINERM: DELETE FROM "NT_Sample" WHERE "NT_Sample"."RunID" IN (%(RunID_1)s)
# CHECK-MACHINERM-NEXT: {'RunID_1': 1}
# CHECK-MACHINERM: DELETE FROM "NT_Run" WHERE "NT_Run"."ID" IN (%(ID_1)s)
# CHECK-MACHINERM-NEXT: {'ID_1': 1}
# CHECK-MACHINERM: DELETE FROM "NT_Machine" WHERE "NT_Machine"."Name" = %(Name_1)s
# CHECK-MACHINERM-NEXT: {'Name_1': 'LNT SAMPLE MACHINE'}
# CHECK-MACHINERM: COMMIT

# REQUIRES: postgres
