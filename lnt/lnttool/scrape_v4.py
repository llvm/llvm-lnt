import click


@click.command("scrape-v4")
@click.argument("url")
@click.argument("archive_dir", type=click.Path(file_okay=False))
@click.option("--suite", "suites", required=True, multiple=True,
              metavar="SUITE",
              help="test suite to scrape, given once (the v4 API cannot list "
                   "them)")
@click.option("--database", default="default", show_default=True,
              help="database of the instance to scrape")
@click.option("--machine", "machines", multiple=True, metavar="NAME",
              help="only scrape the machines with this name (repeatable)")
@click.option("--workers", default=4, show_default=True,
              type=click.IntRange(min=1),
              help="number of runs to fetch concurrently")
@click.option("--dry-run", is_flag=True,
              help="report what would be fetched and removed, without "
                   "changing the archive")
def action_scrape_v4(url: str, archive_dir: str, suites: tuple[str, ...],
                     database: str, machines: tuple[str, ...], workers: int,
                     dry_run: bool) -> None:
    """mirror a test suite of a v4 server into a local archive

    URL is the root of the LNT v4 instance, e.g. https://lnt.llvm.org. The
    archive in ARCHIVE_DIR is created if needed, and brought up to date if it
    already exists. See the "Archiving a v4 Instance" documentation for the
    archive format.
    """
    import sys
    from lnt.util.scrape_v4 import ScrapeError, scrape

    # Accepted as repeatable only so that repeating it is an error rather than
    # silently keeping the last one.
    if len(suites) > 1:
        raise click.UsageError("--suite may only be given once; scrape each "
                               "suite with a separate invocation")
    try:
        failures = scrape(url, archive_dir, suites[0], database=database,
                          machines=machines, workers=workers, dry_run=dry_run,
                          echo=click.echo)
    except ScrapeError as e:
        click.echo("error: %s" % e, err=True)
        sys.exit(1)
    if failures:
        sys.exit(1)
