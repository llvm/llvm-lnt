"""
Miscellaneous utilities for running "scripts".
"""

import errno

import os
import sys
import logging
import time
try:
    from flask import current_app, flash
except:
    # We may be imported from Sphinx. Don't error if current_app isn't available here -
    # instead error when it is used.
    pass
# FIXME: Find a better place for this code.
from lnt.server.ui.util import FLASH_INFO
LOGGER_NAME = "lnt.server.ui.app"


def get_logger():
    logger = logging.getLogger(LOGGER_NAME)
    return logger

note = lambda message: get_logger().info(message)
warning = lambda message: get_logger().warning(message)
error = lambda message: get_logger().error(message)


def visible_note(message):
    """Log a note to the logger as well as page with a flash."""
    get_logger().info(message)
    try:
        flash(message, FLASH_INFO)
    except RuntimeError:
        # We are not in a Flask environment right now (command line).
        pass


def timed(func):
    def timed(*args, **kw):
        t_start = time.time()
        result = func(*args, **kw)
        t_end = time.time()
        short_args = repr(args)
        if len(short_args) > 80:
            short_args = short_args[0:80]
        delta = t_end - t_start
        msg = '%r (%s, %r) %2.2f sec' % (func.__name__, short_args, kw, delta)
        if delta > 10:
            warning(msg)
        else:
            note(msg)
        return result

    return timed


def fatal(message):
    get_logger().critical(message)
    sys.exit(1)


def rm_f(path):
    try:
        os.remove(path)
    except OSError as e:
        if e.errno != errno.ENOENT:
            raise


def mkdir_p(path):
    """mkdir_p(path) - Make the "path" directory, if it does not exist; this
    will also make directories for any missing parent directories."""
    import errno

    try:
        os.makedirs(path)
    except OSError as e:
        # Ignore EEXIST, which may occur during a race condition.        
        if e.errno != errno.EEXIST:
            raise

def capture_with_result(args, include_stderr=False):
    import subprocess
    """capture_with_result(command) -> (output, exit code)

    Run the given command (or argv list) in a shell and return the standard
    output and exit code."""
    stderr = subprocess.PIPE
    if include_stderr:
        stderr = subprocess.STDOUT
    try:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=stderr)
    except OSError,e:
        if e.errno == errno.ENOENT:
            fatal('no such file or directory: %r when running %s.' % (args[0], \
                                                                     ' '.join(args)))
        raise
    out,_ = p.communicate()
    return out,p.wait()

def capture(args, include_stderr=False):
    import subprocess
    """capture(command) - Run the given command (or argv list) in a shell and
    return the standard output."""
    return capture_with_result(args, include_stderr)[0]

def which(command, paths = None):
    """which(command, [paths]) - Look up the given command in the paths string
    (or the PATH environment variable, if unspecified)."""

    if paths is None:
        paths = os.environ.get('PATH','')

    # Check for absolute match first.
    if os.path.exists(command):
        return command

    # Would be nice if Python had a lib function for this.
    if not paths:
        paths = os.defpath

    # Get suffixes to search.
    pathext = os.environ.get('PATHEXT', '').split(os.pathsep)

    # Search the paths...
    for path in paths.split(os.pathsep):
        for ext in pathext:
            p = os.path.join(path, command + ext)
            if os.path.exists(p):
                return p

    return None

def resolve_command_path(name):
    """Try to make the name/path given into an absolute path to an
    executable.

    """
    # If the given name exists (or is a path), make it absolute.
    if os.path.exists(name):
        return os.path.abspath(name)

    # Otherwise we most likely have a command name, try to look it up.
    path = which(name)
    if path is not None:
        note("resolved command %r to path %r" % (name, path))
        return path

    # If that failed just return the original name.
    return name

def isexecfile(path):
    """Does this path point to a valid executable?

    """
    return os.path.isfile(path) and os.access(path, os.X_OK)
