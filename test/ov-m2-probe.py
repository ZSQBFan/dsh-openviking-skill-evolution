#!/usr/bin/env python3
"""Run against a fresh local OpenViking process using a pinned disposable venv."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

import httpx
import yaml

NAME = 'ov-m2-probe-fixture'
ROOT = 'viking://user/alice/skills'
URI = f'{ROOT}/{NAME}'
SKILLS = '/api/v1/skills'
DETAIL = f'{SKILLS}/{NAME}'
OLD = f'''---
name: {NAME}
description: Probe alpha baseline
allowed-tools: [Read]
tags: [fixture, alpha]
metadata:
  author: probe
  x-fixture:
    enabled: true
---
# Fixture

Run smoke.
'''
NEW = OLD.replace('Probe alpha baseline', 'Probe beta revision').replace('Run smoke.', 'Run smoke and check exit status.')
ATTACHMENTS = {'refs/steps.txt': b'alpha\n', 'assets/blob.bin': b'\x00\xffprobe\x80\n'}
SOURCE = {'type': 'api', 'source': 'local-probe-origin', 'marker': 'original'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def emit(event, **data):
    print(json.dumps({'event': event, **data}, ensure_ascii=False), flush=True)


class Inference(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        model = request['model']
        usage = {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}
        if self.path == '/v1/embeddings':
            inputs = request['input']
            if isinstance(inputs, str) or inputs and isinstance(inputs[0], int):
                inputs = [inputs]
            output = {'object': 'list', 'model': model, 'usage': usage, 'data': [
                {'object': 'embedding', 'index': i, 'embedding': [1.0] + [0.0] * 7}
                for i in range(len(inputs))]}
        elif self.path == '/v1/chat/completions':
            if self.server.delay:
                time.sleep(self.server.delay)
            output = {'id': 'local-chat', 'object': 'chat.completion', 'created': 1,
                      'model': model, 'usage': usage, 'choices': [{'index': 0,
                      'message': {'role': 'assistant', 'content': 'Local fixture summary.'},
                      'finish_reason': 'stop'}]}
        else:
            self.send_error(404)
            return
        raw = json.dumps(output).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


def pack(content, attachments):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f'{NAME}/SKILL.md', content)
        for name, raw in sorted(attachments.items()):
            archive.writestr(f'{NAME}/{name}', raw)
    return stream.getvalue()


def inspect(base, root_key, inference):
    with httpx.Client(base_url=base, trust_env=False, timeout=45) as client:
        def call(method, route, *, status=200, auth=root_key, **kwargs):
            response = client.request(method, route, headers={'X-API-Key': auth, **kwargs.pop('headers', {})}, **kwargs)
            assert response.status_code == status, (method, route, response.status_code, response.text)
            payload = response.json()
            if status < 300:
                return payload.get('result', payload)
            return payload

        def upload(content, attachments):
            return call('POST', '/api/v1/resources/temp_upload', auth=alice,
                        files={'file': ('fixture.zip', pack(content, attachments), 'application/zip')})['temp_file_id']

        def detail(expected_body, expected_attachments, expected_source=None, target=ROOT):
            response = client.get(DETAIL, headers={'X-API-Key': alice}, params={
                'target_uri': target, 'level': 2, 'include_files': 'true',
                'include_integrity': 'true', 'include_source': 'true'})
            response.raise_for_status()
            result = response.json()['result']
            assert result['root_uri'] == f'{target}/{NAME}', result
            assert result['content_sha256'] == digest(result['content'].encode()), result
            assert result['content'].split('---\n', 2)[2].strip() == expected_body.split('---\n', 2)[2].strip(), result
            frontmatter = yaml.safe_load(result['content'].split('---\n', 2)[1])
            expected_frontmatter = yaml.safe_load(expected_body.split('---\n', 2)[1])
            assert result['allowed_tools'] == expected_frontmatter.pop('allowed-tools')
            frontmatter.pop('allowed-tools')
            assert frontmatter == expected_frontmatter, result
            assert len(result['revision']) == 64
            entries = {f['path']: f for f in result['files'] if not f['is_dir'] and
                       f['path'].rsplit('/', 1)[-1] not in {'.abstract.md', '.overview.md', '.source.json'}}
            assert set(entries) == {'SKILL.md', *expected_attachments}, entries
            blobs = {}
            for path, entry in entries.items():
                response_raw = client.get('/api/v1/content/download', headers={'X-API-Key': alice}, params={'uri': entry['uri']})
                response_raw.raise_for_status()
                blobs[path] = response_raw.content
                assert digest(blobs[path]) == entry['sha256'], (path, entry)
            assert {p: v for p, v in blobs.items() if p != 'SKILL.md'} == expected_attachments, blobs
            if expected_source is not None:
                assert all(result['source'].get(k) == v for k, v in expected_source.items()), result
            return result, blobs, {key: response.headers.get(key) for key in ('etag', 'last-modified')}

        def index(expected_description):
            result = call('POST', f'{SKILLS}/find', auth=alice,
                          json={'query': NAME, 'target_uri': ROOT, 'limit': 20, 'score_threshold': 0})
            matches = [x for x in result['skills'] if x.get('root_uri', x.get('uri')) in (URI, f'{URI}/SKILL.md')]
            assert matches and any(x.get('description') == expected_description for x in matches), result
            return matches

        health = call('GET', '/health')
        spec = call('GET', '/openapi.json')
        emit('server', health=health, update=spec['components']['schemas']['UpdateSkillRequest'],
             paths=[p for p in spec['paths'] if 'skills' in p or 'audit' in p])
        owner = call('POST', '/api/v1/admin/accounts', json={'account_id': 'probe', 'admin_user_id': 'admin'})
        admin = owner['user_key']
        alice = call('POST', '/api/v1/admin/accounts/probe/users', auth=admin, json={'user_id': 'alice'})['user_key']
        bob = call('POST', '/api/v1/admin/accounts/probe/users', auth=admin, json={'user_id': 'bob'})['user_key']
        install = call('POST', SKILLS, auth=alice, json={'target_uri': ROOT, 'temp_file_id': upload(OLD, ATTACHMENTS),
                                                          'source_metadata': SOURCE, 'wait': True})
        before, blobs, headers = detail(OLD, ATTACHMENTS, SOURCE)
        indexed_before = index('Probe alpha baseline')
        emit('install', response=install, detail=before, headers=headers, index=indexed_before)

        initial_shared = OLD.replace('Run smoke.', 'Shared package.')
        call('POST', SKILLS, auth=admin, json={'target_uri': 'viking://agent/skills', 'data': initial_shared, 'wait': True})
        shared_before = detail(initial_shared, {}, target='viking://agent/skills')[0]
        other_private = call('PUT', DETAIL, auth=bob, status=400, json={'target_uri': ROOT, 'data': NEW})
        shared_write = call('PUT', DETAIL, auth=alice, json={'target_uri': 'viking://agent/skills', 'data': NEW, 'wait': True})
        assert detail(NEW, {}, target='viking://agent/skills')[0]['revision'] != shared_before['revision']
        call('PUT', DETAIL, auth=admin, json={'target_uri': 'viking://agent/skills', 'data': initial_shared, 'wait': True})
        shared_before = detail(initial_shared, {}, target='viking://agent/skills')[0]
        unknown = client.put(DETAIL, headers={'X-API-Key': alice}, json={'target_uri': ROOT, 'data': NEW, 'expected_revision': before['revision']})
        assert unknown.status_code in (400, 422), unknown.text
        missing = client.put(f'{SKILLS}/missing-fixture', headers={'X-API-Key': alice}, json={'target_uri': ROOT, 'data': NEW})
        assert missing.status_code == 404, missing.text
        assert detail(OLD, ATTACHMENTS, SOURCE)[0]['revision'] == before['revision']
        emit('policy', other_private=other_private, shared_as_user=shared_write,
             unknown_revision=[unknown.status_code, unknown.json()], missing=[missing.status_code, missing.json()])

        updated = call('PUT', DETAIL, auth=alice, json={'target_uri': ROOT, 'temp_file_id': upload(NEW, ATTACHMENTS),
                                                        'source_metadata': before['source'], 'wait': True})
        after, _, _ = detail(NEW, ATTACHMENTS, SOURCE)
        assert after['revision'] != before['revision']
        assert after['source'] == before['source']
        assert detail(initial_shared, {}, target='viking://agent/skills')[0]['revision'] == shared_before['revision']
        emit('update', response=updated, detail=after, index=index('Probe beta revision'))

        stale = call('PUT', DETAIL, auth=alice, headers={'If-Match': f'"{before["revision"]}"'},
                     json={'target_uri': ROOT, 'data': OLD, 'wait': True})
        inline, _, _ = detail(OLD, {})
        assert inline['source']['source'] == 'inline_content' and inline['source'] != before['source']
        emit('stale_if_match_inline_update', response=stale, detail=inline)

        restore_id = upload(blobs.pop('SKILL.md'), blobs)
        inference.delay = 1.0
        restore_body = {'target_uri': ROOT, 'temp_file_id': restore_id, 'source_metadata': before['source'], 'wait': True}
        try:
            client.put(DETAIL, headers={'X-API-Key': alice}, json=restore_body, timeout=0.7)
        except httpx.ReadTimeout:
            emit('client_timeout', route=DETAIL)
        else:
            raise AssertionError('Expected a client-side read timeout')
        observations = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            response = client.get(DETAIL, headers={'X-API-Key': alice}, params={
                'target_uri': ROOT, 'level': 2, 'include_integrity': 'true', 'include_source': 'true'})
            observed = (response.json().get('result') or {}).get('revision')
            if not observations or observations[-1] != observed:
                observations.append(observed)
            if observed == before['revision']:
                break
            time.sleep(.25)
        emit('timeout_readback', revisions=observations, initial_revision=inline['revision'], expected_revision=before['revision'])
        inference.delay = 0
        if observations[-1] != before['revision']:
            restore_body['temp_file_id'] = upload(before['content'], ATTACHMENTS)
            call('PUT', DETAIL, auth=alice, json=restore_body)
        restored, _, _ = detail(OLD, ATTACHMENTS, SOURCE)
        assert restored['revision'] == before['revision'] and restored['source'] == before['source']
        emit('restore_readback', detail=restored, index=index('Probe alpha baseline'))
        used = client.put(DETAIL, headers={'X-API-Key': alice}, json=restore_body)
        assert used.status_code in (200, 400, 404, 409, 410), used.text
        assert detail(OLD, ATTACHMENTS, SOURCE)[0]['revision'] == before['revision']
        audit = client.get('/api/v1/console/audit', headers={'X-API-Key': alice})
        emit('audit_and_replay', audit_status=audit.status_code, audit=audit.json(), replay_status=used.status_code, replay=used.json())
        inference.delay = 0
        return alice


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-bin', required=True, type=Path)
    parser.add_argument('--approval-probe', type=Path, help='Node script to run against the restored fixture')
    parser.add_argument('--web', action='store_true', help='Launch the interactive DSH M3 profile')
    args = parser.parse_args()
    node = shutil.which('node') if args.approval_probe else None
    if args.approval_probe and not node:
        parser.error('--approval-probe requires node on PATH')
    with tempfile.TemporaryDirectory(prefix='ov-m2-probe-run-') as temporary:
        root = Path(temporary)
        for name in ('home', 'tmp', 'data'):
            (root / name).mkdir()
        inference = ThreadingHTTPServer(('127.0.0.1', 0), Inference)
        inference.delay = 0
        fake_base = f'http://127.0.0.1:{inference.server_port}/v1'
        threading.Thread(target=inference.serve_forever, daemon=True).start()
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        key = 'disposable-ov-m2-probe-root-key'
        conf = root / 'ov.conf'
        conf.write_text(json.dumps({
            'storage': {'workspace': str(root / 'data')},
            'server': {'host': '127.0.0.1', 'port': port, 'root_api_key': key},
            'embedding': {'dense': {'provider': 'openai', 'model': 'text-embedding-3-small',
                                     'dimension': 8, 'api_key': 'fake', 'api_base': fake_base}},
            'vlm': {'provider': 'openai', 'model': 'gpt-4o-mini', 'api_key': 'fake', 'api_base': fake_base},
        }))
        log = root / 'server.log'
        executable = args.server_bin.resolve()
        env = {'HOME': str(root / 'home'), 'TMPDIR': str(root / 'tmp'), 'PATH': f'{executable.parent}:/usr/bin:/bin',
               'LITELLM_LOCAL_MODEL_COST_MAP': 'True', 'HF_HUB_OFFLINE': '1'}
        base = f'http://127.0.0.1:{port}'
        with log.open('w') as handle:
            server = subprocess.Popen([str(executable), '--config', str(conf)], cwd=root,
                                      env=env, stdout=handle, stderr=subprocess.STDOUT)
            try:
                with httpx.Client(base_url=base, timeout=1, trust_env=False) as client:
                    for _ in range(120):
                        try:
                            if client.get('/health').status_code == 200:
                                break
                        except httpx.RequestError:
                            pass
                        if server.poll() is not None:
                            raise RuntimeError('OpenViking stopped before readiness')
                        time.sleep(.25)
                    else:
                        raise RuntimeError('OpenViking did not become ready')
                alice = inspect(base, key, inference)
                if args.web:
                    web_env = {**env, 'PATH': os.environ['PATH'],
                               'DSH_NODE_EXECUTABLE': os.environ['DSH_NODE_EXECUTABLE'],
                               'DSH_INSTALL_DIR': os.environ['DSH_INSTALL_DIR'],
                               'OV_M2_ORIGIN': base, 'OV_M2_KEY': alice, 'OV_M2_URI': f'{URI}/SKILL.md'}
                    subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('integration-host.py').resolve())],
                                   cwd=root, check=True, env=web_env)
                if args.approval_probe:
                    subprocess.run([node, str(args.approval_probe.resolve())], cwd=root, check=True,
                                   timeout=90, env={**env, 'OV_M2_ORIGIN': base, 'OV_M2_KEY': alice,
                                                    'OV_M2_URI': f'{URI}/SKILL.md',
                                                    'OV_M2_LEDGER': str(root / 'ledger')})
            except BaseException:
                print(log.read_text()[-20000:], flush=True)
                raise
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)
                inference.shutdown()
                inference.server_close()


if __name__ == '__main__':
    main()
