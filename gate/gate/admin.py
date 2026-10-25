"""Admin entry point, run only via host docker exec inside the trusted gate."""
import argparse
import http.client
import json
from pathlib import Path
import socket
import sys
import signal


def terminal_preflight(state):
    """Bounded host-only diagnostic; ordinary admin commands remain unchanged."""
    from .terminal_contract import pairs, nonfinite
    from .lifecycle_contract import IMAGE, HEX
    def expired(*_):
        raise TimeoutError('terminal preflight deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 2)
    connection = None
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise ValueError('terminal preflight limit')
        value = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=pairs, parse_constant=nonfinite)
        if (not isinstance(value, dict) or set(value) != {'image'} or
                not isinstance(value['image'], str) or not IMAGE.fullmatch(value['image'])):
            raise ValueError('terminal preflight request')
        connection = http.client.HTTPConnection('localhost', timeout=2)
        connection.sock = socket.socket(socket.AF_UNIX)
        connection.sock.settimeout(2)
        connection.sock.connect(str(Path(state) / 'admin.sock'))
        connection.request('POST', '/admin/terminal-preflight', json.dumps(value), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(4097)
        if response.status != 200 or len(raw) > 4096:
            raise ValueError('terminal preflight unavailable')
        reply = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=pairs, parse_constant=nonfinite)
        if (not isinstance(reply, dict) or set(reply) != {'v', 'profile', 'image', 'instanceId', 'ready'} or
                type(reply['v']) is not int or reply['v'] != 1 or reply['profile'] != 'web-terminal-v1' or
                reply['image'] != value['image'] or reply['ready'] is not True or
                not isinstance(reply['instanceId'], str) or not HEX.fullmatch(reply['instanceId'])):
            raise ValueError('terminal preflight response')
        print(json.dumps(reply))
    finally:
        if connection is not None:
            connection.close()
        signal.setitimer(signal.ITIMER_REAL, 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', default='/state')
    parser.add_argument('command', choices=('status', 'approve', 'rollback', 'reject', 'export-client',
                                           'services', 'register', 'policy', 'resume', 'intents',
                                           'reject-intent', 'events', 'resolve', 'lifecycle',
                                           'lifecycle-policy', 'lifecycle-approve', 'lifecycle-reject',
                                           'lifecycle-resolve', 'lifecycle-export', 'upgrade-status',
                                           'upgrade-reserve', 'upgrade-finish', 'upgrade-abort',
                                           'runtime-updates', 'runtime-policy', 'runtime-approve',
                                           'runtime-reject', 'runtime-resolve', 'terminal-preflight',
                                           'hub-management-export'))
    parser.add_argument('id', nargs='?')
    parser.add_argument('--commit')
    parser.add_argument('--plan')
    parser.add_argument('--json-stdin', action='store_true', help='bounded private request body on stdin')
    args = parser.parse_args()
    if args.command == 'terminal-preflight':
        if not args.json_stdin or args.id or args.commit or args.plan:
            parser.error('terminal-preflight requires only --json-stdin')
        try:
            terminal_preflight(args.state)
        except Exception:
            parser.exit(1, 'Terminal preflight unavailable. No run was admitted.\n')
        return
    if args.command == 'export-client':
        print(json.dumps({'token': (Path(args.state) / 'request.token').read_text().strip()}))
        return
    connection = http.client.HTTPConnection('localhost', timeout=10)
    connection.sock = socket.socket(socket.AF_UNIX)
    connection.sock.settimeout(10)
    connection.sock.connect(str(Path(args.state) / 'admin.sock'))
    if args.command in ('status', 'services', 'intents', 'events', 'lifecycle', 'upgrade-status',
                        'runtime-updates'):
        if args.json_stdin:
            parser.error('read-only operations do not take payloads')
        method, path, value = 'GET', '/admin/requests' + ('/' + args.id if args.id else ''), None
        if args.command != 'status':
            path = '/admin/' + args.command
        if args.command in ('lifecycle', 'runtime-updates') and args.id:
            path += '/' + args.id
    else:
        if args.json_stdin:
            raw = sys.stdin.buffer.read(65537)
            if len(raw) > 65536:
                parser.error('private payload exceeds limit')
            value = json.loads(raw)
        else:
            if not args.id:
                parser.error('request ID required (or --json-stdin for service controls)')
            value = {'id': args.id}
            if args.command in ('approve', 'rollback'):
                if bool(args.commit) == bool(args.plan):
                    parser.error('exactly one of --commit FULL_SHA or --plan PLAN_HASH required')
                value.update({'commit': args.commit} if args.commit else {'plan': args.plan})
        method, path = 'POST', '/admin/' + args.command
    connection.request(method, path, json.dumps(value) if value is not None else None,
                       {'Content-Type': 'application/json'})
    response = connection.getresponse()
    data = response.read(1024 * 1024)
    connection.close()
    if response.status >= 300:
        parser.exit(1, 'Admin operation rejected (HTTP %d). No arbitrary operation is allowed.\n' % response.status)
    print(data.decode())


if __name__ == '__main__':
    main()
