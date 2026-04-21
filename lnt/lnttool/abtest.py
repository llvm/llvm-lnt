"""lnt abtest — manage A/B performance experiments on a remote LNT server."""
import json
import ssl
import urllib.error
import urllib.request

import certifi
import click


def _api_url(server_url, database, testsuite, *path_parts):
    base = '%s/api/db_%s/v4/%s' % (server_url.rstrip('/'), database, testsuite)
    if path_parts:
        return '%s/%s' % (base, '/'.join(str(p) for p in path_parts))
    return base


def _api_request(method, url, body=None, auth_token=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if auth_token:
        headers['AuthToken'] = auth_token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    context = ssl.create_default_context(cafile=certifi.where())
    try:
        resp = urllib.request.urlopen(req, context=context)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors='replace')
        raise click.ClickException('HTTP %d: %s' % (e.code, body_text))
    except urllib.error.URLError as e:
        raise click.ClickException('Could not connect to %s: %s' % (url, e))


@click.group("abtest")
def group_abtest():
    """manage A/B performance experiments on a remote LNT server"""


@group_abtest.command("create")
@click.argument("server_url")
@click.option("--database", default="default", show_default=True,
              help="LNT database name")
@click.option("--testsuite", "-s", default="nts", show_default=True,
              help="testsuite name")
@click.option("--name", default="",
              help="human-readable experiment name")
@click.option("--control", "control_file",
              type=click.Path(exists=True), default=None,
              help="control run report JSON")
@click.option("--variant", "variant_file",
              type=click.Path(exists=True), default=None,
              help="variant run report JSON")
@click.option("--auth-token", envvar="LNT_AUTH_TOKEN",
              help="API auth token (or set LNT_AUTH_TOKEN)")
def action_abtest_create(server_url, database, testsuite, name,
                         control_file, variant_file, auth_token):
    """Create an A/B experiment on a remote LNT server.

\b
Two workflows are supported:

  Atomic — both runs available at the same time:

    lnt abtest create SERVER --name "pr-42" \\
        --control control.json --variant variant.json

  Two-phase — control and variant submitted by independent CI jobs:

    # Orchestrator: create the experiment and capture the ID
    ID=$(lnt abtest create SERVER --name "pr-42")

    # Control CI job
    lnt abtest submit SERVER $ID --control control.json

    # Variant CI job
    lnt abtest submit SERVER $ID --variant variant.json
    """
    if bool(control_file) != bool(variant_file):
        raise click.UsageError(
            "Provide both --control and --variant for atomic creation, "
            "or neither to create a pending experiment.")

    body = {'name': name}
    if control_file:
        with open(control_file) as f:
            body['control'] = json.load(f)
        with open(variant_file) as f:
            body['variant'] = json.load(f)

    url = _api_url(server_url, database, testsuite, 'abtest')
    result = _api_request('POST', url, body=body, auth_token=auth_token)

    # Print just the ID to stdout so scripts can capture it with $(...).
    click.echo(result['id'])
    exp_url = result.get('url')
    if exp_url:
        click.echo('Experiment: %s' % exp_url, err=True)


@group_abtest.command("submit")
@click.argument("server_url")
@click.argument("experiment_id", type=int)
@click.option("--database", default="default", show_default=True,
              help="LNT database name")
@click.option("--testsuite", "-s", default="nts", show_default=True,
              help="testsuite name")
@click.option("--control", "control_file",
              type=click.Path(exists=True), default=None,
              help="submit this JSON as the control run")
@click.option("--variant", "variant_file",
              type=click.Path(exists=True), default=None,
              help="submit this JSON as the variant run")
@click.option("--auth-token", envvar="LNT_AUTH_TOKEN",
              help="API auth token (or set LNT_AUTH_TOKEN)")
def action_abtest_submit(server_url, experiment_id, database, testsuite,
                         control_file, variant_file, auth_token):
    """Submit a control or variant run to an existing A/B experiment.

\b
Used in the two-phase workflow after 'lnt abtest create' has returned an ID:

    lnt abtest submit SERVER ID --control control.json
    lnt abtest submit SERVER ID --variant variant.json
    """
    if not control_file and not variant_file:
        raise click.UsageError("Provide --control or --variant.")
    if control_file and variant_file:
        raise click.UsageError(
            "Provide --control or --variant, not both. "
            "To submit both at once use 'lnt abtest create'.")

    role = 'control' if control_file else 'variant'
    report_file = control_file or variant_file

    with open(report_file) as f:
        body = json.load(f)

    url = _api_url(server_url, database, testsuite, 'abtest', experiment_id, role)
    _api_request('POST', url, body=body, auth_token=auth_token)
    click.echo('Submitted %s run for experiment %d.' % (role, experiment_id))
