# Check the 'lnt.testing.utils.compilers' version sniffing code.
#
# RUN: python %s %{shared_inputs}/FakeCompilers

import logging
import os
import pprint
import sys

import lnt.testing.util.compilers

basedir = sys.argv[1]

logging.basicConfig(level=logging.DEBUG)

def get_info(name):
    logging.info("checking compiler: %r", name)
    return lnt.testing.util.compilers.get_cc_info(
        os.path.join(basedir, name))

# Check icc.
info = get_info("icc-12.1.3")
pprint.pprint(info)
assert info['cc_name'] == 'icc'
assert info['cc_build'] == 'PROD'
assert info['cc_target'] == 'i686-apple-darwin11'
assert info['inferred_run_order'] == '12.1.3'

# Check a random Clang from SVN.
info = get_info("clang-r154331")
pprint.pprint(info)
assert info['cc_name'] == 'clang'
assert info['cc_build'] == 'DEV'
assert info['inferred_run_order'] == '154331'

# Check an Apple Clang.
info = get_info("apple-clang-138.1")
pprint.pprint(info)
assert info['cc_name'] == 'apple_clang'
assert info['cc_build'] == 'PROD'
assert info['inferred_run_order'] == '138.1'

# Check a Clang built from git repositories.
info = get_info("clang-git")
pprint.pprint(info)
assert info['cc_name'] == 'clang'
assert info['cc_build'] == 'DEV'
assert info['inferred_run_order'] == '%s,%s' % (
    '37ce0feee598d82e7220fa0a4b110619cae6ea72',
    '60fca4f64e697ad834ce7ee8c2e478cae394c7dc')

info = get_info("clang-git-2")
pprint.pprint(info)
assert info['cc_name'] == 'clang'
assert info['cc_build'] == 'DEV'
assert info['inferred_run_order'] == '%s,%s' % (
    '8ab09316f63ea99ff23b2684c454b1008b8d5f10',
    '7c53f795961cc2d35b85d315aadb2ac135a0fdb2')

# Check a Clang that prints no info.
info = get_info("clang-no-info")
pprint.pprint(info)
assert info['cc_name'] == 'clang'
assert info['cc_version_number'] == '3.2'
