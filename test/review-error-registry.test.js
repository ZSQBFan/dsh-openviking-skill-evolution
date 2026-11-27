import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { reviewStreamErrorCode } from '../src/review-stream-log.js';

const active = new AbortController().signal;

test('review attribution maps OpenViking and snapshot errors without returning exception text', () => {
  assert.equal(reviewStreamErrorCode(Error('Incomplete skill snapshot'), active), 'skill_snapshot_incomplete');
  assert.equal(reviewStreamErrorCode(Error('Invalid skill file manifest'), active), 'ov_skill_file_manifest_invalid');
  assert.equal(reviewStreamErrorCode(Error('OpenViking request failed (500)'), active), 'ov_http_server_error');
  assert.equal(reviewStreamErrorCode(Error('OpenViking request failed (429)'), active), 'ov_http_rate_limited');
  assert.equal(reviewStreamErrorCode(Error('OpenViking request failed (401)'), active), 'ov_http_authentication_failed');
  const statuses = {
    400: 'bad_request', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed',
    408: 'request_timeout', 409: 'conflict', 410: 'gone', 413: 'payload_too_large',
    415: 'unsupported_media_type', 422: 'unprocessable_entity', 502: 'bad_gateway',
    503: 'service_unavailable', 504: 'gateway_timeout',
  };
  for (const [status, name] of Object.entries(statuses)) {
    assert.equal(reviewStreamErrorCode(Error(`OpenViking request failed (${status})`), active), `ov_http_${name}`);
  }
  assert.equal(reviewStreamErrorCode(Error('OpenViking request failed (418)'), active), 'ov_request_failed');
  assert.equal(reviewStreamErrorCode(Error('OpenViking request failed (private payload)'), active), 'unexpected_error');
  assert.equal(reviewStreamErrorCode(Error('private payload'), active), 'unexpected_error');
  assert.equal(reviewStreamErrorCode(new DOMException('private payload', 'TimeoutError'), active), 'TimeoutError');
  assert.equal(reviewStreamErrorCode(Error('private payload'), AbortSignal.abort()), 'AbortError');
});

const trivia = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*`;
const identifier = String.raw`[A-Za-z_$][\w$]*`;
const literal = String.raw`('(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\x60(?:\\[\s\S]|[^\x60\\])*\x60)`;
const standardErrors = ['Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'];

// Templates must supply finite examples (or explicitly classify a dynamic family).
const templateExamples = new Map([
  ['`invalid_${key}`', ['invalid_maxTurns', 'invalid_maxToolCalls', 'invalid_maxDurationMs', 'invalid_cooldownMs', 'invalid_maxFailures']],
  ['`OpenViking request failed (${response.status})`', ['OpenViking request failed (404)', 'OpenViking request failed (503)']],
]);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

test('every Error literal in src and index has an explicit classification', async () => {
  const root = new URL('../', import.meta.url);
  const files = [new URL('index.js', root), ...await sourceFiles(new URL('src/', root))];
  const sources = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const constructors = new Set(standardErrors);
  const subclasses = sources.flatMap(source => [...source.matchAll(new RegExp(`\\bclass${trivia}(${identifier})${trivia}extends${trivia}(${identifier})`, 'g'))]);
  for (let previous = 0; previous !== constructors.size;) {
    previous = constructors.size;
    for (const [, cls, base] of subclasses) if (constructors.has(base)) constructors.add(cls);
  }
  const constructor = `\\b(${[...constructors].map(name => name.replaceAll('$', '\\$')).join('|')})${trivia}\\(${trivia}`;
  const patterns = [new RegExp(`${constructor}${literal}${trivia}(?=[,)])`, 'g'),
    new RegExp(`${constructor}\\[[^\\]]*\\]${trivia},${trivia}${literal}${trivia}(?=[,)])`, 'g')];
  const missing = [];
  for (const [index, source] of sources.entries()) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const [, name, raw] = match;
        if (pattern === patterns[1] && name !== 'AggregateError') continue;
        const template = raw.startsWith('`') && raw.includes('${');
        const messages = template ? templateExamples.get(raw) : [raw.slice(1, -1)];
        if (!messages || messages.some(message => reviewStreamErrorCode(Error(message), active) === 'unexpected_error')) {
          const file = files[index].pathname.slice(root.pathname.length);
          const line = source.slice(0, match.index).split('\n').length;
          missing.push(`${file}:${line} ${raw}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], 'Classify each literal explicitly in src/review-errors.js');
});
