import { createHash } from 'node:crypto';
import { validPackagePath } from './skill-archive.js';

const roots = new Set(['references', 'scripts', 'templates', 'assets']);
const generated = new Set(['.source.json', '.overview.md', '.abstract.md', 'skill.md']);
const maxBytes = 16 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isPathPrefix = (ancestor, descendant) => descendant.startsWith(`${ancestor}/`);

function parentPaths(path) {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export function validateAttachmentOperations(operations) {
  if (operations === undefined) return [];
  if (!Array.isArray(operations) || operations.length > 255) throw new TypeError('invalid_attachment_operations');
  const paths = new Set();
  let total = 0;
  return Array.from(operations, operation => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new TypeError('invalid_attachment_operation');
    const { action, path, content, baseSha256 } = operation;
    const parts = typeof path === 'string' ? path.split('/') : [];
    if (!validPackagePath(path) || !path.isWellFormed() || parts.length < 2 || !roots.has(parts[0]) ||
        parts.some(part => generated.has(part.toLowerCase())) ||
        [...paths].some(previous => previous === path || isPathPrefix(previous, path) || isPathPrefix(path, previous))) {
      throw new TypeError('invalid_attachment_path');
    }
    paths.add(path);
    const hasHash = typeof baseSha256 === 'string' && hashPattern.test(baseSha256);
    if (action === 'write_file') {
      if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0') ||
          (total += Buffer.byteLength(content)) > maxBytes || !(baseSha256 === null || hasHash)) {
        throw new TypeError('invalid_attachment_write');
      }
      return { action, path, content, baseSha256: hasHash ? baseSha256.toLowerCase() : null };
    }
    if (action === 'remove_file' && content === undefined && hasHash) {
      return { action, path, baseSha256: baseSha256.toLowerCase() };
    }
    throw new TypeError('invalid_attachment_operation');
  });
}

// Return null when the declared attachment base differs from the current snapshot.
export function applyAttachmentOperations(snapshot, operations) {
  if (!operations.length) return snapshot;
  const files = new Map(Object.entries(snapshot.files));
  const directories = new Set(snapshot.metadata.directories ?? []);
  const removalAncestors = new Set();
  for (const { action, path, content, baseSha256 } of operations) {
    const exists = files.has(path);
    if (baseSha256 === null ? exists : !exists || sha256(Buffer.from(files.get(path), 'base64')) !== baseSha256) return null;
    const parents = parentPaths(path);
    if (action === 'remove_file') {
      files.delete(path);
      for (const parent of parents) removalAncestors.add(parent);
      continue;
    }
    if (parents.some(parent => files.has(parent)) || directories.has(path) ||
        [...files.keys(), ...directories].some(entry => isPathPrefix(path, entry))) return null;
    files.set(path, Buffer.from(content, 'utf8').toString('base64'));
    for (const parent of parents) directories.add(parent);
  }
  // The OpenViking ZIP importer drops empty directories. Only prune emptied ancestors of deleted files.
  for (const parent of [...removalAncestors].sort((a, b) => b.length - a.length)) {
    if (![...files.keys(), ...directories].some(entry => isPathPrefix(parent, entry))) directories.delete(parent);
  }
  return { ...snapshot, files: Object.fromEntries(files), metadata: { ...snapshot.metadata, directories: [...directories].sort() } };
}
