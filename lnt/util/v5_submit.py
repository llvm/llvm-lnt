"""Submit runs to a test suite of an LNT v5 instance.

This implements ``lnt v5 submit``. docs/v5_submit.rst specifies it; the
comments below refer to it as "the spec".

The input can be large (a converted v4 suite can take gigabytes), so it is
read a line at a time, and only a bounded number of runs is ever in flight.
"""

import collections
import gzip
import json
import threading
import time
from collections.abc import Callable, Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

import requests

# Where the command reports its progress, one line at a time.
Echo = Callable[[str], None]

# Requests are retried on connection errors, 5xx responses and `409 retry`
# responses, with these delays (in seconds) before the second and third
# attempts.
RETRY_DELAYS = (1, 4)

# (connect, read) timeouts, in seconds. A large run can take a v5 instance a
# few seconds to store.
TIMEOUT = (30, 300)

USER_AGENT = 'lnt-v5-submit'

# The largest page the v5 API serves.
PAGE_SIZE = 10000

# How many runs may be read ahead of the oldest one in flight, per worker.
READ_AHEAD = 4

# How often, in input lines, progress is reported.
PROGRESS_EVERY = 1000

# v5's scopes, from least to most privileged.
SCOPES = ('read', 'submit', 'triage', 'manage', 'admin')


class SubmitError(Exception):
    """A problem that stops the command before it submits any run."""


def _message(response: requests.Response) -> str:
    """What the instance said, from its error envelope when it has one."""
    try:
        return '%d %s' % (response.status_code,
                          response.json()['error']['message'])
    except (ValueError, KeyError, TypeError):
        return '%d %s' % (response.status_code, response.text.strip()[:200])


def _error_code(response: requests.Response) -> Any:
    try:
        return response.json()['error']['code']
    except (ValueError, KeyError, TypeError):
        return None


class Client:
    """Sends requests to a v5 instance's REST API."""

    def __init__(self, url: str, token: str | None) -> None:
        self.base = url.rstrip('/') + '/api'
        self.token = token
        # requests does not promise that a Session is safe to share between
        # threads, so give each worker its own.
        self._local = threading.local()

    def _session(self) -> requests.Session:
        session: requests.Session | None = getattr(self._local, 'session', None)
        if session is None:
            session = requests.Session()
            session.headers['User-Agent'] = USER_AGENT
            if self.token is not None:
                session.headers['Authorization'] = 'Bearer %s' % self.token
            self._local.session = session
        return session

    def request(self, method: str, path: str, **kwargs: Any
                ) -> requests.Response:
        """Send a request, retrying it as the spec says.

        Returns the last response, whatever its status. Raises
        requests.RequestException if the instance could not be reached.
        """
        delays = iter(RETRY_DELAYS)
        while True:
            try:
                response = self._session().request(
                    method, self.base + path, timeout=TIMEOUT, **kwargs)
            except requests.RequestException:
                delay = next(delays, None)
                if delay is None:
                    raise
            else:
                retryable = response.status_code >= 500 or \
                    (response.status_code == 409 and
                     _error_code(response) == 'retry')
                delay = next(delays, None) if retryable else None
                if delay is None:
                    return response
            time.sleep(delay)


def _check_token(client: Client, needed: str) -> None:
    """Check that the client's token grants the scope `needed`."""
    response = client.request('GET', '/auth')
    if response.status_code != 200:
        raise SubmitError('the token cannot be used: %s' % _message(response))
    key = response.json().get('key')
    scope = key.get('scope') if isinstance(key, dict) else None
    if scope not in SCOPES or SCOPES.index(scope) < SCOPES.index(needed):
        raise SubmitError('a token with %s scope is needed%s'
                          % (needed, ', not %s' % scope if scope else ''))


def _create_suite(client: Client, suite: str, schema: Any) -> None:
    if not isinstance(schema, dict) or schema.get('name') != suite:
        raise SubmitError("--create-suite: the schema's name is not %r"
                          % suite)
    response = client.request('POST', '/suites', json=schema)
    if response.status_code == 409 and _error_code(response) == 'duplicate':
        raise SubmitError("suite '%s' already exists; submit to it without "
                          '--create-suite' % suite)
    if response.status_code != 201:
        raise SubmitError("suite '%s' could not be created: %s"
                          % (suite, _message(response)))


def _check_suite(client: Client, suite: str, path: str) -> None:
    """Check that the suite exists. `path` is the suite's path in the API."""
    response = client.request('GET', path)
    if response.status_code == 404:
        raise SubmitError("there is no suite '%s'" % suite)
    if response.status_code != 200:
        raise SubmitError("suite '%s' cannot be read: %s"
                          % (suite, _message(response)))


def _existing_uuids(client: Client, suite: str, path: str) -> set[str]:
    """The UUIDs of the runs the suite has, in lowercase.

    `path` is the suite's path in the API.
    """
    uuids: set[str] = set()
    params: dict[str, Any] = {'limit': PAGE_SIZE}
    while True:
        response = client.request('GET', path + '/runs', params=params)
        if response.status_code != 200:
            raise SubmitError("the runs of suite '%s' cannot be listed: %s"
                              % (suite, _message(response)))
        page = response.json()
        uuids.update(run['uuid'].lower() for run in page['items'])
        cursor = page['cursor']['next']
        if cursor is None:
            return uuids
        params['cursor'] = cursor


# What became of a run; 'had' means that the suite had it already.
_Count = Literal['submitted', 'had', 'failed']
# What became of a run, and why it failed.
_Outcome = tuple[_Count, str | None]


@dataclass
class _Line:
    number: int
    data: bytes
    submission: Any  # the parsed line, if it is a JSON object

    def describe(self) -> str:
        """Which run the line holds, as far as it says."""
        def get(*keys: str) -> Any:
            value = self.submission
            for key in keys:
                value = value.get(key) if isinstance(value, dict) else None
            return value
        return 'line %d (run %s of machine %s at commit %s)' % (
            self.number, get('uuid'), get('machine', 'name'),
            get('commit', 'value'))


def _lines(lines: Iterable[bytes]) -> Iterable[_Line]:
    for number, data in enumerate(lines, start=1):
        data = data.strip()
        if not data:
            continue
        try:
            submission = json.loads(data)
        except ValueError:
            submission = None
        yield _Line(number, data, submission)


def submit(url: str, suite: str, lines: Iterable[bytes],
           token: str | None = None, create_suite: Any = None,
           workers: int = 4, echo: Echo = print, *,
           skip_existing: bool = False) -> int:
    """Submit the runs in `lines`, one JSON object per line, to `suite`.

    `create_suite` is the schema given with --create-suite, if any. Returns
    the number of runs that could not be submitted. Raises SubmitError for
    problems that stop the command before it submits anything.
    """
    client = Client(url, token)
    path = '/suites/%s' % quote(suite, safe='')
    existing: set[str] = set()
    try:
        _check_token(client, 'manage' if create_suite is not None
                     else 'submit')
        if create_suite is not None:
            _create_suite(client, suite, create_suite)
            echo("Created suite '%s'" % suite)
        else:
            _check_suite(client, suite, path)
            if skip_existing:
                existing = _existing_uuids(client, suite, path)
                echo("Suite '%s' has %d run(s) already"
                     % (suite, len(existing)))
    except requests.RequestException as e:
        raise SubmitError('%s cannot be reached: %s' % (url, e))

    def post(line: _Line) -> _Outcome:
        """Submit a run."""
        # Compressed, as v5 encourages: runs compress several times over. At
        # zlib's default level, since the highest costs far more for little.
        data = gzip.compress(line.data, compresslevel=6)
        try:
            response = client.request(
                'POST', path + '/runs', data=data,
                headers={'Content-Type': 'application/json',
                         'Content-Encoding': 'gzip'})
        except requests.RequestException as e:
            return 'failed', str(e)
        if response.status_code == 201:
            return 'submitted', None
        if response.status_code == 409 and \
                _error_code(response) == 'duplicate':
            return 'had', None
        return 'failed', _message(response)

    counts: collections.Counter[_Count] = collections.Counter()

    def settle(line: _Line, outcome: _Outcome) -> None:
        count, failure = outcome
        counts[count] += 1
        if failure is not None:
            echo('  %s: %s' % (line.describe(), failure))

    in_flight: collections.deque[tuple[_Line, Future[_Outcome]]] = \
        collections.deque()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        try:
            for line in _lines(lines):
                if line.number % PROGRESS_EVERY == 0:
                    echo('  read %d line(s)' % line.number)
                if isinstance(line.submission, dict):
                    uuid = line.submission.get('uuid')
                    if isinstance(uuid, str) and uuid.lower() in existing:
                        settle(line, ('had', None))
                        continue
                    future = pool.submit(post, line)
                else:
                    future = Future()
                    future.set_result(('failed', 'not a JSON object'))
                in_flight.append((line, future))
                # Results are settled in input order, which keeps the report
                # in that order and bounds how far ahead the input is read.
                while len(in_flight) > workers * READ_AHEAD:
                    oldest, future = in_flight.popleft()
                    settle(oldest, future.result())
            while in_flight:
                oldest, future = in_flight.popleft()
                settle(oldest, future.result())
        except BaseException:
            pool.shutdown(wait=True, cancel_futures=True)
            raise
    echo('Submitted %d run(s), %d the suite already had; %d failure(s).'
         % (counts['submitted'], counts['had'], counts['failed']))
    return counts['failed']
