"""Verify the isolated M3 run while the Web fixture and OpenViking are live."""
import base64
import hashlib
import json
from pathlib import Path
import sys

import httpx
import yaml


def sha(data):
    return hashlib.sha256(data).hexdigest()


root = Path(sys.argv[1])
entries = yaml.safe_load((root / 'overlay.yml').read_text())
plugins = next(entry['insert'] for entry in entries if 'insert' in entry)
config = next(p['config']['approval'] for p in plugins if p['id'] == 'skill-evolution-integration')
uri = config['managedUri']
package, _ = uri.rsplit('/', 1)
target, name = package.rsplit('/', 1)
events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
ledger = json.loads((root / 'ledger' / 'approvals.json').read_text())
record, = ledger['records']
proposal = record['proposal']
assert proposal['uri'] == uri
assert [e['status'] for e in record['history']] == ['pending', 'applying', 'applied', 'restoring', 'rolled_back']
assert record['before']['files'] == record['after']['files']
assert record['before']['metadata'] == record['after']['metadata']
assert record['after']['body'] == record['before']['body'].replace('Run smoke.', 'Run smoke and check exit status.')
old, new = (sha(record[key]['body'].encode()) for key in ('before', 'after'))
assert old == proposal['baseSha256'] and old != new
calls = {e['callId']: e for e in events if e['type'] == 'tool/call' and e['name'] == 'mcp__openviking__read'}
reads = [(i, e) for i, e in enumerate(events) if e['type'] == 'tool/result' and e['callId'] in calls]
(first, before), (second, after), (third, restored) = reads
assert len({e['sessionId'] for _, e in reads}) == 3
assert [e['sha256'] for _, e in reads] == [old, new, old]
for _, result in reads:
    call = calls[result['callId']]
    assert result['isError'] is False and result['sessionId'] == call['sessionId']
    assert json.loads(call['arguments']) == {'uri': uri}
commands = [(i, e, json.loads(e['text'])) for i, e in enumerate(events) if e['type'] == 'command/done' and e['kind'] == 'success']
same = [(i, e, value) for i, e, value in commands if value.get('proposalId') == proposal['proposalId']]
(stage, preview, draft), (apply, approved, decision), (rollback, reverted, undo) = same
assert first < stage < apply < second < rollback < third
assert before['sessionId'] == preview['sessionId'] == approved['sessionId'] == reverted['sessionId'] == proposal['evidence']['sessionId']
assert before['seq'] == proposal['evidence']['readResultSeq']
assert calls[before['callId']]['seq'] == proposal['evidence']['readCallSeq']
assert draft['approval']['status'] == 'pending' and decision['status'] == 'applied' and undo['status'] == 'rolled_back'

with httpx.Client(base_url=config['origin'], headers={'X-API-Key': config['apiKey']}, trust_env=False) as client:
    listing = client.get('/api/v1/skills', params={'target_uri': target}).raise_for_status().json()['result']
    assert [x['root_uri'] for x in listing['skills'] if x['name'] == name] == [package]
    detail = client.get(f'/api/v1/skills/{name}', params={'target_uri': target, 'level': 2, 'include_files': 'true', 'include_integrity': 'true', 'include_source': 'true'}).raise_for_status().json()['result']
    assert detail['content_sha256'] == old and detail['source'] == record['before']['metadata']['source']
    assert sorted(entry['path'] for entry in detail['files'] if entry['is_dir']) == record['before']['metadata']['directories']
    files = {entry['path']: entry for entry in detail['files'] if not entry['is_dir'] and entry['path'].split('/')[-1] not in {'.abstract.md', '.overview.md', '.source.json'}}
    assert set(files) == {'SKILL.md', *record['before']['files']}
    for path, entry in files.items():
        data = client.get('/api/v1/content/download', params={'uri': entry['uri']}).raise_for_status().content
        expected = record['before']['body'].encode() if path == 'SKILL.md' else base64.b64decode(record['before']['files'][path])
        assert data == expected and entry['sha256'] == sha(expected)
    hits = client.post('/api/v1/skills/find', json={'query': name, 'target_uri': target, 'limit': 20, 'score_threshold': 0}).raise_for_status().json()['result']['skills']
    assert any(item['root_uri'] == package and item['description'] == detail['description'] for item in hits)

print(json.dumps({'result': 'passed', 'read_hashes': [old, new, old], 'sessions': [e['sessionId'] for _, e in reads],
                  'commands': [preview['seq'], approved['seq'], reverted['seq']], 'attachments': {path: entry['sha256'] for path, entry in files.items() if path != 'SKILL.md'},
                  'restored_revision': detail['revision'], 'private_list_and_index': 'confirmed'}, indent=2))
