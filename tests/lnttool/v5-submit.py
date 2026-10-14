# Test `lnt v5 submit` against a fake v5 instance whose responses the test
# scripts: creating suites, skipping runs a suite already has, retries, and
# failures.
#
# RUN: python %s > %t.out
# RUN: filecheck %s < %t.out

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from click.testing import CliRunner

import lnt.util.v5_submit
from lnt.lnttool.v5 import action_submit

# Retry immediately, rather than after the delays meant for a real instance.
lnt.util.v5_submit.RETRY_DELAYS = (0, 0)

TOKENS = {'admin-token': 'admin', 'submit-token': 'submit',
          'read-token': 'read'}
# The fake instance's suites: name -> {run UUID: submission}.
suites: dict = {}
# Run UUID -> responses to give to its submissions before storing it, as
# (status, error code).
scripted: dict = {}
posts: list = []
lock = threading.Lock()


def error(status, code, message):
    return status, {'error': {'code': code, 'message': message}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def scope(self):
        header = self.headers.get('Authorization')
        if header is None:
            return None
        return TOKENS.get(header.removeprefix('Bearer '), 'invalid')

    def do_GET(self):
        url = urlparse(self.path)
        parts = url.path.strip('/').split('/')
        with lock:
            if parts == ['api', 'auth']:
                scope = self.scope()
                if scope == 'invalid':
                    return self.reply(*error(401, 'unauthorized', 'bad token'))
                key = {'prefix': 'x', 'scope': scope} if scope else None
                return self.reply(200, {'key': key})
            if len(parts) >= 3 and parts[:2] == ['api', 'suites'] and \
                    parts[2] not in suites:
                return self.reply(*error(404, 'not_found', 'no such suite'))
            if len(parts) == 3:
                return self.reply(200, {'name': parts[2]})
            # Two runs per page, whatever the limit, to exercise paging.
            uuids = sorted(suites[parts[2]])
            start = int(parse_qs(url.query).get('cursor', ['0'])[0])
            more = start + 2 < len(uuids)
            return self.reply(200, {
                'items': [{'uuid': u} for u in uuids[start:start + 2]],
                'cursor': {'next': str(start + 2) if more else None,
                           'previous': None}})

    def do_POST(self):
        parts = urlparse(self.path).path.strip('/').split('/')
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            if parts == ['api', 'suites']:
                if body['name'] in suites:
                    return self.reply(*error(409, 'duplicate', 'exists'))
                suites[body['name']] = {}
                return self.reply(201, body)
            runs = suites[parts[2]]
            uuid = body.get('uuid')
            posts.append(uuid)
            if scripted.get(uuid):
                status, code = scripted[uuid].pop(0)
                return self.reply(*error(status, code, 'scripted %d %s'
                                         % (status, code)))
            if uuid in runs:
                return self.reply(*error(409, 'duplicate', 'already there'))
            runs[uuid] = body
            return self.reply(201, body)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:%d' % server.server_address[1]
TMP = tempfile.mkdtemp()


def run(uuid, machine='m', commit='c1'):
    return json.dumps({'format_version': '5', 'uuid': uuid,
                       'machine': {'name': machine},
                       'commit': {'value': commit}, 'tests': []})


def write(name, content):
    path = os.path.join(TMP, name)
    with open(path, 'w') as f:
        f.write(content)
    return path


def submit(*args, input=None):
    del posts[:]
    result = CliRunner().invoke(action_submit, [URL] + list(args),
                                input=input)
    print(result.output, end='')
    print('exit: %d, posted: %d' % (result.exit_code, len(posts)))


SCHEMA = write('schema.json', json.dumps({'name': 'nts', 'metrics': []}))
RUNS = write('runs.jsonl', '\n'.join(run(u) for u in ('u1', 'u2', 'u3')))

# ---------------------------------------------------------------------------
print('# CREATE')
submit('--suite', 'nts', '--create-suite', SCHEMA, '--token', 'admin-token',
       RUNS)
# CHECK-LABEL: # CREATE
# CHECK-NEXT: Created suite 'nts'
# CHECK-NEXT: Submitted 3 run(s), skipped 0 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 3

# A suite that exists already is not created again, and nothing is submitted.
submit('--suite', 'nts', '--create-suite', SCHEMA, '--token', 'admin-token',
       RUNS)
# CHECK-NEXT: error: suite 'nts' already exists; submit to it without --create-suite
# CHECK-NEXT: exit: 1, posted: 0

# The schema must be the suite's.
submit('--suite', 'other', '--create-suite', SCHEMA, '--token', 'admin-token',
       RUNS)
# CHECK-NEXT: error: --create-suite: the schema's name is not 'other'
# CHECK-NEXT: exit: 1, posted: 0

# Without --create-suite, the suite must exist.
submit('--suite', 'missing', '--token', 'submit-token', RUNS)
# CHECK-NEXT: error: there is no suite 'missing'
# CHECK-NEXT: exit: 1, posted: 0

# ---------------------------------------------------------------------------
print('# TOKENS')
submit('--suite', 'nts', RUNS)
submit('--suite', 'nts', '--token', 'read-token', RUNS)
submit('--suite', 'nts', '--token', 'wrong', RUNS)
submit('--suite', 'new', '--create-suite', SCHEMA, '--token', 'submit-token',
       RUNS)
# CHECK-LABEL: # TOKENS
# CHECK-NEXT: error: a token with submit scope is needed
# CHECK-NEXT: exit: 1, posted: 0
# CHECK-NEXT: error: a token with submit scope is needed, not read
# CHECK-NEXT: exit: 1, posted: 0
# CHECK-NEXT: error: the token cannot be used: 401 bad token
# CHECK-NEXT: exit: 1, posted: 0
# CHECK-NEXT: error: a token with manage scope is needed, not submit
# CHECK-NEXT: exit: 1, posted: 0

# The token can also come from the environment.
del posts[:]
result = CliRunner(env={'LNT_V5_TOKEN': 'submit-token'}).invoke(
    action_submit, [URL, '--suite', 'nts', RUNS])
print(result.output, end='')
# CHECK-NEXT: Suite 'nts' has 3 run(s) already
# CHECK-NEXT: Submitted 0 run(s), skipped 3 the suite already had; 0 failure(s).

# ---------------------------------------------------------------------------
print('# RESUME')
# The runs the suite has are listed over several pages, and skipped whatever
# the case of their UUID. The input is read from stdin.
more = '\n'.join([run('U1'), run('u4'), run('u2'), run('u5'), run('u3')])
submit('--suite', 'nts', '--token', 'submit-token', input=more)
# CHECK-LABEL: # RESUME
# CHECK-NEXT: Suite 'nts' has 3 run(s) already
# CHECK-NEXT: Submitted 2 run(s), skipped 3 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 2

# ---------------------------------------------------------------------------
print('# FAILURES')
scripted.update({
    'r1': [(500, 'internal_error')],              # succeeds when retried
    'r2': [(409, 'retry')],                       # likewise
    'r3': [(500, 'internal_error')] * 3,          # keeps failing
    'r4': [(400, 'invalid_request')],             # is not retried
    'r5': [(409, 'duplicate')],                   # was submitted already
    'r6': [(409, 'conflict')],                    # is not retried
})
lines = [run('r1'), run('r2'), run('r3', machine='m3', commit='c3'),
         run('r4'), '', run('r5'), 'not json', '[1, 2]', run('r6')]
submit('--suite', 'nts', '--token', 'submit-token', '--workers', '2',
       write('failures.jsonl', '\n'.join(lines)))
print('r3 posted %d times' % posts.count('r3'))
# CHECK-LABEL: # FAILURES
# CHECK-NEXT: Suite 'nts' has 5 run(s) already
# CHECK-NEXT:   line 3 (run r3 of machine m3 at commit c3): 500 scripted 500 internal_error
# CHECK-NEXT:   line 4 (run r4 of machine m at commit c1): 400 scripted 400 invalid_request
# CHECK-NEXT:   line 7 (run None of machine None at commit None): not a JSON object
# CHECK-NEXT:   line 8 (run None of machine None at commit None): not a JSON object
# CHECK-NEXT:   line 9 (run r6 of machine m at commit c1): 409 scripted 409 conflict
# CHECK-NEXT: Submitted 3 run(s), skipped 0 the suite already had; 5 failure(s).
# CHECK-NEXT: exit: 1, posted: 10
# CHECK-NEXT: r3 posted 3 times

# ---------------------------------------------------------------------------
print('# UNREACHABLE')
server.shutdown()
server.server_close()
submit('--suite', 'nts', '--token', 'submit-token', RUNS)
# CHECK-LABEL: # UNREACHABLE
# CHECK-NEXT: error: http://127.0.0.1:{{[0-9]+}} cannot be reached: {{.*}}
# CHECK-NEXT: exit: 1, posted: 0
