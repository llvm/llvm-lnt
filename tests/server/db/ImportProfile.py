# Check that we can import profiles into a test DB
#
# We first construct a temporary LNT instance.
# RUN: rm -rf %t.install
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.install \
# RUN:         %{shared_inputs}/profile-report.json \
# RUN:         -- python %s %t.install

import sys
import glob
from lnt.testing.profile.profilev1impl import ProfileV1

profile = glob.glob('%s/data/profiles/*.lntprof' % sys.argv[1])[0]
assert ProfileV1.checkFile(profile)
