#!/usr/bin/env python
import click
from importlib import import_module
from .common import submit_options


def _load_dependencies():
    global yaml, sys, requests, json, os, http
    yaml = import_module('yaml')
    sys = import_module('sys')
    requests = import_module('requests')
    json = import_module('json')
    os = import_module('os')
    http = import_module('http')
    import_module('http.client')


def _error(msg):
    sys.stderr.write('%s\n' % msg)


def _fatal(msg):
    _error(msg)
    sys.exit(1)


_default_config_filename = './lntadmin.yaml'


class AdminConfig(object):
    def __init__(self, **args):
        self._set('verbose', args['verbose'])
        self._try_load_config(args['config'])
        for key, value in args.items():
            self._set(key, value)
        self._check_and_normalize()

    def _set(self, key, value):
        '''Set attribute `key` of object to `value`. If `value` is None
        then only set the attribute if it doesn't exist yet.'''
        if value is None and hasattr(self, key):
            return
        setattr(self, key, value)

    @property
    def dict(self):
        return self.__dict__

    def _try_load_config(self, filename):
        try:
            config = yaml.safe_load(open(filename))
            for key, value in config.items():
                self._set(key, value)
        except IOError as e:
            if self.verbose or filename != _default_config_filename:
                _error("Could not load configuration file '%s': %s\n" %
                       (filename, e))

    def _check_and_normalize(self):
        lnt_url = self.lnt_url
        if lnt_url is None:
            _fatal('No lnt_url specified in config or commandline\n'
                   'Tip: Use `create-config` for an example configuration')
        if lnt_url.endswith('/'):
            lnt_url = lnt_url[:-1]
            self.lnt_url = lnt_url
        if self.database is None:
            self.database = 'default'
        if self.testsuite is None:
            self.testsuite = 'nts'

        session = requests.Session()
        user = self.dict.get('user', None)
        password = self.dict.get('password', None)
        if user is not None and password is not None:
            session.auth = (user, password)

        self._set('auth_token', None)
        auth_token = self.auth_token
        if auth_token is not None:
            session.headers.update({'AuthToken': auth_token})

        skip_cert_check = self.dict.get('skip_cert_check', False)
        if skip_cert_check:
            session.verify = False

        self.session = session


_pass_config = click.make_pass_decorator(AdminConfig)


def _check_auth_token(config):
    if config.auth_token is None:
        _fatal('No auth_token specified in config')


def _check_response(response):
    '''Check given response. If it is not a 200 response print an error message
    and quit.'''
    status_code = response.status_code
    if 200 <= status_code and status_code < 400:
        return

    sys.stderr.write("%d: %s\n" %
                     (status_code, http.client.responses.get(status_code, '')))
    sys.stderr.write("\n%s\n" % response.text)
    sys.exit(1)


def _sorted_dict_items(dict, *args):
    result = list()
    for key in args:
        if key in dict:
            result.append((key, dict.pop(key)))
    # Order rest alphabetically
    result += sorted(dict.items())
    return result


def _print_machine_info(machine, indent=''):
    for key, value in _sorted_dict_items(machine, 'name', 'id'):
        sys.stdout.write('%s%s: %s\n' % (indent, key, value))


def _print_run_info(run, indent=''):
    for key, value in _sorted_dict_items(run, 'id'):
        sys.stdout.write('%s%s: %s\n' % (indent, key, value))


@click.command("list-machines")
@_pass_config
def action_list_machines(config):
    """List machines and their id numbers."""
    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines'
           .format(**config.dict))
    response = config.session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    for machine in data['machines']:
        id = machine.get('id', None)
        name = machine.get('name', None)
        sys.stdout.write("%s:%s\n" % (name, id))
        if config.verbose:
            _print_machine_info(machine, indent='\t')


@click.command("get-machine")
@_pass_config
@click.argument("machine")
def action_get_machine(config, machine):
    """Download machine information and run list."""
    filename = 'machine_%s.json' % machine
    if os.path.exists(filename):
        _fatal("'%s' already exists" % filename)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(machine=machine, **config.dict))
    response = config.session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    with open(filename, "w") as destfile:
        json.dump(data, destfile, indent=2, sort_keys=True)
    sys.stdout.write("%s created.\n" % filename)


@click.command("machine-info")
@_pass_config
@click.argument("machine")
def action_machine_info(config, machine):
    """Show machine information."""
    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(machine=machine, **config.dict))
    response = config.session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    _print_machine_info(data['machine'])


@click.command("rm-machine")
@_pass_config
@click.argument("machine")
def action_rm_machine(config, machine):
    """Remove machine and related data."""
    _check_auth_token(config)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(machine=machine, **config.dict))
    response = config.session.delete(url, stream=True)
    _check_response(response)
    for line in response.text.splitlines():
        sys.stdout.write(line + '\n')
        sys.stdout.flush()


@click.command("rename-machine")
@_pass_config
@click.argument("machine")
@click.argument("new-name")
def action_rename_machine(config, machine, new_name):
    """Rename machine."""
    _check_auth_token(config)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(machine=machine, **config.dict))
    post_data = {
        'action': 'rename',
        'name': new_name,
    }
    response = config.session.post(url, data=post_data)
    _check_response(response)


@click.command("merge-machine-into")
@_pass_config
@click.argument("machine")
@click.argument("into")
def action_merge_machine_into(config, machine, into):
    """Merge machine into another machine."""
    _check_auth_token(config)

    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(machine=machine, **config.dict))
    post_data = {
        'action': 'merge',
        'into': into
    }
    response = config.session.post(url, data=post_data)
    _check_response(response)


@click.command("list-runs")
@_pass_config
@click.argument("machine")
def action_list_runs(config, machine):
    """List runs of a machine."""
    url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/machines/{machine}'
           .format(machine=machine, **config.dict))
    response = config.session.get(url)
    _check_response(response)
    data = json.loads(response.text)
    runs = data['runs']
    if config.verbose:
        sys.stdout.write("order run-id\n")
        sys.stdout.write("------------\n")
    for run in runs:
        order_by = [x.strip() for x in run['order_by'].split(',')]
        orders = []
        for field in order_by:
            orders.append("%s=%s" % (field, run[field]))
        sys.stdout.write("%s %s\n" % (";".join(orders), run['id']))
        if config.verbose:
            _print_run_info(run, indent='\t')


@click.command("get-run")
@_pass_config
@click.argument("runs", nargs=-1, required=True)
def action_get_run(config, runs):
    """Download runs and save as report files."""
    for run in runs:
        filename = 'run_%s.json' % run
        if os.path.exists(filename):
            _fatal("'%s' already exists" % filename)

    for run in runs:
        url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/runs/{run}'
               .format(run=run, **config.dict))
        response = config.session.get(url)
        _check_response(response)

        data = json.loads(response.text)
        filename = 'run_%s.json' % run
        with open(filename, "w") as destfile:
            json.dump(data, destfile, indent=2, sort_keys=True)
        sys.stdout.write("%s created.\n" % filename)


@click.command("rm-run")
@_pass_config
@click.argument("runs", nargs=-1, required=True)
def action_rm_run(config, runs):
    """Remove runs and related data."""
    _check_auth_token(config)

    for run in runs:
        url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/runs/{run}'
               .format(run=run, **config.dict))
        response = config.session.delete(url)
        _check_response(response)


@click.command("post-run")
@_pass_config
@click.argument("datafiles", nargs=-1, type=click.Path(exists=True),
                required=True)
@submit_options
def action_post_run(config, datafiles, select_machine, merge):
    """Submit report files to server."""
    _check_auth_token(config)

    for datafile in datafiles:
        with open(datafile, "r") as datafile:
            data = datafile.read()

        url = ('{lnt_url}/api/db_{database}/v4/{testsuite}/runs'
               .format(**config.dict))
        url_params = {
            'select_machine': select_machine,
            'merge': merge,
        }
        response = config.session.post(url, params=url_params, data=data,
                                       allow_redirects=False)
        _check_response(response)
        if response.status_code == 301:
            sys.stdout.write(response.headers.get('Location') + '\n')
        if config.verbose:
            try:
                response_data = json.loads(response.text)
                json.dump(response_data, sys.stderr, response_data, indent=2,
                          sort_keys=True)
            except Exception:
                sys.stderr.write(response.text)
            sys.stderr.write('\n')


@click.command('create-config')
def action_create_config():
    """Create example configuration."""
    if os.path.exists(_default_config_filename):
        _fatal("'%s' already exists" % _default_config_filename)
    with open(_default_config_filename, "w") as out:
        out.write('''\
lnt_url: "http://localhost:8000"
database: default
testsuite: nts
# user: 'http_user'
# password: 'http_password'
# auth_token: 'secret'
''')
    sys.stderr.write("Created '%s'\n" % _default_config_filename)


class AdminCLI(click.Group):
    '''Admin subcommands. Put into this class so we can lazily import
    dependencies.'''
    _commands = [
        action_create_config,
        action_get_machine,
        action_get_run,
        action_list_machines,
        action_list_runs,
        action_machine_info,
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
        return None


@click.group("admin", cls=AdminCLI, no_args_is_help=True)
@click.option("--config", "-C", help="Config File", type=click.Path(),
              default=_default_config_filename, show_default=True)
@click.option("--lnt-url", help="URL of LNT server", metavar="URL")
@click.option("--database", help="database to use", metavar="DBNAME")
@click.option("--testsuite", help="testsuite to use", metavar="SUITE")
@click.option("--verbose", "-v", is_flag=True, help="verbose output")
@click.pass_context
def group_admin(ctx, **kwargs):
    """LNT server admin client."""
    command = ctx.invoked_subcommand
    if command is None or command == "create-config" or '--help' in sys.argv:
        return
    ctx.obj = AdminConfig(**kwargs)
