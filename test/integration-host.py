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
real_model = os.environ.get('SKILL_EVOLUTION_P0_MODEL')
if real_model:
    assert not os.environ.get('OV_M2_ORIGIN'), 'P0 exposes only the read-only MCP fixture'
    assert os.environ.get('DEEPSEEK_API_KEY'), 'Set DEEPSEEK_API_KEY in the isolated launch shell for P0'
model_provider = 'deepseek-official' if real_model else 'skill-fixture'
model_entry = '' if real_model else f'''    - id: skill-evolution-model
      name: {json.dumps(str(repo / 'test/integration-model.mjs'))}
'''

with tempfile.TemporaryDirectory(prefix='dsh-skill-integration-') as directory:
    root = Path(directory)
    patch = root / 'overlay.yml'
    ov = os.environ.get('OV_M2_ORIGIN')
    mcp_config = {'transport': 'stdio', 'command': node,
                  'args': [str(repo / 'test/ov-fixture.mjs'), str(root / 'mcp.jsonl'), *(['--p0'] if real_model else [])]}
    plugin_config = {}
    if ov:
        assert re.fullmatch(r'http://127\.0\.0\.1:\d+', ov)
        mcp_config = {'transport': 'streamable-http', 'url': ov + '/mcp',
                      'headers': {'X-API-Key': os.environ['OV_M2_KEY']}}
        plugin_config = {'approval': {'origin': ov, 'apiKey': os.environ['OV_M2_KEY'],
                          'mode': 'isolated-single-writer', 'managedUri': os.environ['OV_M2_URI'],
                          'directory': str(root / 'ledger')}}
    patch.touch(mode=0o600)
    patch.write_text(f'''- id: workspace-controller
  config:
    documentsDirectory: {json.dumps(str(root / 'Documents'))}
- id: agent-default-model
  config:
    provider: {model_provider}
    model: {json.dumps(real_model or 'skill-fixture')}
- insert:
    - id: skill-evolution-integration
      name: {json.dumps(str(repo / 'index.js'))}
      config: {json.dumps(plugin_config)}
    - id: skill-evolution-observer
      name: {json.dumps(str(repo / 'test/integration-observer.mjs'))}
{model_entry}    - id: skill-evolution-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: openviking
{chr(10).join(f'        {key}: {json.dumps(value)}' for key, value in mcp_config.items())}
        startupTimeoutMs: 5000
        failOnStartupError: true
''')
    env = dict(PATH=os.environ['PATH'], DSH_HOME=str(root / 'profile'),
               DSH_AGENTS_HOME=str(root / 'agents'), ELECTRON_RUN_AS_NODE='1',
               SKILL_EVOLUTION_EVENTS=str(root / 'events.jsonl'))
    if real_model:
        (root / 'home').mkdir()
        env.update(HOME=str(root / 'home'), DEEPSEEK_API_KEY=os.environ['DEEPSEEK_API_KEY'])
    if ov:
        env['SKILL_EVOLUTION_REAL_URI'] = os.environ['OV_M2_URI']
    args = [os.environ['DSH_NODE_EXECUTABLE'], os.environ['DSH_INSTALL_DIR'] + '/lib/bin.js',
            '--profile', 'web', '--patch', str(patch), '--host', '127.0.0.1', '--port', '0', '--no-open']
    print(f'Fixture evidence directory: {root}', flush=True)
    for generation in range(1, 4):
        log_path = root / f'host-{generation}.log'
        with log_path.open('w') as log, subprocess.Popen(args, cwd=root, env={**env, 'SKILL_EVOLUTION_GENERATION': str(generation)}, stdin=subprocess.DEVNULL, stdout=log, stderr=log) as host:
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
