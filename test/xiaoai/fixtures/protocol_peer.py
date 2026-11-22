"""Fault-injection peer, never a production provider."""
import json
import os
from pathlib import Path
import sys
import time

root = Path(sys.argv[sys.argv.index('--state-dir') + 1])
if 'invalid' in root.name:
    print('not-json', flush=True)
    time.sleep(20)
else:
    hello = (json.dumps({'v': 1, 'type': 'hello', 'instanceId': '中文分片'}, ensure_ascii=False) + '\n').encode()
    for byte in hello:
        os.write(1, bytes([byte]))
        time.sleep(.001)
    config = json.loads(sys.stdin.readline())
    print(json.dumps({'v': 1, 'type': 'ready', 'accountId': 'test', 'devices': []}), flush=True)
    for line in sys.stdin:
        value = json.loads(line)
        if value['type'] == 'shutdown':
            break
        if value['type'] == 'speak':
            os._exit(7)
