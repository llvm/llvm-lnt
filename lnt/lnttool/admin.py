#!/usr/bin/env python
import click

_config_filename = 'lntadmin.yaml'


def _load_dependencies():
    global yaml, sys, requests, json, os, httplib
    import yaml
    import sys
    import requests
    import json
    import os
    import httplib


def _error(msg):
    sys.stderr.write('%s\n' % msg)


def _fatal(msg):
    _error(msg)
    sys.exit(1)


def _check_normalize_config(config, need_auth_token):
    '''Verify whether config is correct and complete. Also normalizes the
    server URL if necessary.'''
    lnt_url = config.get('lnt_url', None)
    if lnt_url is None:
        _fatal('No lnt_url specified in config or commandline\n'
               'Tip: Use `create-config` for an example configuration')
    if lnt_url.endswith('/'):
        lnt_url = lnt_url[:-1]
        config['lnt_url'] = lnt_url
    database = config.get('database', None)
    if database is None:
        _fatal('No database specified in config or commandline')
    testsuite = config.get('testsuite', None)
    if testsuite is None:
        config['testsuite'] = 'nts'

    session = requests.Session()
    user = config.get('user', None)
    password = config.get('password', None)
    if user is not None and password is not None:
        session.auth = (user, password)

    auth_token = config.get('auth_token', None)
    if need_auth_token and auth_token is None:
        _fatal('No auth_token specified in config')
    else:
        session.headers.update({'AuthToken': auth_token})
    config['session'] = session


def _make_config(kwargs, need_auth_token=False):
    '''Load configuration from yaml file, merges it with the commandline
    options and verifies the resulting configuration.'''
    verbose = kwargs.get('verbose', False)
    # Load config file
    config = {}
    try:
        config = yaml.load(open(_config_filename))
    except IOError:
        if verbose:
            _error("Could not load configuration file '%s'\n" %
                   _config_filename)
    for key, value in kwargs.items():
        if value is None:
            continue
        config[key] = value
    _check_normalize_config(config, need_auth_token=need_auth_token)
    return config


def _check_response(response):
    '''Check given response. If it is not a 200 response print an error message
    and quit.'''
    status_code = response.status_code
    if 200 <= status_code and status_code < 400:
        return

    sys.stderr.write("%d: %s\n" %
                     (status_code, httplib.responses.get(status_code, '')))
    sys.stderr.write("\n%s\n" % response.text)
    sys.exit(1)


def _print_machine_info(machine, indent=''):
    for key, value in machine.items():
        sys.stdout.write('%s%s: %s\n' % (indent, key, value))


def _print_run_info(run, indent=''):
    for key, value in run.items():
        sys.stdout.write('%s%s: %s\n' % (indent, key, value))


def _common_options(func):
    func = click.option("--lnt-url", help="URL of LNT server")(func)
    func = click.option("--database", help="database to use")(func)
    func = click.option("--testsuite", help="testsuite to use")(func)
    func = click.option("--verbose", "-v", is_flag=True,
                        help="verbose output")(func)
    return func


@click.command("list-machines")
@_common_options
def action_list_machines(**kwargs):
    """List machines and their id numbers."""
    config = _make_config(kwargs)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines'
           .format(**config))
    session = config['session']
    response = session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    for machine in data['machines']:
        id = machine.get('id', None)
        name = machine.get('name', None)
        sys.stdout.write("%s:%s\n" % (name, id))
        if config['verbose']:
            _print_machine_info(machine, indent='\t')


@click.command("get-machine")
@click.argument("machine")
@_common_options
def action_get_machine(**kwargs):
    """Download machine information and run list."""
    config = _make_config(kwargs)

    filename = 'machine_%s.json' % config['machine']
    if os.path.exists(filename):
        _fatal("'%s' already exists" % filename)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(**config))
    session = config['session']
    response = session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    assert len(data['machines']) == 1
    machine = data['machines'][0]

    result = {
        'machine': machine
    }
    runs = data.get('runs', None)
    if runs is not None:
        result['runs'] = runs
    with open(filename, "w") as destfile:
        json.dump(result, destfile, indent=2)
    sys.stdout.write("%s created.\n" % filename)


@click.command("rm-machine")
@click.argument("machine")
@_common_options
def action_rm_machine(**kwargs):
    """Remove machine and related data."""
    config = _make_config(kwargs, need_auth_token=True)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(**config))
    session = config['session']
    response = session.delete(url, stream=True)
    _check_response(response)
    for line in response.iter_lines():
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


@click.command("rename-machine")
@click.argument("machine")
@click.argument("new-name")
@_common_options
def action_rename_machine(**kwargs):
    """Rename machine."""
    config = _make_config(kwargs, need_auth_token=True)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(**config))
    session = config['session']
    response = session.post(url, data=(('action', 'rename'),
                                       ('name', config['new_name'])))
    _check_response(response)


@click.command("merge-machine-into")
@click.argument("machine")
@click.argument("into")
@_common_options
def action_merge_machine_into(**kwargs):
    """Merge machine into another machine."""
    config = _make_config(kwargs, need_auth_token=True)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(**config))
    session = config['session']
    response = session.post(url, data=(('action', 'merge'),
                                       ('into', config['into'])))
    _check_response(response)


@click.command("list-runs")
@click.argument("machine")
@_common_options
def action_list_runs(**kwargs):
    """List runs of a machine."""
    config = _make_config(kwargs)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(**config))
    session = config['session']
    response = session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    runs = data['runs']
    if config['verbose']:
        sys.stdout.write("order run-id\n")
        sys.stdout.write("------------\n")
    for run in runs:
        order_by = [x.strip() for x in run['order_by'].split(',')]
        orders = []
        for field in order_by:
            orders.append("%s=%s" % (field, run[field]))
        sys.stdout.write("%s %s\n" % (";".join(orders), run['id']))
        if config['verbose']:
            _print_run_info(run, indent='\t')


@click.command("get-run")
@click.argument("runs", nargs=-1, required=True)
@_common_options
def action_get_run(**kwargs):
    """Download runs and save as report files."""
    config = _make_config(kwargs)

    runs = config['runs']
    for run in runs:
        filename = 'run_%s.json' % run
        if os.path.exists(filename):
            _fatal("'%s' already exists" % filename)

    session = config['session']
    for run in runs:
        url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/runs/{run}'
               .format(run=run, **config))
        response = session.get(url)
        _check_response(response)

        data = json.loads(response.text)
        filename = 'run_%s.json' % run
        with open(filename, "w") as destfile:
            json.dump(data, destfile, indent=2)
        sys.stdout.write("%s created.\n" % filename)


@click.command("rm-run")
@click.argument("runs", nargs=-1, required=True)
@_common_options
def action_rm_run(**kwargs):
    """Remove runs and related data."""
    config = _make_config(kwargs, need_auth_token=True)

    session = config['session']
    runs = config['runs']
    for run in runs:
        url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/runs/{run}'
               .format(run=run, **config))
        response = session.delete(url)
        _check_response(response)


@click.command("post-run")
@click.argument("datafiles", nargs=-1, type=click.Path(exists=True),
                required=True)
@_common_options
@click.option("--update-machine", is_flag=True, help="Update machine fields")
@click.option("--merge", default="replace", show_default=True,
              type=click.Choice(['reject', 'replace', 'merge']),
              help="Merge strategy when run already exists")
def action_post_run(**kwargs):
    """Submit report files to server."""
    config = _make_config(kwargs, need_auth_token=True)

    session = config['session']
    datafiles = config['datafiles']
    for datafile in datafiles:
        with open(datafile, "r") as datafile:
            data = datafile.read()

        url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/runs'
               .format(**config))
        url_params = {
            'update_machine': 1 if config['update_machine'] else 0,
            'merge': config['merge'],
        }
        response = session.post(url, params=url_params, data=data,
                                allow_redirects=False)
        _check_response(response)
        if response.status_code == 301:
            sys.stdout.write(response.headers.get('Location') + '\n')
        if config['verbose']:
            try:
                response_data = json.loads(response.text)
                json.dump(response_data, sys.stderr, response_data, indent=2)
            except:
                sys.stderr.write(response.text)
            sys.stderr.write('\n')


@click.command('create-config')
def action_create_config():
    """Create example configuration."""
    if os.path.exists(_config_filename):
        _fatal("'%s' already exists" % _config_filename)
    with open(_config_filename, "w") as out:
        out.write('''\
lnt_url: "http://localhost:8000"
database: default
testsuite: nts
# user: 'http_user'
# password: 'http_password'
# auth_token: 'secret'
''')
    sys.stderr.write("Created '%s'\n" % _config_filename)


class AdminCLI(click.MultiCommand):
    '''Admin subcommands. Put into this class so we can lazily import
    dependencies.'''
    _commands = [
        action_create_config,
        action_get_machine,
        action_get_run,
        action_list_machines,
        action_list_runs,
        action_merge_machine_into,
        action_post_run,
        action_rename_machine,
        action_rm_machine,
        action_rm_run,
    ]
    def list_commands(self, ctx):
        return [command.name for command in self._commands]

    def get_command(self, ctx, name):
        _load_dependencies()
        for command in self._commands:
            if command.name == name:
                return command
        raise ValueError("Request unknown command '%s'" % name)


@click.group("admin", cls=AdminCLI, no_args_is_help=True)
def group_admin():
    """LNT server admin client."""
