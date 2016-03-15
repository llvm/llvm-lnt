from lnt.testing.profile.profile import ProfileImpl
import cPickle, zlib

class ProfileV1(ProfileImpl):
    """
ProfileV1 files not clever in any way. They are simple Python objects with
the profile data layed out in the most obvious way for production/consumption
that are then pickled and compressed.

They are expected to be created by simply storing into the self.data member.

The self.data member has this format:

{
 counters: {'cycles': 12345.0, 'branch-misses': 200.0}, # Counter values are absolute.
 disassembly-format: 'raw',
 functions: {
   name: {
     counters: {'cycles': 45.0, ...}, # Note counters are now percentages.
     data: [
       [463464, {'cycles': 23.0, ...}, '\tadd r0, r0, r1'}],
       ...
     ]
   }
  }
}
    """

    def __init__(self, data):
        """
        Create from a raw data dict. data has the format given in the class docstring.
        """
        self.data = data
    
    @staticmethod
    def upgrade(old):
        raise RuntimeError("Cannot upgrade to version 1!")

    @staticmethod
    def checkFile(fn):
        # "zlib compressed data" - 78 9C
        return open(fn).read(2) == '\x78\x9c'

    @staticmethod
    def deserialize(fobj):
        o = zlib.decompress(fobj.read())
        data = cPickle.loads(o)
        return ProfileV1(data)

    def serialize(self, fname=None):
        obj = cPickle.dumps(self.data)
        compressed_obj = zlib.compress(obj)

        if fname is None:
            return bytes(compressed_obj)
        else:
            with open(fname, 'w') as fd:
                fd.write(compressed_obj)

    def getVersion(self):
        return 1

    def getTopLevelCounters(self):
        return self.data['counters']

    def getDisassemblyFormat(self):
        if 'disassembly-format' in self.data:
            return self.data['disassembly-format']
        return 'raw'
    
    def getFunctions(self):
        d = {}
        for fn in self.data['functions']:
            f = self.data['functions'][fn]
            d[fn] = dict(counters=f.get('counters', {}),
                         length=len(f.get('data', [])))
        return d

    def getCodeForFunction(self, fname):
        for l in self.data['functions'][fname].get('data', []):
            yield (l[0], l[1], l[2])
