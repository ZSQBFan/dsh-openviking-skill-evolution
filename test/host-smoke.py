import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='dsh-skill-evolution-') as directory:
    root = Path(directory)
    result = root / 'result.json'
    patch = root / 'overlay.yml'
    patch.write_text(f'- insert:\n    - id: skill-evolution-host-probe\n      name: {json.dumps(str(repo / "test/host-probe.mjs"))}\n')
    env = dict(PATH=os.environ['PATH'], DSH_HOME=directory,
               ELECTRON_RUN_AS_NODE='1', SKILL_EVOLUTION_PROBE=str(result))
    args = [os.environ['DSH_NODE_EXECUTABLE'], os.environ['DSH_INSTALL_DIR'] + '/lib/bin.js',
            '--profile', 'web', '--patch', str(patch), '--host', '127.0.0.1', '--port', '0', '--no-open']
    with (root / 'host.log').open('w') as log, subprocess.Popen(args, env=env, stdout=log, stderr=log) as host:
        try:
            for _ in range(150):
                if result.exists() or host.poll() is not None:
                    break
                time.sleep(0.1)
            if not result.exists():
                raise RuntimeError(f'Host emitted no result, exit code {host.poll()}\n{(root / "host.log").read_text()[-4000:]}')
            report = json.loads(result.read_text())
            print(json.dumps(report, ensure_ascii=False))
            if not report['ok']:
                raise SystemExit(1)
        finally:
            if host.poll() is None:
                host.terminate()
                try:
                    host.wait(5)
                except subprocess.TimeoutExpired:
                    host.kill()
