# RUN: python %s
import unittest, logging, sys, copy, tempfile, io
from lnt.testing.profile.profilev2impl import ProfileV2
from lnt.testing.profile.profilev1impl import ProfileV1


logging.basicConfig(level=logging.DEBUG)

class ProfileV2Test(unittest.TestCase):
    def setUp(self):
        self.test_data = {
            'counters': {'cycles': 12345.0, 'branch-misses': 200.0},
            'disassembly-format': 'raw',
            'functions': {
                'fn1': {
                    'counters': {'cycles': 45.0, 'branch-misses': 10.0},
                    'data': [
                        ({'branch-misses': 0.0, 'cycles': 0.0}, 0x100000, 'add r0, r0, r0'),
                        ({'branch-misses': 0.0, 'cycles': 100.0}, 0x100004, 'sub r1, r0, r0')
                    ]
                }
            }
        }

    def test_serialize(self):
        p = ProfileV2.upgrade(ProfileV1(copy.deepcopy(self.test_data)))
        with tempfile.NamedTemporaryFile() as f:
            s = p.serialize(f.name)
            self.assertTrue(ProfileV2.checkFile(f.name))

    def test_deserialize(self):
        p = ProfileV2.upgrade(ProfileV1(copy.deepcopy(self.test_data)))
        s = p.serialize()
        fobj = io.BytesIO(s)
        p2 = ProfileV2.deserialize(fobj)

        l = list(p2.getCodeForFunction('fn1'))
        l2 = self.test_data['functions']['fn1']['data']
        self.assertEqual(l, l2)

    def test_getFunctions(self):
        p = ProfileV2.upgrade(ProfileV1(copy.deepcopy(self.test_data)))
        self.assertEqual(p.getFunctions(),
                         {'fn1': {'counters': {'cycles': 45.0, 'branch-misses': 10.0},
                                  'length': 2}})
        
if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], ])
