# RUN: python %s

import unittest
import logging
import sys
import copy
import tempfile
import io
from lnt.testing.profile.profilev1impl import ProfileV1
from lnt.testing.profile.profile import Profile

logging.basicConfig(level=logging.DEBUG)


class ProfileV1Test(unittest.TestCase):
    def setUp(self):
        self.test_data = {
            'counters': {'cycles': 12345.0, 'branch-misses': 200.0},
            'disassembly-format': 'raw',
            'functions': {
                'fn1': {
                    'counters': {'cycles': 45.0, 'branch-misses': 10.0},
                    'data': [
                        [{}, 0x100000, 'add r0, r0, r0'],
                        [{'cycles': 100.0}, 0x100004, 'sub r1, r0, r0']
                    ]
                }
            }
        }

    def test_serialize(self):
        p = ProfileV1(copy.deepcopy(self.test_data))
        with tempfile.NamedTemporaryFile() as f:
            p.serialize(f.name)
            self.assertTrue(ProfileV1.checkFile(f.name))

    def test_deserialize(self):
        p = ProfileV1(copy.deepcopy(self.test_data))
        s = p.serialize()
        fobj = io.BytesIO(s)
        p2 = ProfileV1.deserialize(fobj)

        self.assertEqual(p2.data, self.test_data)

    def test_getFunctions(self):
        p = ProfileV1(copy.deepcopy(self.test_data))
        self.assertEqual(p.getFunctions(),
                         {'fn1': {'counters': {'cycles': 45.0, 'branch-misses': 10.0},
                                  'length': 2}})

    def test_saveFromRendered(self):
        p = ProfileV1(copy.deepcopy(self.test_data))
        s = Profile(p).render()

        with tempfile.NamedTemporaryFile() as f:
            Profile.saveFromRendered(s, filename=f.name)
            with open(f.name, 'rb') as f2:
                p2 = ProfileV1.deserialize(f2)

        self.assertEqual(p2.data, self.test_data)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])
