from typing import Any

import click


@click.group("v5")
def group_v5() -> None:
    """tools for interacting with LNT v5 instances"""


@group_v5.command("convert-v4-mirror")
@click.argument("mirror_dir", type=click.Path(exists=True, file_okay=False))
@click.option("--suite", required=True, metavar="SUITE",
              help="test suite of the mirror to convert")
@click.option("--target-suite", metavar="NAME",
              help="name of the v5 test suite the runs are meant for "
                   "[default: SUITE]")
@click.option("--schema", "schema_file", metavar="FILE",
              type=click.Path(exists=True, dir_okay=False),
              help="v5 schema of the target suite, instead of the one derived "
                   "from the mirror")
@click.option("--schema-out", metavar="FILE",
              type=click.Path(dir_okay=False, writable=True),
              help="write the target suite's schema to FILE")
@click.option("--commit-field", metavar="FIELD",
              help="take each run's commit from this v4 run field, when the "
                   "run has one, rather than from the order field")
def action_convert_v4_mirror(mirror_dir: str, suite: str,
                             target_suite: str | None,
                             schema_file: str | None, schema_out: str | None,
                             commit_field: str | None) -> None:
    """convert a test suite of a v4 mirror into v5 runs

    MIRROR_DIR is a mirror made by `lnt mirror-v4`. Each run is written to
    standard output as a line of JSON, ready for `lnt v5 submit`. See the
    "Converting a v4 Mirror for v5" documentation for how the data is
    converted.

    Exits with a non-zero status if any run cannot be converted.
    """
    import json
    import os
    import sys
    from lnt.util.convert_v4_mirror import PlanError, convert

    override = None
    if schema_file is not None:
        try:
            with open(schema_file) as f:
                override = json.load(f)
        except (OSError, ValueError) as e:
            raise click.BadParameter(str(e), param_hint="--schema")
        if not isinstance(override, dict):
            raise click.BadParameter("not a JSON object", param_hint="--schema")
    try:
        failures = convert(mirror_dir, suite, sys.stdout, target_suite,
                           override, commit_field, schema_out,
                           echo=lambda line: click.echo(line, err=True))
    except PlanError as e:
        for problem in e.problems:
            click.echo("error: %s" % problem, err=True)
        sys.exit(1)
    except BrokenPipeError:
        # Whatever reads the output stopped early, e.g. `| head`: stop too,
        # without Python complaining again when it flushes stdout on exit.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(1)
    except OSError as e:
        click.echo("error: %s" % e, err=True)
        sys.exit(1)
    if failures:
        sys.exit(1)


@group_v5.command("convert-perf")
@click.argument("perf_data", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--output", metavar="FILE", default="-",
              type=click.File("wb", lazy=True),
              help="write the result to FILE rather than to standard output")
@click.option("--encode", is_flag=True,
              help="write the document gzip-compressed and base64-encoded, "
                   "as a test's `profile` holds it in a run submission")
@click.option("--objdump", envvar="CMAKE_OBJDUMP", default="objdump",
              metavar="CMD",
              help="objdump command to read the profiled binaries with "
                   "[default: $CMAKE_OBJDUMP, or objdump]")
@click.option("--binary-cache-root", envvar="LNT_BINARY_CACHE_ROOT",
              default="", metavar="DIR",
              help="prefix to the paths of the profiled binaries, for "
                   "reading copies of them [default: $LNT_BINARY_CACHE_ROOT]")
@click.option("--cxxfilt", default="c++filt", show_default=True,
              metavar="CMD", help="c++filt command to demangle names with")
@click.option("--disassembly-format", default="objdump", show_default=True,
              metavar="NAME",
              help="what produced the instruction text, as the document "
                   "records it")
def action_convert_perf(perf_data: str, output: Any, encode: bool,
                        objdump: str, binary_cache_root: str, cxxfilt: str,
                        disassembly_format: str) -> None:
    """convert a Linux perf profile into a v5 profile document

    PERF_DATA is a file recorded by `perf record`. Its profile document is
    written as JSON, or with --encode as the string a test's `profile` holds
    in a v5 run submission. See the "Converting perf Profiles for v5"
    documentation for how the profile is converted.

    Exits with a non-zero status if the profile cannot be converted.
    """
    import sys
    from lnt.util.v5_profile import ConvertError, convert_perf, serialize

    try:
        document = convert_perf(
            perf_data, objdump, binary_cache_root, cxxfilt,
            disassembly_format,
            warn=lambda line: click.echo("warning: %s" % line, err=True))
        output.write(serialize(document, encode) + b"\n")
    except (ConvertError, OSError) as e:
        click.echo("error: %s" % e, err=True)
        sys.exit(1)


@group_v5.command("submit")
@click.argument("url")
@click.argument("input_file", metavar="[FILE]", default="-",
                type=click.File("rb"))
@click.option("--suite", required=True, metavar="NAME",
              help="test suite to submit the runs to")
@click.option("--token", envvar="LNT_V5_TOKEN", metavar="TOKEN",
              help="API token, with submit scope (manage with "
                   "--create-suite) [default: $LNT_V5_TOKEN]")
@click.option("--create-suite", "schema_file", metavar="FILE",
              type=click.Path(exists=True, dir_okay=False),
              help="create the suite, which must not exist yet, from the "
                   "schema in FILE")
@click.option("--workers", default=4, show_default=True,
              type=click.IntRange(min=1),
              help="number of runs to submit concurrently")
def action_submit(url: str, input_file: Any, suite: str, token: str | None,
                  schema_file: str | None, workers: int) -> None:
    """submit runs to a test suite of an LNT v5 instance

    URL is the root of the v5 instance, e.g. https://lnt.example.com. The runs
    are read from FILE, or from standard input, as one JSON run submission per
    line, and submitted in that order. Runs whose UUID already exists in the
    suite are skipped, so submitting the same runs again only submits the
    missing ones.

    Requests that fail because of the network, a server error or a concurrent
    change to the suite's schema are retried a few times. Any other failure is
    reported, and the command carries on with the next run.

    Exits with a zero status if every run was submitted (or skipped without an
    error), and with a non-zero status if any failed.
    """
    import json
    import sys
    from lnt.util.v5_submit import SubmitError, submit

    schema = None
    if schema_file is not None:
        try:
            with open(schema_file) as f:
                schema = json.load(f)
        except (OSError, ValueError) as e:
            raise click.BadParameter(str(e), param_hint="--create-suite")
    try:
        failures = submit(url, suite, input_file, token, schema, workers,
                          echo=click.echo)
    except SubmitError as e:
        click.echo("error: %s" % e, err=True)
        sys.exit(1)
    if failures:
        sys.exit(1)
