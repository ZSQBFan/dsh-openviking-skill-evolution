import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const required = [
  'README.md', 'CHANGELOG.md', 'package.json', 'index.js', 'cordis.patch.yml', 'icon.svg',
  'locale/en.json', 'locale/zh.json', 'docs/memory-link.md', 'docs/m2-api-probe.md',
  'client.js', 'src/approval.js', 'src/automatic-review.js', 'src/curator.js', 'src/dashboard.js',
  'src/evidence.js', 'src/evolution.js', 'src/governance.js', 'src/memory-link.js', 'src/ov-adapter.js', 'src/review.js', 'src/skill-archive.js', 'src/attachments.js', 'src/skill-tool.js',
];
const allowed = new Set([...required, 'LICENSE', 'LICENSE.md']);
const work = mkdtempSync(join(tmpdir(), 'skill-evolution-pack-'));
try {
  const [destination, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'usage: node test/release-pack.mjs [existing-output-directory]');
  const out = destination === undefined ? work : realpathSync(resolve(destination));
  assert(statSync(out).isDirectory());
  const packageDir = join(work, 'node_modules', manifest.name);
  const [packed] = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', out,
  ], { cwd: repo, encoding: 'utf8' }));
  const tarball = join(out, packed.filename);
  const paths = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').sort().map(file => {
    assert(file.startsWith('package/') && allowed.has(file.slice(8)), `Unexpected archive member: ${file}`);
    return file.slice(8);
  });
  assert.deepEqual(paths, packed.files.map(file => file.path).sort());
  assert.equal(new Set(paths).size, paths.length);
  for (const file of required) assert(paths.includes(file), `Missing expected archive member: ${file}`);

  execFileSync('tar', ['-xzf', tarball, '-C', work]);
  for (const file of paths) {
    assert.deepEqual(readFileSync(join(work, 'package', file)), readFileSync(join(repo, file)), file);
  }
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  mkdirSync(dirname(packageDir), { recursive: true });
  renameSync(join(work, 'package'), packageDir);
  execFileSync(process.execPath, ['--input-type=module', '--eval', String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    const name = ${JSON.stringify(manifest.name)};
    assert.equal(typeof (await import(name)).apply, 'function');
    for (const tag of ['en', 'zh']) {
      const { meta } = JSON.parse(readFileSync(new URL(import.meta.resolve(name + '/locale/' + tag + '.json'))));
      assert(meta.title && meta.description);
    }
    assert.match(readFileSync(new URL(import.meta.resolve(name + '/icon')), 'utf8'), /<svg\b/);
  `], { cwd: work, stdio: 'inherit' });

  console.log(JSON.stringify({ name: packed.name, version: packed.version, tarball: destination === undefined ? null : tarball,
    sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'), size: packed.size, files: paths }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
