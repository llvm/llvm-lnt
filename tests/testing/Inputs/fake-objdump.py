import sys


def exit_with_fake_output(suffix):
    fname = '%s.%s' % (sys.argv[1], suffix)
    with open(fname) as f:
        sys.stdout.write(f.read())
    sys.exit(0)


for arg in sys.argv:
    if arg.startswith('--start-address'):
        addr = arg.split('=')[1]
        exit_with_fake_output('%s.out' % addr)

    if arg.startswith('-t'):
        exit_with_fake_output('out')

    if arg.startswith('-p'):
        exit_with_fake_output('p.out')

sys.exit(1)
