# Check that we can import profiles into a test DB
#
# We first construct a temporary LNT instance.
# RUN: rm -rf %t.install
# RUN: lnt create %t.install

# Import the test set
# RUN: lnt import %t.install %S/Inputs/profile-report.json \
# RUN:   --show-sample-count > %t2.log
# RUN: ls %t.install/data/profiles
# RUN: python %s %t.install

import os, sys, glob
from lnt.testing.profile.profilev1impl import ProfileV1

profile = glob.glob('%s/data/profiles/*.lntprof' % sys.argv[1])[0]
assert ProfileV1.checkFile(profile)
