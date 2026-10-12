import click


@click.command("mirror-v4")
@click.argument("url")
@click.argument("mirror_dir", type=click.Path(file_okay=False))
@click.option("--suite", "suites", required=True, multiple=True,
              metavar="SUITE",
              help="test suite to mirror, given once (the v4 API cannot list "
                   "them)")
@click.option("--database", default="default", show_default=True,
              metavar="NAME", help="database of the instance to mirror")
@click.option("--machine", "machines", multiple=True, metavar="NAME",
              help="only refresh the machines with this name (repeatable)")
@click.option("--workers", default=4, show_default=True,
              type=click.IntRange(min=1),
              help="number of requests to send concurrently")
@click.option("--dry-run", is_flag=True,
              help="report what would be fetched and removed, without "
                   "changing the mirror")
def action_mirror_v4(url: str, mirror_dir: str, suites: tuple[str, ...],
                     database: str, machines: tuple[str, ...], workers: int,
                     dry_run: bool) -> None:
    """mirror a test suite of a v4 server into a local directory

    URL is the root of the LNT v4 instance, e.g. https://lnt.llvm.org. The
    mirror in MIRROR_DIR is created if needed, and brought up to date if it
    already exists. A mirror holds a single database of a single instance, and
    can hold several of its suites, each mirrored by an invocation of its own.

    Exits with a non-zero status if anything could not be fetched. The mirror
    is left consistent regardless, and running the same command again resumes
    where it stopped. See the "Mirroring a v4 Instance" documentation for the
    mirror's format.
    """
    import sys
    from lnt.util.mirror_v4 import MirrorError, refresh

    # Accepted as repeatable only so that repeating it is an error rather than
    # silently keeping the last one.
    if len(suites) > 1:
        raise click.UsageError("--suite may only be given once; mirror each "
                               "suite with a separate invocation")
    try:
        failures = refresh(url, mirror_dir, suites[0], database=database,
                           machines=machines, workers=workers,
                           dry_run=dry_run, echo=click.echo)
    except MirrorError as e:
        click.echo("error: %s" % e, err=True)
        sys.exit(1)
    if failures:
        sys.exit(1)
