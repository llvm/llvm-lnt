import base64
import lnt.testing.profile
import os
import tempfile


class Profile(object):
    """Profile objects hold a performance profile.

    The Profile class itself is a thin wrapper around a ProfileImpl
    object, which is what actually holds, reads, writes and dispenses
    the profile information.
    """
    # Import this late to avoid a cyclic dependency
    import lnt.testing.profile

    def __init__(self, impl):
        """Internal constructor. Users should not call this; use fromFile or
        fromRendered."""
        assert isinstance(impl, ProfileImpl)
        self.impl = impl

    @staticmethod
    def fromFile(f, objdump=None):
        """
        Load a profile from a file.
        """
        if objdump is None:
            objdump = os.getenv("CMAKE_OBJDUMP", "objdump")
        for impl in lnt.testing.profile.IMPLEMENTATIONS.values():
            if impl.checkFile(f):
                ret = None
                with open(f, 'rb') as fd:
                    if impl is lnt.testing.profile.perf.LinuxPerfProfile:
                        ret = impl.deserialize(
                            fd,
                            objdump,
                            binaryCacheRoot=os.getenv('LNT_BINARY_CACHE_ROOT', ''))
                    else:
                        ret = impl.deserialize(fd)
                if ret:
                    return Profile(ret)
                else:
                    return None
        raise RuntimeError('No profile implementations could read this file!')

    @staticmethod
    def fromRendered(s):
        """
        Load a profile from a string, which must have been produced
        with Profile.render(). The format of this is not the same as the
        on-disk format; it is base64 encoded to survive wire transfer.
        """
        s = base64.b64decode(s)
        with tempfile.NamedTemporaryFile() as fd:
            fd.write(s)
            # Rewind to beginning.
            fd.flush()
            fd.seek(0)

            for impl in lnt.testing.profile.IMPLEMENTATIONS.values():
                if impl.checkFile(fd.name):
                    ret = impl.deserialize(fd)
                    if ret:
                        return Profile(ret)
                    else:
                        return None
        raise RuntimeError('No profile implementations could read this file!')

    @staticmethod
    def saveFromRendered(s, filename=None, profileDir=None, prefix=''):
        """
        Load a profile from a string, which must have been produced
        with Profile.render(), and save it immediately in filename.

        This is equivalent to Profile.fromRendered(s).save(filename=filename)
        but it avoids the intermediate deserialize/serialize steps.
        """
        s = base64.b64decode(s)

        if not filename:
            assert profileDir is not None
            if not os.path.exists(profileDir):
                os.makedirs(profileDir)
            tf = tempfile.NamedTemporaryFile(prefix=prefix,
                                             suffix='.lntprof',
                                             dir=profileDir,
                                             delete=False)
            tf.write(s)
            return tf.name

        else:
            with open(filename, 'wb') as f:
                f.write(s)
            return filename

    def save(self, filename=None, profileDir=None, prefix=''):
        """
        Save a profile. One of 'filename' or 'profileDir' must be given.
          - If 'filename' is given, that is where the profile is saved.
          - If 'profileDir' is given, a new unique filename is created
            inside 'profileDir', optionally with 'prefix'.

        The filename written to is returned.
        """
        if filename:
            self.impl.serialize(filename)
            return filename

        assert profileDir is not None
        if not os.path.exists(profileDir):
            os.makedirs(profileDir)
        tf = tempfile.NamedTemporaryFile(prefix=prefix,
                                         suffix='.lntprof',
                                         dir=profileDir,
                                         delete=False)
        self.impl.serialize(tf.name)

        # FIXME: make the returned filepath relative to baseDir?
        return os.path.relpath(tf.name, profileDir)

    def render(self):
        """
        Return a string representing this profile suitable for storing inside a
        JSON object.

        Implementation note: the string is base64 encoded.
        """
        return base64.b64encode(self.impl.serialize()).decode('ascii')

    def upgrade(self):
        """
        Upgrade to the latest implementation version.

        Returns self.
        """
        while True:
            version = self.impl.getVersion()
            new_version = version + 1
            if new_version not in lnt.testing.profile.IMPLEMENTATIONS:
                return self
            new_impl = lnt.testing.profile.IMPLEMENTATIONS[new_version]
            self.impl = new_impl.upgrade(self.impl)

    #
    # ProfileImpl facade - see ProfileImpl documentation below.
    #

    def getVersion(self):
        return self.impl.getVersion()

    def getTopLevelCounters(self):
        return self.impl.getTopLevelCounters()

    def getDisassemblyFormat(self):
        return self.impl.getDisassemblyFormat()

    def getFunctions(self):
        return self.impl.getFunctions()

    def getCodeForFunction(self, fname):
        return self.impl.getCodeForFunction(fname)


class ProfileImpl(object):
    @staticmethod
    def upgrade(old):
        """
        Takes a previous profile implementation in 'old' and returns a new
        ProfileImpl for this version. The only old version that must be
        supported is the immediately prior version (e.g. version 3 only has to
        handle upgrades from version 2.
        """
        raise NotImplementedError("Abstract class")

    @staticmethod
    def checkFile(fname):
        """
        Return True if 'fname' is a serialized version of this profile
        implementation.
        """
        raise NotImplementedError("Abstract class")

    @staticmethod
    def deserialize(fobj):
        """
        Reads a profile from 'fobj', returning a new profile object. This can
        be lazy.
        """
        raise NotImplementedError("Abstract class")

    def serialize(self, fname=None):
        """
        Serializes the profile to the given filename (base). If fname is None,
        returns as a bytes instance.
        """
        raise NotImplementedError("Abstract class")

    def getVersion(self):
        """
        Return the profile version.
        """
        raise NotImplementedError("Abstract class")

    def getTopLevelCounters(self):
        """
        Return a dict containing the counters for the entire profile. These
        will be absolute numbers: ``{'cycles': 5000.0}`` for example.
        """
        raise NotImplementedError("Abstract class")

    def getDisassemblyFormat(self):
        """
        Return the format for the disassembly strings returned by
        getCodeForFunction().  Possible values are:

        * ``raw``                   - No interpretation available;
                                      pure strings.
        * ``marked-up-disassembly`` - LLVM marked up disassembly format.
        """
        raise NotImplementedError("Abstract class")

    def getFunctions(self):
        """
        Return a dict containing function names to information about that
        function.

        The information dict contains:

        * ``counters`` - counter values for the function.
        * ``length`` - number of times to call getCodeForFunction to obtain all
          instructions.

        The dict should *not* contain disassembly / function contents.
        The counter values must be percentages, not absolute numbers.

        E.g.::

          {'main': {'counters': {'cycles': 50.0, 'branch-misses': 0},
                    'length': 200},
           'dotest': {'counters': {'cycles': 50.0, 'branch-misses': 0},
                      'length': 4}
          }
        """
        raise NotImplementedError("Abstract class")

    def getCodeForFunction(self, fname):
        """
        Return a *generator* which will return, for every invocation, a
        three-tuple::

          (counters, address, text)

        Where counters is a dict : (e.g.) ``{'cycles': 50.0}``, text is in the
        format as returned by getDisassemblyFormat(), and address is an
        integer.

        The counter values must be percentages (of the function total), not
        absolute numbers.
        """
        raise NotImplementedError("Abstract class")
