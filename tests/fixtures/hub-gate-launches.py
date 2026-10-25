"""Disposable real Gate/SQLite/HTTP; only Docker API is substituted."""
import json
import os
from pathlib import Path
import sys
import threading

root = Path(__file__).resolve().parents[2] / 'integrations/runtime-updater/gate'
sys.path[:0] = [str(root), str(root / 'tests')]
from gate.service import start_servers
from test_pi_launch_engine import LaunchEngineTest

fixture = LaunchEngineTest()
servers = None
stopped = threading.Event()
try:
    fixture.setUp()
    servers = start_servers(fixture.gate, 0)
    credential = Path(sys.argv[1])
    fd = os.open(credential, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'token': fixture.gate.hub_management_token}, stream)
    def worker():
        while not stopped.wait(.05):
            fixture.gate.tick()
    ticker = threading.Thread(target=worker, daemon=True)
    ticker.start()
    print(json.dumps({'endpoint': 'http://127.0.0.1:' + str(servers[0].server_port)}), flush=True)
    sys.stdin.readline()
finally:
    stopped.set()
    if servers:
        for server in servers:
            server.shutdown()
            server.server_close()
    fixture.doCleanups()
