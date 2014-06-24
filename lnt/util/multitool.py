import os
import sys

class MultiTool(object):
    """
    This object defines a generic command line tool instance, which dynamically
    builds its commands from a module dictionary.

    Example usage::

      import multitool

      def action_foo(name, args):
          "the foo command"

          ... 

      tool = multitool.MultiTool(locals())
      if __name__ == '__main__':
        tool.main(sys.argv)

    Any function beginning with "action_" is considered a tool command. It's
    name is defined by the function name suffix. Underscores in the function
    name are converted to '-' in the command line syntax. Actions ending ith
    "-debug" are not listed in the help.
    """

    def __init__(self, locals, version=None):
        self.version = version

        # Create the list of commands.
        self.commands = dict((name[7:].replace('_','-'), f)
                             for name,f in locals.items()
                             if name.startswith('action_'))

    def usage(self, name):
        print >>sys.stderr, "Usage: %s <command> [options] ... arguments ..." %(
            os.path.basename(name),)
        print >>sys.stderr
        print >>sys.stderr, """\
Use ``%s <command> --help`` for more information on a specific command.\n""" % (
            os.path.basename(name),)
        print >>sys.stderr, "Available commands:"
        cmds_width = max(map(len, self.commands))
        for name,func in sorted(self.commands.items()):
            if name.endswith("-debug"):
                continue

            print >>sys.stderr, "  %-*s - %s" % (cmds_width, name, func.__doc__)
        sys.exit(1)

    def main(self, args=None):
        if args is None:
            args = sys.argv

        progname = os.path.basename(args.pop(0))

        # Parse immediate command line options.
        while args and args[0].startswith("-"):
            option = args.pop(0)
            if option in ("-h", "--help"):
                self.usage(progname)
            elif option in ("-v", "--version") and self.version is not None:
                print self.version
                return
            else:
                print >>sys.stderr, "error: invalid option %r\n" % (option,)
                self.usage(progname)

        if not args:
            self.usage(progname)

        cmd = args.pop(0)
        if cmd not in self.commands:
            print >>sys.stderr,"error: invalid command %r\n" % cmd
            self.usage(progname)

        self.commands[cmd]('%s %s' % (progname, cmd), args)
