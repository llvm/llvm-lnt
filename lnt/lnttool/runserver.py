import click
import logging
from .common import init_logger


@click.command("runserver", short_help="start a new development server")
@click.argument("instance_path", type=click.UNPROCESSED)
@click.option("--hostname", default="localhost", show_default=True,
              help="host interface to use")
@click.option("--port", default=8000, show_default=True,
              help="local port to use")
@click.option("--reloader", is_flag=True, help="use WSGI reload monitor")
@click.option("--debugger", is_flag=True, help="use WSGI debugger")
@click.option("--profiler", is_flag=True, help="use WSGI profiler")
@click.option("--profiler-file", help="file to dump profile info to")
@click.option("--profiler-dir",
              help="pstat.Stats files are saved to this directory ")
@click.option("--shell", is_flag=True, help="load in shell")
@click.option("--show-sql", is_flag=True, help="show all SQL queries")
@click.option("--threaded", is_flag=True, help="use a threaded server")
@click.option("--processes", default=1, show_default=True,
              help="number of processes to use")
def action_runserver(instance_path, hostname, port, reloader, debugger,
                     profiler, profiler_file, profiler_dir, shell, show_sql,
                     threaded, processes):
    """start a new development server

\b
Start the LNT server using a development WSGI server. Additional options can be
used to control the server host and port, as well as useful development
features such as automatic reloading.

The command has built-in support for running the server on an instance which
has been packed into a (compressed) tarball. The tarball will be automatically
unpacked into a temporary directory and removed on exit. This is useful for
passing database instances back and forth, when others only need to be able to
view the results.
    """
    import lnt.server.ui.app
    import os

    init_logger(logging.INFO, show_sql=show_sql)

    app = lnt.server.ui.app.App.create_standalone(instance_path)
    if debugger:
        app.debug = True
    if profiler:
        import werkzeug.contrib.profiler
        if profiler_dir:
            if not os.path.isdir(profiler_dir):
                os.mkdir(profiler_dir)
        app.wsgi_app = werkzeug.contrib.profiler.ProfilerMiddleware(
            app.wsgi_app, stream=open(profiler_file, 'w'),
            profile_dir=profiler_dir)
    if shell:
        from flask import current_app  # noqa: F401  # Used in locals() below
        from flask import g  # noqa: F401  # Used in locals() below
        import code
        ctx = app.test_request_context()
        ctx.push()

        vars = globals().copy()
        vars.update(locals())
        shell = code.InteractiveConsole(vars)
        shell.interact()
    else:
        app.run(hostname, port,
                use_reloader=reloader,
                use_debugger=debugger,
                threaded=threaded,
                processes=processes)
