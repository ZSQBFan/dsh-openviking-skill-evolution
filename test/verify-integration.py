"""Assert the M1 Web acceptance sequence against the isolated host logs."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
private = 'viking://user/fixture/skills/demo/SKILL.md'
shared = 'viking://agent/skills/demo/SKILL.md'
missing = 'viking://user/fixture/skills/missing/SKILL.md'
body = '---\nname: demo\ndescription: Demo.\n---\n\nRun smoke.\n'


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def read_jsonl(name):
    return [json.loads(line) for line in (root / name).read_text().splitlines()]


events = read_jsonl('events.jsonl')
assert len({e['sessionId'] for e in events}) == 1
calls = [e for e in events if e['type'] == 'tool/call']
results = [e for e in events if e['type'] == 'tool/result']
requests = read_jsonl('mcp.jsonl')
assert {r['method'] for r in requests} <= {'server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'}
reads = [{'uris': [uri]} for uri in (private, shared, missing, private, private)]
reads.append({'uris': [private], 'limit': 4})
assert [r['arguments'] for r in requests if r['method'] == 'tools/call' and r['name'] == 'read'] == reads
assert sum(r['method'] == 'tools/call' for r in requests) == len(reads)
assert [(c['name'], json.loads(c['arguments'])) for c in calls] == [('mcp__openviking__read', r) for r in reads]
assert [r['callId'] for r in results] == [c['callId'] for c in calls]
assert [r['isError'] for r in results] == [False, False, True, False, False, False]
for index, expected in [(0, body), (1, body.replace('Run smoke.', 'Run shared smoke.')),
                        (3, body), (4, body + '\nFixture newer version.\n'),
                        (5, '\n'.join(body.split('\n')[:4]))]:
    assert results[index]['sha256'] == digest(expected)

commands = [e for e in events if e['type'] == 'command/done']
assert all(e['kind'] == 'success' for e in commands)
listing, patch, duplicate, replay, scoped, failed, stale, partial, final_listing = [json.loads(e['text']) for e in commands]
assert listing['loaded'] == [{'uri': private, 'readResultSeq': results[0]['seq']}]
assert patch['action'] == 'patch' and patch['uri'] == private and patch['baseSha256'] == digest(body)
assert patch['evidence']['readCallSeq'] == calls[0]['seq']
assert patch['evidence']['readResultSeq'] == results[0]['seq']
assert results[0]['seq'] < patch['evidence']['userSeq'] < commands[1]['seq']
assert patch['diff'] == f'--- {private}\n+++ {private}\n@@ -6 +6 @@\n-Run smoke.\n+Run smoke and check exit status.\n'
assert duplicate == replay == {'action': 'no_change', 'reason': 'duplicate', 'previousProposalId': patch['proposalId']}
for actual, reason in [(scoped, 'no_learning_evidence'), (failed, 'latest_read_unusable'),
                       (stale, 'stale_read'), (partial, 'latest_read_unusable')]:
    assert actual == {'action': 'no_change', 'reason': reason}
assert final_listing['loaded'] == [{'uri': uri, 'readResultSeq': results[i]['seq']}
                                  for i, uri in [(0, private), (1, shared), (3, private), (4, private)]]
print(json.dumps({'ok': True, 'reads': len(reads), 'writes': 0, 'commands': len(commands),
                  'sessionId': events[0]['sessionId'], 'patch': patch, 'duplicateSeqs': [commands[2]['seq'], commands[3]['seq']]}))
