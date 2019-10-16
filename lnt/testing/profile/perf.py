from lnt.util import logger
from .profile import ProfileImpl
from .profilev1impl import ProfileV1

import os
import traceback
import glob

try:
    from . import cPerf  # type: ignore  # mypy cannot process Cython modules
except Exception:
    pass


def merge_recursively(dct1, dct2):
    # type: (dict, dict) -> None
    """Add the content of dct2 to dct1.
    :param dct1: merge to.
    :param dct2: merge from.
    """
    for k, v in dct2.items():
        if k in dct1:
            if isinstance(dct1[k], dict) and isinstance(v, dict):
                merge_recursively(dct1[k], v)
            elif isinstance(dct1[k], list) and isinstance(v, list):
                dct1[k].extend(v)
            else:
                raise TypeError("Values for the key {} must be the same type (dict or list), "
                                "but got {} and {}".format(k, type(dct1[k]), type(v)))
        else:
            dct1[k] = v


class LinuxPerfProfile(ProfileImpl):
    def __init__(self):
        pass

    @staticmethod
    def checkFile(fn):
        with open(fn, 'rb') as f:
            return f.read(8) == b'PERFILE2'

    @staticmethod
    def deserialize(f, objdump='objdump', propagateExceptions=False,
                    binaryCacheRoot=''):
        f = f.name

        if os.path.getsize(f) == 0:
            # Empty file - exit early.
            return None

        try:
            data = {}
            for fname in glob.glob("%s*" % f):
                cur_data = cPerf.importPerf(fname, objdump, binaryCacheRoot)
                merge_recursively(data, cur_data)

            # Go through the data and convert counter values to percentages.
            for f in data['functions'].values():
                fc = f['counters']
                for inst_info in f['data']:
                    for k, v in inst_info[0].items():
                        inst_info[0][k] = 100.0 * float(v) / fc[k]
                for k, v in fc.items():
                    fc[k] = 100.0 * v / data['counters'][k]

            return ProfileV1(data)

        except Exception:
            if propagateExceptions:
                raise
            logger.warning(traceback.format_exc())
            return None
