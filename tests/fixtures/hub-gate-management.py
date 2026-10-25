"""Temporary real Gate fixture for the Node Hub protocol integration test.

The existing Gate test substitutes Docker execution only. No Docker CLI, user
credentials, production state or remote network services are used here.
"""
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2] / 'gate'
sys.path.insert(0, str(root))
sys.path.insert(0, str(root / 'tests'))
from test_hub_management import HubManagementTest

fixture = HubManagementTest()
try:
    fixture.setUp()
    job = fixture.pending()
    credential = Path(sys.argv[1])
    fd = os.open(credential, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'token': fixture.gate.hub_management_token}, stream)
    print(json.dumps({'endpoint': 'http://127.0.0.1:' + str(fixture.http.server_address[1]),
                      'id': job['id']}), flush=True)
    sys.stdin.readline()
finally:
    fixture.doCleanups()
