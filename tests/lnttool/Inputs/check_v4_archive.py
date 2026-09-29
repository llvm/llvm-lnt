#!/usr/bin/env python
"""Check that a directory is a well-formed archive produced by `lnt scrape-v4`.

Verifies the properties docs/scrape_v4.rst guarantees for an archive left by a
completed scrape: every file the manifest references exists and has the
recorded hash, every archived run matches its summary and its machine in the
machine listing, and no other file sits in a suite's directory. Prints a
normalized listing of the archive for FileCheck, and exits with a non-zero
status (after reporting every problem) if the archive is not well-formed.

Deliberately independent of lnt.util.scrape_v4, so that it checks the archive
against the spec rather than against the code that wrote it.

Usage: check_v4_archive.py ARCHIVE_DIR
"""

import gzip
import hashlib
import json
import os
import sys


def main():
    archive = sys.argv[1]
    problems = []
    referenced = set()

    def read(relpath, sha256, compressed=False):
        """The contents of a referenced file, or None if it is not usable."""
        referenced.add(relpath)
        path = os.path.join(archive, relpath)
        if not os.path.isfile(path):
            problems.append('%s: missing' % relpath)
            return None
        with open(path, 'rb') as f:
            data = f.read()
        if compressed:
            data = gzip.decompress(data)
        if hashlib.sha256(data).hexdigest() != sha256:
            problems.append('%s: hash mismatch' % relpath)
            return None
        return data

    with open(os.path.join(archive, 'archive.json')) as f:
        manifest = json.load(f)
    source = manifest['source']
    print('source: %s database=%s' % (source['url'], source['database']))

    for suite, entry in manifest['suites'].items():
        schema = read('%s/schema.json' % suite, entry['schema']['sha256'])
        if schema is not None:
            print('suite %s: schema %s' % (suite, json.loads(schema)['name']))

        for machine_id, machine in entry['machines'].items():
            listing_path = '%s/machines/%s.json' % (suite, machine_id)
            for key in ('name', 'scraped_at', 'sha256', 'runs'):
                if key not in machine:
                    problems.append('%s: no %s in the manifest'
                                    % (listing_path, key))
            data = read(listing_path, machine['sha256'])
            listing = json.loads(data) if data is not None else None
            if listing is not None and \
                    listing['machine']['name'] != machine['name']:
                problems.append('%s: name differs from the manifest'
                                % listing_path)
            summaries = {str(r['id']): r for r in listing['runs']} \
                if listing is not None else {}

            for run_id, run in machine['runs'].items():
                run_path = '%s/runs/%s.json.gz' % (suite, run_id)
                data = read(run_path, run['sha256'], compressed=True)
                if data is None or listing is None:
                    continue
                document = json.loads(data)
                if run_id not in summaries:
                    problems.append('%s: not in the listing of machine %s'
                                    % (run_path, machine_id))
                elif document['run'] != summaries[run_id]:
                    problems.append('%s: differs from its summary' % run_path)
                elif document['machine'] != listing['machine']:
                    problems.append('%s: machine differs from the listing'
                                    % run_path)

            print('  machine %s %s: runs %s' % (
                machine_id, machine['name'],
                ' '.join(sorted(machine['runs'], key=int)) or '(none)'))

        for root, _, files in os.walk(os.path.join(archive, suite)):
            for name in files:
                relpath = os.path.relpath(os.path.join(root, name), archive)
                if relpath not in referenced:
                    problems.append('%s: not referenced by the manifest'
                                    % relpath)

    for problem in problems:
        print('PROBLEM: %s' % problem)
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
