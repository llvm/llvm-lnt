__author__ = 'Daniel Dunbar'
__email__ = 'daniel@zuster.org'
__versioninfo__ = (0, 4, 2)
__version__ = '.'.join(map(str, __versioninfo__)) + '.dev0'

# lnt module is imported from the setup script before modules are installed so
# modules might not be available.
try:
    from typing import Sequence
except Exception:
    pass

__all__ = []  # type: Sequence[str]
