"""Verify native OpenViking session extraction with scripted inference and no live data."""
import argparse
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time

import httpx

SPEC = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('ov-m2-probe.py'))
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)
FACT = 'Cobalt-Harbor-141'
PREFERENCE = 'Amber-Checklist-236'
EXPERIENCE = 'Repeatable-Smoke-378'


class Inference(fixture.Inference):
    def do_POST(self):
        if self.path != '/v1/chat/completions':
            return super().do_POST()
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        prompt = '\n'.join(str(m.get('content', '')) for m in data.get('messages', []))
        operations = {}
        if '## Output Format' in prompt:
            if 'ProfileData' in prompt and FACT in prompt:
                operations['profile'] = [{'page_id': 101, 'content': f'# alice\n- Lives in {FACT} (as of 2026-11-22).'}]
            if 'PreferencesData' in prompt and PREFERENCE in prompt:
                operations['preferences'] = [{'page_id': 102, 'user': 'alice', 'topic': 'release_checklists',
                                              'content': f'- Prefers {PREFERENCE} for releases.'}]
            if 'CasesData' in prompt and EXPERIENCE in prompt:
                operations['cases'] = [{'page_id': 103, 'case_name': 'repeatable_smoke',
                    'task_signature': 'Execute a smoke check and verify its exit status.',
                    'input': json.dumps({'summary': 'Run a smoke check', 'preconditions': ['Fixture tool is available']}),
                    'rubric': json.dumps({'name': 'smoke', 'description': 'Verify status', 'criteria': [
                        {'name': 'status', 'description': 'Report exit status 0', 'required': True, 'weight': 1.0}]}),
                    'evidence': 'Fixture smoke tool returned exit status 0.'}]
            if 'TrajectoriesData' in prompt and EXPERIENCE in prompt:
                operations['trajectories'] = [{'page_id': 105, 'trajectory_name': 'repeatable_smoke',
                    'outcome': 'success', 'related_case_ids': ['c1'],
                    'task_query': 'Run the fixture smoke check and verify exit status.',
                    'retrieval_anchor': 'Stage: after_read; Boundary: check completed; Capability: exit verification; Target: smoke check.',
                    'content': '# repeatable_smoke\n- Domain: quality validation\n- Trigger: verify a smoke check\n'
                               '- Procedure: Run the fixture tool and verify its exit status.\n'
                               '- Result: Smoke check succeeded.\n- Evidence: The tool reported success.'}]
            if 'ExperiencesData' in prompt and EXPERIENCE in prompt:
                operations['experiences'] = [{'page_id': 104, 'experience_name': 'repeatable_smoke', 'content': (
                    f'## Situation\n- {EXPERIENCE}\n\n## Approach\n- Run the fixture smoke check.\n\n'
                    '## Reflect\n- Never infer success without the exit status.')}]
        self.server.stages.append(list(operations))
        response = {'id': 'fixture', 'object': 'chat.completion', 'created': 1, 'model': data['model'],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
                    'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': json.dumps(operations)},
                                 'finish_reason': 'stop'}]}
        raw = json.dumps(response).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def verify(client, root_key, stages):
    def call(method, route, key=root_key, **kwargs):
        resp = client.request(method, route, headers={'X-API-Key': key, **kwargs.pop('headers', {})}, **kwargs)
        assert resp.is_success, (route, resp.status_code, resp.text)
        data = resp.json()
        assert data['status'] == 'ok', (route, data)
        return data.get('result')

    account = call('POST', '/api/v1/admin/accounts', json={'account_id': 'fixture', 'admin_user_id': 'alice'})
    key = account['user_key']
    evolution = call('PUT', '/api/v1/admin/agent-evolution', key, json={'enabled': True})
    fixture.emit('agent_evolution', result=evolution)
    headers = {'X-OpenViking-Actor-Peer': 'fixture-workspace-a'}
    create = lambda sid: call('POST', '/api/v1/sessions', key, headers=headers, json={'session_id': sid})
    source = '/api/v1/sessions/fixture-source'
    create('fixture-source')
    call('POST', source + '/messages', key, headers=headers, json={'role': 'user', 'content': (
        f'I live in {FACT}. I always prefer {PREFERENCE} for release validation. '
        f'Run the {EXPERIENCE} smoke check and verify its exit status.')})
    call('POST', source + '/messages', key, headers=headers, json={'role': 'assistant', 'parts': [
        {'type': 'tool', 'tool_id': 'fixture-1', 'tool_name': 'fixture_smoke', 'tool_input': {},
         'tool_output': f'{EXPERIENCE} returned exit status 0', 'tool_status': 'completed'},
        {'type': 'text', 'text': 'Smoke check completed and its exit status is 0.'},
    ]})
    commit = call('POST', source + '/commit', key, headers=headers, json={'keep_recent_count': 0})
    fixture.emit('commit', result=commit)
    for _ in range(120):
        task = call('GET', f"/api/v1/tasks/{commit['task_id']}", key)
        if task.get('status') not in ('pending', 'running'):
            break
        time.sleep(.25)
    fixture.emit('extraction', task=task, scripted_operations=stages)
    assert task.get('status') == 'completed', task
    assert task['result']['memories_extracted'].get('memory_write', 0) >= 2, task
    for peer in ('fixture-workspace-a', 'fixture-workspace-b'):
        sid = f'fixture-new-{peer[-1]}'
        peer_headers = {'X-OpenViking-Actor-Peer': peer}
        call('POST', '/api/v1/sessions', key, headers=peer_headers, json={'session_id': sid})
        for _ in range(40):
            recalled = call('POST', '/api/v1/search/search', key, headers=peer_headers, json={
                'query': 'What is my release checklist preference and repeatable smoke procedure?',
                'session_id': sid, 'mode': 'context', 'purpose': 'coding', 'score_threshold': 0,
                'dedup_turns': 0, 'peer_scope': 'actor',
                'quotas': {'preferences': 4, 'experiences': 4, 'entities': 4},
            })
            experience_hit = any(entry['uri'] == 'viking://user/alice/memories/experiences/repeatable_smoke.md'
                                 and entry['origin'] == 'self' and EXPERIENCE in entry['text']
                                 for entry in recalled['entries'])
            if experience_hit and PREFERENCE in recalled.get('rendered', ''):
                break
            time.sleep(.25)
        else:
            raise AssertionError((sid, recalled))
        fixture.emit('new_session_recall', peer=peer, entries=recalled.get('entries'), rendered=recalled.get('rendered'))
        profile = call('GET', '/api/v1/content/read', key, headers=peer_headers, params={
            'uri': 'viking://~/memories/profile.md'})
        assert FACT in profile, (sid, profile)
    call('POST', '/api/v1/sessions', key, json={'session_id': 'fixture-new-unscoped'})
    for _ in range(20):
        plain = call('POST', '/api/v1/search/search', key, json={'query': 'Release checklist preference',
                     'session_id': 'fixture-new-unscoped', 'mode': 'context', 'purpose': 'coding',
                     'score_threshold': 0, 'quotas': {'preferences': 4}})
        if PREFERENCE in plain.get('rendered', ''):
            break
        time.sleep(.25)
    fixture.emit('unscoped_recall', found=PREFERENCE in plain.get('rendered', ''))
    assert PREFERENCE in plain.get('rendered', ''), plain
    for category in ('profile.md', 'preferences/alice/release_checklists.md', 'experiences/repeatable_smoke.md'):
        resp = client.get('/api/v1/content/read', headers={'X-API-Key': key}, params={
            'uri': f'viking://~/memories/{category}'})
        fixture.emit('readback', category=category, status=resp.status_code, response=resp.json())
        marker = {'profile.md': FACT, 'preferences/alice/release_checklists.md': PREFERENCE,
                  'experiences/repeatable_smoke.md': EXPERIENCE}[category]
        assert resp.status_code == 200 and marker in resp.json()['result'], (category, resp.text)
    assert any('trajectories' in stage for stage in stages), stages
    assert any('experiences' in stage for stage in stages), stages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-bin', required=True, type=Path)
    executable = parser.parse_args().server_bin.resolve()
    with tempfile.TemporaryDirectory(prefix='ov-memory-server-') as temporary:
        root = Path(temporary)
        for name in ('home', 'tmp', 'data'):
            (root / name).mkdir()
        with ThreadingHTTPServer(('127.0.0.1', 0), Inference) as inference:
            inference.stages = []
            worker = threading.Thread(target=inference.serve_forever, daemon=True)
            worker.start()
            try:
                with socket.socket() as reservation:
                    reservation.bind(('127.0.0.1', 0))
                    port = reservation.getsockname()[1]
                key = 'disposable-memory-fixture-root'
                inference_url = f'http://127.0.0.1:{inference.server_port}/v1'
                config = root / 'ov.conf'
                config.write_text(json.dumps({
                    'storage': {'workspace': str(root / 'data')},
                    'server': {'host': '127.0.0.1', 'port': port, 'root_api_key': key},
                    'memory': {'extraction_output_format': 'json'},
                    'agent_evolution': {'enabled': True},
                    'embedding': {'dense': {'provider': 'openai', 'model': 'text-embedding-3-small',
                                              'dimension': 8, 'api_key': 'fake', 'api_base': inference_url}},
                    'vlm': {'provider': 'openai', 'model': 'gpt-4o-mini', 'api_key': 'fake', 'api_base': inference_url},
                }))
                env = {'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'),
                       'PATH': f'{executable.parent}:/usr/bin:/bin', 'LITELLM_LOCAL_MODEL_COST_MAP': 'True',
                       'HF_HUB_OFFLINE': '1'}
                log = root / 'server.log'
                with log.open('w') as output, subprocess.Popen([str(executable), '--config', str(config)],
                        cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT) as server:
                    try:
                        with httpx.Client(base_url=f'http://127.0.0.1:{port}', timeout=10, trust_env=False) as client:
                            for _ in range(120):
                                try:
                                    if client.get('/health').is_success:
                                        break
                                except httpx.RequestError:
                                    pass
                                assert server.poll() is None
                                time.sleep(.25)
                            else:
                                raise RuntimeError('OpenViking readiness timed out')
                            verify(client, key, inference.stages)
                    except Exception:
                        print(log.read_text()[-5000:])
                        raise
                    finally:
                        server.terminate()
                        try:
                            server.wait(5)
                        except subprocess.TimeoutExpired:
                            server.kill()
            finally:
                inference.shutdown()
                worker.join()


if __name__ == '__main__':
    main()
