# This is the profile implementation registry. Register new profile implementations here.

from profilev1impl import ProfileV1
from profilev2impl import ProfileV2
IMPLEMENTATIONS = {1: ProfileV1, 2: ProfileV2}
