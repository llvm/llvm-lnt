import os, sys

for a in sys.argv:
    if a.startswith('--start-address'):
        addr = a.split('=')[1]
        
        fname = '%s.%s.out' % (sys.argv[1], addr)
        sys.stdout.write(open(fname).read())
        sys.exit(0)
        
sys.exit(1)
