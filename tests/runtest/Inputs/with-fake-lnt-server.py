"""Run a command against a fake LNT server.

    with-fake-lnt-server.py [--status N] [--reply FILE] [--unreachable]
                            --requests FILE --posted FILE -- COMMAND...

Start a server on a free port of 127.0.0.1 that answers every POST with the
given status and the contents of the reply file, then run COMMAND with each
'@URL@' in it replaced by the server's submitRun URL. With --unreachable, the
URL names a port nothing listens on instead.

Each request is recorded in the requests file, as one JSON object per line,
and the report it posted (its 'input_data' field) in the posted file. Exit
with the command's exit status.
"""
import argparse
import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument('--status', type=int, default=200)
parser.add_argument('--reply')
parser.add_argument('--unreachable', action='store_true')
parser.add_argument('--requests', required=True)
parser.add_argument('--posted', required=True)
parser.add_argument('command', nargs='+')
args = parser.parse_args()

reply = b''
if args.reply:
    with open(args.reply, 'rb') as f:
        reply = f.read()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        form = urllib.parse.parse_qs(body.decode())
        with open(args.posted, 'w') as f:
            f.write(form.pop('input_data', [''])[0])
        with open(args.requests, 'a') as f:
            f.write(json.dumps({'path': self.path,
                                'accept': self.headers['Accept'],
                                'form': form}, sort_keys=True) + '\n')
        self.send_response(args.status)
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


open(args.requests, 'w').close()
open(args.posted, 'w').close()
# Not an HTTPServer, which looks up the host's name, slowly on some systems.
server = socketserver.TCPServer(('127.0.0.1', 0), Handler)
url = 'http://127.0.0.1:%d/db_default/submitRun' % server.server_address[1]
if args.unreachable:
    server.server_close()
else:
    threading.Thread(target=server.serve_forever, daemon=True).start()

# Reach the server directly, whatever proxy the environment names. A no_proxy
# also keeps urllib from using the system's proxy settings on macOS.
env = dict(os.environ)
for var in ('http_proxy', 'https_proxy', 'all_proxy'):
    env.pop(var, None)
    env.pop(var.upper(), None)
env['no_proxy'] = '*'

command = [arg.replace('@URL@', url) for arg in args.command]
sys.exit(subprocess.call(command, env=env, timeout=300))
