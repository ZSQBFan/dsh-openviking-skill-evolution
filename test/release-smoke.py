"""Pack and exercise the candidate in a disposable DSH Web profile."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def main():
    if len(sys.argv) > 2:
        raise SystemExit('Usage: python3 -B test/release-smoke.py [existing-output-directory]')
    output = Path(sys.argv[1]).resolve(strict=True) if len(sys.argv) == 2 else None
    if output is not None and not output.is_dir():
        raise SystemExit('The output path must be an existing directory.')
    repo = Path(__file__).resolve().parents[1]
    runtime = os.environ.get('DSH_NODE_EXECUTABLE')
    install = os.environ.get('DSH_INSTALL_DIR')
    if not runtime or not install or not Path(runtime).is_absolute() or not Path(install).is_absolute():
        raise SystemExit('Set DSH_NODE_EXECUTABLE and DSH_INSTALL_DIR to absolute installed DSH paths.')

    with tempfile.TemporaryDirectory(prefix='dsh-skill-release-') as directory:
        root = Path(directory).resolve()
        for name in ['home', 'tmp', 'Documents', 'artifacts']:
            (root / name).mkdir()
        pack = root / 'pack.json'
        result = root / 'result.json'
        patch = root / 'overlay.yml'
        env = dict(PATH=os.environ['PATH'], HOME=str(root / 'home'), TMPDIR=str(root / 'tmp'),
                   XDG_CACHE_HOME=str(root / 'cache'), XDG_CONFIG_HOME=str(root / 'config'),
                   XDG_DATA_HOME=str(root / 'data'), XDG_STATE_HOME=str(root / 'state'),
                   DSH_HOME=str(root / 'profile'), DSH_AGENTS_HOME=str(root / 'agents'),
                   npm_config_offline='true', npm_config_update_notifier='false')
        node = subprocess.check_output(['node', '--version'], env=env, text=True).strip()
        metadata = subprocess.check_output(['node', str(repo / 'test/release-pack.mjs'),
                                             str(root / 'artifacts')], cwd=root, env=env, text=True, timeout=60)
        pack.write_text(metadata)
        print(metadata, end='', flush=True)
        probe = root / 'release-probe.mjs'
        for fixture in ['release-probe.mjs', 'release-gate.mjs', 'release-ov-fixture.mjs']:
            shutil.copyfile(repo / 'test' / fixture, root / fixture)
        patch.write_text(f'''- id: workspace-controller
  config:
    documentsDirectory: {json.dumps(str(root / 'Documents'))}
- insert:
    - id: skill-evolution-release-probe
      name: {json.dumps(str(probe))}
''')
        cli = [runtime, str(Path(install) / 'lib/bin.js')]
        env.update(ELECTRON_RUN_AS_NODE='1', SKILL_EVOLUTION_RELEASE_RESULT=str(result),
                   SKILL_EVOLUTION_RELEASE_INPUT=str(pack))
        version = subprocess.check_output([*cli, '--version'], cwd=root, env=env, text=True, timeout=15).strip()
        if not version:
            raise RuntimeError('Installed CLI did not return a DSH version.')
        print(f'Node {node}, DSH {version}; temporary Web profile: {env["DSH_HOME"]}', flush=True)
        args = [*cli, '--profile', 'web', '--patch', str(patch), '--host', '127.0.0.1', '--port', '0', '--no-open']
        run_host(args, root, env, result, root / 'host-1.log')
        resumed = root / 'resumed.json'
        env.update(SKILL_EVOLUTION_RELEASE_PREVIOUS=str(result), SKILL_EVOLUTION_RELEASE_RESULT=str(resumed))
        run_host(args, root, env, resumed, root / 'host-2.log')
        if output is not None:
            tarball = Path(json.loads(metadata)['tarball'])
            retained = output / tarball.name
            with tarball.open('rb') as source, retained.open('xb') as target:
                shutil.copyfileobj(source, target)
            print(f'Verified tarball retained at {retained}', flush=True)


def run_host(args, root, env, result, log_path):
    with log_path.open('w') as log, subprocess.Popen(
        args, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
    ) as host:
        try:
            deadline = time.monotonic() + 90
            while not result.is_file() and host.poll() is None and time.monotonic() < deadline:
                time.sleep(0.1)
            if not result.is_file():
                raise RuntimeError(f'DSH emitted no result (exit code {host.poll()}).\n{log_path.read_text()}')
            report = json.loads(result.read_text())
            print(json.dumps(report, indent=2), flush=True)
            if not report['ok']:
                raise SystemExit(1)
        finally:
            if host.poll() is None:
                host.terminate()
                try:
                    host.wait(5)
                except subprocess.TimeoutExpired:
                    os.killpg(host.pid, signal.SIGKILL)
                    host.wait()


if __name__ == '__main__':
    main()
