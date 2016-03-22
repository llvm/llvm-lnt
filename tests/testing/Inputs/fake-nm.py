import os, sys

if '--fake-nm-be-non-dynamic' in sys.argv:
    if '-D' in sys.argv:
        sys.exit(0)

sys.stdout.write(open(sys.argv[1]).read())
