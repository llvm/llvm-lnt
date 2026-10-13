import click


@click.group("v5")
def group_v5() -> None:
    """tools for moving to an LNT v5 instance"""


@group_v5.command("import-v4-mirror")
@click.argument("mirror_dir", type=click.Path(exists=True, file_okay=False))
@click.option("--suite", required=True, metavar="SUITE",
              help="test suite of the mirror to import")
@click.option("--target-suite", required=True, metavar="NAME",
              help="test suite of the v5 instance to import it into")
@click.option("--schema", "schema_file", metavar="FILE",
              type=click.Path(exists=True, dir_okay=False),
              help="v5 schema to create the target suite with, instead of "
                   "the one derived from the mirror")
@click.option("--dry-run", is_flag=True,
              help="convert every run and report problems, without "
                   "contacting the v5 instance")
def action_import_v4_mirror(mirror_dir: str, suite: str, target_suite: str,
                            schema_file: str | None, dry_run: bool) -> None:
    """import a test suite of a v4 mirror into an LNT v5 instance

    MIRROR_DIR is a mirror made by `lnt mirror-v4`. See the "Importing a v4
    Mirror into v5" documentation for how its data is converted.

    Exits with a non-zero status if any run cannot be imported.
    """
    import json
    import sys
    from lnt.util.import_v4_mirror import PlanError, dry_run as do_dry_run

    if not dry_run:
        raise click.UsageError("only --dry-run is supported for now")
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
        failures = do_dry_run(mirror_dir, suite, target_suite, override,
                              echo=click.echo)
    except PlanError as e:
        for problem in e.problems:
            click.echo("error: %s" % problem, err=True)
        sys.exit(1)
    if failures:
        sys.exit(1)
