# Test `lnt v5 submit` against a fake v5 instance whose responses the test
# scripts: creating suites, submitting runs a suite already has, skipping them
# with --skip-existing, retries, interruptions, and failures.
#
# RUN: python %s > %t.out
# RUN: filecheck %s < %t.out

import gzip
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from click.testing import CliRunner

import lnt.util.v5_submit
from lnt.lnttool.v5 import action_submit

TOKENS = {'admin-token': 'admin', 'submit-token': 'submit',
          'read-token': 'read'}
# The fake instance's suites: name -> {run UUID: submission}.
suites: dict = {}
# Run UUID -> responses to give to its submissions before storing it, as
# (status, error code). Without an error code, the response is an HTML page, as
# a proxy in front of the instance would give.
scripted: dict = {}
# Statuses to answer GET /api/auth with before answering it properly.
scripted_auth: list = []
posts: list = []
# The pages of runs listed.
listed: list = []
lock = threading.Lock()


def error(status, code, message):
    return status, {'error': {'code': code, 'message': message}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        """Reply with `body` as JSON, or as HTML if it is bytes."""
        html = isinstance(body, bytes)
        data = body if html else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type',
                         'text/html' if html else 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def reply_scripted(self, status, code):
        if code is None:
            return self.reply(
                status, b'<html>\r\n<body>  proxy\n  error</body>\r\n</html>\r\n')
        return self.reply(*error(status, code, 'scripted %d %s'
                                 % (status, code)))

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
                if scripted_auth:
                    return self.reply_scripted(scripted_auth.pop(0),
                                               'internal_error')
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
            listed.append(url.query)
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
        data = self.rfile.read(int(self.headers['Content-Length']))
        # Runs are submitted gzip-compressed, which a real instance decodes.
        if parts[-1] == 'runs':
            if self.headers.get('Content-Encoding') != 'gzip':
                return self.reply(*error(400, 'invalid_request',
                                         'the run is not gzip-compressed'))
            data = gzip.decompress(data)
        body = json.loads(data)
        with lock:
            if parts == ['api', 'suites']:
                if body['name'] in suites:
                    return self.reply(*error(409, 'duplicate', 'exists'))
                suites[body['name']] = {}
                return self.reply(201, body)
            runs = suites[parts[2]]
            uuid = body.get('uuid')
            posts.append(uuid)
            uuid = uuid.lower()  # as v5 does
            if scripted.get(uuid):
                return self.reply_scripted(*scripted[uuid].pop(0))
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
    del listed[:]
    # Retry immediately, rather than after the delay meant for a real instance.
    result = CliRunner().invoke(action_submit,
                                [URL, '--retry-delay', '0'] + list(args),
                                input=input)
    print(result.output, end='')
    print('exit: %d, posted: %d, listed: %d'
          % (result.exit_code, len(posts), len(listed)))


SCHEMA = write('schema.json', json.dumps({'name': 'nts', 'metrics': []}))
RUNS = write('runs.jsonl', '\n'.join(run(u) for u in ('u1', 'u2', 'u3')))

# ---------------------------------------------------------------------------
print('# CREATE')
submit('--suite', 'nts', '--create-suite', SCHEMA, '--token', 'admin-token',
       RUNS)
# CHECK-LABEL: # CREATE
# CHECK-NEXT: Created suite 'nts'
# CHECK-NEXT: Submitted 3 run(s), 0 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 3, listed: 0

# A suite just created has no runs to list.
FRESH = write('fresh.json', json.dumps({'name': 'fresh', 'metrics': []}))
submit('--suite', 'fresh', '--create-suite', FRESH, '--token', 'admin-token',
       '--skip-existing', RUNS)
# CHECK-NEXT: Created suite 'fresh'
# CHECK-NEXT: Submitted 3 run(s), 0 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 3, listed: 0

# A suite that exists already is not created again, and nothing is submitted.
submit('--suite', 'nts', '--create-suite', SCHEMA, '--token', 'admin-token',
       RUNS)
# CHECK-NEXT: error: suite 'nts' already exists; submit to it without --create-suite
# CHECK-NEXT: exit: 1, posted: 0, listed: 0

# The schema must be the suite's.
submit('--suite', 'other', '--create-suite', SCHEMA, '--token', 'admin-token',
       RUNS)
# CHECK-NEXT: error: --create-suite: the schema's name is not 'other'
# CHECK-NEXT: exit: 1, posted: 0, listed: 0

# Without --create-suite, the suite must exist, even without --skip-existing.
submit('--suite', 'missing', '--token', 'submit-token', RUNS)
# CHECK-NEXT: error: there is no suite 'missing'
# CHECK-NEXT: exit: 1, posted: 0, listed: 0

# ---------------------------------------------------------------------------
print('# TOKENS')
submit('--suite', 'nts', RUNS)
submit('--suite', 'nts', '--token', 'read-token', RUNS)
submit('--suite', 'nts', '--token', 'wrong', RUNS)
submit('--suite', 'new', '--create-suite', SCHEMA, '--token', 'submit-token',
       RUNS)
# CHECK-LABEL: # TOKENS
# CHECK-NEXT: error: a token with submit scope is needed
# CHECK-NEXT: exit: 1, posted: 0, listed: 0
# CHECK-NEXT: error: a token with submit scope is needed, not read
# CHECK-NEXT: exit: 1, posted: 0, listed: 0
# CHECK-NEXT: error: the token cannot be used: 401 bad token
# CHECK-NEXT: exit: 1, posted: 0, listed: 0
# CHECK-NEXT: error: a token with manage scope is needed, not submit
# CHECK-NEXT: exit: 1, posted: 0, listed: 0

# The token can also come from the environment.
del posts[:]
result = CliRunner(env={'LNT_V5_TOKEN': 'submit-token'}).invoke(
    action_submit, [URL, '--suite', 'nts', RUNS])
print(result.output, end='')
# CHECK-NEXT: Submitted 0 run(s), 3 the suite already had; 0 failure(s).

# ---------------------------------------------------------------------------
print('# DUPLICATES')
# By default, the runs the suite already has are submitted, and the instance
# answers `409 duplicate`. The input is read from stdin.
more = '\n'.join([run('U1'), run('u4'), run('u2'), run('u5'), run('u3')])
submit('--suite', 'nts', '--token', 'submit-token', input=more)
# CHECK-LABEL: # DUPLICATES
# CHECK-NEXT: Submitted 2 run(s), 3 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 5, listed: 0

print('# SKIP EXISTING')
# With --skip-existing, the runs the suite has are listed over several pages,
# and skipped whatever the case of their UUID. A run that is in the input
# twice is answered `409 duplicate` the second time.
more = '\n'.join(run(u) for u in ('u1', 'U2', 'u6', 'u3', 'u6', 'u4', 'u5'))
submit('--suite', 'nts', '--token', 'submit-token', '--skip-existing',
       write('more.jsonl', more))
# CHECK-LABEL: # SKIP EXISTING
# CHECK-NEXT: Suite 'nts' has 5 run(s) already
# CHECK-NEXT: Submitted 1 run(s), 6 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 2, listed: 3

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
       '--retries', '2', write('failures.jsonl', '\n'.join(lines)))
print('r3 posted %d times' % posts.count('r3'))
# The retries come first, in no particular order (RETRIES checks them).
# CHECK-LABEL: # FAILURES
# CHECK:        line 3 (run r3 of machine m3 at commit c3): 500 scripted 500 internal_error
# CHECK-NEXT:   line 4 (run r4 of machine m at commit c1): 400 scripted 400 invalid_request
# CHECK-NEXT:   line 7 (run None of machine None at commit None): not a JSON object
# CHECK-NEXT:   line 8 (run None of machine None at commit None): not a JSON object
# CHECK-NEXT:   line 9 (run r6 of machine m at commit c1): 409 scripted 409 conflict
# CHECK-NEXT: Submitted 2 run(s), 1 the suite already had; 5 failure(s).
# CHECK-NEXT: exit: 1, posted: 10, listed: 0
# CHECK-NEXT: r3 posted 3 times

# ---------------------------------------------------------------------------
print('# RETRIES')
# Without retries, a run fails at once.
scripted['q1'] = [(500, 'internal_error')]
submit('--suite', 'nts', '--token', 'submit-token', '--retries', '0',
       '--retry-delay', '60', input=run('q1'))
# CHECK-LABEL: # RETRIES
# CHECK-NEXT:   line 1 (run q1 of machine m at commit c1): 500 scripted 500 internal_error
# CHECK-NEXT: Submitted 0 run(s), 0 the suite already had; 1 failure(s).
# CHECK-NEXT: exit: 1, posted: 1, listed: 0

# A response that is not the instance's is described by its status line, or by
# its body, on one line, when its status line has no reason phrase.
scripted['q3'] = [(502, None)] * 2
submit('--suite', 'nts', '--token', 'submit-token', '--retries', '1',
       input=run('q3'))
# CHECK-NEXT:   POST /api/suites/nts/runs failed (502 Bad Gateway); retrying in 0s (retry 1 of 1)
# CHECK-NEXT:   line 1 (run q3 of machine m at commit c1): 502 Bad Gateway
# CHECK-NEXT: Submitted 0 run(s), 0 the suite already had; 1 failure(s).
# CHECK-NEXT: exit: 1, posted: 2, listed: 0
scripted['q4'] = [(520, None)]
submit('--suite', 'nts', '--token', 'submit-token', input=run('q4'))
# CHECK-NEXT:   POST /api/suites/nts/runs failed (520 <html> <body> proxy error</body> </html>); retrying {{.*}}
# CHECK-NEXT: Submitted 1 run(s), 0 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 2, listed: 0

# The requests made before submitting runs are retried too.
scripted_auth[:] = [503]
submit('--suite', 'nts', '--token', 'submit-token', input=run('q4'))
# CHECK-NEXT:   GET /api/auth failed (503 scripted 503 internal_error); retrying in 0s (retry 1 of 30)
# CHECK-NEXT: Submitted 0 run(s), 1 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 1, listed: 0

# Retries wait for --retry-delay.
scripted['q5'] = [(409, 'retry'), (500, 'internal_error')]
start = time.monotonic()
submit('--suite', 'nts', '--token', 'submit-token', '--retry-delay', '0.1',
       input=run('q5'))
print('waited at least 0.2s: %s' % (time.monotonic() - start >= 0.2))
# CHECK-NEXT:   POST /api/suites/nts/runs failed (409 scripted 409 retry); retrying in 0.1s (retry 1 of 30)
# CHECK-NEXT:   POST /api/suites/nts/runs failed (500 scripted 500 internal_error); retrying in 0.1s (retry 2 of 30)
# CHECK-NEXT: Submitted 1 run(s), 0 the suite already had; 0 failure(s).
# CHECK-NEXT: exit: 0, posted: 3, listed: 0
# CHECK-NEXT: waited at least 0.2s: True

# Neither option can be negative.
for option in ('--retries', '--retry-delay'):
    result = CliRunner().invoke(action_submit, [URL, '--suite', 'nts', option,
                                                '-1', RUNS])
    print('%s -1: exit %d' % (option, result.exit_code))
# CHECK-NEXT: --retries -1: exit 2
# CHECK-NEXT: --retry-delay -1: exit 2

# A request that would fail again, such as one to a URL without a scheme, is
# not retried.
result = CliRunner().invoke(action_submit, [
    'lnt.example.com', '--suite', 'nts', '--retries', '1', '--retry-delay',
    '60', RUNS])
print(result.output, end='')
# CHECK-NEXT: error: lnt.example.com cannot be reached: {{.*}}No scheme supplied{{.*}}

print('# INTERRUPTED')
# Interrupting the command, as Ctrl-C would while a run waits to be retried,
# stops the retries without waiting for the delay to pass.
scripted['c1'] = [(503, 'internal_error')] * 100
del posts[:]


def interrupted():
    yield run('c1').encode()
    # Once the run's first attempt has failed, and its retry is waiting.
    while not any('retry 1 of 1' in line for line in reported):
        time.sleep(0.01)
    raise KeyboardInterrupt


reported: list = []
start = time.monotonic()
try:
    lnt.util.v5_submit.submit(URL, 'nts', interrupted(), 'submit-token',
                              workers=1, echo=reported.append, retries=1,
                              retry_delay=60)
except KeyboardInterrupt:
    print('interrupted')
print('waited for the retry delay: %s' % (time.monotonic() - start >= 60))
print('stopping reported: %s'
      % ('Stopping: waiting for the requests in flight to finish...'
         in reported))
print('c1 posted %d time(s)' % posts.count('c1'))
# CHECK-LABEL: # INTERRUPTED
# CHECK-NEXT: interrupted
# CHECK-NEXT: waited for the retry delay: False
# CHECK-NEXT: stopping reported: True
# CHECK-NEXT: c1 posted 1 time(s)

# ---------------------------------------------------------------------------
print('# UNREACHABLE')
server.shutdown()
server.server_close()
submit('--suite', 'nts', '--token', 'submit-token', '--retries', '1', RUNS)
# CHECK-LABEL: # UNREACHABLE
# CHECK-NEXT:   GET /api/auth failed (ConnectionError); retrying in 0s (retry 1 of 1)
# CHECK-NEXT: error: http://127.0.0.1:{{[0-9]+}} cannot be reached: {{.*}}
# CHECK-NEXT: exit: 1, posted: 0, listed: 0
