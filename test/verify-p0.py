"""Verify P0 MCP and proposal evidence before stopping the isolated Web host."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
uri = 'viking://user/fixture/skills/demo/SKILL.md'
before = 'Run smoke and report ORCHID-482.'
body = f'---\nname: demo\ndescription: Demo.\n---\n\n{before}\n'
sha = hashlib.sha256(body.encode()).hexdigest()


def records(file):
    return [json.loads(line) for line in (root / file).read_text().splitlines()]


events = records('events.jsonl')
requests = [r for r in records('mcp.jsonl') if r['method'] == 'tools/call']
assert requests and all(r['name'] == 'read' and r['arguments']['uris'] == [uri] for r in requests)
assert not (root / 'ledger').exists(), 'Approval ledger is outside P0 scope'
assert (root / 'host-2.log').is_file(), 'Restart the isolated host before verifying'
calls = {(e['sessionId'], e['callId']): e for e in events if e['type'] == 'tool/call' and e['name'] == 'mcp__openviking__read'}
reads = {(e['sessionId'], e['seq']): e for e in events if e['type'] == 'tool/result' and e['isError'] is False and e['sha256'] == sha}
commands = [(e, json.loads(e['text'])) for e in events if e['type'] == 'command/done' and e['kind'] == 'success' and e['text'].lstrip().startswith('{')]
patches = [(e, c) for e, c in commands if c.get('action') == 'patch']
assert len(patches) == 1, 'Expected exactly one patch proposal'
preview, patch = patches[0]
session = preview['sessionId']
evidence = patch['evidence']
read = reads[(session, evidence['readResultSeq'])]
call = calls[(session, read['callId'])]
assert evidence['sessionId'] == session and evidence['readCallSeq'] == call['seq']
assert json.loads(call['arguments'])['uris'] == [uri]
assert call['seq'] < read['seq'] < evidence['userSeq'] < preview['seq']
assert patch['uri'] == uri and patch['baseSha256'] == sha and 'approval' not in patch
assert f'\n-{before}\n' in patch['diff'] and '\n+Run smoke and report ORCHID-482 after checking exit status.\n' in patch['diff']
assert any(e['sessionId'] == session and e['seq'] > preview['seq'] and e['generation'] > preview['generation'] and c == {
    'action': 'no_change', 'reason': 'duplicate', 'previousProposalId': patch['proposalId']
} for e, c in commands), 'Repeat /skill-refine on the same session after restart'
print(json.dumps({'ok': True, 'sessionId': session, 'reads': len(requests), 'writes': 0,
                  'proposalId': patch['proposalId'], 'model_reply': 'Verify marker in the Web reply separately'}, indent=2))
