#!/usr/bin/env python
"""Create a temporary LNT instance backed by PostgreSQL and optionally import
JSON report files or directories of JSON reports, then exec the given command.

Expects LNT_TEST_DB_URI and LNT_TEST_DB_NAME environment variables
(set by with_postgres.sh).
"""

import argparse
import glob
import json
import os
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(
        description="Create a temporary LNT instance backed by PostgreSQL and optionally import "
                    "JSON report files or directories of JSON reports, then exec the given command. "
                    "Expects LNT_TEST_DB_URI and LNT_TEST_DB_NAME environment variables "
                    "(set by with_postgres.sh).",
        usage="%(prog)s DEST_DIR [DATA_DIR ...] -- COMMAND [ARGS ...]",
    )
    parser.add_argument('dest_dir', metavar='DEST_DIR',
                        help='directory where the LNT instance will be created')
    parser.add_argument('data_dirs', metavar='DATA_DIR', nargs='*',
                        help='directories containing JSON report files to import, '
                             'or individual JSON report files')

    # Split at '--' to separate instance arguments from the command to exec.
    argv = sys.argv[1:]
    if '--' not in argv:
        parser.error("expected '--' to separate instance arguments from COMMAND")
    sep = argv.index('--')
    command = argv[sep + 1:]
    args = parser.parse_args(argv[:sep])

    if not command:
        parser.error("COMMAND is required after '--'")

    dest_dir = os.path.abspath(args.dest_dir)
    data_dirs = args.data_dirs

    db_uri = os.environ['LNT_TEST_DB_URI']
    db_name = os.environ['LNT_TEST_DB_NAME']

    # 1. Create the LNT instance.
    subprocess.check_call(['lnt', 'create', dest_dir, '--db-dir', db_uri, '--default-db', db_name])

    # 2. Symlink schema YAML files into the instance.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    schemas_src = os.path.join(script_dir, '..', '..', 'schemas')
    schemas_dst = os.path.join(dest_dir, 'schemas')
    for schema in ('nts.yaml', 'compile.yaml'):
        os.symlink(
            os.path.join(schemas_src, schema),
            os.path.join(schemas_dst, schema),
        )

    # 3. Append test configuration to lnt.cfg.
    cfg_path = os.path.join(dest_dir, 'lnt.cfg')
    with open(cfg_path, 'a') as f:
        f.write("\napi_auth_token = \"test_token\"\n")
        f.write("zorgURL = 'http://localhost/perf'\n")

    # 4. Import JSON report files from each DATA_DIR (or individual file).
    for data_path in data_dirs:
        if os.path.isdir(data_path):
            json_files = sorted(glob.glob(os.path.join(data_path, '*.json')))
        else:
            json_files = [data_path]
        for json_file in json_files:
            with open(json_file) as f:
                data = json.load(f)
            suite = data.get('schema', 'nts')
            subprocess.check_call(['lnt', 'import', '-s', suite, '--merge', 'append', dest_dir, json_file])

    # 5. Exec the wrapped command.
    os.execvp(command[0], command)


if __name__ == '__main__':
    main()
