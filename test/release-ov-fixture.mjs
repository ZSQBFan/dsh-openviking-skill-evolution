import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { baseline, sha256, uri } from './release-gate.mjs';

const root = uri.slice(0, -'/SKILL.md'.length);
const target = root.slice(0, -'/demo'.length);
const skillPath = '/api/v1/skills/demo';
const identity = 'fixture';
const description = 'Demo.';
const uploadId = 'release-fixture-upload';

function markdownFromArchive(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(8), 0, 'fixture archive must be stored');
  const size = bytes.readUInt32LE(18);
  const nameEnd = 30 + bytes.readUInt16LE(26);
  assert.equal(bytes.toString('utf8', 30, nameEnd), 'SKILL.md');
  const start = nameEnd + bytes.readUInt16LE(28);
  assert.equal(bytes.readUInt32LE(start + size), 0x02014b50, 'fixture archive contains one file');
  return bytes.toString('utf8', start, start + size);
}

export async function startWriterFixture() {
  let body = baseline;
  let uploaded;
  const writes = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    const json = result => res.setHeader('content-type', 'application/json').end(JSON.stringify({ status: 'ok', result }));
    try {
      assert.equal(req.headers.authorization, 'Bearer isolated-fixture-key');
      assert.equal(req.headers['x-openviking-user'], undefined);
      const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');
      switch (`${req.method} ${pathname}`) {
        case 'GET /api/v1/system/status':
          return json({ initialized: true, user: identity });
        case `GET ${skillPath}`:
          assert.equal(searchParams.get('target_uri'), target);
          return json({ root_uri: root, description, content: body, content_sha256: sha256(body), files: [
            { path: 'SKILL.md', uri, is_dir: false, size: Buffer.byteLength(body), sha256: sha256(body) },
          ] });
        case 'GET /api/v1/content/download':
          assert.equal(searchParams.get('uri'), uri);
          return res.end(body);
        case 'GET /api/v1/privacy-configs/skill':
          return json([]);
        case 'POST /api/v1/resources/temp_upload': {
          const form = await new Request('http://127.0.0.1', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).formData();
          const file = form.get('file');
          assert.equal(file.name, 'demo.zip');
          uploaded = markdownFromArchive(Buffer.from(await file.arrayBuffer()));
          writes.push('upload');
          return json({ temp_file_id: uploadId });
        }
        case `PUT ${skillPath}`: {
          const input = await new Request('http://127.0.0.1', { method: 'PUT', headers: req.headers, body: req, duplex: 'half' }).json();
          assert.deepEqual(input, { target_uri: target, temp_file_id: uploadId, wait: true });
          assert.equal(typeof uploaded, 'string');
          body = uploaded;
          uploaded = undefined;
          writes.push('replace');
          return json({});
        }
        case 'POST /api/v1/skills/find':
          await new Request('http://127.0.0.1', { method: 'POST', headers: req.headers, body: req, duplex: 'half' }).json();
          return json({ skills: [{ root_uri: root, description }] });
        default:
          throw Error(`Unexpected writer fixture request: ${req.method} ${pathname}`);
      }
    } catch (error) {
      errors.push(error.stack);
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { config: { baseUrl: `http://127.0.0.1:${server.address().port}`, user: 'owner', apiKey: 'isolated-fixture-key' },
    liveBody: () => body, writes, errors, close() { server.close(); server.closeAllConnections(); } };
}
