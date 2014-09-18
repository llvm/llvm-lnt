# Fake makefile

include Makefile.config

tools:
	echo "This is a fake tools build."

report:
	echo "This is a fake report build."
.PHONY: report

report.simple.csv: report
	cp ${PROJ_SRC_ROOT}/fake-report.simple.csv $@
