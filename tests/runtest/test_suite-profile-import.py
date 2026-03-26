# Check importing test-suite profiles into db
# RUN: rm -rf %t.SANDBOX
# RUN: lnt runtest test-suite \
# RUN:     --sandbox %t.SANDBOX \
# RUN:     --no-timestamp \
# RUN:     --test-suite %S/Inputs/test-suite-cmake \
# RUN:     --cc %{shared_inputs}/FakeCompilers/clang-r154331 \
# RUN:     --use-cmake %S/Inputs/test-suite-cmake/fake-cmake \
# RUN:     --use-make %S/Inputs/test-suite-cmake/fake-make \
# RUN:     --use-lit %S/Inputs/test-suite-cmake/fake-lit-profile-import \
# RUN:     --use-perf=all \
# RUN:     -j2 \
# RUN:     --verbose \
# RUN:     > %t.log 2> %t.err
# RUN: rm -rf %t.DB
# RUN: %{utils}/with_postgres.sh %t.pg.log \
# RUN:     %{utils}/with_temporary_instance.py %t.DB \
# RUN:         %t.SANDBOX/build/report.json \
# RUN:         -- python %s %t.DB

import sys
import glob
from lnt.testing.profile.profilev2impl import ProfileV2

profile = glob.glob('%s/data/profiles/*.lntprof' % sys.argv[1])[0]
assert ProfileV2.checkFile(profile)
