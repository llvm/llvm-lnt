from lnt import formats
import click


def _convert_data(input, output, inFormat, outFormat):
    out = formats.get_format(outFormat)
    if out is None or not out.get('write'):
        raise SystemExit("unknown output format: %r" % outFormat)

    data = formats.read_any(input, inFormat)

    out['write'](data, output)
    output.flush()


@click.command("convert")
@click.argument("input", type=click.File('rb'), default="-", required=False)
@click.argument("output", type=click.File('wb'), default="-", required=False)
@click.option("--from", "input_format", show_default=True,
              type=click.Choice(formats.format_names + ['<auto>']),
              default='<auto>', help="input format")
@click.option("--to", "output_format", show_default=True,
              type=click.Choice(formats.format_names + ['<auto>']),
              default='plist', help="output format")
def action_convert(input, output, input_format, output_format):
    """convert between input formats"""
    import os
    import sys

    try:
        try:
            _convert_data(input, output, input_format, output_format)
        finally:
            if output != sys.stdout:
                output.close()
    except Exception:
        if output != sys.stdout:
            os.remove(output)
        raise
