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


def _setup_v5_instance(dest_dir):
    """Create a test suite in a freshly-created v5 LNT instance.

    After ``lnt create --db-version 5.0`` has built the directory structure,
    config, and v5 global tables, this function:
    1. Boots the app (reads existing v5 schema).
    2. Creates an NTS-equivalent test suite.
    """
    import lnt.server.ui.app
    app = lnt.server.ui.app.App.create_standalone(dest_dir)

    from lnt.server.db.v5.schema import parse_schema

    nts_schema = parse_schema({
        'name': 'nts',
        'metrics': [
            {'name': 'compile_time', 'type': 'real',
             'display_name': 'Compile Time', 'unit': 'seconds',
             'unit_abbrev': 's'},
            {'name': 'compile_status', 'type': 'status'},
            {'name': 'execution_time', 'type': 'real',
             'display_name': 'Execution Time', 'unit': 'seconds',
             'unit_abbrev': 's'},
            {'name': 'execution_status', 'type': 'status'},
            {'name': 'score', 'type': 'real', 'bigger_is_better': True,
             'display_name': 'Score'},
            {'name': 'mem_bytes', 'type': 'real',
             'display_name': 'Memory Usage', 'unit': 'bytes',
             'unit_abbrev': 'b'},
            {'name': 'hash', 'type': 'hash'},
            {'name': 'hash_status', 'type': 'status'},
            {'name': 'code_size', 'type': 'real',
             'display_name': 'Code Size', 'unit': 'bytes',
             'unit_abbrev': 'b'},
        ],
        'commit_fields': [
            {'name': 'llvm_project_revision', 'searchable': True,
             'display': True},
        ],
        'machine_fields': [
            {'name': 'hardware', 'searchable': True},
            {'name': 'os', 'searchable': True},
        ],
    })

    db = app.instance.get_database("default")
    session = db.make_session()
    try:
        db.create_suite(session, nts_schema)
        session.commit()
    finally:
        session.close()


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
    parser.add_argument('--db-version', default='0.4', choices=['0.4', '5.0'],
                        help='database version to use (default: 0.4)')

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
    subprocess.check_call([
        'lnt', 'create', dest_dir,
        '--db-dir', db_uri,
        '--default-db', db_name,
        '--api-auth-token', 'test_token',
        '--url', 'http://localhost/perf',
        '--db-version', args.db_version,
    ])

    # 2. Symlink schema YAML files into the instance.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    schemas_src = os.path.join(script_dir, '..', '..', 'schemas')
    schemas_dst = os.path.join(dest_dir, 'schemas')
    for schema in ('nts.yaml', 'compile.yaml'):
        os.symlink(
            os.path.join(schemas_src, schema),
            os.path.join(schemas_dst, schema),
        )

    # 3. For v5, patch the config and create the test suite programmatically.
    if args.db_version == '5.0':
        _setup_v5_instance(dest_dir)

    # 4. Import JSON report files from each DATA_DIR (or individual file).
    #    Skip for v5 -- the v4 import pipeline won't work.
    if args.db_version == '0.4':
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
