# RUN: rm -rf %t.install
# RUN: lnt create %t.install

# Import a test set.
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --commit --show-sample-count

# Check that we remove both the sample and the run, and that we don't commit by
# default.
#
# RUN: lnt updatedb %t.install --testsuite nts \
# RUN:     --commit --delete-run 1 --show-sql > %t.out
# RUN: FileCheck --check-prefix CHECK-RUNRM %s < %t.out

# CHECK-RUNRM: DELETE FROM "NT_Sample" WHERE "NT_Sample"."ID" = ?
# CHECK-RUNRM-NEXT: ((1,), (2,))
# CHECK-RUNRM: DELETE FROM "NT_Run" WHERE "NT_Run"."ID" = ?
# CHECK-RUNRM-NEXT: (1,)
# CHECK-RUNRM: COMMIT

# Check that we remove runs when we remove a machine.
#
# RUN: rm -rf %t.install
# RUN: lnt create %t.install
# RUN: lnt import %t.install %{shared_inputs}/sample-a-small.plist \
# RUN:     --commit --show-sample-count
# RUN: lnt updatedb %t.install --testsuite nts \
# RUN:     --delete-machine "LNT SAMPLE MACHINE" --commit --show-sql > %t.out
# RUN: FileCheck --check-prefix CHECK-MACHINERM %s < %t.out

# CHECK-MACHINERM: DELETE FROM "NT_Sample" WHERE "NT_Sample"."ID" = ?
# CHECK-MACHINERM-NEXT: ((1,), (2,))
# CHECK-MACHINERM: DELETE FROM "NT_Run" WHERE "NT_Run"."ID" = ?
# CHECK-MACHINERM-NEXT: (1,)
# CHECK-MACHINERM: DELETE FROM "NT_Machine" WHERE "NT_Machine"."ID" = ?
# CHECK-MACHINERM-NEXT: (1,)
# CHECK-MACHINERM: COMMIT
