# Check that we can import the profiles in a report written by
# `lnt runtest test-suite`, which are in version 2 of the profile format.
#
# RUN: rm -rf %t.install
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.install \
# RUN:         %{shared_inputs}/test-suite-report.json \
# RUN:         -- python %s %t.install

import sys
import glob
from lnt.testing.profile.profilev2impl import ProfileV2

profile = glob.glob('%s/data/profiles/*.lntprof' % sys.argv[1])[0]
assert ProfileV2.checkFile(profile)
