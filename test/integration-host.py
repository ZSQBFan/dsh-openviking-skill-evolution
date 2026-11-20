"""Serve an isolated DSH Web profile. Enter 'restart' or 'quit' on stdin."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

repo = Path(__file__).resolve().parents[1]
node = shutil.which('node')
assert node, 'Node.js is required for the stdio fixture'

with tempfile.TemporaryDirectory(prefix='dsh-skill-integration-') as directory:
    root = Path(directory)
    patch = root / 'overlay.yml'
    patch.write_text(f'''- id: workspace-controller
  config:
    documentsDirectory: {json.dumps(str(root / 'Documents'))}
- id: agent-default-model
  config:
    provider: skill-fixture
    model: skill-fixture
- insert:
    - id: skill-evolution-integration
      name: {json.dumps(str(repo / 'index.js'))}
    - id: skill-evolution-observer
      name: {json.dumps(str(repo / 'test/integration-observer.mjs'))}
    - id: skill-evolution-model
      name: {json.dumps(str(repo / 'test/integration-model.mjs'))}
    - id: skill-evolution-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: openviking
        command: {json.dumps(node)}
        args: {json.dumps([str(repo / 'test/ov-fixture.mjs'), str(root / 'mcp.jsonl')])}
        startupTimeoutMs: 5000
        failOnStartupError: true
''')
    env = dict(PATH=os.environ['PATH'], DSH_HOME=str(root / 'profile'),
               DSH_AGENTS_HOME=str(root / 'agents'), ELECTRON_RUN_AS_NODE='1',
               SKILL_EVOLUTION_EVENTS=str(root / 'events.jsonl'))
    args = [os.environ['DSH_NODE_EXECUTABLE'], os.environ['DSH_INSTALL_DIR'] + '/lib/bin.js',
            '--profile', 'web', '--patch', str(patch), '--host', '127.0.0.1', '--port', '0', '--no-open']
    print(f'Fixture evidence directory: {root}', flush=True)
    for generation in range(1, 4):
        log_path = root / f'host-{generation}.log'
        with log_path.open('w') as log, subprocess.Popen(args, cwd=root, env=env, stdout=log, stderr=log) as host:
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and host.poll() is None:
                    match = re.search(r'http://127\.0\.0\.1:\d+', log_path.read_text())
                    if match:
                        print(f'Web generation {generation}: {match[0]}', flush=True)
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError(f'DSH exit status {host.poll()}\n{log_path.read_text()}')
                try:
                    if input().strip() != 'restart':
                        break
                except EOFError:
                    break
            finally:
                if host.poll() is None:
                    host.terminate()
                    try:
                        host.wait(5)
                    except subprocess.TimeoutExpired:
                        host.kill()
                        host.wait()
