# Fake test-suite Makefile for rerun tests.
#
# Support the targets needed for doing a rerun.  Those are the original report
# then the rerun of each of the rerun reports.

include Makefile.config

MS_STRUCT := ms_struct-bitfield
STRUCT_LAYOUT := ms_struct_pack_layout-1
VLA := vla

ALL_BENCHES = Output/$(MS_STRUCT).simple.report.txt \
    Output/$(STRUCT_LAYOUT).simple.report.txt \
    Output/$(VLA).simple.report.txt

tools:
	@echo "This is a fake tools build."

report: $(ALL_BENCHES)
	echo "AB: $(ALL_BENCHES)"
	@echo "This is a fake report build too."
	touch report.simple.txt
	touch report.simple.raw.out

.PHONY: report

report.simple.csv: report
	cp ${PROJ_SRC_ROOT}/fake-report.simple.csv $@

Output/%.simple.report.txt:
	mkdir -p Output
	touch Output/$*.out-simple
	cp ${PROJ_SRC_ROOT}/$@ $@
