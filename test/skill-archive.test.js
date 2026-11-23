import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { skillArchive } from '../src/skill-archive.js';

test('ZIP preserves the exact Markdown and binary attachment bytes', () => {
  const body = '---\r\nname: demo\r\n---\r\nLast line';
  const zip = skillArchive({ body, files: { 'references/data.bin': 'AAEC/w==' }, metadata: { directories: ['references', 'empty'] } });
  const probe = spawnSync('python3', ['-c', `import base64, json, sys, zipfile, io
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.testzip() is None
    print(json.dumps({name: base64.b64encode(archive.read(name)).decode() for name in archive.namelist()}))`], { input: zip, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { 'SKILL.md': Buffer.from(body).toString('base64'), 'references/data.bin': 'AAEC/w==', 'references/': '', 'empty/': '' });
});

test('ZIP rejects paths that would escape or replace SKILL.md', () => {
  for (const path of ['../OUT', 'references/../OUT', '/OUT', 'SKILL.md', 'a\\b']) {
    assert.throws(() => skillArchive({ body: 'test', files: { [path]: '' }, metadata: { directories: [] } }), /path/i);
  }
});
