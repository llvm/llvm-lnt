# Test how `lnt mirror-v4` handles failures and unusual server behavior,
# against a fake server whose responses the test scripts: requests that fail and
# are retried, requests that keep failing, runs that change while they are being
# fetched or that move between machines, and invalid invocations.
#
# RUN: rm -rf %t.dir && mkdir -p %t.dir
# RUN: python %s %t.dir %S/Inputs/check_v4_mirror.py > %t.out
# RUN: filecheck %s < %t.out

import fcntl
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from click.testing import CliRunner

import lnt.util.mirror_v4
from lnt.lnttool.mirror_v4 import action_mirror_v4

# Retry immediately, rather than after the delays meant for a real server.
lnt.util.mirror_v4.RETRY_DELAYS = (0, 0)
# Pin the umask, so that the permissions the mirror's files get are known.
os.umask(0o022)

TMP, CHECKER = sys.argv[1], sys.argv[2]
MIRROR = os.path.join(TMP, 'mirror')
PREFIX = '/api/db_default/v4/nts/'

MACHINE = {'id': 1, 'name': 'fake-machine'}
OTHER_MACHINE = {'id': 2, 'name': 'other-machine'}


def summary(run_id, start_time='2026-01-01T00:00:00'):
    return {'id': run_id, 'start_time': start_time, 'order_id': run_id,
            'llvm_project_revision': str(run_id)}


def run_body(run_id, machine=MACHINE, **kwargs):
    return {'generated_by': 'fake', 'machine': machine,
            'run': summary(run_id, **kwargs),
            'tests': [{'id': run_id, 'run_id': run_id, 'name': 'test',
                       'execution_time': 1.0}]}


def listing(*runs, machine=MACHINE):
    return {'generated_by': 'fake', 'machine': machine, 'runs': list(runs)}


# Path (relative to PREFIX) -> list of (status, JSON body). Each request takes
# the first response off its list, and the last one is repeated.
responses = {}
requests_seen = []


def serve(**routes):
    responses.clear()
    responses.update({path: list(answers) for path, answers in routes.items()})
    del requests_seen[:]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        answers = responses.get(path[len(PREFIX):]) \
            if path.startswith(PREFIX) else None
        if not answers:
            status, body = 404, {'message': 'not found'}
        else:
            status, body = answers.pop(0) if len(answers) > 1 else answers[0]
            requests_seen.append(path[len(PREFIX):])
        data = json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:%d' % server.server_address[1]

OK = 200
SCHEMA = (OK, {'name': 'nts', 'format_version': '2'})
MACHINES = (OK, {'generated_by': 'fake', 'machines': [MACHINE]})


def refresh(title, *args, mirror=MIRROR):
    print('=== %s' % title)
    result = CliRunner().invoke(action_mirror_v4,
                                [URL, mirror] + list(args or ['--suite', 'nts']))
    # The URL has a random port; keep it out of what FileCheck sees.
    print(result.output.replace(URL, 'URL'), end='')
    print('exit: %d' % result.exit_code)


def check(mirror=MIRROR):
    result = subprocess.run([sys.executable, CHECKER, mirror],
                            capture_output=True, text=True)
    print(result.stdout.replace(URL, 'URL'), end='')
    print('check: %d' % result.returncode)


# A request that fails with a 5xx or a 429 is retried; one that keeps failing
# is a failure, and the refresh mirrors everything else and exits with an error.
serve(schema=[SCHEMA], machines=[MACHINES],
      **{'machines/1': [(OK, listing(summary(1), summary(2), summary(3)))],
         'runs/1': [(429, {}), (OK, run_body(1))],
         'runs/2': [(500, {}), (OK, run_body(2))],
         'runs/3': [(500, {})]})
refresh('run 3 keeps failing')
check()
# CHECK-LABEL: === run 3 keeps failing
# CHECK: machine 1 (fake-machine): 3 run(s) to fetch
# CHECK: run 3 of machine 1 (fake-machine): {{.*}}runs/3 returned HTTP 500
# CHECK: Fetched 2 run(s); removed 0 run(s) and 0 machine(s); 1 failure(s).
# CHECK: exit: 1
# CHECK: machine 1 fake-machine: runs 1 2
# CHECK-NOT: PROBLEM
# CHECK: check: 0
print('runs/3 requested %d times' % requests_seen.count('runs/3'))
# CHECK: runs/3 requested 3 times

# The mirror's files get the permissions the umask gives any other new file.
modes = {os.stat(os.path.join(root, name)).st_mode & 0o777
         for root, _, names in os.walk(MIRROR) for name in names}
print('modes: %s' % sorted('%o' % mode for mode in modes))
# CHECK: modes: ['644']

# Once the server recovers, the next refresh fetches only what is missing.
responses['runs/3'] = [(OK, run_body(3))]
del requests_seen[:]
refresh('the server recovered')
check()
fetched = sorted(p for p in requests_seen if p.startswith('runs/'))
print('runs fetched: %s' % fetched)
# CHECK-LABEL: === the server recovered
# CHECK: machine 1 (fake-machine): 1 run(s) to fetch, 0 changed, 0 removed, 2 unchanged
# CHECK: 0 failure(s).
# CHECK: exit: 0
# CHECK: machine 1 fake-machine: runs 1 2 3
# CHECK: check: 0
# CHECK: runs fetched: ['runs/3']

# A run that changes between the machine listing and the fetch of the run is not
# mirrored, since it matches neither the old summary nor the new one.
serve(schema=[SCHEMA], machines=[MACHINES],
      **{'machines/1': [(OK, listing(summary(1, start_time='2026-02-02T00:00'),
                                     summary(2), summary(3)))],
         'runs/1': [(OK, run_body(1, start_time='2026-03-03T00:00'))]})
refresh('run 1 changes during the refresh')
check()
# CHECK-LABEL: === run 1 changes during the refresh
# CHECK: machine 1 (fake-machine): 0 run(s) to fetch, 1 changed, 0 removed, 2 unchanged
# CHECK: run 1 of machine 1 (fake-machine): run 1 changed on the server during the refresh
# CHECK: exit: 1
# CHECK: machine 1 fake-machine: runs 2 3
# CHECK: check: 0

# A machine whose listing cannot be fetched keeps what the mirror has for it.
serve(schema=[SCHEMA], machines=[MACHINES], **{'machines/1': [(500, {})]})
refresh('the machine listing fails')
check()
# CHECK-LABEL: === the machine listing fails
# CHECK: machine 1 (fake-machine): could not fetch its listing: {{.*}}machines/1 returned HTTP 500
# CHECK: exit: 1
# CHECK: machine 1 fake-machine: runs 2 3
# CHECK: check: 0

# The schema is fetched first; if that fails, the mirror is not touched.
serve(schema=[(500, {})])
refresh('the schema fails')
# CHECK-LABEL: === the schema fails
# CHECK: error: {{.*}}schema returned HTTP 500
# CHECK: exit: 1

# Only one refresh may use a mirror at a time.
lock = os.open(MIRROR, os.O_RDONLY)
fcntl.flock(lock, fcntl.LOCK_EX)
refresh('the mirror is locked')
os.close(lock)
# CHECK-LABEL: === the mirror is locked
# CHECK: error: {{.*}}mirror is in use by another refresh
# CHECK: exit: 1

# A run moved to another machine is fetched again with that machine embedded,
# and stops being listed under its old machine, even when that machine is not
# refreshed: excluded by --machine, or its listing cannot be fetched.
MOVED = os.path.join(TMP, 'moved')
BOTH_MACHINES = (OK, {'generated_by': 'fake',
                      'machines': [MACHINE, OTHER_MACHINE]})
serve(schema=[SCHEMA], machines=[BOTH_MACHINES],
      **{'machines/1': [(OK, listing(summary(1), summary(2)))],
         'machines/2': [(OK, listing(summary(3), machine=OTHER_MACHINE))],
         'runs/1': [(OK, run_body(1))],
         'runs/2': [(OK, run_body(2))],
         'runs/3': [(OK, run_body(3, machine=OTHER_MACHINE))]})
refresh('two machines', mirror=MOVED)
responses.update({
    'machines/1': [(OK, listing(summary(1)))],
    'machines/2': [(OK, listing(summary(2), summary(3),
                                machine=OTHER_MACHINE))],
    'runs/2': [(OK, run_body(2, machine=OTHER_MACHINE))]})
refresh('run 2 moved, old machine excluded', '--suite', 'nts',
        '--machine', 'other-machine', mirror=MOVED)
check(MOVED)
# CHECK-LABEL: === run 2 moved, old machine excluded
# CHECK: machine 2 (other-machine): 1 run(s) to fetch, 0 changed, 0 removed, 1 unchanged
# CHECK: exit: 0
# CHECK: machine 1 fake-machine: runs 1
# CHECK-NEXT: machine 2 other-machine: runs 2 3
# CHECK: check: 0

serve(schema=[SCHEMA], machines=[BOTH_MACHINES],
      **{'machines/1': [(OK, listing(summary(1), summary(2)))],
         'machines/2': [(OK, listing(summary(3), machine=OTHER_MACHINE))],
         'runs/1': [(OK, run_body(1))],
         'runs/2': [(OK, run_body(2))],
         'runs/3': [(OK, run_body(3, machine=OTHER_MACHINE))]})
shutil.rmtree(MOVED)
refresh('two machines again', mirror=MOVED)
responses.update({
    'machines/1': [(500, {})],
    'machines/2': [(OK, listing(summary(2), summary(3),
                                machine=OTHER_MACHINE))],
    'runs/2': [(OK, run_body(2, machine=OTHER_MACHINE))]})
refresh('run 2 moved, old machine listing fails', mirror=MOVED)
check(MOVED)
# CHECK-LABEL: === run 2 moved, old machine listing fails
# CHECK: machine 1 (fake-machine): could not fetch its listing
# CHECK: exit: 1
# CHECK: machine 1 fake-machine: runs 1
# CHECK-NEXT: machine 2 other-machine: runs 2 3
# CHECK: check: 0

# Invalid invocations are rejected before anything is written, and a directory
# the refresh would have created is not left behind.
refresh('suite given twice', '--suite', 'nts', '--suite', 'compile')
# CHECK-LABEL: === suite given twice
# CHECK: --suite may only be given once
# CHECK: exit: 2
refresh('invalid suite name', '--suite', 'mirror.json')
# CHECK-LABEL: === invalid suite name
# CHECK: error: invalid suite name: 'mirror.json'
# CHECK: exit: 1
refresh('suite name differing only in case', '--suite', 'NTS')
# CHECK-LABEL: === suite name differing only in case
# CHECK: error: suite 'NTS' would share a directory with the mirrored suite 'nts'
# CHECK: exit: 1
NEW = os.path.join(TMP, 'new')
refresh('unknown suite into a new directory', '--suite', 'nosuch', mirror=NEW)
print('created: %s' % os.path.exists(NEW))
# CHECK-LABEL: === unknown suite into a new directory
# CHECK: error: there is no suite 'nosuch'
# CHECK: exit: 1
# CHECK: created: False

server.shutdown()
